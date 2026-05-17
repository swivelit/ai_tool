from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from ..models import DailyRoutine, User, UserProfile
from ..time_utils import utc_now
from .intent import classify_intent
from .types import AIProviderResponse, AIRequest, AIRoute


def try_handle_pending_reminder(session: Session, request: AIRequest) -> Optional[AIProviderResponse]:
    pending = _pending_reminder_from_context(request)
    if not pending:
        return None
    message = _clean(request.message)
    if not message or _looks_unrelated_to_pending_reminder(message):
        return None

    user = _get_user(session, request.user_id)
    when = _parse_simple_datetime(pending.get("request") or "", user, request.metadata)
    title = _title_from_reminder(message)
    when_phrase = _pending_when_phrase(pending.get("request") or "", when)
    if when_phrase:
        text = f"Done — I’ll remind you {when_phrase} to {title}."
    else:
        text = f"Done — I’ll remind you to {title}."
    route = AIRoute(
        provider="backend_tool",
        model=None,
        route="backend_tool_reminder_continuation",
        reason="pending_reminder_clarification_completed",
        language=request.reply_language or "en",
        intent="reminder",
        max_output_tokens=0,
    )
    metadata = {
        "intent": "reminder",
        "category": "Reminder",
        "datetime": when,
        "title": title,
        "details": text,
        "pending_reminder_completed": True,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="complete_pending_reminder")


def handle_backend_tool(session: Session, request: AIRequest, route: AIRoute) -> AIProviderResponse:
    if route.intent == "reminder":
        return _handle_reminder(session, request, route)
    if route.intent == "profile":
        return _handle_profile(session, request, route)
    if route.intent == "settings":
        return _handle_settings(session, request, route)
    if route.intent == "routine":
        return _handle_routine(session, request, route)
    return _tool_response("I can handle that with a backend tool.", request, route)


def _handle_reminder(session: Session, request: AIRequest, route: AIRoute) -> AIProviderResponse:
    message = _clean(request.message)
    reminder_text = _extract_reminder_text(message)
    if not reminder_text:
        text = "What should I remind you about?"
        user = _get_user(session, request.user_id)
        when = _parse_simple_datetime(message, user, request.metadata)
        metadata = _assistant_metadata(message, text)
        metadata["pending_tool_action"] = {
            "intent": "reminder",
            "datetime": when,
            "source_request": message,
        }
        return _tool_response(text, request, route, item_metadata=metadata, action="clarify")

    user = _get_user(session, request.user_id)
    when = _parse_simple_datetime(message, user, request.metadata)
    if _mentions_time(message) and when is None:
        text = "When should I remind you?"
        return _tool_response(text, request, route, item_metadata=_assistant_metadata(message, text), action="clarify")

    title = _title_from_reminder(reminder_text)
    if when:
        text = f"Reminder saved: {title}."
    else:
        text = f"Reminder saved without a time: {title}."
    metadata = {
        "intent": "reminder",
        "category": "Reminder",
        "datetime": when,
        "title": title,
        "details": text,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="create_reminder")


def _handle_profile(session: Session, request: AIRequest, route: AIRoute) -> AIProviderResponse:
    user = _get_user(session, request.user_id)
    profile = None
    if request.user_id is not None:
        profile = session.exec(select(UserProfile).where(UserProfile.user_id == int(request.user_id))).first()
    if profile is None and user is None:
        text = "Your profile is not set yet."
    else:
        parts: list[str] = []
        if user is not None:
            if user.name:
                parts.append(f"name: {user.name}")
            if user.place:
                parts.append(f"place: {user.place}")
            if user.reply_language:
                parts.append(f"reply language: {user.reply_language}")
        if profile is not None:
            if profile.profile_summary:
                parts.append(profile.profile_summary)
            else:
                try:
                    answers = json.loads(profile.answers_json or "{}")
                except Exception:
                    answers = {}
                if isinstance(answers, dict) and answers:
                    preview = ", ".join(f"{key}: {value}" for key, value in list(answers.items())[:5])
                    parts.append(preview)
        text = "I know this from your saved profile: " + "; ".join(parts) if parts else "Your profile is not set yet."
    return _tool_response(text, request, route, item_metadata=_assistant_metadata(request.message, text), action="read_profile")


