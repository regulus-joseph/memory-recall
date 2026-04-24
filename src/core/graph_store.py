"""
Memory Graph Store - lightweight graph using networkx
File-based persistence: memory_graph.json
L3 graph expansion + co-occurrence edge building
"""
import json
import logging
from collections import defaultdict
from pathlib import Path
from typing import Any

log = logging.getLogger("graph-store")

GRAPHIFY_AVAILABLE = False
try:
    import networkx as nx
    from networkx.algorithms import community
    GRAPHIFY_AVAILABLE = True
except ImportError:
    nx = None
    community = None

logging.getLogger("networkx").setLevel(logging.WARNING)


class GraphStore:
    def __init__(self, graph_file: str):
        self.graph_file = Path(graph_file)
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.cooccurrence: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.session_buckets: dict[str, list[str]] = defaultdict(list)
        self._graph = None
        self._load()

    def _load(self) -> None:
        if self.graph_file.exists():
            try:
                with open(self.graph_file) as f:
                    data = json.load(f)
                    self.nodes = data.get("nodes", {})
                    self.edges = data.get("edges", [])
                    cooc = data.get("cooccurrence", {})
                    for src, targets in cooc.items():
                        for tgt, count in targets.items():
                            self.cooccurrence[src][tgt] = count
                    self.session_buckets = defaultdict(list, data.get("session_buckets", {}))
                log.info(f"Loaded graph: {len(self.nodes)} nodes, {len(self.edges)} edges")
            except Exception as e:
                log.warning(f"Failed to load graph: {e}")
        self._build_nx_graph()

    def _save(self) -> None:
        try:
            cooc_serializable = {
                src: dict(targets) for src, targets in self.cooccurrence.items()
            }
            with open(self.graph_file, "w") as f:
                json.dump(
                    {
                        "nodes": self.nodes,
                        "edges": self.edges,
                        "cooccurrence": cooc_serializable,
                        "session_buckets": dict(self.session_buckets),
                    },
                    f,
                    ensure_ascii=False,
                )
        except Exception as e:
            log.error(f"Failed to save graph: {e}")

    def _build_nx_graph(self) -> None:
        if not GRAPHIFY_AVAILABLE or nx is None:
            self._graph = None
            return
        G = nx.DiGraph()
        for node_id, attrs in self.nodes.items():
            G.add_node(node_id, **(attrs or {}))
        for edge in self.edges:
            src = edge.get("source") or edge.get("from")
            tgt = edge.get("target") or edge.get("to")
            if src and tgt:
                G.add_edge(src, tgt, **edge)
        self._graph = G

    def add_node(self, memory_id: str, attrs: dict) -> None:
        self.nodes[memory_id] = {
            "content": attrs.get("content", ""),
            "category": attrs.get("category", "other"),
            "agent_id": attrs.get("agent_id", ""),
            "conversation_id": attrs.get("conversation_id", ""),
            "importance": attrs.get("importance", 0.5),
            "stored_at": attrs.get("stored_at", ""),
        }
        self._build_nx_graph()
        self._save()

    def remove_node(self, memory_id: str) -> None:
        self.nodes.pop(memory_id, None)
        self.cooccurrence.pop(memory_id, None)
        for src in self.cooccurrence:
            self.cooccurrence[src].pop(memory_id, None)
        self.edges = [
            e for e in self.edges
            if (e.get("source") or e.get("from")) != memory_id
            and (e.get("target") or e.get("to")) != memory_id
        ]
        for bucket in self.session_buckets:
            self.session_buckets[bucket] = [
                m for m in self.session_buckets[bucket] if m != memory_id
            ]
        self._build_nx_graph()
        self._save()

    def update_node(self, memory_id: str, attrs: dict) -> None:
        if memory_id in self.nodes:
            self.nodes[memory_id].update({
                "content": attrs.get("content", ""),
                "category": attrs.get("category", "other"),
                "importance": attrs.get("importance", 0.5),
            })
        self._build_nx_graph()
        self._save()

    def add_session_edge(self, memory_id: str, conversation_id: str) -> None:
        self.session_buckets[conversation_id].append(memory_id)
        bucket = self.session_buckets[conversation_id]
        for i, mid_a in enumerate(bucket):
            for mid_b in bucket[i + 1 :]:
                self.cooccurrence[mid_a][mid_b] += 1
                self.cooccurrence[mid_b][mid_a] += 1
                self._add_edge(mid_a, mid_b, "session")
        self._save()

    def build_recall_edges(self, memory_id: str, related_ids: list[str]) -> None:
        for rel_id in related_ids:
            if rel_id == memory_id:
                continue
            self.cooccurrence[memory_id][rel_id] += 1
            self.cooccurrence[rel_id][memory_id] += 1
            self._add_edge(memory_id, rel_id, "recall_cooccur")
        self._save()

    def _add_edge(self, source: str, target: str, relation: str) -> None:
        for edge in self.edges:
            if (edge.get("source") or edge.get("from")) == source and (
                edge.get("target") or edge.get("to")
            ) == target:
                return
        self.edges.append({"source": source, "target": target, "relation": relation})
        if self._graph is not None and GRAPHIFY_AVAILABLE:
            self._graph.add_edge(source, target, relation=relation)

    def expand(
        self, seed_ids: list[str], depth: int = 2, top_k: int = 10
    ) -> dict[str, float]:
        if not seed_ids:
            return {}

        result: dict[str, float] = {}

        if GRAPHIFY_AVAILABLE and self._graph is not None:
            try:
                bfs_scores: dict[str, float] = {}
                for seed in seed_ids:
                    if seed not in self._graph:
                        continue
                    frontier = {seed}
                    visited = {seed}
                    for d in range(depth):
                        next_frontier: set[str] = set()
                        for node in frontier:
                            neighbors = list(self._graph.successors(node)) + list(
                                self._graph.predecessors(node)
                            )
                            for neighbor in neighbors:
                                if neighbor not in visited:
                                    dist = d + 1
                                    cooc_score = self.cooccurrence.get(seed, {}).get(
                                        neighbor, 0
                                    )
                                    bfs_scores[neighbor] = bfs_scores.get(neighbor, 0) + (
                                        1.0 / dist + 0.1 * cooc_score
                                    )
                                    next_frontier.add(neighbor)
                                    visited.add(neighbor)
                        frontier = next_frontier
                        if not frontier:
                            break

                for node, score in bfs_scores.items():
                    if node not in seed_ids:
                        result[node] = round(score, 4)

                result = dict(
                    sorted(result.items(), key=lambda x: x[1], reverse=True)[:top_k]
                )
                return result

            except Exception as e:
                log.warning(f"Graph expansion via networkx failed: {e}")

        for seed in seed_ids:
            cooc = self.cooccurrence.get(seed, {})
            for rel_id, count in cooc.items():
                if rel_id not in seed_ids:
                    result[rel_id] = result.get(rel_id, 0) + count * 0.1

        return dict(sorted(result.items(), key=lambda x: x[1], reverse=True)[:top_k])

    def node_count(self) -> int:
        return len(self.nodes)

    def get_communities(self) -> list[list[str]]:
        if not GRAPHIFY_AVAILABLE or self._graph is None:
            return []
        try:
            undirected = self._graph.to_undirected()
            if undirected.number_of_nodes() < 3:
                return []
            comps = community.louvain_communities(undirected, seed=42)
            return [list(c) for c in comps]
        except Exception as e:
            log.warning(f"Community detection failed: {e}")
            return []
