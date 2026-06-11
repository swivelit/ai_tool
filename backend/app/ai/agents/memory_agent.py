
from __future__ import annotations

from sqlmodel import Session

from ..agent_schemas import AgentPlan


class MemoryAgent:
    def should_use_local_memory(self, _session: Session, plan: AgentPlan) -> bool:
        return plan.action == "memory"

    def search(self, query: str):

        memory_store = [
            "SWICO V1 project",
            "Master Agent architecture",
            "Token optimization task"
        ]

        for item in memory_store:
            if query.lower() in item.lower():
                return item

        return None