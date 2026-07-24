from __future__ import annotations

import ast
from datetime import datetime
import json
import math
import operator
import re
from typing import Any, Callable
from zoneinfo import ZoneInfo

from sqlmodel import Session

from ..ai.tools import handle_backend_tool
from ..ai.types import AIProviderResponse, AIRequest, AIRoute
from ..models import User
from ..time_utils import utc_now
from .swico_brand import classify_swico_brand_query, swico_brand_response


_TIME_QUERY = re.compile(
    r"\b(?:what(?:'s| is) (?:the )?(?:time|date|day)|"
    r"(?:current|local) (?:time|date)|what day is it|today'?s date|time now)\b",
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


def _time_answer(session: Session, user_id: int, message: str) -> str | None:
    if not _TIME_QUERY.search(message) or re.search(r"\btime complexity\b", message, re.I):
        return None
    user = session.get(User, user_id)
    timezone_name = str(getattr(user, "timezone", "") or "Asia/Kolkata")
    try:
        timezone = ZoneInfo(timezone_name)
    except Exception:
        timezone_name = "Asia/Kolkata"
        timezone = ZoneInfo(timezone_name)
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
    answer = _time_answer(session, user_id, text)
    if answer:
        return _response(answer, intent="local_time", reason="saved_timezone")
    answer = _arithmetic_answer(text)
    if answer:
        return _response(answer, intent="arithmetic", reason="safe_ast")
    answer = _unit_answer(text)
    if answer:
        return _response(answer, intent="unit_conversion", reason="static_unit_table")

    brand = classify_swico_brand_query(text, previous_topic=previous_topic)
    if brand is not None:
        answer = swico_brand_response(
            brand.subintent.value, reply_language=reply_language, message=text
        )
        return _response(answer, intent="swico_brand", reason="approved_swico_public_profile")

    answer = _json_answer(text)
    if answer:
        return _response(answer, intent="json_validation", reason="safe_json_parser")

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
