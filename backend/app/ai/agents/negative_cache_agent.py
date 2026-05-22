from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class NegativeCacheEntry:
    text: str
    reason: str
    route: str
    expires_at: float


class NegativeCacheAgent:
    def __init__(self, ttl_seconds: int = 120, max_size: int = 512) -> None:
        self.ttl_seconds = max(1, int(ttl_seconds or 120))
        self.max_size = max(16, int(max_size or 512))
        self._rows: "OrderedDict[str, NegativeCacheEntry]" = OrderedDict()

    @staticmethod
    def key(text: str) -> str:
        normalized = " ".join(str(text or "").lower().split())
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def get(self, text: str) -> Optional[NegativeCacheEntry]:
        key = self.key(text)
        entry = self._rows.get(key)
        if entry is None:
            return None
        if entry.expires_at <= time.time():
            self._rows.pop(key, None)
            return None
        self._rows.move_to_end(key)
        return entry

    def set(self, text: str, reason: str, response_text: str | None = None, route: str = "negative_cache") -> NegativeCacheEntry:
        entry = NegativeCacheEntry(str(response_text or ""), str(reason or "blocked"), str(route or "negative_cache"), time.time() + self.ttl_seconds)
        self._rows[self.key(text)] = entry
        self._rows.move_to_end(self.key(text))
        while len(self._rows) > self.max_size:
            self._rows.popitem(last=False)
        return entry


default_negative_cache_agent = NegativeCacheAgent()
