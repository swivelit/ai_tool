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
    # For mixed requests, ``as_of`` is the clock date used to validate the
    # current claim. Keep the explicitly requested historical period separate
    # so retrieval and reporting cannot confuse the two.
    historical_as_of: str | None = None


_HISTORICAL_RE = re.compile(
    r"\b(?:as\s+of|in|during|from|between)\s+(?:the\s+year\s+)?\d{4}\b|"
    r"\b\d{4}\s*(?:-ல்|ல்|la|il)(?=\s|$|[?.!,;])|"
    r"\b(?:historical|history|former|previous|back\s+then|at\s+that\s+time)\b|"
    r"(?:முன்னாள்|முந்தைய|வரலாற்று|அப்போது)",
    re.IGNORECASE,
)
_EXPLICIT_CURRENT_RE = re.compile(
    r"\b(?:current(?:ly)?|latest|most\s+recent|today|now|present|incumbent|"
    r"as\s+of\s+today|right\s+now|breaking|live)\b",
    re.IGNORECASE,
)
_LOCALIZED_CURRENT_RE = re.compile(
    r"\b(?:ippo|ippa|ippove|current|present|latest)\b|"
    r"(?:தற்போதைய|இப்போது|இப்போ|இன்றைய|நடப்பு)",
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
_TAMIL_OFFICEHOLDER_RE = re.compile(
    r"(?:முதலமைச்சர்|பிரதமர்|ஆளுநர்).*(?:யார்|தற்போதைய|இப்போது|இன்றைய)|"
    r"(?:யார்|தற்போதைய|இப்போது|இன்றைய).*(?:முதலமைச்சர்|பிரதமர்|ஆளுநர்)",
    re.IGNORECASE,
)
_TANGLISH_OFFICEHOLDER_RE = re.compile(
    r"\b(?:cm|chief\s+minister|pm|prime\s+minister|governor)\b"
    r".*\b(?:yaar|yaaru|who|ippo|ippa|current|present|latest)\b|"
    r"\b(?:yaar|yaaru|who|ippo|ippa|current|present|latest)\b.*"
    r"\b(?:cm|chief\s+minister|pm|prime\s+minister|governor)\b",
    re.IGNORECASE,
)


def _has_officeholder_subject(text: str) -> bool:
    """Recognize identifying a role, not merely discussing that role."""
    if _TAMIL_OFFICEHOLDER_RE.search(text) or _TANGLISH_OFFICEHOLDER_RE.search(text):
        return True
    if _OFFICEHOLDER_RE.search(text):
        return True
    if not _OFFICEHOLDER_ROLE_RE.search(text):
        return False
    if re.search(
        r"\b(?:who|name|identify|appointed|holds?|incumbent|officeholder|current)\b",
        text, re.IGNORECASE,
    ):
        return True
    if re.search(
        r"\b(?:explain|role|duties|responsibilities|constitution|meaning)\b",
        text, re.IGNORECASE,
    ):
        return False
    return bool(re.search(
        r"\b(?:president|prime\s+minister|chief\s+minister|governor|mayor|"
        r"chancellor|minister|secretary|leader|cm|pm|mp|mla)\s+of\s+[A-Za-z]",
        text, re.IGNORECASE,
    ))


def _normalized_terms(value: str) -> set[str]:
    normalized = re.sub(r"\btamilnadu\b", "tamil nadu", value.casefold())
    return set(re.findall(r"[a-z]{3,}", normalized))


def _requested_entity_terms(query: str) -> set[str]:
    match = re.search(
        r"\b(?:president|prime\s+minister|chief\s+minister|governor|mayor|"
        r"chancellor|minister|secretary|leader|cm|pm|mp|mla)\s+of\s+(.+?)"
        r"(?=\s+(?:as\s+of|on|from|now|today|and)\b|[?.!,;]|$)",
        query, re.IGNORECASE,
    )
    if match:
        return _normalized_terms(match.group(1))
    # The intent classifier already understands these forms. Keep evidence
    # matching aligned with it rather than requiring English filler words in a
    # Tamil/Tanglish question.
    folded = query.casefold()
    if "தமிழ்நா" in query or re.search(r"\btamil\s*nadu\b", folded):
        return {"tamil", "nadu"}
    if "இந்தியா" in query or re.search(r"\bindia\b", folded):
        return {"india"}
    return set()


def _requested_role_terms(query: str) -> tuple[str, ...]:
    folded = query.casefold()
    if "முதலமைச்சர்" in query or re.search(r"\b(?:cm|chief\s+minister)\b", folded):
        return ("chief minister",)
    if "பிரதமர்" in query or re.search(r"\b(?:pm|prime\s+minister)\b", folded):
        return ("prime minister",)
    if "ஆளுநர்" in query or re.search(r"\bgovernor\b", folded):
        return ("governor",)
    return ()


def _claim_answer_value(payload: dict[str, object], claim: str) -> str:
    for key in ("answer_value", "officeholder", "current_value"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    match = re.search(
        r"^(.+?)\s+(?:is|was|has\s+been|remains)\s+(?:the\s+)?"
        r"(?:current\s+)?(?:chief\s+minister|prime\s+minister|governor|president|mayor|cm|pm)\b",
        claim, re.IGNORECASE,
    )
    if match:
        return match.group(1).strip(" ,;:")
    match = re.search(
        r"(?:chief\s+minister|prime\s+minister|governor|president|mayor|cm|pm)\s+of\s+.+?\s+"
        r"(?:is|was|has\s+been|remains)\s+(.+)$", claim, re.IGNORECASE,
    )
    return match.group(1).strip(" ,;:") if match else ""


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
        r"\b(?:as\s+of|in|during|from|between)\s+(?:the\s+year\s+)?(\d{4})\b|"
        r"\b(\d{4})\s*(?:-ல்|ல்|la|il)(?=\s|$|[?.!,;])",
        text, re.IGNORECASE,
    )
    if year:
        return year.group(1) or year.group(2)
    return now.astimezone(timezone.utc).date().isoformat()


def _explicit_requested_date(text: str) -> date | None:
    return _parse_explicit_date(text)


def _localized_requested_year(text: str) -> int | None:
    match = re.search(r"\b(\d{4})\s*(?:-ல்|ல்|la|il)(?=\s|$|[?.!,;])", text, re.IGNORECASE)
    return int(match.group(1)) if match else None


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
    """Accept one relevant, supported current claim from a bounded result set."""
    clock = now or datetime.now(timezone.utc)
    result_items = result if isinstance(result, list) else [result]
    dictionaries = [item for item in result_items if isinstance(item, dict)]
    if not dictionaries:
        return False, None, "retrieval_failed"
    if any(
        item.get("stale") is True or item.get("conflicting") is True
        for item in dictionaries
    ):
        return False, None, "evidence_stale_or_conflicting"

    valid: list[tuple[dict[str, object], dict[str, object]]] = []
    reasons: list[str] = []
    for item in dictionaries:
        accepted, normalized, reason = _validate_current_evidence_item(
            query, item, now=clock,
        )
        if accepted and normalized is not None:
            valid.append((item, normalized))
        else:
            reasons.append(reason)
    if not valid:
        # Preserve the most useful failure category for the deterministic
        # response while never allowing an irrelevant first result to hide a
        # later usable result.
        for preferred in (
            "evidence_stale_or_conflicting", "evidence_claim_not_supported",
            "evidence_not_relevant", "evidence_missing_answer_value",
        ):
            if preferred in reasons:
                return False, None, preferred
        return False, None, reasons[0] if reasons else "retrieval_failed"

    answer_values = {
        frozenset(_normalized_terms(str(
            item.get("officeholder") or item.get("current_value") or item.get("claim") or ""
        )))
        for item, _normalized in valid
        if str(
            item.get("officeholder") or item.get("current_value") or item.get("claim") or ""
        ).strip()
    }
    if len(answer_values) > 1:
        return False, None, "evidence_stale_or_conflicting"
    return True, valid[0][1], "grounded_current_evidence"


def _validate_current_evidence_item(
    query: str,
    result: object,
    *,
    now: datetime | None = None,
) -> tuple[bool, dict[str, object] | None, str]:
    """Validate provider-supplied temporal evidence without guessing."""
    clock = now or datetime.now(timezone.utc)
    payload = result if isinstance(result, dict) else None
    if not payload:
        return False, None, "retrieval_failed"
    source_url = str(payload.get("url") or "").strip()
    snippet = " ".join(str(payload.get("snippet") or "").split())
    claim = " ".join(str(payload.get("claim") or "").split())
    synthesis = " ".join(str(payload.get("synthesis") or "").split())
    title = " ".join(str(payload.get("title") or "").split())
    retrieved_at = str(payload.get("retrieved_at") or "").strip()
    provenance = str(payload.get("provenance") or payload.get("source") or "").strip()
    # ``claim`` is the concise, citation-bound relation extracted by the
    # adapter; ``synthesis`` is never used as evidence.  Responses source
    # metadata does not consistently include a snippet, so a cited claim is
    # allowed to use that bounded relation while retaining its distinct
    # ``cited_synthesis`` provenance.  When a source passage is present it is
    # authoritative for entity/value/temporal checks and can reject a stale
    # or contradictory generated assertion.
    support_text = snippet or claim
    if not (re.match(r"^https?://\S+$", source_url) and title and support_text):
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
    temporal_ok = payload.get("temporal_support") is True or (
        payload.get("temporal_support") == "completed_live_search"
        and payload.get("search_call_completed") is True
    )
    if not provenance or not temporal_ok or payload.get("relevant") is False:
        return False, None, "evidence_missing_temporal_support"
    claim_for_temporal_checks = " ".join((snippet or claim).split())
    if re.search(r"\b(?:not|never|former|previous|ex[- ]|no longer)\b", claim_for_temporal_checks, re.I):
        return False, None, "evidence_claim_not_supported"
    if freshness.scope == "current":
        dated_prefix = re.search(
            r"^(?:in|during|as\s+of)\s+(\d{4})\b", claim_for_temporal_checks, re.I,
        )
        if dated_prefix and dated_prefix.group(1) != freshness.as_of[:4]:
            return False, None, "evidence_temporal_scope_mismatch"
        if re.search(
            r"\bwas\s+(?:the\s+)?(?:current\s+)?(?:chief|prime)\s+minister\b",
            claim_for_temporal_checks, re.I,
        ) and not re.search(r"\b(?:today|now|currently|present)\b", claim_for_temporal_checks, re.I):
            return False, None, "evidence_temporal_scope_mismatch"
    query_terms = {
        term.casefold() for term in re.findall(r"[A-Za-z]{3,}", query)
        if term.casefold() not in {
            "what", "who", "where", "when", "which", "the", "and", "today", "current",
        }
    }
    query_terms.update(_normalized_terms(" ".join(_requested_entity_terms(query))))
    for role in _requested_role_terms(query):
        query_terms.update(_normalized_terms(role))
    evidence_terms = _normalized_terms(support_text)
    evidence_lower = support_text.casefold()
    if "cm" in query_terms:
        query_terms.update(("chief", "minister"))
    if "pm" in query_terms:
        query_terms.update(("prime", "minister"))
    if "tamilnadu" in query_terms:
        query_terms.update(("tamil", "nadu"))
    if _has_officeholder_subject(query):
        role_terms = set(re.findall(r"[A-Za-z]{2,}", query.casefold()))
        requested_roles = _requested_role_terms(query)
        if "pm" in role_terms or ("prime" in role_terms and "minister" in role_terms):
            expected_roles = ("prime minister",)
        elif "cm" in role_terms or ("chief" in role_terms and "minister" in role_terms):
            expected_roles = ("chief minister",)
        else:
            expected_roles = tuple(
                role for role in ("president", "governor", "mayor", "chancellor")
                if role in role_terms
            )
        role_supported = bool(requested_roles) or (
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
        if "முதலமைச்சர்" in query and "முதலமைச்சர்" in support_text:
            evidence_role_supported = True
        if "பிரதமர்" in query and "பிரதமர்" in support_text:
            evidence_role_supported = True
        if requested_roles:
            expected_roles = requested_roles
        if expected_roles and not any(role in evidence_lower for role in expected_roles) and not (
            "chief minister" in expected_roles and "முதலமைச்சர்" in support_text
        ) and not (
            "chief minister" in expected_roles and bool(re.search(r"\bcm\b", evidence_lower))
        ) and not (
            "prime minister" in expected_roles and "பிரதமர்" in support_text
        ) and not (
            "prime minister" in expected_roles and bool(re.search(r"\bpm\b", evidence_lower))
        ):
            evidence_role_supported = False
        if not role_supported or not evidence_role_supported:
            return False, None, (
                "evidence_claim_not_supported"
                if snippet and payload.get("claim_support_type") == "cited_synthesis"
                else "evidence_not_relevant"
            )
        entity_terms = _requested_entity_terms(query)
        entity_supported = entity_terms.issubset(evidence_terms)
        if "தமிழ்நாடு" in query or "தமிழ்நா" in query:
            entity_supported = entity_supported or bool(re.search(r"தமிழ்நா", support_text))
        if entity_terms and not entity_supported:
            return False, None, (
                "evidence_claim_not_supported"
                if snippet and payload.get("claim_support_type") == "cited_synthesis"
                else "evidence_not_relevant"
            )
        claim_text = claim or snippet
        answer_value = _claim_answer_value(payload, claim_text)
        if not answer_value:
            return False, None, "evidence_missing_answer_value"
        value_terms = _normalized_terms(answer_value)
        value_supported = bool(value_terms) and value_terms.issubset(evidence_terms)
        if any(ord(char) > 127 for char in answer_value):
            value_supported = answer_value.casefold() in support_text.casefold()
        if not value_supported:
            return False, None, (
                "evidence_claim_not_supported"
                if snippet and payload.get("claim_support_type") == "cited_synthesis"
                else "evidence_missing_answer_value"
            )
        # Keep the source title separate from the body. A matching title is
        # metadata about the page, not proof that the body associates the
        # requested entity with the identified value.
        # A page title is provenance metadata, not evidence that the body
        # associates the requested entity with the answer value. In particular,
        # a matching title plus a contradictory body must never pass.
        support_basis = snippet or claim
        support_clauses = re.split(r"(?<=[!?;])\s+|\n+", support_basis)
        def clause_value_supported(clause: str) -> bool:
            if any(ord(char) > 127 for char in answer_value):
                return answer_value.casefold() in clause.casefold()
            return value_terms.issubset(_normalized_terms(clause))

        if not any(
            clause_value_supported(clause)
            and (
                not entity_terms
                or entity_terms.issubset(_normalized_terms(clause))
                or (("தமிழ்நாடு" in query or "தமிழ்நா" in query) and bool(re.search(r"தமிழ்நா", clause)))
            )
            and (
                any(role in clause.casefold() for role in expected_roles)
                or ("cm" in role_terms and bool(re.search(r"\b(?:cm|chief\s+minister)\b", clause, re.I)))
                or ("pm" in role_terms and bool(re.search(r"\b(?:pm|prime\s+minister)\b", clause, re.I)))
                or ("chief minister" in expected_roles and "முதலமைச்சர்" in clause)
                or ("prime minister" in expected_roles and "பிரதமர்" in clause)
            )
            for clause in support_clauses
        ):
            return False, None, "evidence_claim_not_supported"
        subject_terms = {
            term for term in query_terms
            if term not in {
                "please", "identify", "name", "tell", "me", "could", "you",
                "who", "what", "is", "the", "of", "current", "latest", "now",
                "today", "chief", "prime", "minister", "president", "governor",
                "mayor", "chancellor", "tamilnadu", "tamil", "nadu", "cm", "pm",
                # Common Tanglish question and temporal particles are
                # instructions about the lookup, not entity constraints.
                "la", "il", "ippo", "ippa", "yaar", "yaaru",
            }
            and len(term) >= 4
        }
        if subject_terms and not subject_terms.issubset(evidence_terms):
            return False, None, "evidence_not_relevant"
    if not query_terms.intersection(evidence_terms) and not _has_officeholder_subject(query):
        return False, None, "evidence_not_relevant"
    return True, {
        "title": title[:256], "snippet": snippet[:4_000],
        **({"claim": claim[:1_000], "answer_value": answer_value[:256]} if claim else {}),
        **({"synthesis": synthesis[:4_000]} if synthesis else {}),
        "url": source_url[:2_000], "source": provenance[:128],
        "retrieved_at": retrieved_at[:128],
        "sources": payload.get("sources") if isinstance(payload.get("sources"), list) else [],
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
    localized_year = _localized_requested_year(text)
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
    if localized_year is not None and officeholder:
        if localized_year > clock_date.year:
            return FreshnessDecision("future", True, "future_requested_year", str(localized_year))
        if localized_year < clock_date.year:
            if explicit_current or _LOCALIZED_CURRENT_RE.search(text):
                return FreshnessDecision(
                    "mixed", True, "mixed_current_historical_request",
                    clock_date.isoformat(), str(localized_year),
                )
            return FreshnessDecision("historical", False, "historical_requested_year", str(localized_year))
        # A localized year equal to the clock year is not a completed
        # historical period. Current factual questions still need evidence,
        # and validation uses the full clock date rather than just the year.
        return FreshnessDecision(
            "current", True, "current_requested_year", clock_date.isoformat(),
        )
    if explicit_date and officeholder:
        if explicit_current and explicit_date != clock_date:
            return FreshnessDecision("mixed", True, "mixed_current_historical_request", clock_date.isoformat())
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
