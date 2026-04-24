"""
Memory Recall Worker - consumes extraction tasks from JSONL file queue.
"""
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] memory-recall-worker: %(message)s"
)
log = logging.getLogger("memory-recall-worker")

APP_DIR = Path.home() / ".memory-recall"
DATA_DIR = APP_DIR / "data"
GRAPH_FILE = DATA_DIR / "memory_graph.json"
QUEUE_FILE = DATA_DIR / "extraction_queue.jsonl"

APP_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)


def read_queue():
    if not QUEUE_FILE.exists():
        return None
    try:
        with open(QUEUE_FILE, "r") as f:
            line = f.readline()
        if not line:
            return None
        with open(QUEUE_FILE, "r") as f:
            lines = f.readlines()
        if len(lines) <= 1:
            with open(QUEUE_FILE, "w") as f:
                pass
            return json.loads(lines[0]) if lines else None
        with open(QUEUE_FILE, "w") as f:
            f.writelines(lines[1:])
        return json.loads(line)
    except (FileNotFoundError, json.JSONDecodeError, IndexError):
        return None


def get_queue_length():
    if not QUEUE_FILE.exists():
        return 0
    try:
        with open(QUEUE_FILE, "r") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def enqueue(task: dict):
    try:
        with open(QUEUE_FILE, "a") as f:
            f.write(json.dumps(task, ensure_ascii=False) + "\n")
        return True
    except Exception as e:
        log.warning(f"Enqueue failed: {e}")
        return False


def call_ollama(prompt: str, model: str, timeout: int = 60) -> str:
    url = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {"temperature": 0.1, "num_predict": 512},
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "") or data.get("thinking", "")
    except Exception as e:
        log.warning(f"Ollama call failed: {e}")
        return ""


def extract_with_llm(content: str) -> dict:
    model = os.getenv("LLM_MODEL", "qwen3.5:9b")
    system_prompt = """你是一个记忆提取器。根据用户输入的记忆内容，提取以下信息并以JSON格式返回：
- category: 分类，取值: profile(个人背景)/preferences(偏好)/entities(人物或组织)/events(事件时间)/cases(案例经验)/patterns(行为模式)/other
- importance: 重要性评分，0.0-1.0
- 6w: 6要素字典，键为who/what/when/where/why/how，值为对应内容，无则为null
- summary: 一句话摘要
直接输出JSON，不要解释。"""
    raw = call_ollama(f"{system_prompt}\n\n记忆内容: {content}", model)
    try:
        result = json.loads(raw)
        if isinstance(result, dict) and "category" in result:
            return result
    except json.JSONDecodeError:
        pass
    log.warning(f"LLM extraction parse failed: {raw[:80]}")
    return {"category": "other", "importance": 0.5, "6w": {}, "summary": content[:50]}


STOPWORDS = {"的", "了", "是", "在", "和", "有", "我", "你", "他", "她", "它", "这", "那", "个", "吗", "呢", "吧", "啊", "哦", "嗯", "就", "也", "都", "很", "要", "会", "能", "可以", "不", "没", "很", "一个", "什么", "怎么", "为什么"}


def _tokenize(text: str) -> list[str]:
    tokens = []
    english = __import__("re").findall(r"[a-zA-Z0-9]+", text)
    tokens.extend([w.lower() for w in english if len(w) > 1])
    chinese_segments = __import__("re").findall(r"[\u4e00-\u9fff]+", text)
    for chars in chinese_segments:
        if len(chars) <= 2:
            tokens.append(chars)
        else:
            seen = set()
            for n in (2, 3):
                for i in range(len(chars) - n + 1):
                    tok = chars[i:i + n]
                    if tok not in seen:
                        tokens.append(tok)
                        seen.add(tok)
    return [t for t in tokens if t not in STOPWORDS]


