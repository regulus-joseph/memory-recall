"""
Dictionary maintenance - uses LLM to validate and improve the jieba user dictionary.
Run periodically (e.g., daily) to add missing words discovered by LLM.

Usage:
    python dict_maintenance.py --dry-run  # preview changes
    python dict_maintenance.py            # apply changes
    python dict_maintenance.py --check    # check tokenized output, no LLM
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "projects" / "shared-lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx
import shared_lib as _sl

OLLAMA_URL   = f"{_sl.BASE_URL}/api/generate"
OLLAMA_MODEL = _sl.LLM_MODEL

_USER_DICT_PATH = Path(__file__).parent / "user_dict.txt"


def load_user_dict() -> set[str]:
    if not _USER_DICT_PATH.exists():
        return set()
    words = set()
    for line in _USER_DICT_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        w = line.split()[0] if line.split() else line
        if len(w) >= 2:
            words.add(w)
    return words


def save_user_dict(new_words: set[str]):
    existing = load_user_dict()
    added = new_words - existing
    if not added:
        return
    with open(_USER_DICT_PATH, "a") as f:
        for w in sorted(added):
            f.write(f"{w} 99999 n\n")
    print(f"Added {len(added)} words to {_USER_DICT_PATH}")


def extract_words_llm(text: str) -> list[str]:
    prompt = f"""你是一个中文分词专家。根据给定的句子，提取其中的关键词（名词、动词、形容词、专业术语、地名、人名等有意义的实词）。

句子: {text}

请直接输出提取的关键词列表，格式：
["word1", "word2", "word3"]

要求：
- 只输出JSON数组，不要任何解释
- 关键词长度2-6个字
- 不要包含助词、副词、量词等虚词
- 不要包含停用词如：的、了、是、在、和、有、我、你、他、这、那、个、吗、呢、吧、啊、就、也、都、很、要、会、能、不、没

直接输出JSON数组："""
    try:
        resp = httpx.post(OLLAMA_URL, json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "think": False,
            "options": {"temperature": 0.1, "num_predict": 256},
        }, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        raw = data.get("response", "") or data.get("thinking", "")
        result = json.loads(raw.strip())
        if isinstance(result, list):
            return [str(w) for w in result if len(str(w)) >= 2]
        return []
    except Exception as e:
        print(f"  LLM error: {e}")
        return []


def check_memory(memory_id: str, text: str, user_dict: set[str]) -> dict:
    from src.lark_tok import tokenize as current_tokenize

    current_tokens = set(current_tokenize(text))
    llm_words = extract_words_llm(text)

    missing = [w for w in llm_words if w not in current_tokens and w not in user_dict]
    fp = [t for t in current_tokens if t not in llm_words]

    return {
        "id": memory_id,
        "text": text[:50],
        "current_tokens": sorted(current_tokens),
        "llm_words": llm_words,
        "missing": missing,
        "false_positives": fp,
        "has_issues": bool(missing),
    }


def main():
    parser = argparse.ArgumentParser(description="Dictionary maintenance tool")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without applying")
    parser.add_argument("--check", action="store_true", help="Check tokenized output, no LLM")
    parser.add_argument("--limit", type=int, default=10, help="Max memories to check")
    args = parser.parse_args()

    print("=== Dictionary Maintenance ===")
    user_dict = load_user_dict()
    print(f"Current user dict: {len(user_dict)} words ({_USER_DICT_PATH})")

    if args.check:
        from src.lark_tok import tokenize, STOPWORDS
        tests = [
            "我喜欢麻辣火锅",
            "我住在深圳南山区",
            "我要去德国柏林出差",
            "agent-a专属记忆",
            "qwen3.5和qwen2.5",
            "黑胶唱片",
            "测试中文搜索功能",
        ]
        for t in tests:
            print(f"  '{t}' -> {tokenize(t)}")
        return

    host = os.getenv("QDRANT_HOST", "localhost")
    port = os.getenv("QDRANT_PORT", "6333")
    collection = os.getenv("QDRANT_COLLECTION", "memory_recall")

    try:
        r = httpx.post(f"http://{host}:{port}/collections/{collection}/points/scroll",
            json={"with_payload": True, "limit": args.limit}, timeout=30)
        r.raise_for_status()
        points = r.json().get("result", {}).get("points", [])
    except Exception as e:
        print(f"Qdrant error: {e}")
        return

    print(f"Checking {len(points)} memories with LLM...")

    all_missing = []
    all_fp = {}
    issues = 0

    for i, p in enumerate(points):
        payload = p.get("payload", {})
        text = payload.get("content", "")
        if not text or len(text) < 4:
            continue

        print(f"\n[{i+1}/{len(points)}] {text[:40]}...")
        result = check_memory(p["id"], text, user_dict)

        if result["has_issues"]:
            issues += 1
            print(f"  Missing: {result['missing']}")
            print(f"  FP: {result['false_positives']}")
            all_missing.extend(result['missing'])
            for fp in result['false_positives']:
                all_fp[fp] = all_fp.get(fp, 0) + 1

    print(f"\n=== Summary ===")
    print(f"Memories checked: {len(points)}")
    print(f"Memories with issues: {issues}")

    if all_missing:
        from collections import Counter
        freq = Counter(all_missing)
        candidates = {w for w, c in freq.items() if c >= 2}
        print(f"\nCandidates to add (>=2 occurrences): {len(candidates)}")
        for word, count in freq.most_common(20):
            if count >= 2:
                print(f"  + {word} (appears in {count} memories)")

    if all_fp:
        print(f"\nFalse positives (tokenizer over-segmented):")
        for word, count in sorted(all_fp.items(), key=lambda x: -x[1])[:10]:
            print(f"  - {word} (appears in {count} memories)")

    if args.dry_run:
        print("\nDry run: no changes applied")
        return

    if issues == 0:
        print("\nNo issues found!")
        return

    from collections import Counter
    freq = Counter(all_missing)
    to_add = {w for w, c in freq.items() if c >= 2}
    if to_add:
        print(f"\nAdding {len(to_add)} words to {_USER_DICT_PATH}...")
        save_user_dict(to_add)
    else:
        print("\nNo words meet the frequency threshold (>=2).")


if __name__ == "__main__":
    main()
