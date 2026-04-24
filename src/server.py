"""
Memory Recall Server - Python HTTP Service
Phase 1: L1 vector + L2 BM25 (jieba) + L3 graph cascade via graphify
"""
import asyncio
import json
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
log = logging.getLogger("memory-recall-server")

APP_DIR = Path.home() / ".memory-recall"
APP_DIR.mkdir(exist_ok=True)

DATA_DIR = APP_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

BM25_INDEX_FILE = DATA_DIR / "bm25_index.json"
GRAPH_FILE = DATA_DIR / "memory_graph.json"

DEFAULT_QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
DEFAULT_QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
DEFAULT_COLLECTION = "memory_recall"
DEFAULT_EMBEDDING_URL = os.getenv("EMBEDDING_URL", "http://localhost:11434/api/embeddings")
DEFAULT_EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "bge-m3")
DEFAULT_EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "1024"))
DEFAULT_OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")

app = FastAPI(title="Memory Recall Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StoreRequest(BaseModel):
    content: str
    agent_id: str | None = None
    conversation_id: str | None = None
    metadata: dict[str, Any] | None = None


class UpdateRequest(BaseModel):
    memory_id: str
    content: str | None = None
    metadata: dict[str, Any] | None = None


class RecallRequest(BaseModel):
    query: str
    agent_id: str | None = None
    max_results: int = 10
    min_score: float = 0.0


class ForgetRequest(BaseModel):
    memory_id: str


qdrant_store: Any = None
bm25_index: Any = None
graph_store: Any = None
llm_extractor: Any = None


async def get_services():
    global qdrant_store, bm25_index, graph_store, llm_extractor
    if qdrant_store is None:
        from src.core.qdrant_store import QdrantStore
        from src.core.bm25_index import BM25Index
        from src.core.graph_store import GraphStore
        from src.core.llm_extractor import LLMExtractor

        qdrant_store = QdrantStore(
            host=DEFAULT_QDRANT_HOST,
            port=DEFAULT_QDRANT_PORT,
            collection=DEFAULT_COLLECTION,
            embedding_url=DEFAULT_EMBEDDING_URL,
            embedding_model=DEFAULT_EMBEDDING_MODEL,
            embedding_dim=DEFAULT_EMBEDDING_DIM,
        )
        await qdrant_store.init()

        bm25_index = BM25Index(index_file=str(BM25_INDEX_FILE))
        graph_store = GraphStore(graph_file=str(GRAPH_FILE))
        llm_extractor = LLMExtractor(ollama_url=DEFAULT_OLLAMA_URL)

    return qdrant_store, bm25_index, graph_store, llm_extractor


@app.get("/health")
async def health():
    return {"status": "ok", "service": "memory-recall-server"}


@app.get("/stats")
async def stats():
    store, bm25, graph, _ = await get_services()
    count = await store.count()
    bm25_count = bm25.doc_count()
    node_count = graph.node_count()
    return {
        "memory_count": count,
        "bm25_doc_count": bm25_count,
        "graph_node_count": node_count,
    }


@app.post("/recall")
async def recall(req: RecallRequest):
    """
    L1/L2/L3 cascade recall:
      L1: vector search (Qdrant)
      L2: BM25 keyword search (jieba)
      L3: graph expansion (graphify)
    """
    store, bm25, graph, _ = await get_services()

    query = req.query.strip()
    if not query:
        return {"results": [], "count": 0, "layers": {"l1": 0, "l2": 0, "l3": 0}}

    log.info(f"[/recall] query='{query[:50]}...' max={req.max_results}")

    l1_results = await store.vector_search(query, limit=req.max_results * 3)
    log.info(f"[/recall] L1 vector: {len(l1_results)} candidates")

    l2_results = bm25.search(query, top_k=req.max_results * 2)
    log.info(f"[/recall] L2 BM25: {len(l2_results)} candidates")

    l1_map = {r["id"]: r.get("score", 0) for r in l1_results}
    l2_map = {r["id"]: r.get("score", 0) for r in l2_results}
    all_ids = set(l1_map.keys()) | set(l2_map.keys())

    scored: list[tuple[str, float]] = []
    for mid in all_ids:
        s1 = l1_map.get(mid, 0)
        s2 = l2_map.get(mid, 0)
        score = 0.7 * s1 + 0.3 * s2
        scored.append((mid, score))
    scored.sort(key=lambda x: x[1], reverse=True)

    l3_expanded = graph.expand([mid for mid, _ in scored[: req.max_results * 2]], depth=2, top_k=req.max_results)
    l3_ids = set(l3_expanded.keys())
    for mid in l3_ids:
        if mid not in l1_map and mid not in l2_map:
            scored.append((mid, l3_expanded[mid] * 0.5))
    scored.sort(key=lambda x: x[1], reverse=True)

    final_ids = [mid for mid, _ in scored[: req.max_results]]
    memories = await store.fetch_by_ids(final_ids)
    score_map = dict(scored)
    for m in memories:
        m["relevance_score"] = round(score_map.get(m.get("id", ""), 0), 4)

    filtered = [m for m in memories if m.get("relevance_score", 0) >= req.min_score]

    return {
        "results": filtered,
        "count": len(filtered),
        "layers": {
            "l1": len(l1_results),
            "l2": len(l2_results),
            "l3": len(l3_expanded),
        },
    }



@app.post("/store")
async def store(req: StoreRequest):
    """Store a memory: vector + BM25 index + graph + LLM extraction"""
    store, bm25, graph, extractor = await get_services()

    memory_id = str(uuid.uuid4())
    conversation_id = req.conversation_id or str(uuid.uuid4())
    agent_id = req.agent_id or "default"

    log.info(f"[/store] id={memory_id} content='{req.content[:50]}...'")

    vector = await store.embed(req.content)
    if not vector:
        raise HTTPException(status_code=503, detail="Embedding service unavailable")

    extraction = {}
    try:
        extraction = await extractor.extract(req.content)
        log.info(f"[/store] LLM extraction: category={extraction.get('category')} 6w keys={[k for k in extraction.get('6w', {}).keys() if extraction['6w'][k]]}")
    except Exception as e:
        log.warning(f"[/store] LLM extraction failed (non-fatal): {e}")
        extraction = {"category": "other", "6w": {}}

    payload = {
        "content": req.content,
        "agent_id": agent_id,
        "conversation_id": conversation_id,
        "category": extraction.get("category", "other"),
        "6w": extraction.get("6w", {}),
        "importance": extraction.get("importance", 0.5),
        "stored_at": __import__("datetime").datetime.now().isoformat(),
        "state": "confirmed",
        "access_count": 0,
        "last_accessed": __import__("datetime").datetime.now().isoformat(),
        "graph_edges": [],
        **(req.metadata or {}),
    }

    stored_id = await store.upsert(memory_id, vector, payload)
    bm25.add(memory_id, req.content)

    graph.add_node(memory_id, payload)
    if req.metadata and req.metadata.get("conversation_id"):
        graph.add_session_edge(memory_id, conversation_id)

    l1_results_for_graph = await store.vector_search(req.content, limit=5)
    graph.build_recall_edges(memory_id, [r["id"] for r in l1_results_for_graph if r.get("id")])

    return {
        "memory_id": stored_id,
        "conversation_id": conversation_id,
        "category": payload["category"],
        "6w": payload["6w"],
        "importance": payload["importance"],
    }


@app.post("/forget")
async def forget(req: ForgetRequest):
    """Delete a memory from Qdrant, BM25 index, and graph"""
    store, bm25, graph, _ = await get_services()

    log.info(f"[/forget] id={req.memory_id}")
    await store.delete(req.memory_id)
    bm25.remove(req.memory_id)
    graph.remove_node(req.memory_id)

    return {"memory_id": req.memory_id, "deleted": True}


@app.post("/update")
async def update(req: UpdateRequest):
    """Update memory content and re-index"""
    store, bm25, graph, extractor = await get_services()

    log.info(f"[/update] id={req.memory_id}")

    existing = await store.fetch_by_ids([req.memory_id])
    if not existing:
        raise HTTPException(status_code=404, detail=f"Memory {req.memory_id} not found")

    old = existing[0]
    new_content = req.content if req.content is not None else old.get("content", "")
    new_metadata = {**old, **(req.metadata or {})}

    if req.content and req.content != old.get("content"):
        new_vector = await store.embed(new_content)
        if new_vector:
            await store.upsert(req.memory_id, new_vector, new_metadata)
        bm25.update(req.memory_id, new_content)

        try:
            extraction = await extractor.extract(new_content)
            new_metadata["category"] = extraction.get("category", "other")
            new_metadata["6w"] = extraction.get("6w", {})
            new_metadata["importance"] = extraction.get("importance", 0.5)
            await store.upsert(req.memory_id, new_vector or [], new_metadata)
        except Exception as e:
            log.warning(f"[/update] LLM re-extraction failed: {e}")

        graph.update_node(req.memory_id, new_metadata)

    return {"memory_id": req.memory_id, "updated": True}


if __name__ == "__main__":
    log.info(f"Starting Memory Recall Server...")
    log.info(f"  Data dir: {DATA_DIR}")
    log.info(f"  Qdrant: {DEFAULT_QDRANT_HOST}:{DEFAULT_QDRANT_PORT}/{DEFAULT_COLLECTION}")
    log.info(f"  Embedding: {DEFAULT_EMBEDDING_URL} ({DEFAULT_EMBEDDING_MODEL})")
    log.info(f"  Ollama: {DEFAULT_OLLAMA_URL}")
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="info")
