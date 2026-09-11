from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.parse import quote
import urllib.request


class LiveSearchConfigurationError(ValueError):
    """Raised for an invalid paid live-search configuration."""


@dataclass(frozen=True)
class LiveSearchConfig:
    enabled: bool = False
    provider: str = "openai"
    model: str = "gpt-4.1-mini"
    timeout_seconds: float = 15.0
    max_calls_per_turn: int = 1
    max_output_tokens: int = 1000


@dataclass(frozen=True)
class WebSearchResult:
    enabled: bool
    results: list[dict]
    reason: str = "disabled"
    usage: dict[str, int | float] | None = None
    # Bounded, operator-only diagnostics.  This is deliberately separate from
    # ``results``: an extraction failure must not become evidence, but it must
    # remain diagnosable without repeating a paid request.
    diagnostics: dict[str, Any] | None = None


_ROLE_RE = r"chief\s+minister|prime\s+minister|governor|president|mayor|cm|pm"
_WORD_RE = r"[\w\u0080-\uffff][\w\u0080-\uffff.'’\-]*"
_VALUE_RE = rf"(?P<value>{_WORD_RE}(?:\s+{_WORD_RE}){{0,7}})"


_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}
_PAID_TIERS = frozenset({"lite", "standard", "pro"})


def _bool_value(environ: Mapping[str, str], name: str, default: bool) -> bool:
    raw = str(environ.get(name, "true" if default else "false") or "").strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise LiveSearchConfigurationError(f"{name} must be a boolean")


def _bounded_number(
    environ: Mapping[str, str], name: str, default: str, *, integer: bool,
    minimum: int | float, maximum: int | float,
) -> int | float:
    raw = str(environ.get(name, default) or "").strip()
    try:
        value: int | float = int(raw) if integer else float(raw)
    except (TypeError, ValueError) as exc:
        raise LiveSearchConfigurationError(f"{name} must be numeric") from exc
    if value < minimum or value > maximum:
        raise LiveSearchConfigurationError(
            f"{name} must be between {minimum} and {maximum}"
        )
    return value


def live_search_config(
    environ: Mapping[str, str] | None = None, *, require_key: bool = False,
) -> LiveSearchConfig:
    env = os.environ if environ is None else environ
    enabled = _bool_value(env, "WEB_LIVE_SEARCH_ENABLED", False)
    provider = str(env.get("WEB_LIVE_SEARCH_PROVIDER", "openai") or "").strip().lower()
    model = str(env.get("WEB_LIVE_SEARCH_MODEL", "gpt-4.1-mini") or "").strip()
    if provider != "openai":
        raise LiveSearchConfigurationError("WEB_LIVE_SEARCH_PROVIDER must be openai")
    if model != "gpt-4.1-mini":
        raise LiveSearchConfigurationError("WEB_LIVE_SEARCH_MODEL must be gpt-4.1-mini")
    timeout = float(_bounded_number(
        env, "WEB_LIVE_SEARCH_TIMEOUT_SECONDS", "15", integer=False,
        minimum=1, maximum=60,
    ))
    max_calls = int(_bounded_number(
        env, "WEB_LIVE_SEARCH_MAX_CALLS_PER_TURN", "1", integer=True,
        minimum=1, maximum=1,
    ))
    output_tokens = int(_bounded_number(
        env, "WEB_LIVE_SEARCH_MAX_OUTPUT_TOKENS", "1000", integer=True,
        minimum=128, maximum=4000,
    ))
    if enabled and require_key and not str(env.get("OPENAI_API_KEY", "") or "").strip():
        raise LiveSearchConfigurationError(
            "OPENAI_API_KEY must be configured when WEB_LIVE_SEARCH_ENABLED is true"
        )
    return LiveSearchConfig(
        enabled=enabled, provider=provider, model=model,
        timeout_seconds=timeout, max_calls_per_turn=max_calls,
        max_output_tokens=output_tokens,
    )


def paid_live_search_allowed(swico_tier: str | None) -> bool:
    """Server-side entitlement check; client metadata is intentionally ignored."""
    return str(swico_tier or "").strip().lower() in _PAID_TIERS


