from __future__ import annotations

from ..agent_schemas import AgentPlan


class CostOptimizerAgent:
    _LOCAL_ACTIONS = {
        "local_reply",
        "reminder",
        "task",
        "note",
        "document",
        "file_retrieval",
        "unsupported_tool",
        "memory",
        "settings",
    }

    def optimize(self, plan: AgentPlan) -> AgentPlan:
        if plan.action in self._LOCAL_ACTIONS:
            return AgentPlan(
                action=plan.action,
                intent=plan.intent,
                route=plan.route,
                category=plan.category,
                language=plan.language,
                confidence=max(plan.confidence, 0.9),
                reason=f"{plan.reason}:provider_blocked_for_local_tool",
                provider_allowed=False,
                metadata={**plan.metadata, "provider_calls_allowed": 0},
            )
        return AgentPlan(
            action=plan.action,
            intent=plan.intent,
            route=plan.route,
            category=plan.category,
            language=plan.language,
            confidence=plan.confidence,
            reason=f"{plan.reason}:cheapest_provider_fallback_allowed",
            provider_allowed=True,
            metadata={**plan.metadata, "preferred_model_tier": "cheap"},
        )
