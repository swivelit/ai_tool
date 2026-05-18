from __future__ import annotations

from sqlmodel import Session

from ..agent_schemas import AgentPlan
from ..tools import handle_backend_tool, try_handle_pending_reminder
from ..types import AIRoute, AIProviderResponse, AIRequest


class ToolExecutionAgent:
    def execute(self, session: Session, request: AIRequest, plan: AgentPlan) -> AIProviderResponse | None:
        if plan.action == "clarify":
            text = "Can you clarify what you want me to do?"
            if plan.language == "ta":
                text = "என்ன செய்ய வேண்டும் என்று கொஞ்சம் தெளிவாக சொல்லுங்கள்."
            return AIProviderResponse(
                text=text,
                provider="backend_tool",
                model=None,
                route="agent_clarify",
                reason=plan.reason,
                language=plan.language,
                intent=plan.intent,
                characters=len(text),
                raw={"tool_action": "clarify", "agent_plan": plan.metadata},
            )

        if plan.reason.startswith("pending_reminder_clarification_completed"):
            response = try_handle_pending_reminder(session, request)
            if response is not None:
                response.route = "agent_tool_reminder"
                response.reason = plan.reason
                response.raw.setdefault("agent_route", "agent_tool_reminder")
                return response

        if plan.action not in {
            "local_reply",
            "reminder",
            "task",
            "note",
            "document",
            "file_retrieval",
            "unsupported_tool",
            "memory",
            "settings",
        }:
            return None

        route = AIRoute(
            provider="backend_tool",
            model=None,
            route=plan.route,
            reason=plan.reason,
            language=plan.language,
            intent=plan.intent,
            max_output_tokens=0,
        )
        response = handle_backend_tool(session, request, route)
        response.route = plan.route
        response.reason = plan.reason
        response.raw.setdefault("agent_route", plan.route)
        response.raw.setdefault("agent_confidence", plan.confidence)
        return response