def _value(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(key, default)
    return getattr(value, key, default)


class WebSearchAgent:
    """Legacy Free helper plus the paid Responses web-search adapter."""

    def __init__(self, *, client: Any | None = None, clock: Any | None = None) -> None:
        self._client = client
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def search(self, query: str) -> WebSearchResult:
        config = live_search_config()
        if config.enabled:
            return self._paid_search(query, config)
        return self._legacy_wikipedia_search(query)

    def _paid_search(self, query: str, config: LiveSearchConfig) -> WebSearchResult:
        raw_query = " ".join(str(query or "").split()).strip()
        if not raw_query:
            return WebSearchResult(True, [], "empty_query")
        api_key = str(os.getenv("OPENAI_API_KEY", "") or "").strip()
        if not api_key:
            return WebSearchResult(True, [], "missing_api_key")
        try:
            client = self._client
            if client is None:
                import openai
                client = openai.OpenAI(
                    api_key=api_key, timeout=config.timeout_seconds, max_retries=0,
                )
            response = client.responses.create(
                model=config.model,
                tools=[{"type": "web_search", "external_web_access": True}],
                tool_choice="required",
                max_tool_calls=config.max_calls_per_turn,
                include=["web_search_call.action.sources"],
                input=(
                    "Search the public web for the user's question. Use the web "
                    "search tool and return a concise answer with citations. "
                    "Do not rely on memory or private context. User question: "
                    + raw_query[:2000]
                ),
                max_output_tokens=config.max_output_tokens,
            )
        except Exception as exc:
            return WebSearchResult(True, [], _search_failure_reason(exc))
        return self._normalize_response(
            response, raw_query, max_calls=config.max_calls_per_turn,
        )

    def _normalize_response(
        self, response: Any, query: str, *, max_calls: int = 1,
    ) -> WebSearchResult:
        output = _value(response, "output", [])
        items = output if isinstance(output, (list, tuple)) else []
        completed_search = False
        completed_search_count = 0
        sources: list[dict[str, str]] = []
        citation_annotations: list[dict[str, object]] = []

        tool_statuses: list[dict[str, object]] = []
        annotation_entries: list[tuple[Any, int]] = []
        response_has_output_text = bool(str(_value(response, "output_text", "") or ""))

        def add_source(source: Any) -> None:
            url = str(_value(source, "url", "") or "").strip()
            title = " ".join(str(_value(source, "title", "") or "").split())
            if re.match(r"^https?://\S+$", url) and title:
                candidate = {
                    "url": url[:2000], "title": title[:256],
                }
                source_text = " ".join(str(
                    _value(source, "snippet", _value(source, "text", "")) or ""
                ).split())
                if source_text:
                    candidate["snippet"] = source_text[:4000]
                if not any(item.get("url") == candidate["url"] for item in sources):
                    sources.append(candidate)

        raw_text_blocks: list[str] = []

        for item in items:
            if _value(item, "type") == "web_search_call":
                action = _value(item, "action", {})
                tool_statuses.append({
                    "type": "web_search_call",
                    "status": str(_value(item, "status", "") or "")[:64],
                    "action_type": str(_value(action, "type", "") or "")[:64],
                })
                # The hosted tool's action type describes the action, not its
                # outcome. Treat only an explicitly completed call as usable.
                if _value(item, "status") == "completed":
                    completed_search = True
                    completed_search_count += 1
                for source in _value(action, "sources", []) or []:
                    add_source(source)
            # Responses can also expose URL-citation annotations on the
            # assistant message. Keep those associations instead of relying
            # only on the optional expanded source metadata.
            annotation_entries.extend(
                (annotation, 0)
                for annotation in (_value(item, "annotations", []) or [])
            )
            content_offset = 0
            for content in _value(item, "content", []) or []:
                annotation_entries.extend(
                    (annotation, content_offset)
                    for annotation in (_value(content, "annotations", []) or [])
                )
                content_type = _value(content, "type")
                if content_type in {"output_text", "text"}:
                    content_text = str(_value(content, "text", "") or "")
                    if content_text:
                        raw_text_blocks.append(content_text[:4000])
                        content_offset += len(content_text) + 1
            for annotation, block_offset in annotation_entries:
                if _value(annotation, "type") in {"url_citation", "url_citation_annotation"}:
                    # Responses uses direct fields; legacy-shaped fixtures and
                    # some SDK serializers wrap them in ``url_citation``.
                    citation = _value(annotation, "url_citation", annotation)
                    source_url = str(_value(citation, "url", "") or "").strip()
                    source_title = " ".join(str(_value(citation, "title", "") or "").split())
                    add_source(citation)
                    if source_url:
                        offset = 0 if response_has_output_text else block_offset
                        citation_annotations.append({
                            "url": source_url[:2000],
                            "title": source_title[:256],
                            "start_index": _offset_index(
                                _value(citation, "start_index"), offset,
                            ),
                            "end_index": _offset_index(
                                _value(citation, "end_index"), offset,
                            ),
                        })
            # Entries are scoped to the current item.  Keeping the list small
            # also prevents repeated annotations from multiplying diagnostics.
            annotation_entries = []
        original_text = str(_value(response, "output_text", "") or "")
        if original_text:
            raw_text_blocks.insert(0, original_text[:4000])
        if not original_text:
            nested_parts: list[str] = []
            for item in items:
                for content in _value(item, "content", []) or []:
                    content_type = _value(content, "type")
                    if content_type in {"output_text", "text"}:
                        value = _value(content, "text", "")
                        if value:
                            nested_parts.append(str(value))
            original_text = "\n".join(nested_parts)
        text = original_text
        usage = _value(response, "usage", None)
        usage_data: dict[str, int | float] = {
            "input_tokens": int(_value(usage, "input_tokens", 0) or 0),
            "output_tokens": int(_value(usage, "output_tokens", 0) or 0),
            "search_calls": completed_search_count,
        }
        diagnostics = _response_diagnostics(
            response=response,
            original_text=original_text,
            text_blocks=raw_text_blocks,
            tool_statuses=tool_statuses,
            sources=sources,
            citations=citation_annotations,
            usage=usage_data,
        )
        diagnostics["fixture_response"] = _sanitize_response_fixture(response)

        def failed(reason: str, *, extraction: dict[str, object] | None = None) -> WebSearchResult:
            if extraction is not None:
                diagnostics["extraction"] = extraction
            return WebSearchResult(True, [], reason, usage_data, diagnostics)

        if not completed_search:
            return failed("search_tool_not_completed", extraction={"stage": "tool", "reason": "not_completed"})
        if completed_search_count > max(1, int(max_calls)):
            return failed("search_call_limit_exceeded", extraction={"stage": "tool", "reason": "call_limit"})
        if not text or not sources:
            return failed("no_usable_sources", extraction={"stage": "candidate_extraction", "reason": "missing_text_or_sources"})
        clock = self._clock().astimezone(timezone.utc)
        # Keep the requested period distinct from retrieval time.  In normal
        # routing only current questions reach this adapter, but explicit
        # as-of requests still need one authoritative date for validation.
        from app.ai.freshness import resolve_freshness
        requested_as_of = resolve_freshness(query, now=clock).as_of
        candidates = _extract_search_claim_candidates(
            text, query, now=clock, requested_as_of=requested_as_of,
        )
        diagnostics["extraction"] = {
            "stage": "candidate_extraction",
            "reason": "candidates_found" if candidates else "no_candidate_fact",
            "candidates": [
                {key: value for key, value in candidate.items() if not key.startswith("_")}
                for candidate in candidates
            ][:16],
        }
        if not candidates:
            return failed("search_claim_not_extractable")
        results: list[dict[str, object]] = []
        rejected: list[dict[str, object]] = []
        for candidate in candidates:
            start = int(candidate.get("_start", 0))
            end = int(candidate.get("_end", start))
            claim_sources = [
                source for source in sources
                if source["url"] in {
                    str(annotation.get("url") or "")
                    for annotation in citation_annotations
                    if _annotation_overlaps(annotation, start, end)
                }
            ]
            # A single tool result without inline annotations remains
            # compatible with SDK responses that omit annotations. Multiple
            # sources must be tied to an explicit claim span.
            if not claim_sources and len(sources) == 1:
                claim_sources = list(sources)
            rejection = str(candidate.get("_rejection_reason") or "")
            if not claim_sources and not rejection:
                rejection = "claim_has_no_supporting_citation"
            if rejection:
                rejected.append({
                    **{key: value for key, value in candidate.items() if not key.startswith("_")},
                    "reason": rejection,
                })
                continue
            first = claim_sources[0]
            result: dict[str, object] = {
                "title": first["title"],
                "synthesis": " ".join(text.split())[:4000],
                "claim": candidate["claim"],
                "answer_value": candidate["answer_value"],
                "requested_role": candidate["role"],
                "requested_entity": candidate["entity"],
                "url": first["url"], "source": "openai_web_search",
                "provenance": "openai_responses_web_search",
                "retrieved_at": clock.isoformat(),
                "temporal_support": "completed_live_search",
                "temporal_as_of": candidate.get("temporal_as_of", clock.date().isoformat()),
                "relevant": True, "search_call_completed": True,
                "sources": [{"url": item["url"], "title": item["title"]} for item in sources[:16]],
                "claim_sources": claim_sources,
                "citation_annotations": citation_annotations[:32],
                "claim_support_type": "cited_synthesis",
            }
            results.append(result)
        diagnostics["extraction"]["rejected_candidates"] = rejected[:16]
        if not results:
            return failed(
                "claim_has_no_supporting_citation" if rejected and all(
                    item.get("reason") == "claim_has_no_supporting_citation" for item in rejected
                ) else "search_claim_not_extractable",
            )
        usage_data["search_calls"] = max(1, completed_search_count)
        diagnostics["extraction"]["stage"] = "citation_association"
        diagnostics["extraction"]["reason"] = "accepted_candidates"
        return WebSearchResult(True, results, "openai_responses_web_search", usage_data, diagnostics)

    def _legacy_wikipedia_search(self, query: str) -> WebSearchResult:
        enabled = str(os.getenv("ENABLE_WEB_SEARCH_FOR_FREE", "") or "").strip().lower() in _TRUE
        if not enabled:
            return WebSearchResult(False, [], "disabled")
        raw = str(query or "").strip()
        if not raw:
            return WebSearchResult(True, [], "empty_query")
        title = self._wikipedia_title(raw)
        if not title:
            return WebSearchResult(True, [], "unsupported_query")
        url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(title.replace(' ', '_'))}"
        try:
            with urllib.request.urlopen(url, timeout=3.0) as response:  # noqa: S310 - fixed public endpoint.
                payload = json.loads(response.read().decode("utf-8"))
        except Exception:
            return WebSearchResult(True, [], "lookup_failed")
        extract = str(payload.get("extract") or "").strip()
        page_url = str((payload.get("content_urls") or {}).get("desktop", {}).get("page") or payload.get("url") or url)
        if not extract:
            return WebSearchResult(True, [], "not_found")
        return WebSearchResult(True, [{
            "title": str(payload.get("title") or title), "snippet": extract,
            "source": "wikipedia", "url": page_url,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "provenance": "wikipedia_summary", "temporal_support": False,
        }], "wikipedia_summary")

    @staticmethod
    def _wikipedia_title(query: str) -> str:
        normalized = re.sub(r"\s+", " ", str(query or "").strip())
        patterns = [
            r"(?i)^what\s+is\s+(.+?)\??$",
            r"(?i)^who\s+is\s+(.+?)\??$",
            r"(?i)^tell\s+me\s+about\s+(.+?)\??$",
            r"(?i)^explain\s+(.+?)\??$",
        ]
        for pattern in patterns:
            match = re.match(pattern, normalized)
            if match:
                title = re.sub(r"\b(?:the|a|an)\b$", "", match.group(1).strip(), flags=re.IGNORECASE).strip()
                return title[:120]
        return ""


