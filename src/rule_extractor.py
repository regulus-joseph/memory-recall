"""
Rule-based memory extraction - no LLM, instant, synchronous.
Uses lark-based Chinese segmentation + keyword matching.
"""
import re
from datetime import datetime
from src.lark_tok import tokenize as _lark_tokenize


CATEGORY_KEYWORDS = {
    "profile": ["我是", "我叫", "我住", "我来自", "住在", "工作", "职业", "公司", "学校", "学历", "专业", "城市", "家乡", "年龄", "生日", "性别"],
    "preferences": ["喜欢", "讨厌", "爱", "偏好", "想", "愿意", "不喜欢", "热爱", "擅长", "收藏", "爱好", "经常"],
    "entities": ["认识", "朋友", "家人", "同事", "老板", "老师", "同学", "买", "使用", "用", "品牌", "产品", "人名"],
    "events": ["去", "来了", "发生", "做了", "参加", "开会", "旅游", "出差", "考试", "生日", "纪念日", "节日"],
    "cases": ["经验", "方法", "技巧", "做过", "尝试", "遇到", "问题", "解决", "方案", "结果", "成功", "失败"],
    "patterns": ["每天", "经常", "习惯", "总是", "每次", "通常", "一般", "往往", "有时", "周末", "早上", "晚上", "每月", "每周"],
}

TIME_PATTERNS = [
    (r"(\d{4})年(\d{1,2})月(\d{1,2})日", "datetime"),
    (r"(\d{4})-(\d{2})-(\d{2})", "datetime"),
    (r"(\d{1,2})月(\d{1,2})日", "date"),
    (r"每[天周月年]", "periodic"),
    (r"昨天|今天|明天|后天|前天", "relative"),
    (r"早上|上午|中午|下午|晚上|凌晨|傍晚", "timeofday"),
    (r"\d+[点时分秒]", "time"),
]

WHERE_PATTERNS = [
    r"[在到去往]([^\s,，。、；：!?！？]+)",
    r"去([^\s,，。、；：!?！？]+?)(?:的|出|旅)",
    r"在([^\s,，。、；：!?！？]+)",
]


def _tokenize(text: str) -> list[str]:
    return _lark_tokenize(text)


def _extract_category(content: str) -> str:
    scores = {}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in content)
        scores[cat] = score
    if max(scores.values(), default=0) == 0:
        return "other"
    return max(scores, key=scores.get)


def _extract_6w(content: str) -> dict:
    tokens = _tokenize(content)
    words = set(tokens)

    who = None
    if any(w in words for w in ["我", "自己", "本人"]):
        who = "user"

    what = content[:80]

    when = None
    for pattern, _ in TIME_PATTERNS:
        m = re.search(pattern, content)
        if m:
            when = m.group(0)
            break

    where = None
    for pattern in WHERE_PATTERNS:
        m = re.search(pattern, content)
        if m:
            where = m.group(1)[:30]
            break

    why = None
    if "因为" in content:
        m = re.search(r"因为([^。，,。]+)", content)
        if m:
            why = m.group(1)[:30]

    how = None
    if "通过" in content:
        m = re.search(r"通过([^。，,。]+)", content)
        if m:
            how = m.group(1)[:30]

    return {"who": who, "what": what, "when": when, "where": where, "why": why, "how": how}


def _estimate_importance(content: str) -> float:
    score = 0.5
    if any(w in content for w in ["重要", "关键", "必须", "紧急", "必须"]):
        score += 0.2
    if any(w in content for w in ["大概", "也许", "可能", "似乎"]):
        score -= 0.1
    if len(content) > 50:
        score += 0.1
    return max(0.1, min(1.0, score))


def extract(content: str) -> dict:
    category = _extract_category(content)
    six_w = _extract_6w(content)
    importance = _estimate_importance(content)
    summary = content[:50]
    return {
        "category": category,
        "importance": importance,
        "6w": six_w,
        "summary": summary,
    }


if __name__ == "__main__":
    tests = [
        "我爱跑步和游泳",
        "我住在深圳南山区，喜欢喝铁观音",
        "我下周要去上海出差三天",
        "我每周读一本书",
        "我喜欢收集黑胶唱片，主要是古典和爵士",
        "我每天都练习冥想",
        "我决定用 Qwen3.5 来做 LLM extraction",
    ]
    for t in tests:
        r = extract(t)
        print(f"'{t}' -> {r['category']}")
