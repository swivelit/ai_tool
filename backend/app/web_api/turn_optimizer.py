from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
import re
from typing import Any, Literal

from ..ai.intent import classify_contextual_followup, classify_intent_with_metadata
from ..ai.prompts import detailed_answer_requested
from ..billing.pricing import estimate_tokens
from ..global_qa_cache import is_live_or_current_question, is_private_or_personal_question


AnswerClass = Literal["simple", "normal", "detailed"]


@dataclass(frozen=True)
class WebTurnOptimization:
    optimization_route: str
    is_contextual_followup: bool
    selected_context_turns: list[dict[str, str]] = field(default_factory=list)
    context_chars_sent: int = 0
    compact_profile_prompt: str = ""
    profile_chars_sent: int = 0
    attachment_prompt_context: str = ""
    attachment_chars_sent: int = 0
    answer_class: AnswerClass = "normal"
    max_output_tokens: int = 320
    cache_eligible: bool = False
    estimated_prompt_tokens: int = 0
    metrics: dict[str, Any] = field(default_factory=dict)
    formatted_context: str = ""
    local_intent: str = ""


def optimizer_enabled() -> bool:
    return _env_bool("WEB_TURN_OPTIMIZER_ENABLED", True)


def optimize_web_turn(
    message: str,
    *,
    reply_language: str | None = None,
    context_turns: list[dict[str, str]] | None = None,
    profile_context: dict[str, Any] | None = None,
    attachment_prompt_context: str = "",
    has_attachments: bool = False,
) -> WebTurnOptimization:
    """Build a deterministic, provider-free website turn policy."""
    text = str(message or "").strip()
    decision = classify_intent_with_metadata(text)
    contextual = classify_contextual_followup(text) is not None
    answer_class = classify_answer_class(text, decision.intent)
    maximum = output_ceiling(answer_class)
    local_route = "" if has_attachments else _local_route(decision.intent)
    selected, formatted = select_context_turns(context_turns or [], contextual=contextual)
    profile_prompt = build_compact_profile_prompt(
        profile_context or {}, text, reply_language=reply_language
    )
    attachment_limit = _env_int("WEB_ATTACHMENT_PROMPT_MAX_CHARS", 8_000, minimum=1)
    attachment_context = str(attachment_prompt_context or "").strip()[:attachment_limit].rstrip()
    cache_eligible = bool(
        not local_route
        and not contextual
        and not has_attachments
        and decision.intent not in {"weather", "live_data", "unsafe_or_sensitive"}
        and not is_live_or_current_question(text)
        and not is_private_or_personal_question(text)
    )
    route = local_route or ("provider_contextual" if contextual else "provider_standalone")
    metrics = {
        "optimization_route": route,
        "answer_class": answer_class,
        "context_turns_sent": len(selected),
        "context_chars_sent": len(formatted),
        "profile_chars_sent": len(profile_prompt),
        "attachment_chars_sent": len(attachment_context),
        "cache_hit": False,
        "cache_hit_source": "",
        "estimated_prompt_tokens": 0,
        "max_output_tokens": maximum,
        "provider_attempts": 0,
        "provider_calls_with_usage": 0,
        "fallback_attempted": False,
        "cached_input_tokens": 0,
        "cache_write_tokens": 0,
    }
    return WebTurnOptimization(
        optimization_route=route,
        is_contextual_followup=contextual,
        selected_context_turns=selected,
        context_chars_sent=len(formatted),
        compact_profile_prompt=profile_prompt,
        profile_chars_sent=len(profile_prompt),
        attachment_prompt_context=attachment_context,
        attachment_chars_sent=len(attachment_context),
        answer_class=answer_class,
        max_output_tokens=maximum,
        cache_eligible=cache_eligible,
        metrics=metrics,
        formatted_context=formatted,
        local_intent=decision.intent if local_route else "",
    )


def with_prompt_estimate(
    optimization: WebTurnOptimization, serialized_prompt: str
) -> WebTurnOptimization:
    from dataclasses import replace

    prompt_tokens = estimate_tokens(serialized_prompt)
    metrics = {**optimization.metrics, "estimated_prompt_tokens": prompt_tokens}
    return replace(optimization, estimated_prompt_tokens=prompt_tokens, metrics=metrics)


def select_context_turns(
    turns: list[dict[str, str]], *, contextual: bool
) -> tuple[list[dict[str, str]], str]:
    if not contextual:
        return [], ""
    max_turns = _env_int("WEB_CONTEXT_MAX_TURNS", 2, minimum=0)
    max_chars = _env_int("WEB_CONTEXT_MAX_CHARS", 900, minimum=0)
    if max_turns <= 0 or max_chars <= 0:
        return [], ""

    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for turn in turns:
        user = _compact(turn.get("user") or turn.get("user_input") or "")
        assistant = _compact(turn.get("assistant") or turn.get("assistant_text") or "")
        key = (user, assistant)
        if key == ("", "") or key in seen:
            continue
        seen.add(key)
        normalized.append({"user": user, "assistant": assistant})

    candidates: list[dict[str, str]] = []
    blocks: list[str] = []
    used = 0
    for turn in reversed(normalized[-max_turns:]):
        block = _format_turn(turn)
        separator = 1 if blocks else 0
        if len(block) + separator + used <= max_chars:
            candidates.insert(0, turn)
            blocks.insert(0, block)
            used += len(block) + separator
            continue
        if not blocks:
            bounded = _bounded_turn(turn, max_chars)
            candidates.insert(0, bounded)
            blocks.insert(0, _format_turn(bounded))
        # Older context is skipped if it cannot fit as a complete turn.
    formatted = "\n".join(blocks).strip()
    return candidates, formatted


