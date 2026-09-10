from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class FreshnessDecision:
    scope: str
    requires_fresh_evidence: bool
    reason: str
    as_of: str


_HISTORICAL_RE = re.compile(
    r"\b(?:as\s+of|in|during|from|between)\s+(?:the\s+year\s+)?\d{4}\b|"
    r"\b(?:historical|history|former|previous|then|was|were)\b",
    re.IGNORECASE,
)
_EXPLICIT_CURRENT_RE = re.compile(
    r"\b(?:current(?:ly)?|latest|most\s+recent|today|now|present|incumbent|"
    r"as\s+of\s+today|right\s+now|breaking|live)\b",
    re.IGNORECASE,
)
_OFFICEHOLDER_RE = re.compile(
    r"\b(?:who\s+is|name\s+the|identify|officeholder|office\s+holder)\b.{0,100}\b"
    r"(?:president|prime\s+minister|chief\s+minister|governor|mayor|"
    r"chancellor|minister|secretary|leader|head\s+of\s+state)\b|"
    r"\b(?:president|prime\s+minister|chief\s+minister|governor|mayor|"
    r"chancellor|minister|secretary|leader|head\s+of\s+state)\s+of\s+"
    r"[A-Za-z][A-Za-z .'-]{1,80}\??$",
    re.IGNORECASE,
)
_CURRENT_FACT_RE = re.compile(
    r"\b(?:latest\s+news|breaking\s+news|live\s+score|stock\s+price|"
    r"crypto\s+price|gold\s+rate|exchange\s+rate|election\s+result|"
    r"weather|score\s+today)\b",
    re.IGNORECASE,
)


def resolve_freshness(message: str, *, now: datetime | None = None) -> FreshnessDecision:
    """Classify temporal scope without naming or guessing a current fact."""
    text = " ".join(str(message or "").split())
    as_of = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date().isoformat()
    if _HISTORICAL_RE.search(text):
        return FreshnessDecision("historical", False, "historical_or_as_of_request", as_of)
    if _EXPLICIT_CURRENT_RE.search(text) or _CURRENT_FACT_RE.search(text) or _OFFICEHOLDER_RE.search(text):
        reason = "explicit_current_request" if _EXPLICIT_CURRENT_RE.search(text) else (
            "implicit_current_officeholder" if _OFFICEHOLDER_RE.search(text) else "current_fact_request"
        )
        return FreshnessDecision("current", True, reason, as_of)
    return FreshnessDecision("unspecified", False, "no_temporal_freshness_signal", as_of)