def _source_snippet(source: Mapping[str, str]) -> str:
    """Return only source text supplied by the tool, never generated synthesis."""
    return " ".join(str(source.get("snippet") or source.get("text") or "").split())[:4000]


def _response_diagnostics(
    *, response: Any, original_text: str, text_blocks: list[str],
    tool_statuses: list[dict[str, object]], sources: list[dict[str, str]],
    citations: list[dict[str, object]], usage: dict[str, int | float],
) -> dict[str, Any]:
    """Build a bounded, public-query-only diagnostic envelope.

    The envelope is not sent to ordinary chat clients.  It is retained on the
    adapter result so the operator probe can explain an extraction failure and
    replay the sanitized Responses shape without making another paid request.
    """
    incomplete = _value(response, "incomplete_details", None)
    refusal = _value(response, "refusal", None)
    return {
        "response_status": str(_value(response, "status", "completed") or "")[:64],
        "incomplete_details": _bounded_value(incomplete),
        "refusal": _bounded_value(refusal),
        "tool_statuses": tool_statuses[:8],
        "text_blocks": [{"text": str(block)[:4000]} for block in text_blocks[:8]],
        "output_text": str(original_text)[:4000],
        "consulted_sources": [dict(source) for source in sources[:16]],
        "citation_annotations": [dict(annotation) for annotation in citations[:32]],
        "usage": dict(usage),
    }


