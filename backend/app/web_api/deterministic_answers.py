from __future__ import annotations

import ast
from dataclasses import dataclass
from datetime import datetime
import json
import logging
import math
import operator
import os
import re
from typing import Any, Callable
from zoneinfo import ZoneInfo

from sqlmodel import Session

from ..ai.tools import handle_backend_tool
from ..ai.swico_tiers import public_tier_settings
from ..ai.types import AIProviderResponse, AIRequest, AIRoute
from ..billing.topups import (
    custom_topup_enabled, enforce_topup_packages, topup_bounds, topup_packages,
)
from ..models import User
from ..time_utils import utc_now
from .swico_brand import classify_swico_brand_query, swico_brand_response


logger = logging.getLogger(__name__)

DETERMINISTIC_SCOPE_MAX_CHARACTERS = 240
DETERMINISTIC_SCOPE_MAX_NONEMPTY_LINES = 2
DETERMINISTIC_SCOPE_INTENT_PREFIX_CHARACTERS = 160

_CREATION_TASK_OPEN = re.compile(
    r"^\s*(?:create|build|make|design|write|generate|develop|implement|code|draft)\b",
    re.IGNORECASE,
)
_BRAND_SCOPE_ANCHOR = re.compile(
    r"(?:\bswico\b|\bswivel\s+technologies\b|\bjeyanth\b|"
    r"ஸ்விகோ|சுவிகோ|ஸ்விவல்|"
    r"\bwho\s+are\s+you\b|\bwhat\s+are\s+you\b|"
    r"\bwhat(?:'s|\s+is)\s+your\s+name\b|\bwhat\s+ai\s+are\s+you\b|"
    r"\bwho\s+(?:created|made|developed|built)\s+you\b|"
    r"\b(?:your|the\s+assistant(?:'s)?)\s+(?:creator|developer|company|"
    r"architecture|agents?|token\s+optimi[sz]ation|voice\s+functionality|"
    r"document\s+support|billing|credits?|security|privacy|model|provider)\b|"
    r"\bwhich\s+company\s+(?:created|made|developed|built)\s+you\b|"
    r"\bwhich\s+model\s+(?:powers|runs|drives)\s+you\b|"
    r"\bwhat\s+model\s+do\s+you\s+use\b|"
    r"\bare\s+you\s+(?:an?\s+)?(?:ai|assistant|chatgpt|sarvam(?:\s+ai)?)\b|"
    r"நீ(?:ங்கள்)?\s+யார்|உன்(?:ங்கள்)?\s+பெயர்\s+என்ன)",
    re.IGNORECASE,
)

_TIME_QUERY = re.compile(
    r"\b(?:what\s+(?:time|date|day)\s+is\s+it|"
    r"what(?:'s|\s+is)\s+(?:the\s+)?(?:time|date|day)|"
    r"(?:current|local)\s+(?:time|date)|today'?s\s+date|time\s+now)\b",
    re.IGNORECASE,
)
_ARITHMETIC_PREFIX = re.compile(
    r"^\s*(?:what(?:'s| is)|calculate|compute|evaluate)\s+", re.IGNORECASE
)
_UNIT_QUERY = re.compile(
    r"^\s*(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([A-Za-z°]+)\s+"
    r"(?:to|in)\s+([A-Za-z°]+)\s*[?.]?\s*$",
    re.IGNORECASE,
)
_JSON_INTENT = re.compile(
    r"\b(?:validate|valid|check|pretty[- ]?print|format)\b.*\bjson\b|"
    r"\bjson\b.*\b(?:validate|valid|check|pretty[- ]?print|format)\b",
    re.IGNORECASE | re.DOTALL,
)
_COMING_SOON = re.compile(
    r"^\s*(?:please\s+)?(?:create|add|save|set|make|remind)\b.*\b"
    r"(?:reminder|note|task|todo|to-do)\b|^\s*remind me\b",
    re.IGNORECASE,
)
_TOPUP_HOW = re.compile(
    r"\b(?:how (?:do|can) i (?:top[ -]?up|recharge|add (?:ai )?credits?|add money)|"
    r"(?:top[ -]?up|recharge|add credits?) (?:how|steps?|process)|"
    r"recharge (?:panna|seiya) (?:eppadi|epdi)|credits? (?:vaanga|add) "
    r"(?:eppadi|epdi))\b",
    re.IGNORECASE,
)
_TOPUP_PACKAGES = re.compile(
    r"\b(?:(?:available|what|which|show|list).{0,24}"
    r"(?:top[ -]?up|recharge|credit).{0,16}(?:packages?|options?|amounts?)|"
    r"(?:top[ -]?up|recharge) packages?|recharge options?)\b",
    re.IGNORECASE,
)
_TOPUP_BOUNDS = re.compile(
    r"\b(?:(?:minimum|maximum|min|max|lowest|highest).{0,24}"
    r"(?:top[ -]?up|recharge|credit)|(?:top[ -]?up|recharge).{0,24}"
    r"(?:minimum|maximum|min|max|limit|range))\b",
    re.IGNORECASE,
)
_TOPUP_CUSTOM = re.compile(
    r"\b(?:(?:any|arbitrary|custom|my own|different).{0,20}"
    r"(?:top[ -]?up|recharge|amount|value)|"
    r"(?:top[ -]?up|recharge).{0,20}(?:any|arbitrary|custom|own amount))\b",
    re.IGNORECASE,
)
_PLAN_PRICING = re.compile(
    r"\b(?:swico )?(?:plans?|pricing|tiers?|modes?)\b.*"
    r"\b(?:price|pricing|cost|difference|available|compare|which|what)\b|"
    r"\b(?:price|pricing|cost|compare|difference)\b.*"
    r"\b(?:swico )?(?:plans?|tiers?|modes?)\b",
    re.IGNORECASE,
)

