"""
Qdrant Storage Module
"""
import logging
from typing import Any

from ..utils.ollama_client import OllamaEmbedding

log = logging.getLogger(__name__)


class MemoryStorage:
    """Qdrant-backed memory storage with Ollama embeddings"""

    def __init__(self, config: dict):
        self.config = config
        self.host = config.get("qdrant", {}).get("host", "localhost")
        self.port = config.get("qdrant", {}).get("port", 6333)
        self.collection = config.get("qdrant", {}).get("collection", "memory_recall")
        self.embedding_config = config.get("embedding", {})

        self.embedder = OllamaEmbedding(
            base_url=self.embedding_config.get("baseURL", "http://localhost:11434/v1"),
            model=self.embedding_config.get("model", "bge-m3")
        )

        self._client = None
        self._collection_initialized = False

    @property
    def client(self):
        if self._client is None:
            from qdrant_client import QdrantClient
            self._client = QdrantClient(host=self.host, port=self.port)
        return self._client

    async def init_collection(self) -> None:
        """Initialize Qdrant collection with vector config"""
        from qdrant_client.models import Distance, VectorParams

        if self._collection_initialized:
            return

        try:
            collections = self.client.get_collections().collections
            collection_names = [c.name for c in collections]

            if self.collection not in collection_names:
                vector_size = self.embedding_config.get("dimensions", 1024)
                self.client.create_collection(
                    collection_name=self.collection,
                    vectors_config=VectorParams(
                        size=vector_size,
                        distance=Distance.COSINE
                    )
                )
                log.info(f"Created collection: {self.collection}")
            else:
                log.info(f"Collection already exists: {self.collection}")

            self._collection_initialized = True

        except Exception as e:
            log.error(f"Failed to initialize collection: {e}")
            raise

    async def store(self, memory_record: dict) -> str:
        """Store a memory record with auto-embedding"""
        from qdrant_client.models import PointStruct

        memory_id = memory_record.get("id")
        content = memory_record.get("content", "")

        vector = memory_record.get("vector")
        if not vector:
            vector = await self.embedder.embed_single(content)

        payload = {k: v for k, v in memory_record.items() if k != "vector"}

        point_id = memory_id
        try:
            from uuid import UUID
            UUID(memory_id)
        except (ValueError, AttributeError):
            point_id = memory_id

        self.client.upsert(
            collection_name=self.collection,
            points=[
                PointStruct(
                    id=point_id,
                    vector=vector,
                    payload=payload
                )
            ]
        )

        return memory_id

    async def search(
        self,
        vector: list[float],
        limit: int = 10,
        score_threshold: float | None = None
    ) -> list[dict]:
        """Vector similarity search"""
        from qdrant_client.models import Filter, SearchParams

        search_params = {"limit": limit}
        if score_threshold:
            search_params["score_threshold"] = score_threshold

        results = self.client.search(
            collection_name=self.collection,
            query_vector=vector,
            **search_params
        )

        return [r.payload for r in results]

    async def scroll(self, limit: int = 1000, offset: str | None = None) -> tuple[list[dict], str | None]:
        """Scroll through all memories"""
        results = self.client.scroll(
            collection_name=self.collection,
            limit=limit,
            offset=offset,
            with_payload=True
        )

        if isinstance(results, tuple) and len(results) >= 2:
            points = results[0]
            next_page_offset = results[1]
        else:
            points = results
            next_page_offset = None

        return ([r.payload for r in points], next_page_offset)

    async def delete(self, memory_id: str) -> None:
        """Delete a memory"""
        self.client.delete(
            collection_name=self.collection,
            points_selector=[memory_id]
        )
