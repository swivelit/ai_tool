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


def _has_officeholder_subject(text: str) -> bool:
    """Recognize a role question even when a date follows the subject."""
    if _OFFICEHOLDER_RE.search(text):
        return True
    return bool(
        _OFFICEHOLDER_ROLE_RE.search(text)
        and re.search(r"\b(?:of|in)\b", text, re.IGNORECASE)
    )


def _parse_explicit_date(text: str) -> date | None:
    match = re.search(
        r"\b(?:as\s+of|on|from)\s+(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b",
        text, re.IGNORECASE,
    )
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
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
            ).date()
        except ValueError:
            return None
    return None


def _requested_date(text: str, now: datetime) -> str:
    explicit = _parse_explicit_date(text)
    if explicit:
        return explicit.isoformat()
    year = re.search(
        r"\b(?:as\s+of|in|during|from|between)\s+(?:the\s+year\s+)?(\d{4})\b",
        text, re.IGNORECASE,
    )
    if year:
        return year.group(1)
    return now.astimezone(timezone.utc).date().isoformat()


def _explicit_requested_date(text: str) -> date | None:
    return _parse_explicit_date(text)


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
    *,
    now: datetime | None = None,
) -> tuple[bool, dict[str, object] | None, str]:
    """Validate provider-supplied temporal evidence without guessing."""
    clock = now or datetime.now(timezone.utc)
    result_items = result if isinstance(result, list) else [result]
    dictionaries = [item for item in result_items if isinstance(item, dict)]
    if any(item.get("stale") is True or item.get("conflicting") is True for item in dictionaries):
        return False, None, "evidence_stale_or_conflicting"
    claims = {
        str(item.get(key)).strip()
        for item in dictionaries
        for key in ("claim", "officeholder", "current_value")
        if str(item.get(key) or "").strip()
    }
    if len(claims) > 1:
        return False, None, "evidence_stale_or_conflicting"
    payload = dictionaries[0] if dictionaries else None
    if not payload:
        return False, None, "retrieval_failed"
    source_url = str(payload.get("url") or "").strip()
    snippet = " ".join(str(payload.get("snippet") or "").split())
    title = " ".join(str(payload.get("title") or "").split())
    retrieved_at = str(payload.get("retrieved_at") or "").strip()
    provenance = str(payload.get("provenance") or payload.get("source") or "").strip()
    if not (re.match(r"^https?://\S+$", source_url) and title and snippet):
        return False, None, "evidence_missing_provenance"
    try:
        retrieved = datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
        if retrieved.tzinfo is None:
            retrieved = retrieved.replace(tzinfo=timezone.utc)
        retrieved = retrieved.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return False, None, "evidence_invalid_timestamp"
    age_seconds = (clock.astimezone(timezone.utc) - retrieved).total_seconds()
    if age_seconds < -300 or age_seconds > 86_400:
        return False, None, "evidence_timestamp_out_of_range"
    temporal_as_of = str(
        payload.get("temporal_as_of") or payload.get("as_of") or ""
    ).strip()
    try:
        claimed_date = date.fromisoformat(temporal_as_of)
    except (TypeError, ValueError):
        return False, None, "evidence_missing_temporal_support"
    freshness = resolve_freshness(query, now=clock)
    if freshness.scope == "future":
        return False, None, "future_temporal_scope_unavailable"
    if claimed_date.isoformat() != freshness.as_of:
        return False, None, "evidence_temporal_scope_mismatch"
    if (
        not provenance
        or payload.get("temporal_support") is not True
        or payload.get("relevant") is False
    ):
        return False, None, "evidence_missing_temporal_support"
    query_terms = {
        term.casefold() for term in re.findall(r"[A-Za-z]{3,}", query)
        if term.casefold() not in {
            "what", "who", "where", "when", "which", "the", "and", "today", "current",
        }
    }
    evidence_terms = set(re.findall(r"[A-Za-z]{3,}", f"{title} {snippet}".casefold()))
    if "cm" in query_terms:
        query_terms.update(("chief", "minister"))
    if "pm" in query_terms:
        query_terms.update(("prime", "minister"))
    if "tamilnadu" in query_terms:
        query_terms.update(("tamil", "nadu"))
    if _has_officeholder_subject(query):
        role_terms = set(re.findall(r"[A-Za-z]{2,}", query.casefold()))
        evidence_lower = f"{title} {snippet}".casefold()
        if "pm" in role_terms or ("prime" in role_terms and "minister" in role_terms):
            expected_roles = ("prime minister",)
        elif "cm" in role_terms or ("chief" in role_terms and "minister" in role_terms):
            expected_roles = ("chief minister",)
        else:
            expected_roles = tuple(
                role for role in ("president", "governor", "mayor", "chancellor")
                if role in role_terms
            )
        role_supported = (
            ("chief" in role_terms and "minister" in role_terms)
            or "cm" in role_terms
            or ("prime" in role_terms and "minister" in role_terms)
            or "pm" in role_terms
            or any(role in role_terms for role in ("president", "governor", "mayor", "chancellor"))
        )
        evidence_role_supported = (
            ("chief" in evidence_lower and "minister" in evidence_lower)
            or bool(re.search(r"\bcm\b", evidence_lower))
            or ("prime minister" in evidence_lower or bool(re.search(r"\bpm\b", evidence_lower)))
            or any(re.search(rf"\b{role}\b", evidence_lower) for role in ("president", "governor", "mayor", "chancellor"))
        )
        if expected_roles and not any(role in evidence_lower for role in expected_roles):
            evidence_role_supported = False
        if not role_supported or not evidence_role_supported:
            return False, None, "evidence_not_relevant"
        subject_terms = {
            term for term in query_terms
            if term not in {"please", "identify", "name", "tell", "me", "could", "you", "who", "what", "is", "the", "of", "current", "latest", "chief", "prime", "minister", "president", "governor", "mayor", "chancellor", "tamilnadu", "tamil", "nadu", "cm", "pm"}
            and len(term) >= 4
        }
        if subject_terms and not subject_terms.issubset(evidence_terms):
            return False, None, "evidence_not_relevant"
    if not query_terms.intersection(evidence_terms):
        return False, None, "evidence_not_relevant"
    return True, {
        "title": title[:256], "snippet": snippet[:4_000],
        "url": source_url[:2_000], "source": provenance[:128],
        "retrieved_at": retrieved_at[:128],
    }, "grounded_current_evidence"


