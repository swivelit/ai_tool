from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlmodel import Session


@dataclass(frozen=True)
class CacheWriteDecision:
    record: bool
    reason: str = "ok"


class CacheWriterAgent:
    def should_record(self, question: str, answer: str) -> CacheWriteDecision:
        from ...global_qa_cache import is_cacheable_global_question

        if not is_cacheable_global_question(question, answer):
            return CacheWriteDecision(False, "not_cacheable")
        return CacheWriteDecision(True)

    def record_provider_answer(
        self,
        session: Session,
        *,
        user_id: object,
        question: str,
        answer: str,
        model_used: Optional[str],
        request_id: Optional[str] = None,
    ) -> dict:
        from ...global_qa_cache import record_backend_openai_answer

        decision = self.should_record(question, answer)
        if not decision.record:
            return {"ok": False, "skipped": True, "reason": decision.reason}
        return record_backend_openai_answer(session, user_id, question, answer, model_used, request_id=request_id)
