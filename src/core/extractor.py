"""
6W Entity Extractor
Extract Who, What, When, Where, Why, How from conversation content
"""
import re
import json
import logging
from typing import Any

log = logging.getLogger(__name__)


class EntityExtractor:
    """Extract 6W entities from conversation text using regex patterns"""

    EN_PATTERNS = {
        "who": [
            r"\b([A-Z][a-z]+ [A-Z][a-z]+)\b",
            r"\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+[A-Z][a-z]+\b",
        ],
        "when": [
            r"\b\d{4}[-/]\d{2}[-/]\d{2}\b",
            r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b",
        ],
        "where": [
            r"\bat\s+([A-Z][a-zA-Z\s,]+)",
            r"\bin\s+([A-Z][a-zA-Z\s,]+)",
        ],
        "why": [
            r"\bbecause\s+([^.,]+)",
            r"\breason\s+is\s+([^.,]+)",
            r"\bsince\s+([^.,]+)",
        ],
        "how": [
            r"\bby\s+(?:using|doing|creating|implementing)\s+([^.,]+)",
            r"\bthrough\s+([^.,]+)",
        ],
    }

    ZH_PATTERNS = {
        "when": [
            r"\b(?:昨天|今天|明天|上周|下周|去年|明年)\b",
            r"\b(?:上个月|这个月|下个月)\b",
            r"\b\d{4}年\d{1,2}月\d{1,2}日?\b",
        ],
        "where": [
            r"\b(?:北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州)\b",
            r"\b(?:美国|英国|德国|法国|日本|韩国|新加坡)\b",
            r"\b(?:\/home\/|\/var\/|\/opt\/|\/tmp\/)\S*\b",
        ],
        "why": [
            r"\b因为|由于|原因是|为了\b",
        ],
        "how": [
            r"\b通过|使用|利用|借助\b",
        ],
    }

    WHAT_ACTIONS_EN = [
        "bought", "sold", "discussed", "decided", "agreed", "rejected",
        "approved", "completed", "started", "finished", "failed",
        "created", "deleted", "updated", "modified", "installed",
    ]

    WHAT_ACTIONS_ZH = [
        "购买", "销售", "讨论", "决定", "同意", "拒绝", "完成", "开始", "结束",
        "创建", "删除", "更新", "修改", "安装",
    ]

    def extract(self, text: str) -> dict[str, list[str]]:
        """Extract 6W entities from text"""
        entities = {
            "who": [],
            "what": [],
            "when": [],
            "where": [],
            "why": [],
            "how": [],
        }

        self._extract_by_patterns(text, entities)

        what = self.extract_what(text)
        entities["what"] = list(set(what))

        for key in entities:
            entities[key] = list(set(entities[key]))

        return entities

    def _extract_by_patterns(self, text: str, entities: dict) -> None:
        """Extract entities using regex patterns"""
        all_patterns = {
            "who": self.EN_PATTERNS["who"],
            "when": self.EN_PATTERNS["when"] + self.ZH_PATTERNS["when"],
            "where": self.EN_PATTERNS["where"] + self.ZH_PATTERNS["where"],
            "why": self.EN_PATTERNS["why"] + self.ZH_PATTERNS["why"],
            "how": self.EN_PATTERNS["how"] + self.ZH_PATTERNS["how"],
        }

        for entity_type, patterns in all_patterns.items():
            for pattern in patterns:
                matches = re.findall(pattern, text, re.IGNORECASE)
                for match in matches:
                    if isinstance(match, tuple):
                        cleaned = [m.strip() for m in match if m.strip()]
                        entities[entity_type].extend(cleaned)
                    elif isinstance(match, str):
                        entities[entity_type].append(match.strip())

    def extract_what(self, text: str) -> list[str]:
        """Extract 'what' entities - action/event keywords"""
        found = []

        text_lower = text.lower()
        for word in self.WHAT_ACTIONS_EN:
            if word.lower() in text_lower:
                found.append(word)

        for word in self.WHAT_ACTIONS_ZH:
            if word in text:
                found.append(word)

        return found

    def extract_all(self, conversations: list[dict]) -> list[dict]:
        """Extract entities from multiple conversation entries"""
        results = []
        for conv in conversations:
            content = conv.get("content", "")
            entities = self.extract(content)
            results.append({
                "conversation_id": conv.get("id"),
                "entities": entities,
                "content": content[:500],
            })
        return results
