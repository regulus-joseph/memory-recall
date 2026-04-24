"""
LLM Extractor - 6W + category extraction via Ollama
"""
import json
import logging
import re

import httpx

log = logging.getLogger("llm-extractor")

CATEGORIES = ["preference", "fact", "decision", "entity", "reflection", "other"]

SYSTEM_PROMPT = """你是一个记忆提取助手。从用户输入中提取结构化信息。

输出格式（JSON）：
{
  "category": "preference|fact|decision|entity|reflection|other",
  "6w": {
    "who": "人物/角色",
    "what": "核心事件/内容",
    "when": "时间（如果有）",
    "where": "地点（如果有）",
    "why": "原因/动机（如果有）",
    "how": "方式/方法（如果有）"
  },
  "importance": 0.0-1.0
}

规则：
- category 判断：
  * preference: 用户偏好、喜好、习惯（我更喜欢.../我不喜欢...）
  * fact: 客观事实、知识、定义
  * decision: 决定、计划、目标
  * entity: 实体、人物、项目、技术名词
  * reflection: 反思、总结、感悟
  * other: 不属于以上
- importance: 0.3 以下=日常闲聊，0.3-0.6=普通信息，0.6-0.8=重要信息，0.8-1.0=关键决策
- 如果没有对应字段的信息，设为空字符串""""""

USER_PROMPT_TEMPLATE = '提取以下文本的结构化信息：\n"""\n{content}\n"""'


class LLMExtractor:
    def __init__(self, ollama_url: str = "http://localhost:11434/api/generate"):
        self.ollama_url = ollama_url
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self._client

    async def extract(self, content: str) -> dict:
        if not content or len(content.strip()) < 5:
            return {"category": "other", "6w": {}, "importance": 0.3}

        try:
            client = await self._get_client()
            prompt = SYSTEM_PROMPT + "\n\n" + USER_PROMPT_TEMPLATE.format(content=content[:1000])

            resp = await client.post(
                self.ollama_url,
                json={
                    "model": "qwen2.5",
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1},
                },
                timeout=60.0,
            )
            resp.raise_for_status()
            data = resp.json()
            raw = data.get("response", "").strip()

            parsed = self._parse_response(raw)
            if parsed:
                log.debug(f"LLM extraction success: {parsed.get('category')}")
                return parsed

        except httpx.HTTPError as e:
            log.warning(f"LLM extraction HTTP error: {e}")
        except Exception as e:
            log.warning(f"LLM extraction failed: {e}")

        return self._fallback_extract(content)

    def _parse_response(self, raw: str) -> dict | None:
        raw = raw.strip()
        if raw.startswith("```json"):
            raw = raw[7:]
        if raw.startswith("```"):
            raw = raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

        for attempt in range(2):
            try:
                data = json.loads(raw)
                if "category" in data and "6w" in data:
                    data["6w"] = {
                        k: str(v) if v else ""
                        for k, v in data.get("6w", {}).items()
                    }
                    data["category"] = self._normalize_category(
                        data.get("category", "other")
                    )
                    data["importance"] = float(data.get("importance", 0.5))
                    data["importance"] = max(0.0, min(1.0, data["importance"]))
                    return data
            except (json.JSONDecodeError, ValueError):
                json_start = raw.find("{")
                if json_start >= 0:
                    raw = raw[json_start:]
                else:
                    break

        return None

    def _normalize_category(self, cat: str) -> str:
        cat_lower = cat.lower().strip()
        for c in CATEGORIES:
            if c in cat_lower:
                return c
        return "other"

    def _fallback_extract(self, content: str) -> dict:
        import re

        words = content.lower()
        why_indicators = ["因为", "为了", "原因", "so that", "because", "reason"]
        how_indicators = ["通过", "使用", "用", "using", "by", "via", "方法"]
        decision_indicators = ["决定", "决定要", "要", "决定", "will", "plan", "going to"]
        pref_indicators = ["喜欢", "不喜欢", "prefer", "hate", "love", "want", "不想要"]

        category = "other"
        for kw in decision_indicators:
            if kw in words:
                category = "decision"
                break
        if category == "other":
            for kw in pref_indicators:
                if kw in words:
                    category = "preference"
                    break
        if category == "other":
            if re.search(r"^\[?\d{4}[-/]\d{2}", content):
                category = "fact"

        importance = 0.3
        if any(kw in words for kw in ["重要", "关键", "必须", "critical", "important", "must"]):
            importance = 0.7
        elif len(content) > 200:
            importance = 0.5

        return {
            "category": category,
            "6w": {"who": "", "what": content[:50], "when": "", "where": "", "why": "", "how": ""},
            "importance": importance,
        }
