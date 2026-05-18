from __future__ import annotations

from sqlmodel import Session

from ..agent_schemas import AgentPlan


class MemoryAgent:
    def should_use_local_memory(self, _session: Session, plan: AgentPlan) -> bool:
        return plan.action == "memory"
