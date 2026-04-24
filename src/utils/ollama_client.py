"""
Ollama Embedding Client
"""
import httpx
import logging
from typing import Any

log = logging.getLogger(__name__)


class OllamaEmbedding:
    """Ollama embedding client for bge-m3 and other models"""

    def __init__(self, base_url: str = "http://localhost:11434", model: str = "bge-m3"):
        self.base_url = base_url.rstrip("/")
        self.model = model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for texts"""
        if not texts:
            return []

        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                embeddings = []
                for text in texts:
                    response = await client.post(
                        f"{self.base_url}/api/embeddings",
                        json={
                            "model": self.model,
                            "prompt": text
                        }
                    )
                    response.raise_for_status()
                    data = response.json()
                    emb = data.get("embedding", [])
                    if emb:
                        embeddings.append(emb)

                return embeddings

            except httpx.HTTPError as e:
                log.error(f"HTTP error during embedding: {e}")
                return []

    async def embed_single(self, text: str) -> list[float]:
        """Generate embedding for single text"""
        results = await self.embed([text])
        return results[0] if results else []

    async def embed_query(self, query: str) -> list[float]:
        """Generate embedding optimized for query/search"""
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                response = await client.post(
                    f"{self.base_url}/api/embeddings",
                    json={
                        "model": self.model,
                        "prompt": query
                    }
                )
                response.raise_for_status()
                data = response.json()

                if isinstance(data, dict) and "embedding" in data:
                    return data["embedding"]
                else:
                    return await self.embed_single(query)

            except Exception as e:
                log.error(f"Query embedding failed: {e}")
                return await self.embed_single(query)
