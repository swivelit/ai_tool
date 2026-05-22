from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class WebSearchResult:
    enabled: bool
    results: List[dict]
    reason: str = "disabled"


class WebSearchAgent:
    def search(self, query: str) -> WebSearchResult:
        enabled = os.getenv("ENABLE_WEB_SEARCH_FOR_FREE", "").strip().lower() in {"1", "true", "yes", "on"}
        if not enabled:
            return WebSearchResult(enabled=False, results=[], reason="disabled")
        if not str(query or "").strip():
            return WebSearchResult(enabled=True, results=[], reason="empty_query")
        return WebSearchResult(enabled=True, results=[], reason="no_free_source_configured")