def _handle_settings(session: Session, request: AIRequest, route: AIRoute) -> AIProviderResponse:
    message = _clean(request.message).lower()
    user = _get_user(session, request.user_id)
    language = _requested_reply_language(message)
    if user is not None and language:
        user.reply_language = language
        session.add(user)
        session.commit()
        text = f"Reply language updated to {language}."
        return _tool_response(
            text,
            request,
            route,
            item_metadata=_assistant_metadata(request.message, text),
            action="update_reply_language",
        )
    text = "Which setting should I update?"
    return _tool_response(text, request, route, item_metadata=_assistant_metadata(request.message, text), action="clarify")


def _handle_routine(session: Session, request: AIRequest, route: AIRoute) -> AIProviderResponse:
    routine = None
    if request.user_id is not None:
        routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == int(request.user_id))).first()
    if routine is None:
        text = "Your routine is not set yet."
    else:
        parts = [f"wake: {routine.wake_time}", f"sleep: {routine.sleep_time}"]
        if routine.work_start or routine.work_end:
            parts.append(f"work: {routine.work_start or '?'} to {routine.work_end or '?'}")
        if routine.daily_habits:
            parts.append(f"habits: {routine.daily_habits}")
        text = "Your saved routine: " + "; ".join(parts)
    return _tool_response(text, request, route, item_metadata=_assistant_metadata(request.message, text), action="read_routine")


def _tool_response(
    text: str,
    request: AIRequest,
    route: AIRoute,
    *,
    item_metadata: Optional[dict[str, Any]] = None,
    action: str = "",
) -> AIProviderResponse:
    raw: dict[str, Any] = {"tool_action": action}
    if item_metadata:
        raw["item_metadata"] = item_metadata
    return AIProviderResponse(
        text=text,
        provider="backend_tool",
        model=None,
        route=route.route,
        reason=route.reason,
        language=route.language,
        intent=route.intent,
        characters=len(text),
        raw=raw,
    )


def _get_user(session: Session, user_id: Optional[int]) -> Optional[User]:
    if user_id is None:
        return None
    try:
        return session.get(User, int(user_id))
    except Exception:
        session.rollback()
        return None


def _assistant_metadata(message: str, text: str) -> dict[str, Any]:
    clean = _clean(message)
    return {
        "intent": "assistant",
        "category": "Other",
        "datetime": None,
        "title": (clean[:60] + "...") if len(clean) > 60 else clean or "Assistant",
        "details": text,
    }


