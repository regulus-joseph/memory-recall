"""
L1 Keyword Matcher
Fast regex-based keyword matching for memory recall
"""
import re
from typing import Any


class KeywordMatcher:
    """L1: Fast keyword matching using regex"""

    def __init__(self, whitelist: list[str] | None = None):
        self.whitelist = whitelist or []
        self.whitelist_pattern = self._build_pattern(self.whitelist)

    def _build_pattern(self, keywords: list[str]) -> re.Pattern | None:
        if not keywords:
            return None
        escaped = [re.escape(k) for k in keywords]
        return re.compile("|".join(escaped), re.IGNORECASE)

    def match(self, query: str, candidates: list[dict]) -> list[tuple[str, float]]:
        """
        Match query against candidates using keyword overlap
        Returns: list of (memory_id, score)
        """
        if not candidates:
            return []

        query_keywords = self._extract_keywords(query)
        if not query_keywords:
            return [(c["id"], 0.5) for c in candidates]

        results = []
        for mem in candidates:
            content = mem.get("content", "")
            entities = mem.get("entities", {})
            memory_keywords = self._extract_keywords(content)
            memory_keywords.update(self._extract_entities(entities))

            score = self._jaccard_similarity(set(query_keywords), memory_keywords)

            if score > 0:
                results.append((mem["id"], score))

        results.sort(key=lambda x: x[1], reverse=True)
        return results

    def _extract_keywords(self, text: str) -> set[str]:
        """Extract keywords from text - improved for Chinese"""
        if not text:
            return set()

        text_lower = text.lower()
        keywords = set()

        import re

        english_words = re.findall(r"[a-zA-Z]+", text_lower)
        for w in english_words:
            if len(w) > 1:
                keywords.add(w)

        chinese_chars = re.findall(r"[\u4e00-\u9fff]+", text)
        for chars in chinese_chars:
            if len(chars) >= 2:
                for i in range(len(chars) - 1):
                    keywords.add(chars[i:i+2])
                if len(chars) >= 3:
                    for i in range(len(chars) - 2):
                        keywords.add(chars[i:i+3])

        return keywords

    def _extract_entities(self, entities: dict) -> set[str]:
        """Extract all entity types"""
        result = set()
        for entity_list in entities.values():
            if isinstance(entity_list, list):
                result.update(str(e) for e in entity_list)
        return result

    def _jaccard_similarity(self, set1: set[str], set2: set[str]) -> float:
        if not set1 or not set2:
            return 0.0
        intersection = len(set1 & set2)
        union = len(set1 | set2)
        return intersection / union if union > 0 else 0.0
