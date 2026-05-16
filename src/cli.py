"""
Memory Recall CLI Tool - LanceDB backend
Usage: python src/cli.py [command]
"""
import asyncio
import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.core.matcher import MemoryMatcher
from src.core.extractor import EntityExtractor
from src.utils.ollama_client import OllamaEmbedding

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

DATA_DIR = Path.home() / ".memory-recall" / "data"
EMBED_DIM = 1024


def _agent_db_path(agent_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", agent_id)
    return DATA_DIR / safe


async def init_cmd(agent_id: str = "cli"):
    """Initialize LanceDB collection for an agent"""
    import lancedb
    import pyarrow as pa

    db_path = _agent_db_path(agent_id)
    db_path.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(db_path))

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

    if "memories" not in db.table_names():
        table = db.create_table("memories", schema=SCHEMA)
        try:
            table.create_fts_index("tokens")
            log.info(f"FTS index created for agent={agent_id}")
        except Exception as e:
            log.warning(f"FTS index creation failed: {e}")
        print(f"Collection initialized for agent '{agent_id}'")
    else:
        print(f"Collection already exists for agent '{agent_id}'")


async def store_cmd(content: str, agent_id: str = "cli", user_id: str = "cli"):
    """Store a memory in LanceDB"""
    import uuid
    import pyarrow as pa
    import lancedb
    from datetime import datetime

    db_path = _agent_db_path(agent_id)
    db_path.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(db_path))

    if "memories" not in db.table_names():
        await init_cmd(agent_id)
        db = lancedb.connect(str(db_path))

    table = db.open_table("memories")

    extractor = EntityExtractor()
    entities = extractor.extract(content)

    embedder = OllamaEmbedding(
        base_url="http://localhost:11434",
        model="bge-m3"
    )
    vector = await embedder.embed_single(content)

    memory_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    import jieba
    tokens = " ".join(list(jieba.cut(content)))

    record = {
        "id": memory_id,
        "text": content,
        "tokens": tokens,
        "vector": vector,
        "category": entities.get("category", "other"),
        "scope": agent_id,
        "conversation_id": str(uuid.uuid4()),
        "importance": 0.5,
        "timestamp": asyncio.get_event_loop().time(),
        "stored_at": now,
        "metadata_json": json.dumps(entities),
        "who": entities.get("who", ""),
        "when": entities.get("when", ""),
        "where": entities.get("where", ""),
        "why": entities.get("why", ""),
        "how": entities.get("how", ""),
        "summary": entities.get("summary", ""),
        "confidence": 0.5,
        "temporal_type": "static",
        "access_count": 0,
        "last_accessed_at": 0.0,
        "compaction_rounds": 0,
        "last_compacted_at": 0.0,
        "original_source_count": 1,
    }

    table.add([record])
    print(f"Stored memory: {memory_id}")
    return memory_id


async def recall_cmd(query: str, agent_id: str = "cli", max_results: int = 5):
    """Recall relevant memories from LanceDB"""
    import lancedb

    db_path = _agent_db_path(agent_id)
    if not db_path.exists():
        print(f"No data for agent '{agent_id}'")
        return

    db = lancedb.connect(str(db_path))
    if "memories" not in db.table_names():
        print(f"No memories collection for agent '{agent_id}'")
        return

    table = db.open_table("memories")

    embedder = OllamaEmbedding(
        base_url="http://localhost:11434",
        model="bge-m3"
    )
    query_vector = await embedder.embed_single(query)

    try:
        results = table.search(query_vector, vector_column_name="vector").limit(max_results).to_list()
    except Exception as e:
        log.error(f"Search failed: {e}")
        results = []

    if not results:
        print("No relevant memories found")
        return

    print(f"\nFound {len(results)} relevant memories:\n")
    for i, mem in enumerate(results, 1):
        print(f"{i}. [{mem.get('scope', 'unknown')}]")
        print(f"   {mem.get('text', '')[:200]}")
        print(f"   Score: {mem.get('_distance', 0):.3f}")
        print()


async def search_cmd(keyword: str, agent_id: str = "cli"):
    """Search memories by keyword"""
    import lancedb

    db_path = _agent_db_path(agent_id)
    if not db_path.exists():
        print(f"No data for agent '{agent_id}'")
        return

    db = lancedb.connect(str(db_path))
    if "memories" not in db.table_names():
        print(f"No memories collection for agent '{agent_id}'")
        return

    table = db.open_table("memories")

    try:
        results = table.search(keyword, columns=["text"]).limit(20).to_list()
    except Exception as e:
        log.error(f"Search failed: {e}")
        results = []

    if not results:
        print(f"No matches for '{keyword}'")
        return

    print(f"Found {len(results)} matches for '{keyword}':\n")
    for mem in results[:10]:
        print(f"- {mem.get('text', '')[:100]} (score: {mem.get('_distance', 0):.3f})")


def main():
    parser = argparse.ArgumentParser(description="Memory Recall CLI - LanceDB backend")
    parser.add_argument("--agent-id", default="cli", help="Agent ID (default: cli)")
    parser.add_argument("--config", default=None, help="Config file (unused, for compatibility)")

    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("init", help="Initialize collection")

    store_parser = subparsers.add_parser("store", help="Store a memory")
    store_parser.add_argument("--content", required=True, help="Memory content")
    store_parser.add_argument("--agent-id", default="cli", help="Agent ID")
    store_parser.add_argument("--user-id", default="cli", help="User ID")

    recall_parser = subparsers.add_parser("recall", help="Recall memories")
    recall_parser.add_argument("--query", required=True, help="Query")
    recall_parser.add_argument("--agent-id", default="cli", help="Agent ID")
    recall_parser.add_argument("--max", type=int, default=5, help="Max results")

    search_parser = subparsers.add_parser("search", help="Search by keyword")
    search_parser.add_argument("--query", required=True, help="Keyword")
    search_parser.add_argument("--agent-id", default="cli", help="Agent ID")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    agent_id = getattr(args, 'agent_id', 'cli')

    if args.command == "init":
        asyncio.run(init_cmd(agent_id))
    elif args.command == "store":
        asyncio.run(store_cmd(args.content, args.agent_id, args.user_id))
    elif args.command == "recall":
        asyncio.run(recall_cmd(args.query, args.agent_id, args.max))
    elif args.command == "search":
        asyncio.run(search_cmd(args.query, args.agent_id))


if __name__ == "__main__":
    main()