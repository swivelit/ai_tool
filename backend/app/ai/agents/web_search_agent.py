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

        def add_source(source: Any) -> None:
            url = str(_value(source, "url", "") or "").strip()
            title = " ".join(str(_value(source, "title", "") or "").split())
            if re.match(r"^https?://\S+$", url) and title:
                candidate = {"url": url[:2000], "title": title[:256]}
                if candidate not in sources:
                    sources.append(candidate)

        for item in items:
            if _value(item, "type") == "web_search_call":
                action = _value(item, "action", {})
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
            annotations = _value(item, "annotations", []) or []
            for content in _value(item, "content", []) or []:
                annotations = [*annotations, *(_value(content, "annotations", []) or [])]
            for annotation in annotations:
                if _value(annotation, "type") in {"url_citation", "url_citation_annotation"}:
                    add_source(annotation)
        text = " ".join(str(_value(response, "output_text", "") or "").split())
        usage = _value(response, "usage", None)
        usage_data: dict[str, int | float] = {
            "input_tokens": int(_value(usage, "input_tokens", 0) or 0),
            "output_tokens": int(_value(usage, "output_tokens", 0) or 0),
            "search_calls": completed_search_count,
        }
        if not completed_search:
            return WebSearchResult(True, [], "search_tool_not_completed", usage_data)
        if completed_search_count > max(1, int(max_calls)):
            return WebSearchResult(True, [], "search_call_limit_exceeded", usage_data)
        if not text or not sources:
            return WebSearchResult(True, [], "no_usable_sources", usage_data)
        clock = self._clock().astimezone(timezone.utc)
        first = sources[0]
        result = {
            "title": first["title"], "snippet": text[:4000], "claim": text[:4000],
            "url": first["url"], "source": "openai_web_search",
            "provenance": "openai_responses_web_search",
            "retrieved_at": clock.isoformat(),
            "temporal_support": "completed_live_search",
            "temporal_as_of": clock.date().isoformat(), "relevant": True,
            "search_call_completed": True,
            "sources": [{"url": item["url"], "title": item["title"]} for item in sources[:16]],
        }
        usage_data["search_calls"] = max(1, completed_search_count)
        return WebSearchResult(True, [result], "openai_responses_web_search", usage_data)

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


def _search_failure_reason(exc: Exception) -> str:
    name = type(exc).__name__.lower()
    if "timeout" in name:
        return "search_timeout"
    if "authentication" in name or "permission" in name:
        return "search_authentication_failed"
    if "rate" in name or "limit" in name:
        return "search_rate_limited"
    return "search_request_failed"
