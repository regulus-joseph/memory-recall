#!/usr/bin/env python3
"""
Memory Recall Worker - stdio JSON-RPC server with LanceDB storage.
Per-agent LanceDB databases. L1=vector, L2=full-text, L3=graph expand.

Usage: python worker.py
Communication: JSON-RPC over stdin/stdout

Methods:
  store      - store a memory (LanceDB vector + FTS + Graph), async LLM extraction
  recall     - L1 vector + L2 FTS + L3 graph cascade, tracks access_count
  forget     - delete from LanceDB + Graph
  update     - update memory content
  stats      - get storage stats
  decay_scan - Weibull decay scan, return stale memories (dry_run default)
  health     - health check

Storage: ~/.memory-recall/data/{agent_id}/memories.lance/
         ~/.memory-recall/data/{agent_id}/graph.json
"""
import asyncio
import json
import logging
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

import httpx
import lancedb
import pyarrow as pa

_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

_shared = Path.home() / "projects" / "shared-lib"
if str(_shared) not in sys.path:
    sys.path.insert(0, str(_shared))

from src.core.graph_store import GraphStore
from src.rule_extractor import extract as rule_extract
from src.lark_tok import tokenize as jieba_tokenize
import shared_lib as _sl

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] worker: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("worker")

APP_DIR = Path.home() / ".memory-recall"
APP_DIR.mkdir(exist_ok=True)
DATA_DIR = APP_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

EMBED_URL   = f"{_sl.BASE_URL}/api/embeddings"
EMBED_MODEL = _sl.EMBED_MODEL
EMBED_DIM   = _sl.EMBED_DIM
LLM_URL     = f"{_sl.BASE_URL}/api/chat"
LLM_MODEL   = _sl.LLM_MODEL

_lance_instances: dict[str, "lancedb.table.LanceTable"] = {}
_graph_instances: dict[str, GraphStore] = {}

# Decay & compaction config (all overridable via env vars)
DECAY_CONFIG = {
    "recencyHalfLifeDays": float(os.getenv("DECAY_HALF_LIFE_DAYS", "30")),
    "recencyWeight": float(os.getenv("DECAY_RECENCY_WEIGHT", "0.4")),
    "frequencyWeight": float(os.getenv("DECAY_FREQUENCY_WEIGHT", "0.3")),
    "intrinsicWeight": float(os.getenv("DECAY_INTRINSIC_WEIGHT", "0.3")),
    "staleThreshold": float(os.getenv("DECAY_STALE_THRESHOLD", "0.3")),
    "compactDeleteThreshold": float(os.getenv("DECAY_COMPACT_DELETE_THRESHOLD", "0.15")),
    "importanceBoostFactor": float(os.getenv("DECAY_IMPORTANCE_BOOST_FACTOR", "0.05")),
    "betaCore": float(os.getenv("DECAY_BETA_CORE", "0.8")),
    "betaWorking": float(os.getenv("DECAY_BETA_WORKING", "1.0")),
    "betaPeripheral": float(os.getenv("DECAY_BETA_PERIPHERAL", "1.3")),
    "coreDecayFloor": float(os.getenv("DECAY_FLOOR_CORE", "0.9")),
    "workingDecayFloor": float(os.getenv("DECAY_FLOOR_WORKING", "0.7")),
    "peripheralDecayFloor": float(os.getenv("DECAY_FLOOR_PERIPHERAL", "0.5")),
    "compactMinAgeDays": int(os.getenv("COMPACT_MIN_AGE_DAYS", "14")),
    "compactMinClusterSize": int(os.getenv("COMPACT_MIN_CLUSTER_SIZE", "2")),
    "compactSimilarityThreshold": float(os.getenv("COMPACT_SIM_THRESHOLD", "0.88")),
    "compactCooldownHours": int(os.getenv("COMPACT_COOLDOWN_HOURS", "24")),
    "maxCompactionRounds": int(os.getenv("COMPACT_MAX_ROUNDS", "4")),
    "compactMaxMemoriesToScan": int(os.getenv("COMPACT_MAX_SCAN", "200")),
}


def _tokenize_for_fts(text: str) -> list[str]:
    if not text:
        return []
    tokens = list(jieba_tokenize(text))
    return [t for t in tokens if len(t) >= 1]


def _tokenize_for_embed(text: str) -> list[str]:
    if not text:
        return []
    tokens = list(jieba_tokenize(text))
    return [t for t in tokens if len(t) > 1]

SCHEMA = pa.schema([
    pa.field("id", pa.string()),
    pa.field("text", pa.string()),
    pa.field("tokens", pa.string()),
    pa.field("vector", pa.list_(pa.float32(), EMBED_DIM)),
    pa.field("category", pa.string()),
    pa.field("scope", pa.string()),
    pa.field("conversation_id", pa.string()),
    pa.field("importance", pa.float32()),
    pa.field("timestamp", pa.float64()),
    pa.field("stored_at", pa.string()),
    pa.field("metadata_json", pa.string()),
    pa.field("who", pa.string()),
    pa.field("when", pa.string()),
    pa.field("where", pa.string()),
    pa.field("why", pa.string()),
    pa.field("how", pa.string()),
    pa.field("summary", pa.string()),
    pa.field("confidence", pa.float32()),
    pa.field("temporal_type", pa.string()),
    pa.field("access_count", pa.int32()),
    pa.field("last_accessed_at", pa.float64()),
    pa.field("compaction_rounds", pa.int32()),
    pa.field("last_compacted_at", pa.float64()),
    pa.field("original_source_count", pa.int32()),
])


