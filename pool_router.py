#!/usr/bin/env python3
"""
Memory Recall Worker Pool Router

Session affinity: each session assigned to a dedicated worker process.
Workers are spawned as child processes, isolated from each other.

Usage: python pool_router.py [--workers N] [--base-port PORT]

Endpoints:
  POST /mr/{method}  — dispatch to worker's session
  GET  /health      — router health
  GET  /pool/status — pool and worker status
  POST /pool/reset  — reset a session's worker (force new worker assignment)

Worker isolation:
  - Each worker = one Python subprocess = one session
  - Worker stdin/stdout used internally (not exposed)
  - LanceDB operations are isolated per agent_id (already safe)
  - Multiple concurrent sessions → multiple workers, no interleaving
"""
import argparse
import asyncio
import httpx
import logging
import os
import signal
import sys
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger("pool-router")

_worker_bin = Path(__file__).resolve().parent / "src" / "worker.py"
_python_bin = (
    Path.home() / ".memory-recall-venv" / "bin" / "python"
    if (Path.home() / ".memory-recall-venv" / "bin" / "python").exists()
    else sys.executable
)

DEFAULT_POOL_SIZE = 3
DEFAULT_BASE_PORT = 18801
DEFAULT_ROUTER_PORT = 18799
STALE_WORKER_TIMEOUT = 300  # seconds before unused worker is recycled


class WorkerInstance:
    def __init__(self, worker_id: int, port: int, session_id: str | None = None):
        self.worker_id = worker_id
        self.port = port
        self.session_id = session_id
        self.process: asyncio.subprocess.Process | None = None
        self.last_used = 0.0
        self.dead = False

    async def start(self):
        if self.process:
            return
        self.process = await asyncio.create_subprocess_exec(
            _python_bin, str(_worker_bin),
            "--http-port", str(self.port),
            "--session-id", self.session_id or "",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        log.info(f"Worker {self.worker_id} started on port {self.port}, session={self.session_id or '(available)'}")

    async def stop(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.process.kill()
            log.info(f"Worker {self.worker_id} stopped")
        self.process = None
        self.dead = False

    async def forward(self, method: str, payload: dict) -> dict:
        if not self.process or self.dead:
            raise ConnectionError(f"Worker {self.worker_id} is not running")
        url = f"http://127.0.0.1:{self.port}/mr/{method}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            return resp.json()


class PoolRouter:
    def __init__(self, pool_size: int = DEFAULT_POOL_SIZE, base_port: int = DEFAULT_BASE_PORT):
        self.pool_size = pool_size
        self.base_port = base_port
        self.available: list[WorkerInstance] = []
        self.busy: dict[str, WorkerInstance] = {}  # session_id → worker
        self.all_workers: list[WorkerInstance] = []

    async def bootstrap(self):
        log.info(f"Starting pool with {self.pool_size} workers...")
        for i in range(self.pool_size):
            port = self.base_port + i
            worker = WorkerInstance(worker_id=i, port=port)
            await worker.start()
            self.all_workers.append(worker)
            self.available.append(worker)

    async def assign(self, session_id: str) -> WorkerInstance:
        if session_id in self.busy:
            worker = self.busy[session_id]
            worker.last_used = 0.0
            return worker

        if not self.available:
            raise RuntimeError("No available workers — pool exhausted")

        worker = self.available.pop()
        worker.session_id = session_id
        self.busy[session_id] = worker
        worker.last_used = 0.0
        log.info(f"Assigned session {session_id} → worker {worker.worker_id}")
        return worker

    async def release(self, session_id: str):
        if session_id not in self.busy:
            return
        worker = self.busy.pop(session_id)
        worker.session_id = None
        self.available.append(worker)
        log.info(f"Released session {session_id} from worker {worker.worker_id}")

    async def dispatch(self, session_id: str, method: str, payload: dict) -> dict:
        worker = await self.assign(session_id)
        return await worker.forward(method, payload)

    def status(self) -> dict:
        return {
            "pool_size": self.pool_size,
            "available": len(self.available),
            "busy": {sid: w.worker_id for sid, w in self.busy.items()},
            "workers": [
                {
                    "id": w.worker_id,
                    "port": w.port,
                    "session": w.session_id,
                    "alive": w.process is not None and w.dead is False,
                }
                for w in self.all_workers
            ],
        }

    async def shutdown(self):
        log.info("Shutting down pool...")
        for w in self.all_workers:
            await w.stop()


# ─── HTTP Server ────────────────────────────────────────────────────────────────

from fastapi import FastAPI, HTTPException, Request
from contextlib import asynccontextmanager

_app: FastAPI | None = None
_router: PoolRouter | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _router
    _router = PoolRouter(
        pool_size=int(os.environ.get("MR_POOL_SIZE", DEFAULT_POOL_SIZE)),
        base_port=int(os.environ.get("MR_POOL_BASE_PORT", DEFAULT_BASE_PORT)),
    )
    await _router.bootstrap()
    log.info("Pool router HTTP server started")
    yield
    await _router.shutdown()
    log.info("Pool router HTTP server stopped")


def make_app() -> FastAPI:
    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/pool/status")
    async def pool_status():
        if not _router:
            raise HTTPException(status_code=503, detail="Router not ready")
        return _router.status()

    @app.post("/pool/release")
    async def pool_release(session: dict | None = None):
        if not _router:
            raise HTTPException(status_code=503, detail="Router not ready")
        sid = session.get("session_id") if session else None
        if sid:
            await _router.release(sid)
        return {"released": sid}

    @app.post("/mr/{method}")
    async def dispatch(method: str, request: Request):
        if not _router:
            raise HTTPException(status_code=503, detail="Router not ready")

        body = await request.json()
        session_id = body.pop("_session_id", None) or "default"

        try:
            result = await _router.dispatch(session_id, method, body)
            return result
        except ConnectionError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except Exception as e:
            log.error(f"dispatch error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return app


def run(port: int = DEFAULT_ROUTER_PORT):
    import uvicorn
    global _app
    _app = make_app()
    uvicorn.run(_app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Memory Recall Worker Pool Router")
    parser.add_argument("--port", type=int, default=DEFAULT_ROUTER_PORT, help="Router HTTP port")
    parser.add_argument("--workers", type=int, default=DEFAULT_POOL_SIZE, help="Number of workers in pool")
    parser.add_argument("--base-port", type=int, default=DEFAULT_BASE_PORT, help="First worker HTTP port")
    args = parser.parse_args()

    os.environ["MR_POOL_SIZE"] = str(args.workers)
    os.environ["MR_POOL_BASE_PORT"] = str(args.base_port)

    run(port=args.port)