def _sanitize_response_fixture(response: Any) -> dict[str, object]:
    """Serialize only the public Responses fields needed for offline replay."""
    serialized: dict[str, object] = {
        "status": str(_value(response, "status", "completed") or "")[:64],
        "incomplete_details": _bounded_value(_value(response, "incomplete_details", None)),
        "refusal": _bounded_value(_value(response, "refusal", None)),
        "output_text": str(_value(response, "output_text", "") or "")[:4000],
        "usage": {
            "input_tokens": int(_value(_value(response, "usage", None), "input_tokens", 0) or 0),
            "output_tokens": int(_value(_value(response, "usage", None), "output_tokens", 0) or 0),
        },
        "output": [],
    }
    for item in list(_value(response, "output", []) or [])[:16]:
        normalized: dict[str, object] = {
            "type": str(_value(item, "type", "") or "")[:64],
            "status": str(_value(item, "status", "") or "")[:64],
        }
        action = _value(item, "action", None)
        if action is not None:
            normalized["action"] = {
                "type": str(_value(action, "type", "") or "")[:64],
                "sources": [
                    {
                        key: str(_value(source, key, "") or "")[:4000]
                        for key in ("url", "title", "snippet", "text")
                        if _value(source, key, None) is not None
                    }
                    for source in list(_value(action, "sources", []) or [])[:16]
                ],
            }
        item_annotations = [
            _sanitize_annotation(annotation)
            for annotation in list(_value(item, "annotations", []) or [])[:32]
        ]
        if item_annotations:
            normalized["annotations"] = item_annotations
        content_items: list[dict[str, object]] = []
        for content in list(_value(item, "content", []) or [])[:8]:
            content_items.append({
                "type": str(_value(content, "type", "") or "")[:64],
                "text": str(_value(content, "text", "") or "")[:4000],
                "annotations": [
                    _sanitize_annotation(annotation)
                    for annotation in list(_value(content, "annotations", []) or [])[:32]
                ],
            })
        if content_items:
            normalized["content"] = content_items
        serialized["output"].append(normalized)
    return serialized


