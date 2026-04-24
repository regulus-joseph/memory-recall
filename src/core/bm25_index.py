"""
BM25 Index with jieba Chinese tokenization
File-based persistence: bm25_index.json
"""
import json
import logging
import re
from pathlib import Path
from typing import Any

JIEBA_AVAILABLE = False
jieba = None

try:
    from rank_bm25 import BM25Okapi
    BM25_AVAILABLE = True
except ImportError:
    BM25_AVAILABLE = False
    BM25Okapi = None

log = logging.getLogger("bm25-index")


class BM25Index:
    def __init__(self, index_file: str):
        self.index_file = Path(index_file)
        self.corpus: dict[str, str] = {}
        self._bm25: Any = None
        self._tokenized: list[list[str]] = []
        self._doc_ids: list[str] = []
        self._load()

    def _load(self) -> None:
        if self.index_file.exists():
            try:
                with open(self.index_file) as f:
                    data = json.load(f)
                    self.corpus = data.get("corpus", {})
                log.info(f"Loaded BM25 corpus: {len(self.corpus)} docs")
            except Exception as e:
                log.warning(f"Failed to load BM25 index: {e}")
                self.corpus = {}
        self._rebuild()

    def _save(self) -> None:
        try:
            with open(self.index_file, "w") as f:
                json.dump({"corpus": self.corpus}, f, ensure_ascii=False)
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
        if not BM25_AVAILABLE or not self.corpus:
            self._bm25 = None
            self._tokenized = []
            self._doc_ids = []
            return

        self._doc_ids = list(self.corpus.keys())
        self._tokenized = [self._tokenize(text) for text in self.corpus.values()]
        if self._tokenized and self._doc_ids:
            try:
                self._bm25 = BM25Okapi(self._tokenized)
                log.info(f"Rebuilt BM25 index: {len(self._doc_ids)} docs")
            except Exception as e:
                log.error(f"BM25 rebuild failed: {e}")
                self._bm25 = None

    def add(self, doc_id: str, content: str) -> None:
        self.corpus[doc_id] = content
        self._rebuild()
        self._save()

    def remove(self, doc_id: str) -> None:
        self.corpus.pop(doc_id, None)
        self._rebuild()
        self._save()

    def update(self, doc_id: str, content: str) -> None:
        self.corpus[doc_id] = content
        self._rebuild()
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

        scored: list[tuple[str, float]] = [
            (self._doc_ids[i], float(scores[i])) for i in range(len(self._doc_ids))
        ]
        scored.sort(key=lambda x: x[1], reverse=True)

        results = []
        for doc_id, score in scored[:top_k]:
            results.append({
                "id": doc_id,
                "score": round(score, 4),
                "content": self.corpus.get(doc_id, ""),
            })
        return results

    def doc_count(self) -> int:
        return len(self.corpus)