_BINARY_OPERATORS: dict[type[ast.operator], Callable[[float, float], float]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPERATORS: dict[type[ast.unaryop], Callable[[float], float]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

_UNITS: dict[str, tuple[str, float, str]] = {
    "mm": ("length", 0.001, "mm"),
    "cm": ("length", 0.01, "cm"),
    "m": ("length", 1.0, "m"),
    "meter": ("length", 1.0, "m"),
    "meters": ("length", 1.0, "m"),
    "km": ("length", 1000.0, "km"),
    "in": ("length", 0.0254, "in"),
    "inch": ("length", 0.0254, "in"),
    "inches": ("length", 0.0254, "in"),
    "ft": ("length", 0.3048, "ft"),
    "feet": ("length", 0.3048, "ft"),
    "yd": ("length", 0.9144, "yd"),
    "mile": ("length", 1609.344, "mi"),
    "miles": ("length", 1609.344, "mi"),
    "mi": ("length", 1609.344, "mi"),
    "g": ("mass", 0.001, "g"),
    "gram": ("mass", 0.001, "g"),
    "grams": ("mass", 0.001, "g"),
    "kg": ("mass", 1.0, "kg"),
    "lb": ("mass", 0.45359237, "lb"),
    "lbs": ("mass", 0.45359237, "lb"),
    "pound": ("mass", 0.45359237, "lb"),
    "pounds": ("mass", 0.45359237, "lb"),
    "oz": ("mass", 0.028349523125, "oz"),
    "b": ("data", 1.0, "B"),
    "byte": ("data", 1.0, "B"),
    "bytes": ("data", 1.0, "B"),
    "kb": ("data", 1000.0, "KB"),
    "mb": ("data", 1_000_000.0, "MB"),
    "gb": ("data", 1_000_000_000.0, "GB"),
    "tb": ("data", 1_000_000_000_000.0, "TB"),
    "kib": ("data", 1024.0, "KiB"),
    "mib": ("data", 1024.0**2, "MiB"),
    "gib": ("data", 1024.0**3, "GiB"),
}


@dataclass(frozen=True)
class DeterministicScopeDecision:
    intent: str | None
    scope_gate_reason: str | None


def _billing_intent_match(message: str) -> tuple[str, re.Match[str]] | None:
    for intent, pattern in (
        ("billing_topup_how", _TOPUP_HOW),
        ("billing_topup_packages", _TOPUP_PACKAGES),
        ("billing_topup_bounds", _TOPUP_BOUNDS),
        ("billing_custom_topup", _TOPUP_CUSTOM),
        ("billing_tier_pricing", _PLAN_PRICING),
    ):
        match = pattern.search(message)
        if match is not None:
            return intent, match
    return None


def _candidate_intent(
    message: str, *, previous_topic: str | None = None,
) -> tuple[str | None, int | None]:
    if (
        _TIME_QUERY.search(message)
        and not re.search(r"\btime complexity\b", message, re.IGNORECASE)
    ):
        return "local_time", 0
    if _arithmetic_answer(message) is not None:
        return "arithmetic", 0
    if _UNIT_QUERY.match(message) is not None:
        return "unit_conversion", 0
    json_match = _JSON_INTENT.search(message)
    if json_match is not None:
        return "json_validation", json_match.start()
    billing = _billing_intent_match(message)
    if billing is not None:
        return billing[0], billing[1].start()
    if classify_swico_brand_query(message, previous_topic=previous_topic) is not None:
        anchor = _BRAND_SCOPE_ANCHOR.search(message)
        return "swico_brand", anchor.start() if anchor is not None else 0
    lowered = message.casefold()
    if re.search(r"\b(?:my profile|what do you know about me|saved profile)\b", lowered):
        return "profile", 0
    if re.search(
        r"\b(?:my settings|reply language setting|change (?:my )?reply language)\b",
        lowered,
    ):
        return "settings", 0
    if _COMING_SOON.search(message):
        return "web_tool_coming_soon", 0
    return None, None


def deterministic_scope_decision(
    message: str,
    *,
    answer_class: str | None = None,
    previous_topic: str | None = None,
    emit_log: bool = False,
) -> DeterministicScopeDecision:
    """Bound deterministic tools to short, direct requests.

    A suppressed candidate deliberately returns to the normal generation path.
    Only content-free intent and reason identifiers are logged.
    """

    text = str(message or "").strip()
    intent, match_start = _candidate_intent(
        text, previous_topic=previous_topic,
    ) if text else (None, None)
    reason: str | None = None
    normalized_answer_class = str(answer_class or "").strip().lower()
    if normalized_answer_class in {"detailed", "long_form"}:
        reason = f"answer_class_{normalized_answer_class}"
    elif len(text) > DETERMINISTIC_SCOPE_MAX_CHARACTERS:
        reason = "message_too_long"
    elif sum(1 for line in text.splitlines() if line.strip()) > (
        DETERMINISTIC_SCOPE_MAX_NONEMPTY_LINES
    ):
        reason = "too_many_nonempty_lines"
    elif intent and (
        intent.startswith("billing_") or intent == "swico_brand"
    ):
        if _CREATION_TASK_OPEN.match(text):
            reason = "creation_task"
        elif match_start is None or match_start >= (
            DETERMINISTIC_SCOPE_INTENT_PREFIX_CHARACTERS
        ):
            reason = "intent_match_too_late"
    if reason is not None and intent is not None and emit_log:
        logger.info(
            "web_deterministic_scope_suppressed",
            extra={
                "event": "web_deterministic_scope_suppressed",
                "intent": intent,
                "reason": reason,
            },
        )
    return DeterministicScopeDecision(intent, reason)


def _response(text: str, *, intent: str, reason: str) -> AIProviderResponse:
    return AIProviderResponse(
        text=text,
        provider="backend_tool",
        model=None,
        route=f"deterministic_{intent}",
        reason=reason,
        language="en",
        intent=intent,
        characters=len(text),
        raw={
            "deterministic": True,
            "zero_charge": True,
            "provider_attempts": 0,
            "provider_calls_with_usage": 0,
            "fallback_attempted": False,
            "cache_hit": False,
            "provenance": ["backend_tool"],
        },
    )


def _safe_number(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _safe_number(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        value = float(node.value)
    elif isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPERATORS:
        left = _safe_number(node.left)
        right = _safe_number(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > 10:
            raise ValueError("exponent is too large")
        value = _BINARY_OPERATORS[type(node.op)](left, right)
    elif isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPERATORS:
        value = _UNARY_OPERATORS[type(node.op)](_safe_number(node.operand))
    else:
        raise ValueError("unsupported expression")
    if not math.isfinite(value) or abs(value) > 1e100:
        raise ValueError("result is out of range")
    return value


def _arithmetic_answer(message: str) -> str | None:
    expression = _ARITHMETIC_PREFIX.sub("", message).strip().rstrip("?.")
    if not expression or len(expression) > 160:
        return None
    if not re.fullmatch(r"[\d\s()+\-*/%.]+", expression):
        return None
    try:
        tree = ast.parse(expression, mode="eval")
        result = _safe_number(tree)
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError, OverflowError):
        return None
    rendered = str(int(result)) if result.is_integer() else f"{result:.12g}"
    return f"{expression} = {rendered}"


def _temperature(value: float, source: str, target: str) -> float | None:
    aliases = {
        "c": "c", "°c": "c", "celsius": "c",
        "f": "f", "°f": "f", "fahrenheit": "f",
        "k": "k", "kelvin": "k",
    }
    source_key = aliases.get(source.casefold())
    target_key = aliases.get(target.casefold())
    if not source_key or not target_key:
        return None
    celsius = (
        value if source_key == "c"
        else (value - 32.0) * 5.0 / 9.0 if source_key == "f"
        else value - 273.15
    )
    return (
        celsius if target_key == "c"
        else celsius * 9.0 / 5.0 + 32.0 if target_key == "f"
        else celsius + 273.15
    )


def _unit_answer(message: str) -> str | None:
    match = _UNIT_QUERY.match(message)
    if not match:
        return None
    value = float(match.group(1))
    source = match.group(2)
    target = match.group(3)
    temperature = _temperature(value, source, target)
    if temperature is not None:
        return f"{value:g} {source} = {temperature:.6g} {target}"
    source_unit = _UNITS.get(source.casefold())
    target_unit = _UNITS.get(target.casefold())
    if not source_unit or not target_unit or source_unit[0] != target_unit[0]:
        return None
    converted = value * source_unit[1] / target_unit[1]
    return f"{value:g} {source_unit[2]} = {converted:.6g} {target_unit[2]}"


def _json_answer(message: str) -> str | None:
    if not _JSON_INTENT.search(message):
        return None
    fenced = re.search(r"```(?:json)?\s*(.*?)```", message, re.IGNORECASE | re.DOTALL)
    candidate = fenced.group(1).strip() if fenced else ""
    if not candidate:
        starts = [index for index in (message.find("{"), message.find("[")) if index >= 0]
        if starts:
            candidate = message[min(starts):].strip()
    if not candidate:
        return "Paste the JSON you want me to validate or pretty-print."
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        return f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}."
    return "Valid JSON:\n```json\n" + json.dumps(parsed, ensure_ascii=False, indent=2) + "\n```"


def _rupees(paise: int) -> str:
    value = int(paise)
    if value % 100 == 0:
        return f"₹{value // 100:,}"
    return f"₹{value / 100:,.2f}"


def _billing_answer(message: str, reply_language: str | None) -> tuple[str, str] | None:
    text = str(message or "").strip()
    packages = topup_packages()
    minimum, maximum = topup_bounds()
    custom_enabled = custom_topup_enabled()
    package_text = ", ".join(_rupees(value) for value in packages) or "none configured"
    tanglish = (
        str(reply_language or "").strip().lower() in {"ta", "tamil", "mixed", "tanglish"}
        or bool(re.search(
            r"\b(?:panna|seiya|eppadi|epdi|vaanga|enna|sollunga)\b",
            text,
            re.I,
        ))
        or bool(re.search(r"[\u0B80-\u0BFF]", text))
    )

    if _TOPUP_HOW.search(text):
        checkout_enabled = str(
            os.getenv("BILLING_CHECKOUT_ENABLED", "false")
        ).strip().lower() in {"1", "true", "yes", "on"}
        if not checkout_enabled:
            answer = (
                "AI credit top-up checkout is currently unavailable."
                if not tanglish else
                "AI credit top-up checkout ippo available illa."
            )
        elif tanglish:
            answer = (
                "Web-la **Add credits** open pannunga, package அல்லது allowed amount-a "
                "select panni Razorpay checkout complete pannunga."
            )
        else:
            answer = (
                "Open **Add credits** on the website, choose a package"
                + (" or enter an allowed whole-rupee amount" if custom_enabled else "")
                + ", then complete the existing Razorpay checkout."
            )
        return answer, "billing_topup_how"
    if _TOPUP_PACKAGES.search(text):
        return (
            (
                f"Available top-up packages: {package_text}."
                if not tanglish else
                f"Available recharge packages: {package_text}."
            ),
            "billing_topup_packages",
        )
    if _TOPUP_BOUNDS.search(text):
        return (
            (
                f"The configured top-up range is {_rupees(minimum)} to "
                f"{_rupees(maximum)}, using whole-rupee amounts."
            ),
            "billing_topup_bounds",
        )
    if _TOPUP_CUSTOM.search(text):
        if custom_enabled and not enforce_topup_packages():
            return (
                f"Yes. You can enter any whole-rupee top-up from "
                f"{_rupees(minimum)} to {_rupees(maximum)}.",
                "billing_custom_topup",
            )
        return (
            f"No. Choose one of the configured packages: {package_text}.",
            "billing_custom_topup",
        )
    if _PLAN_PRICING.search(text):
        settings = public_tier_settings(
            os.getenv("SWICO_DEFAULT_TIER", "lite")
        )
        tiers = [
            f"{item['label']}: {item['description']}"
            + ("" if item["available"] else " (not currently available)")
            for item in settings["tiers"]
        ]
        answer = (
            "Swico’s available modes are " + "; ".join(tiers)
            + f". AI usage is paid from credits; configured top-up packages are "
            f"{package_text}."
        )
        if tanglish:
            answer = (
                "Swico-oda available modes: " + "; ".join(tiers)
                + f". AI usage credits-la pay aagum; configured top-up packages: "
                f"{package_text}."
            )
        return answer, "billing_tier_pricing"
    return None


def _time_answer(session: Session, user_id: int, message: str) -> str | None:
    if not _TIME_QUERY.search(message) or re.search(r"\btime complexity\b", message, re.I):
        return None
    user = session.get(User, user_id)
    timezone_name = str(getattr(user, "timezone", "") or "").strip()
    if not timezone_name:
        return (
            "Set a valid IANA timezone in Settings → Profile to use the "
            "time and date tool."
        )
    try:
        timezone = ZoneInfo(timezone_name)
    except Exception:
        return (
            "Set a valid IANA timezone in Settings → Profile to use the "
            "time and date tool."
        )
    now = utc_now().astimezone(timezone)
    lowered = message.casefold()
    if "time" in lowered:
        return f"It’s {now.strftime('%-I:%M %p')} on {now.strftime('%A, %d %B %Y')} ({timezone_name})."
    if "day" in lowered:
        return f"Today is {now.strftime('%A, %d %B %Y')} ({timezone_name})."
    return f"Today’s date is {now.strftime('%d %B %Y')} ({timezone_name})."


def try_deterministic_answer(
    session: Session,
    *,
    user_id: int,
    message: str,
    reply_language: str | None,
    request_id: str,
    previous_topic: str | None = None,
) -> AIProviderResponse | None:
    text = str(message or "").strip()
    if not text:
        return None
    scope = deterministic_scope_decision(
        text,
        previous_topic=previous_topic,
        emit_log=True,
    )
    if scope.scope_gate_reason is not None:
        return None
    answer = _time_answer(session, user_id, text)
    if answer:
        return _response(answer, intent="local_time", reason="saved_timezone")
    answer = _arithmetic_answer(text)
    if answer:
        return _response(answer, intent="arithmetic", reason="safe_ast")
    answer = _unit_answer(text)
    if answer:
        return _response(answer, intent="unit_conversion", reason="static_unit_table")

    answer = _json_answer(text)
    if answer:
        return _response(answer, intent="json_validation", reason="safe_json_parser")

    billing = _billing_answer(text, reply_language)
    if billing is not None:
        answer, intent = billing
        return _response(answer, intent=intent, reason="configured_billing_policy")

    brand = classify_swico_brand_query(text, previous_topic=previous_topic)
    if brand is not None:
        answer = swico_brand_response(
            brand.subintent.value, reply_language=reply_language, message=text
        )
        return _response(answer, intent="swico_brand", reason="approved_swico_public_profile")

    lowered = text.casefold()
    tool_intent = ""
    if re.search(r"\b(?:my profile|what do you know about me|saved profile)\b", lowered):
        tool_intent = "profile"
    elif re.search(r"\b(?:my settings|reply language setting|change (?:my )?reply language)\b", lowered):
        tool_intent = "settings"
    if tool_intent:
        request = AIRequest(
            user_id=user_id,
            message=text,
            reply_language=reply_language,
            channel="text",
            request_id=request_id,
            metadata={"client_surface": "web"},
        )
        route = AIRoute(
            "backend_tool",
            None,
            f"backend_tool_{tool_intent}",
            "web_backend_tool",
            str(reply_language or "en"),
            tool_intent,
            0,
        )
        response = handle_backend_tool(session, request, route)
        response.raw.update(
            {
                "deterministic": True,
                "zero_charge": True,
                "provider_attempts": 0,
                "provider_calls_with_usage": 0,
                "fallback_attempted": False,
                "cache_hit": False,
                "provenance": ["backend_tool"],
            }
        )
        return response
    if _COMING_SOON.search(text):
        return _response(
            "Reminders, notes, and tasks are coming to web soon.",
            intent="web_tool_coming_soon",
            reason="explicit_web_tool_request",
        )
    return None