def _sanitize_annotation(annotation: Any) -> dict[str, object]:
    values = {
        key: _value(annotation, key, None)
        for key in ("type", "url", "title", "start_index", "end_index")
        if _value(annotation, key, None) is not None
    }
    nested = _value(annotation, "url_citation", None)
    if nested is not None:
        values["url_citation"] = {
            key: _value(nested, key, None)
            for key in ("url", "title", "start_index", "end_index")
            if _value(nested, key, None) is not None
        }
    return values


def _bounded_value(value: Any, limit: int = 512) -> object:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value)[:limit] if isinstance(value, str) else value
    if isinstance(value, Mapping):
        return {
            str(key)[:64]: _bounded_value(item, limit=limit)
            for key, item in list(value.items())[:16]
        }
    if isinstance(value, (list, tuple)):
        return [_bounded_value(item, limit=limit) for item in list(value)[:16]]
    return str(value)[:limit]


def _format_with_offsets(text: str) -> tuple[str, list[int]]:
    """Remove presentation markup while retaining raw-output coordinates."""
    formatted: list[str] = []
    offsets: list[int] = []
    index = 0
    while index < len(text):
        if text.startswith("[", index):
            link = re.match(r"\[([^\]]+)\]\(https?://[^)]+\)", text[index:])
            if link:
                for offset, char in enumerate(link.group(1)):
                    formatted.append(char)
                    offsets.append(index + 1 + offset)
                index += link.end()
                continue
        if text.startswith("**", index) or text.startswith("__", index):
            index += 2
            continue
        if text[index] == "*":
            index += 1
            continue
        if text.startswith("http://", index) or text.startswith("https://", index):
            url = re.match(r"https?://\S+", text[index:])
            index += url.end() if url else 1
            continue
        char = text[index]
        if char.isspace():
            if formatted and formatted[-1] != " ":
                formatted.append(" ")
                offsets.append(index)
        else:
            formatted.append(char)
            offsets.append(index)
        index += 1
    return "".join(formatted).strip(), offsets


