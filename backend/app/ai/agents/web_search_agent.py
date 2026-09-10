from __future__ import annotations

import os
import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
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
        raw = str(query or "").strip()
        if not raw:
            return WebSearchResult(enabled=True, results=[], reason="empty_query")
        title = self._wikipedia_title(raw)
        if not title:
            return WebSearchResult(enabled=True, results=[], reason="unsupported_query")
        url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title.replace(' ', '_'))}"
        try:
            with urllib.request.urlopen(url, timeout=3.0) as response:  # noqa: S310 - fixed public Wikipedia endpoint.
                payload = json.loads(response.read().decode("utf-8"))
        except Exception:
            return WebSearchResult(enabled=True, results=[], reason="lookup_failed")
        extract = str(payload.get("extract") or "").strip()
        page_url = str((payload.get("content_urls") or {}).get("desktop", {}).get("page") or payload.get("url") or url)
        if not extract:
            return WebSearchResult(enabled=True, results=[], reason="not_found")
        return WebSearchResult(
            enabled=True,
            results=[
                {
                    "title": str(payload.get("title") or title),
                    "snippet": extract,
                    "source": "wikipedia",
                    "url": page_url,
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                    "provenance": "wikipedia_summary",
                    "temporal_support": False,
                }
            ],
            reason="wikipedia_summary",
        )

    @staticmethod
    def _wikipedia_title(query: str) -> str:
        normalized = re.sub(r"\s+", " ", str(query or "").strip())
        patterns = [
            r"(?i)^what\s+is\s+(.+?)\??$",
            r"(?i)^who\s+is\s+(.+?)\??$",
            r"(?i)^tell\s+me\s+about\s+(.+?)\??$",
            r"(?i)^explain\s+(.+?)\??$",
        ]
        for pattern in patterns:
            match = re.match(pattern, normalized)
            if match:
                title = re.sub(r"\b(?:the|a|an)\b$", "", match.group(1).strip(), flags=re.IGNORECASE).strip()
                return title[:120]
        return ""
