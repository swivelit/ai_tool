from __future__ import annotations

import os
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class QueryRewriteResult:
    original_question: str
    canonical_question: str
    changed: bool
    reason: str = "heuristic"


class QueryRewriterAgent:
    """Request-path safe deterministic query canonicalizer."""

    _SECTION_80C_RE = re.compile(r"(?i)\b(?:what'?s|what is|explain|tell me about).*\b(?:section\s*)?80c\b")

    def rewrite(self, question: str) -> QueryRewriteResult:
        original = str(question or "").strip()
        if not original:
            return QueryRewriteResult(original, original, False, "empty")
        normalized = re.sub(r"\s+", " ", original).strip()
        if self._SECTION_80C_RE.search(normalized) and not re.search(r"(?i)\b(my|our|latest|today|current|new)\b", normalized):
            return QueryRewriteResult(original, "what is section 80c deduction", True)
        if os.getenv("GLOBAL_QA_QUERY_REWRITER_MODEL_ENABLED", "").strip().lower() in {"1", "true", "yes"}:
            return QueryRewriteResult(original, normalized, normalized != original, "model_hook_disabled")
        return QueryRewriteResult(original, normalized, normalized != original, "normalized_whitespace")
