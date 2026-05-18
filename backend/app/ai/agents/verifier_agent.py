from __future__ import annotations

import re

from ..agent_schemas import AgentPlan
from ..types import AIRequest


_MEDIA_GENERAL_QUERY_RE = re.compile(
    r"^(?:tell me about|describe|explain|what is|who is|enna|என்ன|பத்தி சொல்லு)\b|"
    r"\b(?:movie|film|series|book|news|actor|director|dhoom|padam)\b|படம்|சினிமா|பத்தி|செய்தி",
    re.I,
)


class VerifierAgent:
    def verify(self, request: AIRequest, plan: AgentPlan) -> AgentPlan:
        if plan.intent == "reminder" and _MEDIA_GENERAL_QUERY_RE.search(str(request.message or "")):
            return AgentPlan(
                action="provider_qa",
                intent="general",
                route="agent_provider_qa",
                category="Other",
                language=plan.language,
                confidence=0.99,
                reason="verifier_blocked_media_query_from_reminder",
                provider_allowed=True,
                metadata={**plan.metadata, "verifier_block": "media_query_not_reminder"},
            )
        if plan.action != "provider_qa" and plan.confidence < 0.55:
            return AgentPlan(
                action="clarify",
                intent=plan.intent,
                route="agent_clarify",
                category=plan.category,
                language=plan.language,
                confidence=plan.confidence,
                reason=f"{plan.reason}:low_confidence_clarification",
                provider_allowed=False,
                metadata=plan.metadata,
            )
        return plan
