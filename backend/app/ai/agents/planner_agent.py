from __future__ import annotations

from ..agent_schemas import AgentIntentResult, AgentPlan
from ..types import AIRequest


class PlannerAgent:
    def plan(self, request: AIRequest, intent: AgentIntentResult, *, pending_reminder: bool = False) -> AgentPlan:
        if pending_reminder and not intent.metadata.get("pending_reminder_blocked") and intent.intent != "creative_tool":
            return AgentPlan(
                action="reminder",
                intent="reminder",
                route="agent_tool_reminder",
                category="Reminder",
                language=intent.language,
                confidence=max(intent.confidence, 0.96),
                reason="pending_reminder_clarification_completed",
            )

        action_by_intent = {
            "greeting": "local_reply",
            "thanks": "local_reply",
            "capabilities": "local_reply",
            "reminder": "reminder",
            "task": "task",
            "note": "note",
            "document": "document",
            "file_retrieval": "file_retrieval",
            "creative_tool": "unsupported_tool",
            "profile": "memory",
            "routine": "memory",
            "settings": "settings",
        }
        action = action_by_intent.get(intent.intent)
        if action:
            route = {
                "local_reply": f"agent_local_{intent.intent}",
                "reminder": "agent_tool_reminder",
                "task": "agent_tool_task",
                "note": "agent_tool_note",
                "document": "agent_tool_document",
                "file_retrieval": "agent_tool_file_retrieval",
                "unsupported_tool": "agent_unsupported_tool",
                "memory": f"agent_memory_{intent.intent}",
                "settings": "agent_tool_settings",
            }[action]
            return AgentPlan(
                action=action,
                intent=intent.intent,
                route=route,
                category=intent.category,
                language=intent.language,
                confidence=intent.confidence,
                reason=intent.reason,
                provider_allowed=False,
                metadata=intent.metadata,
            )

        return AgentPlan(
            action="provider_qa",
            intent=intent.intent,
            route="agent_provider_qa",
            category=intent.category,
            language=intent.language,
            confidence=intent.confidence,
            reason=intent.reason,
            provider_allowed=True,
            metadata=intent.metadata,
        )
