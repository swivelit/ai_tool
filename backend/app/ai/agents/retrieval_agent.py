from __future__ import annotations

from datetime import date, timedelta

from ..agent_schemas import AgentPlan
from ...time_utils import utc_now


class RetrievalAgent:
    def can_handle(self, plan: AgentPlan) -> bool:
        return plan.action == "file_retrieval"

    @staticmethod
    def resolve_relative_date(message: str) -> date | None:
        text = str(message or "").lower()

        if any(token in text for token in ("yesterday", "நேத்து", "நேற்று")):
            return (utc_now() - timedelta(days=1)).date()

        if any(token in text for token in ("today", "இன்று")):
            return utc_now().date()

        return None
    
    def search(self, query: str):
        # Retrieval must come from an authorized configured document store.
        return []
