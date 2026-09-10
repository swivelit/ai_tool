from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timezone


@dataclass(frozen=True)
class FreshnessDecision:
    scope: str
    requires_fresh_evidence: bool
    reason: str
    as_of: str


_HISTORICAL_RE = re.compile(
    r"\b(?:as\s+of|in|during|from|between)\s+(?:the\s+year\s+)?\d{4}\b|"
    r"\b(?:historical|history|former|previous|back\s+then|at\s+that\s+time)\b",
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
    r"chancellor|minister|secretary|leader|head\s+of\s+state|cm|pm|mp|mla)\b|"
    r"\b(?:president|prime\s+minister|chief\s+minister|governor|mayor|"
    r"chancellor|minister|secretary|leader|head\s+of\s+state|cm|pm|mp|mla)\s+of\s+"
    r"[A-Za-z][A-Za-z .'-]{1,80}\??$",
    re.IGNORECASE,
)
_OFFICEHOLDER_ROLE_RE = re.compile(
    r"\b(?:chief\s+minister|prime\s+minister|president|governor|mayor|"
    r"chancellor|minister|secretary|leader|head\s+of\s+state|cm|pm|mp|mla)\b",
    re.IGNORECASE,
)
_CURRENT_FACT_RE = re.compile(
    r"\b(?:latest\s+news|breaking\s+news|live\s+score|stock\s+price|"
    r"crypto\s+price|gold\s+rate|exchange\s+rate|election\s+result|"
    r"weather|score\s+today)\b",
    re.IGNORECASE,
)


def _requested_date(text: str, now: datetime) -> str:
    full = re.search(
        r"\b(?:as\s+of|on|from)\s+(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b",
        text, re.IGNORECASE,
    )
    if full:
        try:
            return date(int(full.group(1)), int(full.group(2)), int(full.group(3))).isoformat()
        except ValueError:
            pass
    month_names = (
        "january|february|march|april|may|june|july|august|september|"
        "october|november|december"
    )
    named = re.search(
        rf"\b(?:as\s+of|on|from)\s+({month_names})\s+(\d{{1,2}}),?\s+(\d{{4}})\b",
        text, re.IGNORECASE,
    )
    if named:
        try:
            return datetime.strptime(
                f"{named.group(1)} {named.group(2)} {named.group(3)}", "%B %d %Y"
            ).date().isoformat()
        except ValueError:
            pass
    year = re.search(
        r"\b(?:as\s+of|in|during|from|between)\s+(?:the\s+year\s+)?(\d{4})\b",
        text, re.IGNORECASE,
    )
    if year:
        return year.group(1)
    return now.astimezone(timezone.utc).date().isoformat()


def _has_current_subject(text: str) -> bool:
    if _OFFICEHOLDER_ROLE_RE.search(text) or _CURRENT_FACT_RE.search(text):
        return True
    return bool(re.search(
        r"\b(?:news|version|release|appointment|appointed|election|result|"
        r"price|rate|score|weather|forecast|status|policy|rule|event|happening)\b",
        text, re.IGNORECASE,
    ))


def validate_current_evidence(
    query: str,
    result: object,
) -> tuple[bool, dict[str, object] | None, str]:
    """Validate provider-supplied temporal evidence without guessing."""
    result_items = result if isinstance(result, list) else [result]
    if any(
        isinstance(item, dict)
        and (item.get("stale") is True or item.get("conflicting") is True)
        for item in result_items
    ):
        return False, None, "evidence_stale_or_conflicting"
    payload = next((item for item in result_items if isinstance(item, dict)), None)
    if not payload:
        return False, None, "retrieval_failed"
    source_url = str(payload.get("url") or "").strip()
    snippet = " ".join(str(payload.get("snippet") or "").split())
    title = " ".join(str(payload.get("title") or "").split())
    retrieved_at = str(payload.get("retrieved_at") or "").strip()
    provenance = str(payload.get("provenance") or payload.get("source") or "").strip()
    if not (re.match(r"^https?://\S+$", source_url) and title and snippet):
        return False, None, "evidence_missing_provenance"
    if not retrieved_at or not provenance or payload.get("temporal_support") is not True:
        return False, None, "evidence_missing_temporal_support"
    if payload.get("relevant") is not True:
        query_terms = {
            term.casefold() for term in re.findall(r"[A-Za-z]{3,}", query)
            if term.casefold() not in {
                "what", "who", "where", "when", "which", "the", "and", "today", "current",
            }
        }
        evidence_terms = set(re.findall(r"[A-Za-z]{3,}", f"{title} {snippet}".casefold()))
        if not query_terms.intersection(evidence_terms):
            return False, None, "evidence_not_relevant"
    return True, {
        "title": title[:256], "snippet": snippet[:4_000],
        "url": source_url[:2_000], "source": provenance[:128],
        "retrieved_at": retrieved_at[:128],
    }, "grounded_current_evidence"


def resolve_freshness(message: str, *, now: datetime | None = None) -> FreshnessDecision:
    """Classify temporal scope without naming or guessing a current fact."""
    text = " ".join(str(message or "").split())
    clock = now or datetime.now(timezone.utc)
    as_of = _requested_date(text, clock)
    if _HISTORICAL_RE.search(text):
        return FreshnessDecision("historical", False, "historical_or_as_of_request", as_of)
    explicit_current = _EXPLICIT_CURRENT_RE.search(text)
    officeholder = _OFFICEHOLDER_RE.search(text)
    if officeholder or _CURRENT_FACT_RE.search(text) or (
        explicit_current and _has_current_subject(text)
    ):
        reason = "implicit_current_officeholder" if officeholder and not explicit_current else (
            "explicit_current_request" if explicit_current else "current_fact_request"
        )
        return FreshnessDecision("current", True, reason, as_of)
    return FreshnessDecision("unspecified", False, "no_temporal_freshness_signal", as_of)
