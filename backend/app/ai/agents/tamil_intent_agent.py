from __future__ import annotations

import re
from typing import Optional

from ..agent_schemas import AgentIntentResult
from ..intent import classify_intent
from ..tools import classify_folder_category
from ..types import AIRequest


_TAMIL_RE = re.compile(r"[\u0b80-\u0bff]")
_TANGLISH_RE = re.compile(
    r"\b(?:enna|ennaikku|epdi|eppadi|iruka|irukka|iruku|venum|vena|pannu|pannunga|"
    r"sollu|sollunga|pesu|pesunga|theriyala|seri|sapadu|saapadu|nan|naan|unga|"
    r"ungalukku|ennoda|naalaikku|nalai|nethu|naethu|inniku|kaalai|maalai|padam|"
    r"aakki|akki|vai|folder\s+la|save\s+pannu)\b",
    re.I,
)
_GENERAL_KNOWLEDGE_RE = re.compile(
    r"^(?:tell me about|describe|explain|what is|who is|enna|என்ன|பத்தி சொல்லு)\b|"
    r"\b(?:movie|film|series|book|news|actor|director|dhoom|padam)\b|படம்|சினிமா|பத்தி|செய்தி",
    re.I,
)


class TamilIntentAgent:
    """Rules-first intent detector for Tamil, Tanglish, and mixed commands."""

    def classify(self, request: AIRequest, *, pending_reminder: Optional[dict[str, str]] = None) -> AgentIntentResult:
        message = str(request.message or "").strip()
        language = self._language(message, request.reply_language)
        decision = classify_intent(message)
        if _GENERAL_KNOWLEDGE_RE.search(message) and decision.intent not in {
            "profile",
            "routine",
            "settings",
            "capabilities",
        }:
            return AgentIntentResult(
                intent="general",
                category="Other",
                language=language,
                confidence=0.96,
                reason="general_knowledge_guard",
                requires_provider=True,
                metadata={"pending_reminder_blocked": bool(pending_reminder)},
            )

        confidence = 0.92 if decision.route == "backend_tool" else 0.72
        if decision.intent in {"greeting", "thanks", "capabilities"}:
            confidence = 0.99
        if decision.intent in {"reminder", "note", "task", "document", "file_retrieval", "creative_tool"}:
            confidence = 0.95
        return AgentIntentResult(
            intent=decision.intent,
            category=classify_folder_category(message),
            language=language,
            confidence=confidence,
            reason=decision.reason,
            requires_provider=decision.route not in {"backend_tool", "blocked_live_data", "safety"},
            metadata={"intent_route": decision.route},
        )

    @staticmethod
    def _language(message: str, reply_language: Optional[str]) -> str:
        requested = str(reply_language or "").strip().lower()
        if requested in {"ta", "tamil", "mixed", "tanglish"}:
            return "ta"
        if requested in {"en", "english"} and not (_TAMIL_RE.search(message) or _TANGLISH_RE.search(message)):
            return "en"
        if _TAMIL_RE.search(message) or _TANGLISH_RE.search(message):
            return "ta"
        return "en"
