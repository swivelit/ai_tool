from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, List, Tuple

from ...models import GlobalQACache


class RerankerAgent:
    """Small deterministic reranker for cache candidates."""

    def rerank(self, candidates: Iterable[Tuple[GlobalQACache, float]]) -> List[Tuple[GlobalQACache, float]]:
        now = datetime.now(timezone.utc)

        def key(item: Tuple[GlobalQACache, float]) -> tuple:
            row, score = item
            scope_bonus = 1 if str(getattr(row, "scope", "") or "global") == "user" else 0
            confidence = float(getattr(row, "confidence", 0.0) or 0.0)
            updated = getattr(row, "updated_at", None)
            if isinstance(updated, datetime):
                if updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
                recency = -max(0.0, (now - updated).total_seconds())
            else:
                recency = float("-inf")
            return (float(score or 0.0), scope_bonus, confidence, recency)

        return sorted(list(candidates), key=key, reverse=True)