def build_compact_profile_prompt(
    profile: dict[str, Any], message: str, *, reply_language: str | None
) -> str:
    limit = _env_int("WEB_PROFILE_PROMPT_MAX_CHARS", 500, minimum=1)
    user = profile.get("user") if isinstance(profile.get("user"), dict) else {}
    result: dict[str, str] = {}
    language = str(reply_language or user.get("reply_language") or "").strip().lower()
    if language and language not in {"en", "english"}:
        result["reply_language"] = _compact(language, 24)

    tone = str(profile.get("communication_tone") or "").strip()
    if tone and tone.lower() not in {"", "warm", "default"}:
        result["communication_tone"] = _compact(tone, 80)
    length = str(profile.get("answer_length") or "").strip()
    if length and length.lower() not in {"", "medium", "normal", "default"}:
        result["answer_length"] = _compact(length, 48)

    age = str(profile.get("age_group") or "").strip()
    if age in {"under_13", "13_17"}:
        result["minor_safety"] = "Use age-appropriate language and avoid adult-style advice."

    lowered = str(message or "").lower()
    if re.search(r"\b(your name|assistant name|what should i call you)\b", lowered):
        name = str(user.get("assistant_name") or "").strip()
        if name:
            result["assistant_name"] = _compact(name, 60)
    if re.search(r"\b(my location|my place|where am i|local time|my timezone|timezone)\b", lowered):
        place = str(user.get("place") or "").strip()
        timezone = str(user.get("timezone") or "").strip()
        if place:
            result["place"] = _compact(place, 80)
        if timezone:
            result["timezone"] = _compact(timezone, 80)

    if not result:
        return ""
    encoded = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _truncate(encoded, limit)


def classify_answer_class(message: str, intent: str = "") -> AnswerClass:
    text = str(message or "").strip()
    if intent in {"coding", "complex_reasoning"} or detailed_answer_requested(text):
        return "detailed"
    if len(text.split()) <= 12 and (
        intent in {"general", "translation", "contextual_rewrite"}
        or re.match(r"^(what|who|when|where|define|is|are)\b", text, re.I)
    ):
        return "simple"
    return "normal"


def output_ceiling(answer_class: AnswerClass) -> int:
    defaults = {"simple": 220, "normal": 320, "detailed": 700}
    names = {
        "simple": "WEB_SIMPLE_MAX_OUTPUT_TOKENS",
        "normal": "WEB_NORMAL_MAX_OUTPUT_TOKENS",
        "detailed": "WEB_DETAILED_MAX_OUTPUT_TOKENS",
    }
    web_limit = _env_int(names[answer_class], defaults[answer_class], minimum=1)
    provider_hard = _env_int("OPENAI_MAX_OUTPUT_TOKENS_HARD", 900, minimum=1)
    return min(web_limit, provider_hard)


def _local_route(intent: str) -> str:
    if intent in {"greeting", "thanks", "capabilities"}:
        return f"deterministic_{intent}"
    if intent == "unsafe_or_sensitive":
        return "safety_block"
    if intent in {
        "reminder", "routine", "profile", "settings", "note", "task",
        "document", "file_retrieval", "creative_tool", "tts", "stt",
    }:
        return "unsupported_web_capability"
    return ""


def _format_turn(turn: dict[str, str]) -> str:
    parts: list[str] = []
    if turn.get("user"):
        parts.append(f"User: {turn['user']}")
    if turn.get("assistant"):
        parts.append(f"Assistant: {turn['assistant']}")
    return "\n".join(parts)


def _bounded_turn(turn: dict[str, str], limit: int) -> dict[str, str]:
    user = str(turn.get("user") or "")
    assistant = str(turn.get("assistant") or "")
    if user and assistant:
        fixed = len("User: \nAssistant: ")
        available = max(0, limit - fixed)
        user_limit = available * 2 // 5
        assistant_limit = available - user_limit
        return {
            "user": _truncate(user, user_limit),
            "assistant": _truncate(assistant, assistant_limit),
        }
    if user:
        return {"user": _truncate(user, max(0, limit - len("User: "))), "assistant": ""}
    return {"user": "", "assistant": _truncate(assistant, max(0, limit - len("Assistant: ")))}


def _compact(value: Any, limit: int = 10_000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    if limit <= 3:
        return value[:limit]
    return value[: limit - 3].rstrip() + "..."


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int, *, minimum: int) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except Exception:
        value = default
    return max(minimum, value)