def update_graph(memory_id: str, category: str, stored_at: str, content: str):
    try:
        with open(GRAPH_FILE, "r") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return

    nodes = data.get("nodes", {})
    if memory_id not in nodes:
        return
    nodes[memory_id]["category"] = category
    nodes[memory_id]["extraction_done"] = True

    current = datetime.fromisoformat(stored_at)
    edges = data.setdefault("edges", [])

    if category != "other":
        for other_id, attrs in nodes.items():
            if other_id == memory_id or attrs.get("category") != category:
                continue
            try:
                other_time = datetime.fromisoformat(attrs.get("stored_at", ""))
                if abs((current - other_time).total_seconds()) > 24 * 3600:
                    continue
            except Exception:
                continue
            exists = any(
                (e.get("source") == memory_id and e.get("target") == other_id) or
                (e.get("source") == other_id and e.get("target") == memory_id)
                for e in edges
            )
            if not exists:
                edges.append({"source": memory_id, "target": other_id, "relation": "category_overlap", "category": category})

    words = set(_tokenize(content))
    for other_id, attrs in nodes.items():
        if other_id == memory_id:
            continue
        other_words = set(_tokenize(attrs.get("content", "")))
        shared = words & other_words
        if not shared:
            continue
        exists = any(
            (e.get("source") == memory_id and e.get("target") == other_id) or
            (e.get("source") == other_id and e.get("target") == memory_id)
            for e in edges
        )
        if not exists:
            edges.append({
                "source": memory_id,
                "target": other_id,
                "relation": "word_overlap",
                "words": list(shared)[:10],
            })

    with open(GRAPH_FILE, "w") as f:
        json.dump(data, f, ensure_ascii=False)


def update_qdrant(memory_id: str, payload: dict):
    host = os.getenv("QDRANT_HOST", "localhost")
    port = os.getenv("QDRANT_PORT", "6333")
    collection = os.getenv("QDRANT_COLLECTION", "memory_recall")
    url = f"http://{host}:{port}/collections/{collection}/points/{memory_id}"
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.put(url, json={"payload": payload})
            if resp.status_code not in (200, 201):
                log.warning(f"Qdrant update failed: {resp.status_code}")
    except Exception as e:
        log.warning(f"Qdrant update error: {e}")


def get_vector(text: str):
    embed_url = os.getenv("EMBEDDING_URL", "http://localhost:11434/api/embeddings")
    embed_model = os.getenv("EMBEDDING_MODEL", "bge-m3")
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(embed_url, json={"model": embed_model, "input": text})
            resp.raise_for_status()
            data = resp.json()
            embeddings = data.get("embeddings") or data.get("embedding")
            if embeddings:
                return embeddings[0] if isinstance(embeddings[0], list) else embeddings
    except Exception as e:
        log.warning(f"Embedding failed: {e}")
    return None


def process_task(task: dict):
    memory_id = task.get("memory_id")
    content = task.get("content", "")
    agent_id = task.get("agent_id", "")
    conversation_id = task.get("conversation_id", "")
    stored_at = task.get("stored_at", "")
    metadata = task.get("metadata") or {}

    log.info(f"[worker] {memory_id[:8]}: {content[:30]}")

    extraction = extract_with_llm(content)
    category = extraction.get("category", "other")
    summary = extraction.get("summary", "")
    six_w = extraction.get("6w", {})
    importance = extraction.get("importance", 0.5)

    log.info(f"[worker] done {memory_id[:8]}: cat={category}")

    vector_text = f"{content} {summary} {json.dumps(six_w, ensure_ascii=False)}"
    vector = get_vector(vector_text)

    payload = {
        "content": content,
        "agent_id": agent_id,
        "conversation_id": conversation_id,
        "category": category,
        "6w": six_w,
        "importance": importance,
        "stored_at": stored_at,
        "state": "confirmed",
        "access_count": 0,
        "last_accessed": datetime.now().isoformat(),
        "graph_edges": [],
        "extraction_done": True,
        **metadata,
    }

    if vector:
        update_qdrant(memory_id, payload)
    update_graph(memory_id, category, stored_at, content)


def main():
    log.info(f"Worker started. Queue: {QUEUE_FILE}")
    while True:
        task = read_queue()
        if task is None:
            import time; time.sleep(1)
            continue
        try:
            process_task(task)
        except Exception as e:
            log.warning(f"Task failed: {e}")


if __name__ == "__main__":
    main()