def _requested_fact_intent(query: str) -> tuple[str, str, str]:
    folded = query.casefold()
    if "முதலமைச்சர்" in query or re.search(r"\b(?:cm|chief\s+minister)\b", folded):
        role = "chief minister"
    elif "பிரதமர்" in query or re.search(r"\b(?:pm|prime\s+minister)\b", folded):
        role = "prime minister"
    elif "ஆளுநர்" in query or re.search(r"\bgovernor\b", folded):
        role = "governor"
    else:
        return "", "", ""
    if "தமிழ்நா" in query or re.search(r"tamil\s*nadu|tamilnadu", folded):
        return role, "Tamil Nadu", "(?:தமிழ்நாடு|தமிழ்நாட்டின்|Tamil\\s+Nadu|Tamilnadu)"
    entity_match = re.search(
        rf"(?:{_ROLE_RE})\s+(?:of|in)\s+([\w .'-]+?)(?=\s+(?:as\s+of|on|now|today|and)\b|[?.!,;]|$)",
        query, re.IGNORECASE,
    )
    entity = " ".join(entity_match.group(1).split()).strip(" .,") if entity_match else ""
    entity_pattern = re.escape(entity).replace(r"\ ", r"\s+") if entity else ""
    return role, entity, entity_pattern


def _canonical_role(role: str) -> str:
    normalized = " ".join(role.casefold().split())
    return {
        "cm": "chief minister", "pm": "prime minister",
        "முதலமைச்சர்": "chief minister", "பிரதமர்": "prime minister",
    }.get(normalized, normalized)


def _canonical_entity(entity: str) -> str:
    folded = " ".join(entity.casefold().replace("தமிழ்நாட்டின்", "தமிழ்நாடு").split())
    if re.fullmatch(r"tamil\s*nadu|tamilnadu|தமிழ்நாடு", folded):
        return "tamil nadu"
    return folded.replace("'s", "").strip()


def _claim_sentence(text: str, start: int, end: int) -> str:
    begin = max(text.rfind(mark, 0, start) for mark in (".", "!", "?", ";", "\n")) + 1
    stops = [text.find(mark, end) for mark in (".", "!", "?", ";", "\n")]
    finish = min((stop for stop in stops if stop >= 0), default=len(text))
    return text[begin:finish].strip(" .;:")


