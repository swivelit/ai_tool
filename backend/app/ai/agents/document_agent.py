from __future__ import annotations

from ..agent_schemas import AgentPlan


class DocumentAgent:
    SUPPORTED_FORMATS = {"pdf", "docx", "xlsx", "pptx"}

    def can_handle(self, plan: AgentPlan) -> bool:
        return plan.action == "document"
