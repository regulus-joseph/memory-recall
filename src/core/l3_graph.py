"""
L3 Graph Matcher
Associative reasoning via graph traversal
"""
import logging
from typing import Any

log = logging.getLogger(__name__)


class GraphMatcher:
    """L3: Graph-based associative matching"""

    def __init__(self, config: dict):
        self.config = config
        self.threshold = config.get("l3", {}).get("triggerThreshold", 0.6)

    async def match(
        self,
        query: str,
        candidate_ids: list[str],
        memory_store: dict[str, dict],
        top_k: int = 5
    ) -> list[tuple[str, float]]:
        """
        Graph-based expansion of candidate memories
        Returns: list of (memory_id, association_score)
        """
        if len(candidate_ids) < 2:
            return [(cid, 1.0) for cid in candidate_ids]

        graph_scores = {}
        for mem_id in candidate_ids:
            memory = memory_store.get(mem_id, {})
            edges = memory.get("graph_edges", [])

            if not edges:
                graph_scores[mem_id] = 0.3
                continue

            connected_ids = set()
            for edge in edges:
                source = edge.get("source")
                target = edge.get("target")
                relation = edge.get("relation", "")
                confidence = edge.get("confidence", "INFERRED")

                if source == mem_id and target:
                    connected_ids.add(target)
                elif target == mem_id and source:
                    connected_ids.add(source)

                if confidence == "EXTRACTED":
                    graph_scores[mem_id] = graph_scores.get(mem_id, 0) + 0.3
                elif confidence == "INFERRED":
                    graph_scores[mem_id] = graph_scores.get(mem_id, 0) + 0.1

            if connected_ids:
                for connected_id in connected_ids:
                    graph_scores[connected_id] = graph_scores.get(connected_id, 0) + 0.2

        results = sorted(graph_scores.items(), key=lambda x: x[1], reverse=True)
        return results[:top_k]

    def should_trigger_l3(self, l2_max_score: float) -> bool:
        """Check if L3 should be triggered based on L2 score"""
        return l2_max_score < self.threshold
