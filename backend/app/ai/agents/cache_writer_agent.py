from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlmodel import Session


@dataclass(frozen=True)
class CacheWriteDecision:
    record: bool
    reason: str = "ok"
    safe_question: str = ""
    safe_answer: str = ""
    scope: str = "global_and_user"


class CacheWriterAgent:
    def should_record(self, question: str, answer: str) -> CacheWriteDecision:
        from ...global_qa_cache import is_cacheable_global_question
        from .privacy_sanitizer_agent import PrivacySanitizerAgent

        sanitizer = PrivacySanitizerAgent()
        safe_question = sanitizer.sanitize_question(question)
        safe_answer = sanitizer.sanitize_answer(answer)
        if not safe_question.safe_for_user or not safe_answer.safe_for_user:
            return CacheWriteDecision(False, "unsafe_after_sanitization", safe_question.text, safe_answer.text)
        if not safe_question.safe_for_global or not safe_answer.safe_for_global:
            return CacheWriteDecision(False, "global_cache_sanitization_rejected", safe_question.text, safe_answer.text, "user")
        if not is_cacheable_global_question(safe_question.text, safe_answer.text):
            return CacheWriteDecision(False, "not_cacheable", safe_question.text, safe_answer.text)
        return CacheWriteDecision(True, "ok", safe_question.text, safe_answer.text)

    def record_provider_answer(
        self,
        session: Session,
        *,
        user_id: object,
        question: str,
        answer: str,
        model_used: Optional[str],
        request_id: Optional[str] = None,
        cache_compatibility_hash: Optional[str] = None,
        reply_language: Optional[str] = None,
    ) -> dict:
        from ...global_qa_cache import _record_backend_openai_answer_impl

        decision = self.should_record(question, answer)
        if not decision.record:
            return {"ok": False, "skipped": True, "reason": decision.reason}
        return _record_backend_openai_answer_impl(
            session,
            user_id,
            decision.safe_question or question,
            decision.safe_answer or answer,
            model_used,
            request_id=request_id,
            cache_compatibility_hash=cache_compatibility_hash,
            reply_language=reply_language,
        )
