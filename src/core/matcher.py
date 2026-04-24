"""
Memory Matcher - Orchestrates L1/L2/L3 Cascade
"""
import logging
from typing import Any

from .l1_keyword import KeywordMatcher
from .l2_vector import VectorMatcher
from .l3_graph import GraphMatcher

log = logging.getLogger(__name__)


class MemoryMatcher:
    """Cascading L1/L2/L3 memory recall"""

    def __init__(self, config: dict):
        self.config = config
        self.l1_config = config.get("l1", {})
        self.l2_config = config.get("l2", {})
        self.l3_config = config.get("l3", {})

        self.l1 = KeywordMatcher()
        self.l2 = VectorMatcher(config)
        self.l3 = GraphMatcher(config)

        self.qdrant_host = config.get("qdrant", {}).get("host", "localhost")
        self.qdrant_port = config.get("qdrant", {}).get("port", 6333)
        self.collection = config.get("qdrant", {}).get("collection", "memory_recall")

    async def recall(
        self,
        query: str,
        session_messages: list[dict] | None = None,
        max_results: int = 10
    ) -> list[dict]:
        """
        Execute L1/L2/L3 cascade recall
        Returns list of relevant memory records
        """
        candidates = await self._fetch_all_candidates()

        if not candidates:
            log.info("No memory candidates found")
            return []

        log.info(f"Fetched {len(candidates)} candidates from storage")

        l1_results = self._l1_filter(query, candidates)
        log.info(f"L1 keyword match: {len(l1_results)} candidates")

        l2_results = await self._l2_rank(query, l1_results)
        log.info(f"L2 vector rank: {len(l2_results)} candidates")

        l2_best_score = l2_results[0][1] if l2_results else 0.0

        if self.l3.should_trigger_l3(l2_best_score):
            log.info("L3 triggered (low L2 confidence)")
            final_results = await self._l3_expand(l2_results, candidates)
        else:
            final_results = l2_results

        return self._format_results(final_results, candidates, max_results)

    def _l1_filter(self, query: str, candidates: list[dict]) -> list[dict]:
        """L1: Keyword filtering"""
        if not self.l1_config.get("enabled", True):
            return candidates

        min_score = self.l1_config.get("minScore", 0.0)
        matches = self.l1.match(query, candidates)

        seen_ids = set()
        results = []
        for mid, score in matches:
            if mid in seen_ids:
                continue
            seen_ids.add(mid)
            if score >= min_score:
                for c in candidates:
                    if c["id"] == mid:
                        results.append(c)
                        break

        return results

    async def _l2_rank(self, query: str, candidates: list[dict]) -> list[tuple[str, float]]:
        """L2: Vector similarity ranking"""
        if not self.l2_config.get("enabled", True) or not candidates:
            return [(c["id"], 0.5) for c in candidates]

        try:
            return await self.l2.match(query, candidates)
        except Exception as e:
            log.error(f"L2 matching failed: {e}")
            return [(c["id"], 0.5) for c in candidates]

    async def _l3_expand(
        self,
        l2_results: list[tuple[str, float]],
        candidates: list[dict]
    ) -> list[tuple[str, float]]:
        """L3: Graph-based expansion (only triggered when L2 confidence is low)"""
        if not self.l3_config.get("enabled", True):
            return l2_results

        candidate_dict = {c["id"]: c for c in candidates}
        candidate_ids = [mid for mid, _ in l2_results]

        try:
            return await self.l3.match(
                query="",
                candidate_ids=candidate_ids,
                memory_store=candidate_dict
            )
        except Exception as e:
            log.error(f"L3 matching failed: {e}")
            return l2_results

    async def _fetch_all_candidates(self) -> list[dict]:
        """Fetch all memories from Qdrant"""
        try:
            from qdrant_client import QdrantClient

            client = QdrantClient(host=self.qdrant_host, port=self.qdrant_port)

            all_candidates = []
            offset = None
            while True:
                results, next_offset = client.scroll(
                    collection_name=self.collection,
                    limit=1000,
                    offset=offset,
                    with_payload=True
                )

                if results:
                    all_candidates.extend([r.payload for r in results])

                if not next_offset:
                    break
                offset = next_offset

            return all_candidates

        except Exception as e:
            log.error(f"Failed to fetch from Qdrant: {e}")
            return []

    def _format_results(
        self,
        ranked_results: list[tuple[str, float]],
        candidates: list[dict],
        max_results: int
    ) -> list[dict]:
        """Format final results"""
        candidate_dict = {c["id"]: c for c in candidates}
        formatted = []

        for mem_id, score in ranked_results[:max_results]:
            mem = candidate_dict.get(mem_id)
            if mem:
                mem["relevance_score"] = score
                formatted.append(mem)

        return formatted
