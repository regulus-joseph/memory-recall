# Memory Recall Worker Pool — Architecture Design

**Status:** Proposed
**Date:** 2026-04-29
**Reason:** Current stdin/stdout worker blocks gateway on cold start (44s), unsuitable for multi-agent concurrency

---

## Problem Statement

### Current Architecture

```
Gateway (Node.js)
  └── memory-recall plugin
        └── WorkerClient (stdin/stdout JSON-RPC)
              └── Python worker (LanceDB + FTS + Graph + LLM extraction)
```

**Issues:**
1. Worker is a child process of gateway — gateway restart → worker dies → 44s cold start
2. stdin/stdout is a single stream — message interleaving possible with concurrent calls
3. Single worker for all sessions — no isolation between agents
4. No HTTP interface — cannot be managed by systemd

### Why stdin/stdout was chosen

Previous HTTP-based architecture had concurrency issues (HTTP concurrent requests to single worker process caused race conditions). stdin/stdout serializes naturally — one message per line, requests queue automatically.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Gateway (Node.js)                                         │
│  └── memory-recall plugin                                  │
│        └── WorkerPoolClient (HTTP client)                   │
│              Connects to: http://localhost:PORT/mr-pool/   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/JSON-RPC
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  memory-recall-worker-pool.service (systemd, always-on)    │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────┐ │
│  │ Worker 1      │  │ Worker 2      │  │ Worker N   │ │
│  │ session=A     │  │ session=B     │  │ (hot standby)│ │
│  │ stdin+Worker  │  │ stdin+Worker  │  │              │ │
│  │ LanceDB       │  │ LanceDB       │  │              │ │
│  └────────────────┘  └────────────────┘  └─────────────┘ │
│                                                              │
│  Router: session_id → worker assignment                    │
└─────────────────────────────────────────────────────────────┘
```

### Key Design: Session → Worker Affinity

**Problem:** Multiple agents/sessions hitting the same worker causes request interleaving.

**Solution:** Assign each session to a **dedicated worker** (1:1 mapping within pool).

```
Session A → Router → Worker 1 (session=A, locked)
Session B → Router → Worker 2 (session=B, locked)
Session A (again) → Router → Worker 1 (same worker, still locked)

Worker 3 → hot standby, rotates in when assigned to new session
Worker N → hot standby
```

Benefits:
- Each worker handles one session → no message interleaving → safe stdin/stdout
- Pool of workers → concurrency without HTTP race conditions
- Worker per session → clean isolation → one session crash doesn't affect others

### Pool Management

```
Startup:
  - Pool spawns N workers on boot
  - Workers register with router (session_id = null = available)

Assignment:
  - New session connects → router assigns available worker
  - Worker locks to session_id
  - Worker stays locked until session ends or worker dies

Reassignment:
  - Session ends → worker releases lock → returns to pool (reset state)
  - Worker dies → router reassigns session to new available worker
  - Max pool size = max concurrent sessions (e.g., 5)

Overflow:
  - All workers busy → queue request or spawn temporary worker
  - Temporary worker dies after session cleanup
```

---

## Implementation Plan

### Phase 1: Worker as HTTP Server (Low Risk)

Add HTTP listener to existing worker.py, keep stdin/stdout as-is:

```python
# worker.py — new flag
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--http-port", type=int, default=None)
    args = parser.parse_args()

    if args.http_port:
        # HTTP server mode
        run_http_server(args.http_port)
    else:
        # Original stdin/stdout mode
        run_stdin_loop()
```

**Risk:** Low. Existing logic untouched, HTTP is new path only.

### Phase 2: Pool Router (Medium Risk)

HTTP router that assigns sessions to workers:

```python
# pool_router.py (new file)
class PoolRouter:
    def __init__(self, worker_count=3):
        self.workers = [WorkerSession(i) for i in range(worker_count)]
        self.session_map = {}  # session_id → worker

    def assign(self, session_id):
        # Find available worker, assign session
        ...

    def dispatch(self, session_id, payload):
        worker = self.session_map[session_id]
        return worker.call(payload)
```

**Risk:** Medium. New component, needs testing for routing correctness.

### Phase 3: Plugin HTTP Client (Low Risk)

Plugin connects to HTTP pool instead of spawning:

```typescript
// memory-recall/src/index.ts — new mode
if (process.env.MR_POOL_URL) {
  // HTTP mode — connect to pool
  const pool = new PoolClient(process.env.MR_POOL_URL);
  // ...
} else {
  // Original spawn mode — backward compatible
  // ...
}
```

**Risk:** Low. Original spawn mode preserved for dev/testing.

### Phase 4: systemd Service (Low Risk)

```ini
# /etc/systemd/system/memory-recall-worker-pool.service
[Unit]
Description=Memory Recall Worker Pool
After=network.target
Wants=openclaw-gateway.service
PartOf=openclaw-gateway.service

[Service]
ExecStart=/usr/bin/python3 /path/to/pool_router.py --workers 3
Restart=always
RestartSec=5

[Install]
WantedBy=openclaw-gateway.service
```

**Risk:** Low. Standard systemd unit.

---

## Open Questions

1. **Worker count:** How many concurrent sessions expected? (Start with 3, auto-scale?)
2. **Session lifecycle:** How does pool know a session ended? (Gateway sends `session_end` signal, or timeout?)
3. **Worker warm-up:** Keep workers pre-warmed (import LanceDB at startup) or lazy? (Lazy = first call still slow. Pre-warm = faster but uses memory.)
4. **State persistence:** LanceDB data is per-agent-id, workers are stateless routers. No cross-session state. Safe.
5. **Backward compatibility:** Keep stdin/stdout mode for dev machines without pool. Fallback on HTTP connect failure.

---

## Why This Solves the Original Problems

| Problem | Solution |
|---------|----------|
| Gateway restart → worker dies (44s cold) | Worker pool is standalone systemd service |
| stdin/stdout message interleaving | Session → dedicated worker (1:1), no concurrent calls to same worker |
| Previous HTTP concurrency issues | Each worker handles one session, not multiple concurrent requests |
| Worker crash → session dead | Pool router reassigns session to available worker |
| Resource waste (one worker idle) | Pool of workers, shared across sessions |

---

## OpenClaw Gateway Restart Behavior

Current: `systemctl restart openclaw-gateway` kills all child processes (workers).

With pool:
- `restart` → gateway dies → workers survive (standalone service)
- gateway respawns → reconnects to workers → zero cold start
- `systemctl stop openclaw-gateway` → gateway + workers all stop (PartOf=)
