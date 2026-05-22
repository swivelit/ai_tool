from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class LiveDataClassification:
    is_live: bool
    reason: str = "keyword"


class LiveDataClassifierAgent:
    _LIVE_PATTERNS = [
        re.compile(r"(?i)\bwho'?s\s+playing\s+(?:tonight|today|now)\b"),
        re.compile(r"(?i)\bwhat'?s\s+the\s+score\b"),
        re.compile(r"(?i)\blatest\s+election\s+result"),
        re.compile(r"(?i)\bwho\s+is\s+(?:the\s+)?(?:president|prime\s+minister|pm|cm)\s+now\b"),
        re.compile(r"(?i)\bcurrent\s+price\s+of\s+(?:bitcoin|btc|ethereum|stock|gold|silver)\b"),
        re.compile(r"(?i)\b(?:today|tonight|now)\b.*\b(?:playing|score|result|price|rate|president|minister)\b"),
    ]

    def classify(self, text: str) -> LiveDataClassification:
        from ...global_qa_cache import is_live_or_current_question

        raw = str(text or "")
        for pattern in self._LIVE_PATTERNS:
            if pattern.search(raw):
                return LiveDataClassification(True, "deterministic_pattern")
        return LiveDataClassification(bool(is_live_or_current_question(text)), "keyword_fallback")
