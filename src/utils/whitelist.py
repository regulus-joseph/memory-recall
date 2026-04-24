"""
Whitelist Manager for keyword filtering
"""
import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


class WhitelistManager:
    """Manages keyword whitelist for memory recall filtering"""

    def __init__(self, whitelist_file: str | None = None):
        self.whitelist_file = whitelist_file or ".memory_recall_whitelist.json"
        self.whitelist: set[str] = set()
        self._load()

    def _load(self) -> None:
        """Load whitelist from file"""
        path = Path(self.whitelist_file)
        if path.exists():
            try:
                with open(path) as f:
                    data = json.load(f)
                    self.whitelist = set(data.get("keywords", []))
                log.info(f"Loaded {len(self.whitelist)} whitelist entries")
            except Exception as e:
                log.error(f"Failed to load whitelist: {e}")

    def save(self) -> None:
        """Save whitelist to file"""
        try:
            with open(self.whitelist_file, "w") as f:
                json.dump({"keywords": list(self.whitelist)}, f, ensure_ascii=False, indent=2)
            log.info(f"Saved {len(self.whitelist)} whitelist entries")
        except Exception as e:
            log.error(f"Failed to save whitelist: {e}")

    def add(self, keyword: str) -> None:
        """Add keyword to whitelist"""
        self.whitelist.add(keyword.lower())

    def add_batch(self, keywords: list[str]) -> None:
        """Add multiple keywords"""
        for kw in keywords:
            self.add(kw)

    def remove(self, keyword: str) -> None:
        """Remove keyword from whitelist"""
        self.whitelist.discard(keyword.lower())

    def is_allowed(self, keyword: str) -> bool:
        """Check if keyword is in whitelist (empty whitelist = allow all)"""
        if not self.whitelist:
            return True
        return keyword.lower() in self.whitelist

    def filter_keywords(self, keywords: list[str]) -> list[str]:
        """Filter keywords against whitelist"""
        if not self.whitelist:
            return keywords
        return [k for k in keywords if self.is_allowed(k)]