def _clean(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _extract_reminder_text(message: str) -> str:
    text = _clean(message)
    lowered = text.lower()
    for pattern in (
        r"^remind me(?: to| about)?\s+",
        r"^create (?:a )?reminder(?: to| about| for)?\s+",
        r"^set (?:a )?(?:reminder|alarm)(?: to| about| for)?\s+",
        r"^add (?:a )?(?:todo|to-do|task)(?: to| about| for)?\s+",
    ):
        text = re.sub(pattern, "", text, flags=re.I).strip()
    text = re.sub(r"\b(?:tomorrow morning|tomorrow evening|today evening|tonight)\b", "", text, flags=re.I).strip()
    text = re.sub(r"\bin\s+\d+\s+(?:minutes?|mins?|hours?|hrs?)\b", "", text, flags=re.I).strip()
    text = re.sub(r"\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b", "", text, flags=re.I).strip()
    text = re.sub(r"\b(?:tomorrow|today)\b", "", text, flags=re.I).strip()
    text = re.sub(r"^(?:for|to|about)\s+", "", text, flags=re.I).strip()
    ambiguous = {"", "me", "reminder", "alarm", "todo", "to-do", "task", "appointment"}
    if lowered in {"remind me", "create a reminder", "set reminder", "set an alarm"}:
        return ""
    return "" if text.lower() in ambiguous else text


def _title_from_reminder(text: str) -> str:
    clean = _clean(text)
    return (clean[:60] + "...") if len(clean) > 60 else clean


def _mentions_time(message: str) -> bool:
    return bool(
        re.search(
            r"\b(tomorrow|today|tonight|morning|evening|in\s+\d+\s+(?:minutes?|mins?|hours?|hrs?)|at\s+\d{1,2})\b",
            message,
            flags=re.I,
        )
    )


def _pending_reminder_from_context(request: AIRequest) -> dict[str, str]:
    turns = list(request.context_turns or [])
    for turn in reversed(turns[-6:]):
        user_text = _clean(turn.get("user") or turn.get("user_input") or "")
        assistant_text = _clean(turn.get("assistant") or turn.get("assistant_text") or "")
        if not user_text or not assistant_text:
            continue
        if "what should i remind you about" not in assistant_text.lower():
            continue
        if classify_intent(user_text).intent != "reminder":
            continue
        return {"request": user_text, "assistant": assistant_text}
    return {}


def _looks_unrelated_to_pending_reminder(message: str) -> bool:
    lowered = message.lower().strip()
    if re.search(r"\b(remind|reminder|alarm|todo|to-do|task)\b", lowered):
        return True
    if "?" in lowered or re.match(r"^(what|who|why|how|when|where|explain|design|debug|write|latest)\b", lowered):
        return True
    intent = classify_intent(message).intent
    return intent not in {"general", "reminder"}


def _pending_when_phrase(source_request: str, when: Optional[str]) -> str:
    text = source_request.lower()
    for phrase in ("tomorrow morning", "tomorrow evening", "today evening", "tonight", "tomorrow", "today"):
        if phrase in text:
            return phrase
    return "at the saved time" if when else ""


def _parse_simple_datetime(message: str, user: Optional[User], metadata: dict[str, Any]) -> Optional[str]:
    tz = _user_timezone(user)
    now_value = metadata.get("now") if isinstance(metadata, dict) else None
    if isinstance(now_value, datetime):
        now = now_value.astimezone(tz) if now_value.tzinfo else now_value.replace(tzinfo=tz)
    elif now_value:
        try:
            parsed = datetime.fromisoformat(str(now_value).replace("Z", "+00:00"))
            now = parsed.astimezone(tz) if parsed.tzinfo else parsed.replace(tzinfo=tz)
        except Exception:
            now = utc_now().astimezone(tz)
    else:
        now = utc_now().astimezone(tz)

    text = message.lower()
    target: Optional[datetime] = None
    if re.search(r"\btomorrow morning\b", text):
        target = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    elif re.search(r"\btomorrow evening\b", text):
        target = (now + timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    elif re.search(r"\btoday evening\b", text):
        target = now.replace(hour=18, minute=0, second=0, microsecond=0)
    elif re.search(r"\btonight\b", text):
        target = now.replace(hour=20, minute=0, second=0, microsecond=0)

    relative = re.search(r"\bin\s+(\d+)\s+(minutes?|mins?|hours?|hrs?)\b", text)
    if relative:
        amount = int(relative.group(1))
        unit = relative.group(2)
        target = now + (timedelta(hours=amount) if unit.startswith(("hour", "hr")) else timedelta(minutes=amount))

    clock = re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", text)
    if clock:
        hour = int(clock.group(1))
        minute = int(clock.group(2) or "0")
        meridiem = clock.group(3)
        if meridiem == "pm" and hour < 12:
            hour += 12
        if meridiem == "am" and hour == 12:
            hour = 0
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if target <= now:
                target = target + timedelta(days=1)

    if target is None:
        return None
    return target.replace(tzinfo=None).isoformat(timespec="seconds")


def _user_timezone(user: Optional[User]) -> ZoneInfo:
    try:
        return ZoneInfo(str(getattr(user, "timezone", "") or "Asia/Kolkata"))
    except Exception:
        return ZoneInfo("Asia/Kolkata")


def _requested_reply_language(message: str) -> Optional[str]:
    if re.search(r"\b(?:english|en)\b", message, flags=re.I):
        return "en"
    if re.search(r"\b(?:tamil|ta|தமிழ்)\b", message, flags=re.I):
        return "ta"
    return None
