#!/usr/bin/env python3
"""
L1/L2 Hit Rate Test Script
"""
import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.core.storage import MemoryStorage
from src.core.matcher import MemoryMatcher
from src.core.l1_keyword import KeywordMatcher
from src.core.extractor import EntityExtractor


TEST_MEMORIES = [
    {
        "id": str(uuid.uuid4()),
        "content": "用户讨论了购买苹果股票，AAPL，当前价格是150美元",
        "agent_id": "test",
        "user_id": "user1"
    },
    {
        "id": str(uuid.uuid4()),
        "content": "上次会议决定使用Python来开发后端服务，使用FastAPI框架",
        "agent_id": "test",
        "user_id": "user1"
    },
    {
        "id": str(uuid.uuid4()),
        "content": "用户想了解量子计算的基本原理，特别是量子纠缠",
        "agent_id": "test",
        "user_id": "user2"
    },
    {
        "id": str(uuid.uuid4()),
        "content": "项目使用Docker容器化部署，数据库用PostgreSQL",
        "agent_id": "test",
        "user_id": "user1"
    },
    {
        "id": str(uuid.uuid4()),
        "content": "用户住在上海浦东，喜欢在周末去健身房锻炼",
        "agent_id": "test",
        "user_id": "user2"
    },
]

TEST_QUERIES = [
    ("想买股票", "L1: 股票"),
    ("Python开发", "L1: Python"),
    ("上海用户", "L1: 上海"),
    ("Docker部署", "L1: Docker"),
    ("量子物理", "L2: 语义相似"),
    ("运动健身", "L2: 语义相似"),
    ("fastapi服务", "L2: 语义相关"),
    ("健身地点", "L2: 语义相关"),
]


async def setup_test_data(config):
    """Store test memories"""
    storage = MemoryStorage(config)
    await storage.init_collection()

    print("Storing test memories...")
    for mem in TEST_MEMORIES:
        await storage.store(mem)
    print(f"Stored {len(TEST_MEMORIES)} memories\n")


async def test_l1(config):
    """Test L1 keyword matching"""
    print("=" * 50)
    print("L1 KEYWORD MATCHING TEST")
    print("=" * 50)

    storage = MemoryStorage(config)
    await storage.init_collection()

    candidates, _ = await storage.scroll(limit=1000)
    if not isinstance(candidates, list):
        candidates = []
    matcher = KeywordMatcher()

    for query, desc in TEST_QUERIES:
        if "L1" not in desc:
            continue

        matches = matcher.match(query, candidates)
        print(f"\nQuery: '{query}' ({desc})")
        print(f"  Matches: {len(matches)}")
        for mem_id, score in matches[:3]:
            mem = next((c for c in candidates if c["id"] == mem_id), None)
            if mem:
                print(f"  - [{score:.3f}] {mem['content'][:60]}...")


async def test_l2(config):
    """Test L2 vector matching"""
    print("\n" + "=" * 50)
    print("L2 VECTOR MATCHING TEST")
    print("=" * 50)

    matcher = MemoryMatcher(config)

    for query, desc in TEST_QUERIES:
        if "L2" not in desc:
            continue

        results = await matcher.recall(query, max_results=3)
        print(f"\nQuery: '{query}' ({desc})")
        print(f"  Matches: {len(results)}")
        for mem in results:
            print(f"  - [{mem.get('relevance_score', 0):.3f}] {mem.get('content', '')[:60]}...")


async def test_combined(config):
    """Test L1+L2 cascade"""
    print("\n" + "=" * 50)
    print("L1 + L2 COMBINED TEST")
    print("=" * 50)

    matcher = MemoryMatcher(config)

    test_queries = [
        "股票投资",
        "Python编程",
        "健身运动",
        "Docker容器",
        "量子计算",
        "上海浦东",
    ]

    for query in test_queries:
        results = await matcher.recall(query, max_results=5)
        print(f"\nQuery: '{query}'")
        print(f"  Total matches: {len(results)}")
        for mem in results:
            score = mem.get("relevance_score", 0)
            content = mem.get("content", "")[:50]
            print(f"  - [{score:.3f}] {content}...")


async def main():
    config = {
        "embedding": {
            "baseURL": "http://localhost:11434",
            "model": "bge-m3",
            "dimensions": 1024
        },
        "qdrant": {
            "host": "localhost",
            "port": 6333,
            "collection": "memory_recall_test"
        },
        "l1": {"enabled": True, "minScore": 0.0},
        "l2": {"enabled": True},
        "l3": {"enabled": False}
    }

    await setup_test_data(config)
    await test_l1(config)
    await test_l2(config)
    await test_combined(config)


if __name__ == "__main__":
    asyncio.run(main())