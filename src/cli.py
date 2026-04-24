"""
Memory Recall CLI Tool
Usage: python -m memory_recall.cli [command]
"""
import asyncio
import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.core.storage import MemoryStorage
from src.core.matcher import MemoryMatcher
from src.core.extractor import EntityExtractor

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


async def init_cmd(config: dict):
    """Initialize Qdrant collection"""
    storage = MemoryStorage(config)
    await storage.init_collection()
    print("Collection initialized successfully")


async def store_cmd(config: dict, content: str, agent_id: str, user_id: str):
    """Store a memory"""
    import uuid
    from src.utils.ollama_client import OllamaEmbedding

    storage = MemoryStorage(config)
    await storage.init_collection()

    extractor = EntityExtractor()
    entities = extractor.extract(content)

    embedder = OllamaEmbedding(
        base_url=config.get("embedding", {}).get("baseURL", "http://localhost:11434/v1"),
        model=config.get("embedding", {}).get("model", "bge-m3")
    )
    vector = await embedder.embed_single(content)

    memory_record = {
        "id": str(uuid.uuid4()),
        "conversation_id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "user_id": user_id,
        "timestamp": asyncio.get_event_loop().time(),
        "content": content,
        "entities": entities,
        "vector": vector,
        "confidence": "EXTRACTED",
        "access_count": 0,
        "importance": 0.5,
    }

    memory_id = await storage.store(memory_record)
    print(f"Stored memory: {memory_id}")


async def recall_cmd(config: dict, query: str, max_results: int = 5):
    """Recall relevant memories"""
    matcher = MemoryMatcher(config)
    results = await matcher.recall(query, max_results=max_results)

    if not results:
        print("No relevant memories found")
        return

    print(f"\nFound {len(results)} relevant memories:\n")
    for i, mem in enumerate(results, 1):
        print(f"{i}. [{mem.get('agent_id', 'unknown')}]")
        print(f"   {mem.get('content', '')[:200]}")
        print(f"   Score: {mem.get('relevance_score', 0):.3f}")
        print()


async def search_cmd(config: dict, keyword: str):
    """Search memories by keyword"""
    storage = MemoryStorage(config)
    await storage.init_collection()

    candidates, _ = await storage.scroll(limit=1000)
    matcher = MemoryMatcher(config)

    from src.core.l1_keyword import KeywordMatcher
    km = KeywordMatcher()
    matches = km.match(keyword, candidates)

    print(f"Found {len(matches)} matches for '{keyword}':\n")
    for mem_id, score in matches[:10]:
        mem = next((c for c in candidates if c["id"] == mem_id), None)
        if mem:
            print(f"- {mem.get('content', '')[:100]} (score: {score:.3f})")


def main():
    parser = argparse.ArgumentParser(description="Memory Recall CLI")
    parser.add_argument("--config", default="config.json", help="Config file path")

    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("init", help="Initialize collection")

    store_parser = subparsers.add_parser("store", help="Store a memory")
    store_parser.add_argument("--content", required=True, help="Memory content")
    store_parser.add_argument("--agent-id", default="cli", help="Agent ID")
    store_parser.add_argument("--user-id", default="cli", help="User ID")

    recall_parser = subparsers.add_parser("recall", help="Recall memories")
    recall_parser.add_argument("--query", required=True, help="Query")
    recall_parser.add_argument("--max", type=int, default=5, help="Max results")

    search_parser = subparsers.add_parser("search", help="Search by keyword")
    search_parser.add_argument("--keyword", required=True, help="Keyword")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    config = {}
    config_path = Path(args.config)
    if config_path.exists():
        with open(config_path) as f:
            config = json.load(f)

    if args.command == "init":
        asyncio.run(init_cmd(config))
    elif args.command == "store":
        asyncio.run(store_cmd(config, args.content, args.agent_id, args.user_id))
    elif args.command == "recall":
        asyncio.run(recall_cmd(config, args.query, args.max))
    elif args.command == "search":
        asyncio.run(search_cmd(config, args.keyword))


if __name__ == "__main__":
    main()
