from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LiveDataClassification:
    is_live: bool
    reason: str = "keyword"


class LiveDataClassifierAgent:
    def classify(self, text: str) -> LiveDataClassification:
        from ...global_qa_cache import is_live_or_current_question

        return LiveDataClassification(bool(is_live_or_current_question(text)))
