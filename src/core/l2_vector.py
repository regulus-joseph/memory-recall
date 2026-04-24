"""
L2 Vector Matcher
Semantic similarity using Ollama embeddings
"""
import logging
from typing import Any

from ..utils.ollama_client import OllamaEmbedding

log = logging.getLogger(__name__)


class VectorMatcher:
    """L2: Vector similarity matching via Ollama embeddings"""

    def __init__(self, config: dict):
        self.config = config
        self.embedding_config = config.get("embedding", {})

        self.embedder = OllamaEmbedding(
            base_url=self.embedding_config.get("baseURL", "http://localhost:11434/v1"),
            model=self.embedding_config.get("model", "bge-m3")
        )

    async def match(
        self,
        query: str,
        candidates: list[dict],
        top_k: int = 10
    ) -> list[tuple[str, float]]:
        """
        Match query against candidates by vector similarity
        Returns: list of (memory_id, cosine_similarity)
        """
        if not candidates:
            return []

        try:
            query_emb = await self.embedder.embed_query(query)
            if not query_emb:
                return [(c["id"], 0.5) for c in candidates[:top_k]]

            contents = [c.get("content", "") for c in candidates]
            candidate_embs = await self.embedder.embed(contents)

            if not candidate_embs:
                return [(c["id"], 0.5) for c in candidates[:top_k]]

            similarities = []
            for i, mem in enumerate(candidates):
                sim = self._cosine_similarity(query_emb, candidate_embs[i])
                similarities.append((mem["id"], sim))

            similarities.sort(key=lambda x: x[1], reverse=True)
            return similarities[:top_k]

        except Exception as e:
            log.error(f"Vector matching failed: {e}")
            return [(c["id"], 0.5) for c in candidates[:top_k]]

    def _cosine_similarity(self, vec1: list[float], vec2: list[float]) -> float:
        dot = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = sum(a * a for a in vec1) ** 0.5
        norm2 = sum(b * b for b in vec2) ** 0.5
        if norm1 == 0 or norm2 == 0:
            return 0.0
        return dot / (norm1 * norm2)