def _extract_search_claim_candidates(
    text: str, query: str, *, now: datetime, requested_as_of: str | None = None,
) -> list[dict[str, object]]:
    """Extract all requested relation candidates without turning prose into proof."""
    role, entity, entity_pattern = _requested_fact_intent(query)
    if not role or not entity_pattern:
        return []
    cleaned, offsets = _format_with_offsets(text)
    if not cleaned:
        return []
    role_pattern = rf"(?:{_ROLE_RE})"
    candidates: list[dict[str, object]] = []
    patterns = [
        re.compile(
            rf"{_VALUE_RE}\s+(?:is|was|has\s+been|remains|serves\s+as|serves)\s+"
            rf"(?:(?:the|a)\s+)?(?:(?:current|present|incumbent)\s+)?"
            rf"(?P<role>{role_pattern})\s+of\s+(?P<entity>{entity_pattern})",
            re.IGNORECASE,
        ),
        re.compile(
            rf"(?:the\s+)?(?P<role>{role_pattern})\s+of\s+(?P<entity>{entity_pattern})\s+"
            rf"(?:is|was|has\s+been|remains)\s+(?:(?:the|a)\s+)?{_VALUE_RE}",
            re.IGNORECASE,
        ),
        re.compile(
            rf"(?P<entity>{entity_pattern})['’]s\s+(?:(?:current|present|incumbent)\s+)?"
            rf"(?P<role>{role_pattern})\s+(?:is|was|has\s+been|remains)\s+{_VALUE_RE}",
            re.IGNORECASE,
        ),
        re.compile(
            rf"{_VALUE_RE}\s+(?:is\s+)?(?P<entity>{entity_pattern})\s+"
            rf"(?:la|oda)\s+(?:(?:ippo|ippa|current|present)\s+)?"
            rf"(?P<role>{role_pattern})(?:\s*(?:-?a))?\s+"
            rf"(?:irukkaru|irukkaaru|aagiraar|yaaru)?",
            re.IGNORECASE,
        ),
        re.compile(
            rf"{_VALUE_RE}\s+(?P<entity>தமிழ்நாடு|தமிழ்நாட்டின்)\s+"
            rf"(?:(?:தற்போதைய|இப்போதைய)\s+)?(?P<role>முதலமைச்சர்|பிரதமர்)\s+"
            rf"(?:ஆவார்|ஆகிறார்|இருக்கிறார்)",
            re.IGNORECASE,
        ),
    ]
    seen: set[tuple[str, str, str]] = set()
    for pattern in patterns:
        for match in pattern.finditer(cleaned):
            value = " ".join(str(match.group("value") or "").split()).strip(" .,!?:;")
            matched_role = _canonical_role(str(match.group("role") or ""))
            matched_entity = " ".join(str(match.group("entity") or "").split()).strip(" ,;:")
            if not value or value.casefold() in {"the", "a", "an", "example"}:
                continue
            if matched_role != role or _canonical_entity(matched_entity) != _canonical_entity(entity):
                continue
            start, end = match.start(), match.end()
            if offsets:
                raw_start = offsets[min(start, len(offsets) - 1)]
                raw_end = offsets[min(max(start, end - 1), len(offsets) - 1)] + 1
            else:
                raw_start, raw_end = start, end
            claim = _claim_sentence(cleaned, start, end)
            key = (value.casefold(), matched_role, _canonical_entity(matched_entity))
            if key in seen:
                continue
            seen.add(key)
            context = cleaned[max(0, start - 80):min(len(cleaned), end + 80)]
            rejection = ""
            if re.search(r"\b(?:not|never|former|previous|ex[- ]|no longer|hypothetical|might be|could be)\b", context, re.I):
                rejection = "evidence_claim_not_supported"
            years = [int(year) for year in re.findall(r"\b(19\d{2}|20\d{2})\b", claim)]
            if years and max(years) < now.date().year and not re.search(
                r"\b(?:current|currently|now|today|present|latest)\b|தமிழ்|ippo|ippa", claim, re.I,
            ):
                rejection = "evidence_temporal_scope_mismatch"
            candidates.append({
                "claim": claim[:1000], "answer_value": value[:256],
                "role": matched_role[:64], "entity": matched_entity[:256],
                "temporal_as_of": requested_as_of or now.date().isoformat(),
                "_start": raw_start, "_end": raw_end,
                "_rejection_reason": rejection,
            })
    return candidates


def _annotation_overlaps(annotation: Mapping[str, object], start: int, end: int) -> bool:
    try:
        annotation_start = int(annotation.get("start_index"))
        annotation_end = int(annotation.get("end_index"))
    except (TypeError, ValueError):
        return False
    return annotation_start < end and annotation_end > start


def _offset_index(value: object, offset: int) -> object:
    try:
        return int(value) + offset
    except (TypeError, ValueError):
        return value


def _extract_search_claim(text: str, query: str) -> dict[str, str] | None:
    """Compatibility wrapper for callers that only need one extracted fact."""
    candidates = _extract_search_claim_candidates(
        text, query, now=datetime.now(timezone.utc),
    )
    for candidate in candidates:
        if not candidate.get("_rejection_reason"):
            return {
                key: str(value) for key, value in candidate.items()
                if not key.startswith("_")
            }
    return None


def _search_failure_reason(exc: Exception) -> str:
    name = type(exc).__name__.lower()
    if "timeout" in name:
        return "search_timeout"
    if "authentication" in name or "permission" in name:
        return "search_authentication_failed"
    if "rate" in name or "limit" in name:
        return "search_rate_limited"
    return "search_request_failed"
