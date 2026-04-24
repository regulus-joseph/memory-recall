"""
BM25 Index with incremental update support.
jieba tokenization, file-based persistence.
增量策略：add/remove/update 不重建索引，累积 N 次或显式触发 rebuild。
"""
import json
import logging
import re
from pathlib import Path
from typing import Any

jieba = None
try:
    import jieba
    JIEBA_AVAILABLE = True
except ImportError:
    JIEBA_AVAILABLE = False

try:
    from rank_bm25 import BM25Okapi
    BM25_AVAILABLE = True
except ImportError:
    BM25_AVAILABLE = False
    BM25Okapi = None

log = logging.getLogger("bm25-index")

REBUILD_THRESHOLD = 20


class BM25Index:
    def __init__(self, index_file: str):
        self.index_file = Path(index_file)
        self.corpus: dict[str, dict] = {}
        self._deleted_ids: set[str] = set()
        self._bm25: Any = None
        self._tokenized: list[list[str]] = []
        self._doc_ids: list[str] = []
        self._changes_since_rebuild = 0
        self._load()

    def _load(self) -> None:
        if self.index_file.exists():
            try:
                with open(self.index_file) as f:
                    data = json.load(f)
                    raw = data.get("corpus", {})
                    for doc_id, val in raw.items():
                        if isinstance(val, str):
                            self.corpus[doc_id] = {"content": val, "agent_id": "default"}
                        else:
                            self.corpus[doc_id] = val
                    self._deleted_ids = set(data.get("deleted", []))
                log.info(f"Loaded BM25 corpus: {len(self.corpus)} docs, {len(self._deleted_ids)} deleted")
            except Exception as e:
                log.warning(f"Failed to load BM25 index: {e}")
                self.corpus = {}
                self._deleted_ids = set()
        self._rebuild()

    def _save(self) -> None:
        try:
            with open(self.index_file, "w") as f:
                json.dump({
                    "corpus": self.corpus,
                    "deleted": list(self._deleted_ids),
                }, f, ensure_ascii=False)
        except Exception as e:
            log.error(f"Failed to save BM25 index: {e}")

    def _tokenize(self, text: str) -> list[str]:
        if not text:
            return []
        if JIEBA_AVAILABLE:
            tokens = list(jieba.cut(text))
        else:
            tokens = self._fallback_tokenize(text)
        return [t for t in tokens if len(t) > 1]

    def _fallback_tokenize(self, text: str) -> list[str]:
        tokens = []
        english = re.findall(r"[a-zA-Z]+", text)
        tokens.extend([w.lower() for w in english if len(w) > 1])
        chinese_segments = re.findall(r"[\u4e00-\u9fff]+", text)
        for chars in chinese_segments:
            if len(chars) <= 2:
                tokens.append(chars)
            else:
                seen = set()
                for n in (2, 3):
                    for i in range(len(chars) - n + 1):
                        tok = chars[i : i + n]
                        if tok not in seen:
                            tokens.append(tok)
                            seen.add(tok)
                tokens.append(chars[:4])
                tokens.append(chars[-4:])
        return tokens

    def _rebuild(self) -> None:
        self._deleted_ids &= set(self.corpus.keys())
        active_ids = [did for did in self.corpus if did not in self._deleted_ids]
        self._doc_ids = active_ids
        self._tokenized = [self._tokenize(self.corpus[did].get("content", "")) for did in active_ids]
        if self._tokenized and self._doc_ids and BM25_AVAILABLE:
            try:
                self._bm25 = BM25Okapi(self._tokenized)
                log.info(f"BM25 rebuilt: {len(self._doc_ids)} active docs")
            except Exception as e:
                log.error(f"BM25 rebuild failed: {e}")
                self._bm25 = None
        else:
            self._bm25 = None
            self._tokenized = []
            self._doc_ids = []
        self._changes_since_rebuild = 0

    def _may_rebuild(self) -> None:
        self._changes_since_rebuild += 1
        if self._changes_since_rebuild >= REBUILD_THRESHOLD:
            self._rebuild()

    def add(self, doc_id: str, content: str, agent_id: str = "default") -> None:
        if doc_id in self._deleted_ids:
            self._deleted_ids.discard(doc_id)
        self.corpus[doc_id] = {"content": content, "agent_id": agent_id}
        if doc_id not in self._doc_ids:
            self._doc_ids.append(doc_id)
            self._tokenized.append(self._tokenize(content))
            self._rebuild()
        else:
            idx = self._doc_ids.index(doc_id)
            self._tokenized[idx] = self._tokenize(content)
            self._may_rebuild()
        self._save()

    def remove(self, doc_id: str) -> None:
        self._deleted_ids.add(doc_id)
        self._may_rebuild()
        self._save()

    def update_doc(self, doc_id: str, content: str) -> None:
        if doc_id in self.corpus:
            self.corpus[doc_id]["content"] = content
            if doc_id in self._doc_ids:
                idx = self._doc_ids.index(doc_id)
                self._tokenized[idx] = self._tokenize(content)
            self._may_rebuild()
            self._save()

    def search(self, query: str, top_k: int = 20) -> list[dict]:
        if not self._bm25 or not self._tokenized:
            return []
        tokens = self._tokenize(query)
        if not tokens:
            return []
        try:
            scores = self._bm25.get_scores(tokens)
        except Exception as e:
            log.error(f"BM25 scoring failed: {e}")
            return []
        scored = [
            (self._doc_ids[i], float(scores[i])) for i in range(len(self._doc_ids))
            if self._doc_ids[i] not in self._deleted_ids
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        results = []
        for doc_id, score in scored[:top_k]:
            entry = self.corpus.get(doc_id, {})
            results.append({
                "id": doc_id,
                "score": round(score, 4),
                "content": entry.get("content", ""),
                "agent_id": entry.get("agent_id", "default"),
            })
        return results

    def doc_count(self) -> int:
        return len(self.corpus) - len(self._deleted_ids)

    def force_rebuild(self) -> None:
        self._rebuild()
        self._save()