def resolve_freshness(
    message: str,
    *,
    context: str = "",
    now: datetime | None = None,
) -> FreshnessDecision:
    """Classify temporal scope without naming or guessing a current fact."""
    text = " ".join(str(message or "").split())
    context_text = " ".join(str(context or "").split())
    subject_text = f"{text} {context_text}".strip()
    clock = now or datetime.now(timezone.utc)
    as_of = _requested_date(text, clock)
    historical = _HISTORICAL_RE.search(text)
    explicit_date = _explicit_requested_date(text)
    explicit_current = _EXPLICIT_CURRENT_RE.search(text)
    officeholder = _has_officeholder_subject(text)
    contextual_officeholder = bool(
        context_text
        and _OFFICEHOLDER_ROLE_RE.search(context_text)
        and re.search(r"\b(?:holds?|it|they|them|incumbent|office)\b", text, re.IGNORECASE)
    )
    current_subject = _has_current_subject(subject_text)
    current_signal = bool(
        explicit_current or _CURRENT_FACT_RE.search(text)
        or (officeholder and not historical)
        or contextual_officeholder
    )
    clock_date = clock.astimezone(timezone.utc).date()
    if explicit_date and officeholder:
        if explicit_date > clock_date:
            return FreshnessDecision("future", True, "future_requested_date", as_of)
        if explicit_date == clock_date:
            return FreshnessDecision("current", True, "current_requested_date", as_of)
        return FreshnessDecision("historical", False, "historical_requested_date", as_of)
    # Mixed questions still need fresh support for their current half.
    if historical and not explicit_current and not contextual_officeholder:
        return FreshnessDecision("historical", False, "historical_or_as_of_request", as_of)
    if current_signal and (current_subject or officeholder or contextual_officeholder):
        scope = "mixed" if historical else "current"
        reason = "mixed_current_historical_request" if scope == "mixed" else (
            "implicit_current_officeholder" if officeholder and not explicit_current else (
            "explicit_current_request" if explicit_current else "current_fact_request"
            )
        )
        return FreshnessDecision(scope, True, reason, as_of)
    if historical:
        return FreshnessDecision("historical", False, "historical_or_as_of_request", as_of)
    return FreshnessDecision("unspecified", False, "no_temporal_freshness_signal", as_of)
