"""
Qdrant Storage - fixed version
- scroll returns point IDs (not just payload)
- delete uses correct PointIdsList format
- connection pooling
"""
import json
import logging
from typing import Any

import httpx

log = logging.getLogger("qdrant-store")


class QdrantStore:
    def __init__(
        self,
        host: str = "localhost",
        port: int = 6333,
        collection: str = "memory_recall",
        embedding_url: str = "http://localhost:11434/api/embeddings",
        embedding_model: str = "bge-m3",
        embedding_dim: int = 1024,
    ):
        self.host = host
        self.port = port
        self.collection = collection
        self.embedding_url = embedding_url
        self.embedding_model = embedding_model
        self.embedding_dim = embedding_dim
        self.base_url = f"http://{host}:{port}"
        self._initialized = False
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self._client

    async def init(self) -> None:
        if self._initialized:
            return
        try:
            client = await self._get_client()
            resp = await client.get(f"{self.base_url}/collections/{self.collection}")
            if resp.status_code == 200:
                log.info(f"Collection '{self.collection}' already exists")
                self._initialized = True
                return

            from qdrant_client.models import Distance, VectorParams
            create_payload = {
                "vectors": {
                    "size": self.embedding_dim,
                    "distance": "Cosine",
                }
            }
            resp = await client.put(
                f"{self.base_url}/collections/{self.collection}",
                json={"vectors": create_payload["vectors"]},
            )
            if resp.status_code in (200, 201):
                log.info(f"Created collection '{self.collection}'")
                self._initialized = True
            else:
                log.warning(f"Failed to create collection: {resp.text}")
                self._initialized = True

        except Exception as e:
            log.warning(f"Qdrant init failed (non-fatal): {e}")
            self._initialized = True

    def build_enhanced_text(self, content: str, six_w: dict) -> str:
        parts = [f"原文: {content}"]
        six_w_labels = {
            "who": "人物", "what": "事件", "when": "时间",
            "where": "地点", "why": "原因", "how": "方式"
        }
        for key, label in six_w_labels.items():
            val = six_w.get(key, "")
            if val:
                parts.append(f"{label}: {val}")
        return " | ".join(parts)

    async def embed(self, text: str) -> list[float]:
        try:
            client = await self._get_client()
            resp = await client.post(
                self.embedding_url,
                json={"model": self.embedding_model, "prompt": text},
            )
            resp.raise_for_status()
            data = resp.json()
            emb = data.get("embedding", [])
            if emb and len(emb) == self.embedding_dim:
                return emb
            return []
        except Exception as e:
            log.error(f"Embedding failed: {e}")
            return []

    async def embed_enhanced(self, content: str, six_w: dict) -> list[float]:
        text = self.build_enhanced_text(content, six_w)
        return await self.embed(text)

    async def check_duplicate(self, content: str, agent_id: str) -> str | None:
        client = await self._get_client()
        resp = await client.post(
            f"{self.base_url}/collections/{self.collection}/points/scroll",
            json={
                "filter": {"must": [{"key": "agent_id", "match": {"value": agent_id}}]},
                "with_payload": True,
                "limit": 200,
            },
        )
        resp.raise_for_status()
        for p in resp.json().get("result", {}).get("points", []):
            if p.get("payload", {}).get("content") == content:
                return p["id"]
        return None

    async def upsert(self, memory_id: str, vector: list[float], payload: dict) -> str:
        client = await self._get_client()
        point = {
            "id": memory_id,
            "vector": vector,
            "payload": payload,
        }
        resp = await client.put(
            f"{self.base_url}/collections/{self.collection}/points",
            json={"points": [point]},
        )
        resp.raise_for_status()
        return memory_id

    async def vector_search(
        self, query: str, limit: int = 10, score_threshold: float = 0.0, filter_agent_id: str | None = None
    ) -> list[dict]:
        vector = await self.embed(query)
        if not vector:
            return []

        client = await self._get_client()
        search_body: dict[str, Any] = {
            "vector": vector,
            "limit": limit,
            "with_payload": True,
        }
        if score_threshold > 0:
            search_body["score_threshold"] = score_threshold
        if filter_agent_id:
            search_body["filter"] = {
                "must": [{"key": "agent_id", "match": {"value": filter_agent_id}}]
            }

        resp = await client.post(
            f"{self.base_url}/collections/{self.collection}/points/search",
            json=search_body,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("result", [])

        memories = []
        for r in results:
            mem = dict(r.get("payload", {}))
            mem["id"] = r.get("id")
            mem["score"] = r.get("score", 0)
            memories.append(mem)
        return memories

    async def scroll(self, limit: int = 1000) -> tuple[list[dict], list[str]]:
        client = await self._get_client()
        all_points: list[dict] = []
        all_ids: list[str] = []
        offset: str | None = None

        while True:
            body: dict[str, Any] = {
                "collection_name": self.collection,
                "limit": min(limit, 256),
                "with_payload": True,
            }
            if offset:
                body["offset"] = offset

            resp = await client.post(
                f"{self.base_url}/collections/{self.collection}/points/scroll",
                json=body,
            )

            if resp.status_code != 200:
                log.error(f"Scroll failed: {resp.text}")
                break

            data = resp.json()
            points = data.get("result", {}).get("points", [])
            next_page_offset = data.get("result", {}).get("next_page_offset")

            for p in points:
                mem = dict(p.get("payload", {}))
                mem["id"] = p.get("id")
                all_points.append(mem)
                all_ids.append(str(p.get("id")))

            if not next_page_offset:
                break
            offset = next_page_offset

        return all_points, all_ids

    async def fetch_by_ids(self, memory_ids: list[str]) -> list[dict]:
        if not memory_ids:
            return []
        client = await self._get_client()
        resp = await client.post(
            f"{self.base_url}/collections/{self.collection}/points",
            json={"ids": memory_ids, "with_payload": True},
        )
        if resp.status_code not in (200, 201):
            log.warning(f"fetch_by_ids failed: {resp.status_code} {resp.text[:200]}")
            return []
        data = resp.json()
        points = data.get("result", [])
        memories = []
        for p in points:
            if p:
                mem = dict(p.get("payload", {}))
                mem["id"] = p.get("id")
                memories.append(mem)
        return memories

    async def delete(self, memory_id: str) -> None:
        from qdrant_client.models import PointIdsList

        client = await self._get_client()
        resp = await client.post(
            f"{self.base_url}/collections/{self.collection}/points/delete",
            json={"points": [memory_id]},
        )
        if resp.status_code not in (200, 201):
            log.error(f"Delete failed: {resp.text}")

    async def count(self) -> int:
        client = await self._get_client()
        resp = await client.post(
            f"{self.base_url}/collections/{self.collection}/points/count",
            json={"exact": True},
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("result", {}).get("count", 0)
        return 0
        return 0

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
