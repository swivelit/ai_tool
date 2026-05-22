from __future__ import annotations

from dataclasses import dataclass

from ... import global_qa_cache


@dataclass(frozen=True)
class PrivacySanitizerResult:
    text: str
    safe_for_global: bool
    safe_for_user: bool
    changed: bool
    reason: str = "regex"


class PrivacySanitizerAgent:
    def sanitize_question(self, text: str) -> PrivacySanitizerResult:
        raw = str(text or "")
        redacted = global_qa_cache.redact_sensitive_text(raw)
        private = global_qa_cache.is_private_or_personal_question(raw)
        changed_meaning = global_qa_cache._redaction_changed_meaning(raw, redacted)
        safe = bool(redacted.strip()) and not private and not changed_meaning
        return PrivacySanitizerResult(redacted, safe_for_global=safe, safe_for_user=safe, changed=redacted != raw)

    def sanitize_answer(self, text: str) -> PrivacySanitizerResult:
        raw = str(text or "")
        redacted = global_qa_cache.redact_sensitive_text(raw)
        private = global_qa_cache.is_private_or_personal_question(raw)
        return PrivacySanitizerResult(redacted, safe_for_global=not private, safe_for_user=not private, changed=redacted != raw)