def _agent_db_path(agent_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", agent_id)
    return DATA_DIR / safe


def _dir_to_agent_id(dirname: str) -> str:
    return dirname


def _find_agent_for_memory(memory_id: str) -> str | None:
    for aid in _lance_instances:
        try:
            rows = _lance_instances[aid].search().where(f'id = "{memory_id}"').limit(1).to_list()
            if rows:
                return aid
        except Exception:
            pass
    for subdir in DATA_DIR.iterdir():
        if not subdir.is_dir():
            continue
        lance_path = subdir / "memories.lance"
        if lance_path.exists():
            try:
                db = lancedb.connect(str(subdir))
                table = db.open_table("memories")
                rows = table.search().where(f'id = "{memory_id}"').limit(1).to_list()
                if rows:
                    return _dir_to_agent_id(subdir.name)
            except Exception:
                pass
    return None





def _agent_table(agent_id: str) -> "lancedb.table.LanceTable":
    if agent_id in _lance_instances:
        return _lance_instances[agent_id]

    db_path = _agent_db_path(agent_id)
    db_path.mkdir(parents=True, exist_ok=True)
    db_path_str = str(db_path)

    db = lancedb.connect(db_path_str)
    table_names = db.table_names()

    if "memories" in table_names:
        table = db.open_table("memories")
        _migrate_schema(table)
    else:
        table = db.create_table("memories", schema=SCHEMA)
        try:
            table.create_fts_index("tokens")
            log.info(f"FTS index created for agent={agent_id}")
        except Exception as e:
            log.warning(f"FTS index creation failed (may already exist): {e}")

    _lance_instances[agent_id] = table
    return table


def _migrate_schema(table: "lancedb.table.LanceTable") -> None:
    try:
        schema_names = {f.name for f in table.schema()}
    except Exception:
        return
    needed = {
        "compaction_rounds", "last_compacted_at", "original_source_count",
        "who", "when", "where", "why", "how", "summary", "confidence",
    }
    missing = needed - schema_names
    if not missing:
        return
    for col in missing:
        try:
            if col == "compaction_rounds":
                table.add_columns([pa.field("compaction_rounds", pa.int32())])
            elif col == "last_compacted_at":
                table.add_columns([pa.field("last_compacted_at", pa.float64())])
            elif col == "original_source_count":
                table.add_columns([pa.field("original_source_count", pa.int32())])
            elif col == "who":
                table.add_columns([pa.field("who", pa.string())])
            elif col == "when":
                table.add_columns([pa.field("when", pa.string())])
            elif col == "where":
                table.add_columns([pa.field("where", pa.string())])
            elif col == "why":
                table.add_columns([pa.field("why", pa.string())])
            elif col == "how":
                table.add_columns([pa.field("how", pa.string())])
            elif col == "summary":
                table.add_columns([pa.field("summary", pa.string())])
            elif col == "confidence":
                table.add_columns([pa.field("confidence", pa.float32())])
            log.info(f"Migrated schema: added {col}")
        except Exception as e:
            log.warning(f"Schema migration failed for {col}: {e}")


def _get_graph(agent_id: str) -> GraphStore:
    if agent_id not in _graph_instances:
        db_path = _agent_db_path(agent_id)
        graph_path = db_path / "graph.json"
        _graph_instances[agent_id] = GraphStore(str(graph_path))
    return _graph_instances[agent_id]


async def _embed(text: str) -> list[float] | None:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(EMBED_URL, json={"model": EMBED_MODEL, "prompt": text})
            resp.raise_for_status()
            data = resp.json()
            emb = data.get("embeddings") or data.get("embedding")
            if emb:
                vec = emb[0] if isinstance(emb[0], list) else emb
                return [float(x) for x in vec[:EMBED_DIM]]
    except Exception as e:
        log.warning(f"embed failed: {e}")
    return None


EXTRACT_PROMPT = """你是一个记忆提取器。分析以下文本，提取结构化信息。

文本：{content}

输出 JSON（不要有其他内容）：
{{
  "category": "profile|preferences|entities|events|cases|patterns|other",
  "who": "主语是谁（20字内）",
  "what": "核心内容（50字内）",
  "when": "时间（具体日期/周期/相对时间，没有则空字符串）",
  "where": "地点（20字内，没有则空字符串）",
  "why": "原因/目的（30字内，可选）",
  "how": "方式/方法（30字内，可选）",
  "importance": 0.0~1.0,
  "confidence": 0.0~1.0,
  "temporal_type": "dynamic|static"
}}

注意：
- importance：信息对后续决策的价值（高=反复使用，低=一次性）
- confidence：你对提取准确性的置信度（低=模糊/推测，高=明确）
- temporal_type：dynamic=时间敏感/会变化（日期、周期、事件），static=基本不变（习惯、偏好、身份）"""


async def _llm_extract(content: str) -> dict:
    if not LLM_MODEL:
        return {}

    prompt = EXTRACT_PROMPT.replace("{content}", content[:2000])
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                LLM_URL,
                json={
                    "model": LLM_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            raw = data.get("message", {}).get("content", "")
            if isinstance(raw, list):
                raw = raw[0].get("text", "") if raw else ""
            raw = raw.strip()
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                raw = raw[start:end]
            result = json.loads(raw)
            return {
                "category": str(result.get("category", "other")),
                "who": str(result.get("who", "") or "")[:20],
                "what": str(result.get("what", content[:50])),
                "when": str(result.get("when", "") or "")[:40],
                "where": str(result.get("where", "") or "")[:20],
                "why": str(result.get("why", "") or "")[:30],
                "how": str(result.get("how", "") or "")[:30],
                "importance": float(max(0.0, min(1.0, float(result.get("importance", 0.5))))),
                "confidence": float(max(0.0, min(1.0, float(result.get("confidence", 1.0))))),
                "temporal_type": str(result.get("temporal_type", "static")),
                "summary": content[:80],
            }
    except Exception as e:
        log.warning(f"LLM extraction failed: {e}")
    return {}


def _add_temporal_edge(graph: GraphStore, memory_id: str, when_val: str, agent_id: str, stored_at: str) -> None:
    if not when_val or len(when_val) < 2:
        return
    edge_type = "temporal_same_when"
    changed = False
    for other_id, attrs in graph.nodes.items():
        if other_id == memory_id:
            continue
        if attrs.get("when") == when_val and attrs.get("agent_id") == agent_id:
            edge = {"source": memory_id, "target": other_id, "relation": edge_type, "when": when_val}
            if edge not in graph.edges:
                graph.edges.append(edge)
                changed = True
    if changed:
        graph._save()


def _add_where_edge(graph: GraphStore, memory_id: str, where_val: str, stored_at: str) -> None:
    if not where_val or len(where_val) < 2:
        return
    edge_type = "same_where"
    changed = False
    for other_id, attrs in graph.nodes.items():
        if other_id == memory_id:
            continue
        if attrs.get("where") == where_val:
            edge = {"source": memory_id, "target": other_id, "relation": edge_type, "where": where_val}
            if edge not in graph.edges:
                graph.edges.append(edge)
                changed = True
    if changed:
        graph._save()


async def cmd_store(params: dict) -> dict:
    content: str = params["content"]
    agent_id: str = params.get("agent_id") or "default"
    conversation_id: str = params.get("conversation_id") or str(uuid.uuid4())
    metadata: dict = params.get("metadata") or {}

    memory_id = str(uuid.uuid4())
    stored_at = datetime.now().isoformat()
    timestamp = datetime.now().timestamp()

    extraction = rule_extract(content)
    category = extraction.get("category", "other")
    importance = extraction.get("importance", 0.5)
    six_w = extraction.get("6w", {})

    vector = await _embed(content)
    if vector is None:
        vector = [0.0] * EMBED_DIM

    row = {
        "id": memory_id,
        "text": content,
        "tokens": " ".join(_tokenize_for_fts(content)),
        "vector": vector,
        "category": category,
        "scope": agent_id,
        "conversation_id": conversation_id,
        "importance": float(importance),
        "timestamp": float(timestamp),
        "stored_at": stored_at,
        "metadata_json": json.dumps(metadata, ensure_ascii=False),
        "who": six_w.get("who", "") or "",
        "when": six_w.get("when", "") or "",
        "where": six_w.get("where", "") or "",
        "why": six_w.get("why", "") or "",
        "how": six_w.get("how", "") or "",
        "summary": content[:80],
        "confidence": 0.5,
        "temporal_type": "static",
        "access_count": 0,
        "last_accessed_at": 0.0,
        "compaction_rounds": 0,
        "last_compacted_at": 0.0,
        "original_source_count": 1,
    }

    table = _agent_table(agent_id)
    table.add([row])

    graph = _get_graph(agent_id)
    graph.add_node(memory_id, {
        "content": content,
        "category": category,
        "agent_id": agent_id,
        "conversation_id": conversation_id,
        "importance": importance,
        "stored_at": stored_at,
        "who": six_w.get("who", "") or "",
        "when": six_w.get("when", "") or "",
        "where": six_w.get("where", "") or "",
    })
    graph.add_session_edge(memory_id, conversation_id)
    if category != "other":
        graph.build_category_overlap(memory_id, category, stored_at)
    if six_w.get("when"):
        _add_temporal_edge(graph, memory_id, six_w["when"], agent_id, stored_at)
    if six_w.get("where"):
        _add_where_edge(graph, memory_id, six_w["where"], stored_at)

    asyncio.create_task(_bg_llm_extract_and_update(memory_id, agent_id, content))

    log.info(f"[store] {memory_id[:8]} agent={agent_id} cat={category}")
    return {"memory_id": memory_id, "conversation_id": conversation_id, "dedup": False}


async def _bg_llm_extract_and_update(memory_id: str, agent_id: str, content: str) -> None:
    llm_result = await _llm_extract(content)
    if not llm_result:
        return

    try:
        table = _lance_instances.get(agent_id)
        if not table:
            table = _agent_table(agent_id)

        six_w = {
            "who": llm_result.get("who", ""),
            "what": llm_result.get("what", content[:50]),
            "when": llm_result.get("when", ""),
            "where": llm_result.get("where", ""),
            "why": llm_result.get("why", ""),
            "how": llm_result.get("how", ""),
        }

        table.update(
            where=f'id = "{memory_id}"',
            values={
                "category": llm_result.get("category", "other"),
                "importance": float(llm_result.get("importance", 0.5)),
                "who": llm_result.get("who", ""),
                "when": llm_result.get("when", ""),
                "where": llm_result.get("where", ""),
                "why": llm_result.get("why", ""),
                "how": llm_result.get("how", ""),
                "summary": llm_result.get("summary", content[:80]),
                "confidence": float(llm_result.get("confidence", 1.0)),
                "temporal_type": llm_result.get("temporal_type", "static"),
            },
        )

        full_meta = {
            **six_w,
            "category": llm_result.get("category", "other"),
            "importance": llm_result.get("importance", 0.5),
            "confidence": llm_result.get("confidence", 1.0),
            "temporal_type": llm_result.get("temporal_type", "static"),
        }
        table.update(
            where=f'id = "{memory_id}"',
            values={"metadata_json": json.dumps(full_meta, ensure_ascii=False)},
        )

        stored_at = datetime.now().isoformat()
        graph = _get_graph(agent_id)
        graph.update_node(memory_id, {
            "category": llm_result.get("category", "other"),
            "importance": llm_result.get("importance", 0.5),
            "who": llm_result.get("who", ""),
            "when": llm_result.get("when", ""),
            "where": llm_result.get("where", ""),
        })
        if llm_result.get("when"):
            _add_temporal_edge(graph, memory_id, llm_result["when"], agent_id, stored_at)
        if llm_result.get("where"):
            _add_where_edge(graph, memory_id, llm_result["where"], stored_at)

        log.info(f"[extract] {memory_id[:8]} done cat={llm_result.get('category')} conf={llm_result.get('confidence')}")
    except Exception as e:
        log.warning(f"BG extraction update failed for {memory_id[:8]}: {e}")


async def cmd_recall(params: dict) -> dict:
    query: str = params["query"]
    agent_id: str = params.get("agent_id") or "default"
    max_results: int = params.get("max_results", 10)
    min_score: float = params.get("min_score", 0.0)

    if not query.strip():
        return {"results": [], "count": 0, "layers": {"l1": 0, "l2": 0, "l3": 0}}

    table = _agent_table(agent_id)
    graph = _get_graph(agent_id)

    vector = await _embed(query)

    l1_map: dict[str, float] = {}
    l2_map: dict[str, float] = {}

    if vector:
        try:
            results_l1 = (
                table.search(vector, vector_column_name="vector")
                .where(f'scope = "{agent_id}"')
                .limit(max_results * 2)
                .to_list()
            )
            for r in results_l1:
                l1_map[r["id"]] = round(1.0 - float(r.get("_distance", 0)) / EMBED_DIM, 4)
        except Exception as e:
            log.warning(f"L1 vector search failed: {e}")

    try:
        query_tokens = " ".join(_tokenize_for_fts(query))
        results_l2 = (
            table.search(query_tokens)
            .where(f'scope = "{agent_id}"')
            .limit(max_results * 2)
            .to_list()
        )
        for r in results_l2:
            l2_map[r["id"]] = round(float(r.get("_score", 0)), 4)
    except Exception as e:
        log.warning(f"L2 FTS search failed: {e}")

    all_ids = set(l1_map.keys()) | set(l2_map.keys())
    scored: list[tuple[str, float]] = []
    for mid in all_ids:
        s1 = l1_map.get(mid, 0.0)
        s2 = l2_map.get(mid, 0.0)
        combined = 0.5 * s1 + 0.5 * s2
        scored.append((mid, combined))

    scored.sort(key=lambda x: x[1], reverse=True)

    if scored and graph.node_count() > 0:
        top_ids = [mid for mid, _ in scored[:5]]
        l3_expanded = graph.expand(top_ids, depth=2, top_k=max_results)
        for mid, s3 in l3_expanded.items():
            if mid not in l1_map and mid not in l2_map:
                scored.append((mid, s3 * 0.4))
        scored.sort(key=lambda x: x[1], reverse=True)

    scored.sort(key=lambda x: x[1], reverse=True)
    final_ids = [mid for mid, _ in scored[:max_results]]
    score_map = dict(scored)

    memories = []
    for mid in final_ids:
        if score_map.get(mid, -999) < min_score:
            continue
        try:
            rows = table.search().where(f'id = "{mid}"').limit(1).to_list()
        except Exception:
            rows = []
        if not rows:
            attrs = graph.nodes.get(mid, {})
            if attrs:
                memories.append({
                    "id": mid,
                    "content": attrs.get("content", ""),
                    "agent_id": attrs.get("agent_id", agent_id),
                    "conversation_id": attrs.get("conversation_id", ""),
                    "category": attrs.get("category", "other"),
                    "importance": attrs.get("importance", 0.5),
                    "stored_at": attrs.get("stored_at", ""),
                    "relevance_score": round(score_map.get(mid, 0), 4),
                })
        else:
            row = rows[0]
            meta = {}
            try:
                meta = json.loads(row.get("metadata_json", "{}"))
            except Exception:
                pass
            memories.append({
                "id": row["id"],
                "content": row["text"],
                "agent_id": row.get("scope", agent_id),
                "conversation_id": row.get("conversation_id", ""),
                "category": row.get("category", "other"),
                "importance": float(row.get("importance", 0.5)),
                "stored_at": row.get("stored_at", ""),
                "relevance_score": round(score_map.get(mid, 0), 4),
                **meta,
            })

    for mid in final_ids:
        try:
            rows = table.search().where(f'id = "{mid}"').limit(1).to_list()
            now_ts = datetime.now().timestamp()
            if rows:
                current_count = int(rows[0].get("access_count", 0) or 0)
                table.update(
                    where=f'id = "{mid}"',
                    values={
                        "access_count": current_count + 1,
                        "last_accessed_at": now_ts,
                    },
                )
        except Exception:
            pass

    return {
        "results": memories,
        "count": len(memories),
        "layers": {
            "l1": len(l1_map),
            "l2": len(l2_map),
            "l3": len(scored) - len(l1_map) - len(l2_map),
        },
    }


async def cmd_forget(params: dict) -> dict:
    memory_id: str = params["memory_id"]
    agent_id: str | None = params.get("agent_id") or _find_agent_for_memory(memory_id)

    if not agent_id:
        return {"memory_id": memory_id, "deleted": False, "error": "memory not found"}

    try:
        table = _lance_instances.get(agent_id) or _agent_table(agent_id)
        table.delete(f'id = "{memory_id}"')
    except Exception as e:
        log.warning(f"LanceDB delete failed: {e}")

    try:
        graph = _get_graph(agent_id)
        graph.remove_node(memory_id)
    except Exception:
        pass

    log.info(f"[forget] {memory_id[:8]} agent={agent_id}")
    return {"memory_id": memory_id, "deleted": True}


async def cmd_update(params: dict) -> dict:
    memory_id: str = params["memory_id"]
    new_content: str | None = params.get("content")
    new_metadata: dict | None = params.get("metadata")
    agent_id: str | None = params.get("agent_id") or _find_agent_for_memory(memory_id)

    if not new_content and not new_metadata:
        return {"memory_id": memory_id, "updated": False, "error": "no changes"}

    if not agent_id:
        return {"memory_id": memory_id, "updated": False, "error": "memory not found"}

    graph = _get_graph(agent_id)
    if memory_id not in graph.nodes and agent_id not in _lance_instances:
        return {"memory_id": memory_id, "updated": False, "error": "not found"}

    old_attrs = graph.nodes.get(memory_id, {})

    if new_content:
        vector = await _embed(new_content)
        if vector is None:
            vector = [0.0] * EMBED_DIM

        try:
            table = _lance_instances.get(agent_id) or _agent_table(agent_id)
            extraction = rule_extract(new_content)
            table.update(
                where=f'id = "{memory_id}"',
                values={
                    "text": new_content,
                    "tokens": " ".join(_tokenize_for_fts(new_content)),
                    "vector": vector,
                    "category": extraction.get("category", old_attrs.get("category", "other")),
                    "conversation_id": old_attrs.get("conversation_id", ""),
                    "importance": float(extraction.get("importance", old_attrs.get("importance", 0.5))),
                    "metadata_json": json.dumps(new_metadata or {}, ensure_ascii=False),
                },
            )
        except Exception as e:
            log.warning(f"LanceDB update failed: {e}")

        graph.update_node(memory_id, {
            "content": new_content,
            "category": extraction.get("category", old_attrs.get("category", "other")),
            "importance": extraction.get("importance", old_attrs.get("importance", 0.5)),
        })

    if new_metadata:
        attrs = dict(graph.nodes.get(memory_id, {}))
        attrs.update(new_metadata)
        graph.update_node(memory_id, attrs)

    log.info(f"[update] {memory_id[:8]} agent={agent_id}")
    return {"memory_id": memory_id, "updated": True}


MS_PER_DAY = 86_400_000.0


def _decay_score(
    importance: float,
    confidence: float,
    access_count: int,
    created_at: float,
    last_accessed_at: float,
    temporal_type: str,
    tier: str,
    now: float | None = None,
) -> dict:
    if now is None:
        now = datetime.now().timestamp() * 1000

    last_active = last_accessed_at if access_count > 0 else created_at
    days_since = max(0, (now - last_active) / MS_PER_DAY)

    base_hl = 30.0
    if temporal_type == "dynamic":
        base_hl = base_hl / 3.0
    effective_hl = base_hl * (2.71828 ** (1.5 * importance))
    lambda_val = 0.693147 / effective_hl

    beta_map = {"core": 0.8, "working": 1.0, "peripheral": 1.3}
    beta = beta_map.get(tier, 1.0)

    recency = 2.71828 ** (-lambda_val * (days_since ** beta))

    frequency = 1.0 - (2.71828 ** (-access_count / 5.0))
    if access_count > 1:
        access_span = max(1.0, (last_active - created_at) / MS_PER_DAY)
        avg_gap = access_span / max(access_count - 1, 1)
        recentness_bonus = 2.71828 ** (-avg_gap / 30.0)
        frequency = frequency * (0.5 + 0.5 * recentness_bonus)

    intrinsic = importance * confidence

    composite = 0.4 * recency + 0.3 * frequency + 0.3 * intrinsic

    floor_map = {"core": 0.9, "working": 0.7, "peripheral": 0.5}
    floor = floor_map.get(tier, 0.5)
    floor = max(floor, composite)

    return {
        "recency": round(recency, 4),
        "frequency": round(frequency, 4),
        "intrinsic": round(intrinsic, 4),
        "composite": round(composite, 4),
        "floor": round(floor, 4),
        "days_since": round(days_since, 1),
        "is_stale": composite < 0.3,
    }


def _tier_from_importance(importance: float) -> str:
    if importance >= 0.7:
        return "core"
    elif importance >= 0.4:
        return "working"
    return "peripheral"


# ============================================================================
# Compactor — Progressive Summarization
# ============================================================================

def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return max(0.0, min(1.0, dot / (norm_a * norm_b)))


def _fetch_for_compaction(
    table: "lancedb.table.LanceTable",
    cutoff_ts: float,
    limit: int,
) -> list[dict]:
    try:
        rows = (
            table.search()
            .where(f"timestamp < {cutoff_ts}")
            .limit(limit)
            .to_list()
        )
        return [r for r in rows if r.get("vector") and len(r.get("vector", [])) > 0]
    except Exception as e:
        log.warning(f"fetchForCompaction failed: {e}")
        return []


def _build_clusters(
    entries: list[dict],
    threshold: float,
    min_cluster_size: int,
) -> list[dict]:
    if len(entries) < min_cluster_size:
        return []

    order = sorted(range(len(entries)), key=lambda i: entries[i].get("importance", 0), reverse=True)
    assigned = [False] * len(entries)
    clusters = []

    for seed_idx in order:
        if assigned[seed_idx]:
            continue
        seed_vec = entries[seed_idx].get("vector", [])
        if not seed_vec:
            continue

        cluster = [seed_idx]
        assigned[seed_idx] = True

        for j in range(len(entries)):
            if assigned[j]:
                continue
            j_vec = entries[j].get("vector", [])
            if not j_vec:
                continue
            if _cosine_similarity(seed_vec, j_vec) >= threshold:
                cluster.append(j)
                assigned[j] = True

        if len(cluster) >= min_cluster_size:
            members_with_tier = []
            for idx in cluster:
                e = dict(entries[idx])
                e["_tier"] = _tier_from_importance(float(e.get("importance", 0.5)))
                members_with_tier.append(e)
            if any(m.get("_tier") == "core" for m in members_with_tier):
                continue
            clusters.append({"member_indices": cluster, "members": members_with_tier})

    return clusters


def _build_merged_entry(members: list[dict]) -> dict:
    seen = set()
    lines = []
    for m in members:
        for line in m.get("text", "").split("\n"):
            t = line.strip()
            if t and t.lower() not in seen:
                seen.add(t.lower())
                lines.append(t)

    text = "\n".join(lines)
    importance = min(1.0, max(m.get("importance", 0.5) for m in members))

    cat_counts: dict[str, int] = {}
    for m in members:
        c = m.get("category", "other")
        cat_counts[c] = cat_counts.get(c, 0) + 1
    category = max(cat_counts, key=cat_counts.get, default="other")

    original_count = sum(m.get("original_source_count", 1) for m in members)
    total_rounds = max(m.get("compaction_rounds", 0) for m in members) + 1

    return {
        "text": text,
        "importance": importance,
        "category": category,
        "scope": members[0].get("scope", "default"),
        "conversation_id": members[0].get("conversation_id", ""),
        "original_source_count": original_count,
        "compaction_rounds": total_rounds,
        "who": members[0].get("who", ""),
        "when": members[0].get("when", ""),
        "where": members[0].get("where", ""),
        "why": members[0].get("why", ""),
        "how": members[0].get("how", ""),
        "summary": text[:80],
        "confidence": min(1.0, max(m.get("confidence", 1.0) for m in members)),
        "temporal_type": members[0].get("temporal_type", "static"),
    }


async def cmd_compact(params: dict) -> dict:
    agent_id: str | None = params.get("agent_id")
    dry_run: bool = params.get("dry_run", True)
    limit: int = params.get("limit", DECAY_CONFIG["compactMaxMemoriesToScan"])
    scopes: list[str] | None = params.get("scopes")

    cfg = DECAY_CONFIG
    cutoff_days = cfg["compactMinAgeDays"]
    threshold = cfg["compactSimilarityThreshold"]
    min_cluster = cfg["compactMinClusterSize"]
    now_ts = datetime.now().timestamp()

    agents = [agent_id] if agent_id else [
        _dir_to_agent_id(d.name)
        for d in DATA_DIR.iterdir()
        if d.is_dir() and (d / "memories.lance").exists()
    ]

    total_clusters = 0
    total_deleted = 0
    total_created = 0
    compaction_rounds = cfg["maxCompactionRounds"]

    for aid in agents:
        try:
            table = _agent_table(aid)
            cutoff_ts = now_ts - cutoff_days * MS_PER_DAY
            entries = _fetch_for_compaction(table, cutoff_ts, limit)

            if not entries:
                continue

            clusters = _build_clusters(entries, threshold, min_cluster)
            total_clusters += len(clusters)

            if dry_run:
                continue

            for cluster in clusters:
                members = cluster["members"]
                merged = _build_merged_entry(members)

                try:
                    vector = await _embed(merged["text"])
                    if vector is None:
                        vector = [0.0] * EMBED_DIM
                except Exception:
                    vector = [0.0] * EMBED_DIM

                new_row = {
                    "id": str(uuid.uuid4()),
                    "text": merged["text"],
                    "tokens": " ".join(_tokenize_for_fts(merged["text"])),
                    "vector": vector,
                    "category": merged["category"],
                    "scope": merged["scope"],
                    "conversation_id": merged["conversation_id"],
                    "importance": float(merged["importance"]),
                    "timestamp": now_ts,
                    "stored_at": datetime.now().isoformat(),
                    "metadata_json": json.dumps({
                        "compacted": True,
                        "original_source_count": merged["original_source_count"],
                        "compaction_rounds": merged["compaction_rounds"],
                        "compactedAt": now_ts,
                    }, ensure_ascii=False),
                    "who": merged["who"],
                    "when": merged["when"],
                    "where": merged["where"],
                    "why": merged["why"],
                    "how": merged["how"],
                    "summary": merged["summary"],
                    "confidence": float(merged["confidence"]),
                    "temporal_type": merged["temporal_type"],
                    "access_count": 0,
                    "last_accessed_at": 0.0,
                    "compaction_rounds": merged["compaction_rounds"],
                    "last_compacted_at": now_ts,
                    "original_source_count": merged["original_source_count"],
                }
                table.add([new_row])
                total_created += 1

                for m in members:
                    try:
                        table.delete(f'id = "{m["id"]}"')
                        total_deleted += 1
                    except Exception as e:
                        log.warning(f"compact delete failed: {e}")

            log.info(f"[compact] agent={aid} clusters={len(clusters)} created={total_created} deleted={total_deleted}")

        except Exception as e:
            log.warning(f"compact failed for agent {aid}: {e}")

    return {
        "clusters_found": total_clusters,
        "memories_deleted": total_deleted,
        "memories_created": total_created,
        "dry_run": dry_run,
    }


# ============================================================================
# Decay scan + graph rebuild
# ============================================================================

async def cmd_graph_rebuild(params: dict) -> dict:
    agent_id: str | None = params.get("agent_id")

    agents = [agent_id] if agent_id else [
        _dir_to_agent_id(d.name)
        for d in DATA_DIR.iterdir()
        if d.is_dir() and (d / "memories.lance").exists()
    ]

    total_cleaned = 0
    total_rebuilt = 0

    for aid in agents:
        try:
            table = _agent_table(aid)
            graph = _get_graph(aid)
            rows = table.to_arrow()
            if rows.num_rows == 0:
                continue

            valid_ids = set(str(rows["id"][i].as_py()) for i in range(rows.num_rows))
            valid_conversations = set(
                str(rows["conversation_id"][i].as_py())
                for i in range(rows.num_rows)
                if rows["conversation_id"][i].as_py()
            )

            old_edge_count = len(graph.edges)
            graph.edges = [
                e for e in graph.edges
                if str(e.get("source") or e.get("from")) in valid_ids
                and str(e.get("target") or e.get("to")) in valid_ids
            ]
            dangling = old_edge_count - len(graph.edges)
            total_cleaned += dangling

            for i in range(rows.num_rows):
                mid = str(rows["id"][i].as_py())
                when_val = str(rows["when"][i].as_py() or "")
                where_val = str(rows["where"][i].as_py() or "")
                category = str(rows["category"][i].as_py() or "other")
                stored_at = str(rows["stored_at"][i].as_py() or "")
                conv_id = str(rows["conversation_id"][i].as_py() or "")
                scope = str(rows["scope"][i].as_py() or aid)

                if mid not in graph.nodes:
                    graph.add_node(mid, {
                        "content": str(rows["text"][i].as_py() or ""),
                        "category": category,
                        "agent_id": scope,
                        "conversation_id": conv_id,
                        "importance": float(rows["importance"][i].as_py() or 0.5),
                        "stored_at": stored_at,
                        "who": str(rows["who"][i].as_py() or ""),
                        "when": when_val,
                        "where": where_val,
                    })

                if conv_id and conv_id in valid_conversations:
                    graph.add_session_edge(mid, conv_id)

                if when_val and len(when_val) >= 2:
                    _add_temporal_edge(graph, mid, when_val, scope, stored_at)
                if where_val and len(where_val) >= 2:
                    _add_where_edge(graph, mid, where_val, stored_at)

                if category != "other":
                    graph.build_category_overlap(mid, category, stored_at)

            graph._save()
            total_rebuilt += 1

        except Exception as e:
            log.warning(f"graph rebuild failed for agent {aid}: {e}")

    return {
        "agents_rebuilt": total_rebuilt,
        "dangling_edges_cleaned": total_cleaned,
    }


async def cmd_decay_scan(params: dict) -> dict:
    agent_id: str | None = params.get("agent_id")
    dry_run: bool = params.get("dry_run", True)
    limit: int = params.get("limit", 50)
    also_compact: bool = params.get("also_compact", False)
    also_graph_rebuild: bool = params.get("also_graph_rebuild", False)

    cfg = DECAY_CONFIG
    stale_threshold = cfg["staleThreshold"]
    compact_delete_threshold = cfg["compactDeleteThreshold"]
    max_rounds = cfg["maxCompactionRounds"]
    now_ts_ms = datetime.now().timestamp() * 1000
    now_ts = datetime.now().timestamp()

    stale_memories: list[dict] = []
    deleted_count = 0
    compacted_count = 0

    agents = [agent_id] if agent_id else [
        _dir_to_agent_id(d.name)
        for d in DATA_DIR.iterdir()
        if d.is_dir() and (d / "memories.lance").exists()
    ]

    for aid in agents:
        try:
            table = _agent_table(aid)
            rows = table.to_arrow()
            if rows.num_rows == 0:
                continue

            data = rows.to_pydict()
            ids = data.get("id", [])
            importances = data.get("importance", [])
            confidences = data.get("confidence", [])
            access_counts = data.get("access_count", [])
            timestamps = data.get("timestamp", [])
            last_accessed = data.get("last_accessed_at", [])
            temporal_types = data.get("temporal_type", [])
            texts = data.get("text", [])
            compaction_rounds_list = data.get("compaction_rounds", [])

            for i in range(rows.num_rows):
                imp = float(importances[i] if i < len(importances) else 0.5)
                conf = float(confidences[i] if i < len(confidences) else 1.0)
                acc = int(access_counts[i] if i < len(access_counts) else 0)
                ts = float(timestamps[i] if i < len(timestamps) else 0)
                last = float(last_accessed[i] if i < len(last_accessed) else ts)
                tt = str(temporal_types[i] if i < len(temporal_types) else "static")
                tid = str(ids[i] if i < len(ids) else "")
                txt = str(texts[i] if i < len(texts) else "")
                rounds = int(compaction_rounds_list[i] if i < len(compaction_rounds_list) else 0)

                tier = _tier_from_importance(imp)
                score = _decay_score(imp, conf, acc, ts * 1000, last, tt, tier, now_ts_ms)

                if score["is_stale"]:
                    stale_memories.append({
                        "memory_id": tid,
                        "agent_id": aid,
                        "content_preview": txt[:60],
                        "importance": imp,
                        "confidence": conf,
                        "access_count": acc,
                        "days_since": score["days_since"],
                        "composite": score["composite"],
                        "compaction_rounds": rounds,
                        "tier": tier,
                    })

            stale_memories.sort(key=lambda x: x["composite"])
            stale_memories = stale_memories[:limit]

            if not dry_run:
                for mem in stale_memories:
                    rounds = mem["compaction_rounds"]
                    composite = mem["composite"]
                    mid = mem["memory_id"]
                    a = mem["agent_id"]

                    if mem.get("tier") == "core":
                        continue
                    should_delete = (
                        rounds >= max_rounds or composite < compact_delete_threshold
                    )

                    if should_delete:
                        try:
                            tbl = _agent_table(a)
                            tbl.delete(f'id = "{mid}"')
                            g = _get_graph(a)
                            g.remove_node(mid)
                            deleted_count += 1
                            log.info(f"[decay] deleted {mid[:8]} rounds={rounds} composite={composite:.3f}")
                        except Exception as e:
                            log.warning(f"decay delete failed: {e}")
                    elif also_compact:
                        try:
                            tbl = _agent_table(a)
                            tbl.delete(f'id = "{mid}"')
                            g = _get_graph(a)
                            g.remove_node(mid)
                            compacted_count += 1
                            log.info(f"[decay] compacted {mid[:8]} rounds={rounds}")
                        except Exception as e:
                            log.warning(f"decay compact delete failed: {e}")

            if also_graph_rebuild and not dry_run:
                try:
                    table2 = _agent_table(aid)
                    graph = _get_graph(aid)
                    rows2 = table2.to_arrow()
                    if rows2.num_rows > 0:
                        data2 = rows2.to_pydict()
                        valid_ids = set(str(data2["id"][i]) for i in range(rows2.num_rows))
                        graph.edges = [
                            e for e in graph.edges
                            if str(e.get("source") or e.get("from")) in valid_ids
                            and str(e.get("target") or e.get("to")) in valid_ids
                        ]
                        graph._save()
                        log.info(f"[decay] graph rebuilt for agent={aid}")
                except Exception as e:
                    log.warning(f"graph rebuild failed: {e}")

        except Exception as e:
            log.warning(f"decay scan failed for agent {aid}: {e}")

    return {
        "stale_count": len(stale_memories),
        "stale_memories": stale_memories[:20],
        "deleted": deleted_count,
        "compacted": compacted_count,
        "dry_run": dry_run,
    }


async def cmd_stats(params: dict) -> dict:
    agent_id: str | None = params.get("agent_id")

    if agent_id:
        try:
            table = _agent_table(agent_id)
            count = table.count_rows()
        except Exception:
            count = 0
        graph = _get_graph(agent_id)
        return {
            "memory_count": count,
            "bm25_doc_count": count,
            "lance_doc_count": count,
            "graph_node_count": graph.node_count(),
        }

    total_lance = 0
    total_graph = 0
    for subdir in DATA_DIR.iterdir():
        if not subdir.is_dir():
            continue
        lance_path = subdir / "memories.lance"
        if lance_path.exists():
            try:
                db = lancedb.connect(str(subdir))
                tbl = db.open_table("memories")
                total_lance += tbl.count_rows()
            except Exception:
                pass
        graph_path = subdir / "graph.json"
        if graph_path.exists():
            try:
                g = GraphStore(str(graph_path))
                total_graph += g.node_count()
            except Exception:
                pass

    return {
        "memory_count": total_lance,
        "bm25_doc_count": total_lance,
        "lance_doc_count": total_lance,
        "graph_node_count": total_graph,
    }


async def cmd_health(params: dict) -> dict:
    return {"status": "ok"}


async def cmd_ping(params: dict) -> dict:
    return {"pong": True}


METHODS = {
    "store": cmd_store,
    "recall": cmd_recall,
    "forget": cmd_forget,
    "update": cmd_update,
    "stats": cmd_stats,
    "compact": cmd_compact,
    "graph_rebuild": cmd_graph_rebuild,
    "decay_scan": cmd_decay_scan,
    "health": cmd_health,
    "ping": cmd_ping,
}


async def handle_request(req: dict) -> dict:
    method = req.get("method")
    params = req.get("params", {})
    req_id = req.get("id", 0)

    if method not in METHODS:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}

    try:
        result = await METHODS[method](params)
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    except Exception as e:
        log.error(f"{method} error: {e}")
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": str(e)}}


async def main():
    log.info("worker started")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            resp = {"jsonrpc": "2.0", "id": 0, "error": {"code": -32700, "message": "Parse error"}}
            print(json.dumps(resp), flush=True)
            continue

        result = await handle_request(req)
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
