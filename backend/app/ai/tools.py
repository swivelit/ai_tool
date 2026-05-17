from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from ..models import DailyRoutine, DocumentArtifact, User, UserProfile
from ..time_utils import utc_now
from .intent import classify_intent
from .tool_registry import get_tool_capability
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
    if route.intent == "greeting":
        return _handle_greeting(request, route)
    if route.intent == "thanks":
        return _handle_thanks(request, route)
    if route.intent == "capabilities":
        return _handle_capabilities(request, route)
    if route.intent == "reminder":
        return _handle_reminder(session, request, route)
    if route.intent == "note":
        return _handle_note(request, route)
    if route.intent == "task":
        return _handle_task(request, route)
    if route.intent == "document":
        return _handle_document(request, route)
    if route.intent == "file_retrieval":
        return _handle_file_retrieval(session, request, route)
    if route.intent == "creative_tool":
        return _handle_creative_tool(request, route)
    if route.intent == "profile":
        return _handle_profile(session, request, route)
    if route.intent == "settings":
        return _handle_settings(session, request, route)
    if route.intent == "routine":
        return _handle_routine(session, request, route)
    return _tool_response("I can handle that with a backend tool.", request, route)


def _handle_greeting(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    text = "வணக்கம். எப்படி உதவலாம்?" if _prefers_tamil(request, route) else "Hi. How can I help?"
    return _tool_response(text, request, route, item_metadata=_assistant_metadata(request.message, text), action="local_greeting")


def _handle_thanks(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    text = "சரி." if _prefers_tamil(request, route) else "You’re welcome."
    return _tool_response(text, request, route, item_metadata=_assistant_metadata(request.message, text), action="local_thanks")


def _handle_capabilities(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    if _prefers_tamil(request, route):
        text = "நான் reminders, notes, tasks, PDF/DOCX/XLSX/PPTX files, saved file search, profile/routine questions ஆகியவற்றை உதவ முடியும்."
    else:
        text = "I can help with reminders, notes, tasks, PDF/DOCX/XLSX/PPTX files, saved file search, and profile or routine questions."
    return _tool_response(text, request, route, item_metadata=_assistant_metadata(request.message, text), action="local_capabilities")


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
        "category": classify_folder_category(message) if classify_folder_category(message) != "Other" else "Reminder",
        "datetime": when,
        "title": title,
        "details": text,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="create_reminder")


def _handle_note(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    message = _clean(request.message)
    title = _title_from_reminder(_strip_note_command(message)) or "Note"
    category = classify_folder_category(message)
    text = f"Note saved: {title}."
    metadata = {
        "intent": "note",
        "category": category,
        "datetime": None,
        "title": title,
        "details": text,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="create_note")


def _handle_task(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    message = _clean(request.message)
    title = _title_from_reminder(_strip_task_command(message)) or "Task"
    category = classify_folder_category(message)
    text = f"Task saved: {title}."
    metadata = {
        "intent": "task",
        "category": category,
        "datetime": None,
        "title": title,
        "details": text,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="create_task")


def _handle_document(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    message = _clean(request.message)
    formats = _extract_document_formats(message)
    category = classify_folder_category(message)
    source_text = _strip_document_command(message)
    title = _title_from_reminder(source_text) or "Voice document"
    format_label = ", ".join(fmt.upper() for fmt in formats)
    text = f"Created {format_label}: {title}."
    metadata = {
        "intent": "document",
        "category": category,
        "datetime": None,
        "title": title,
        "details": text,
        "document_formats": formats,
        "source_text": source_text or message,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="create_document")


def _handle_file_retrieval(session: Session, request: AIRequest, route: AIRoute) -> AIProviderResponse:
    files = search_document_artifacts(session, request.user_id, request.message)
    if files:
        first = files[0]
        text = f"Found {len(files)} file(s). Opening {first['title']}."
    else:
        text = "I could not find a matching generated file."
    metadata = _assistant_metadata(request.message, text)
    metadata["files"] = files
    metadata["status"] = "found" if files else "not_found"
    return _tool_response(text, request, route, item_metadata=metadata, action="search_files")


def _handle_creative_tool(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    kind = _creative_tool_kind(request.message)
    capability = get_tool_capability(kind)
    if capability.configured:
        text = f"{kind.title()} tooling is configured, but no execution adapter is registered yet."
    else:
        text = f"{kind.title()} tooling is not configured. I cannot claim this was created or edited."
    metadata = _assistant_metadata(request.message, text)
    metadata["tool"] = {
        "kind": kind,
        "status": "not_configured",
        "provider": capability.provider or "",
        "provider_env": capability.provider_env,
    }
    return _tool_response(text, request, route, item_metadata=metadata, action="tool_not_configured")


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
        r"\bremind\s+(?:panna|pannu|பண்ணு|பண்ணுங்க)\b",
        r"\breminder\s+(?:save|வை|vechidu|podu|பண்ணு)\b",
    ):
        text = re.sub(pattern, "", text, flags=re.I).strip()
    text = re.sub(r"\b(?:tomorrow morning|tomorrow evening|today evening|tonight|naalaikku kaalai|nalai kaalai)\b", "", text, flags=re.I).strip()
    text = re.sub(r"(?:நாளைக்கு|நாளை|நாளைக்கு|நேற்று|இன்று)\s*(?:காலை|மாலை|இரவு)?", "", text, flags=re.I).strip()
    text = re.sub(r"\bin\s+\d+\s+(?:minutes?|mins?|hours?|hrs?)\b", "", text, flags=re.I).strip()
    text = re.sub(r"\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b", "", text, flags=re.I).strip()
    text = re.sub(r"\b(?:tomorrow|today|naalaikku|nalai|kaalai|morning)\b", "", text, flags=re.I).strip()
    text = re.sub(r"\b(?:panna|pannu|save|podu|vechidu)\b|(?:பண்ணு|பண்ணுங்க|வை|சேமி)", "", text, flags=re.I).strip()
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
            r"\b(tomorrow|today|tonight|morning|evening|naalaikku|nalai|kaalai|in\s+\d+\s+(?:minutes?|mins?|hours?|hrs?)|at\s+\d{1,2})\b|நாளை|நாளைக்கு|காலை|மாலை|இரவு",
            message,
            flags=re.I,
        )
    )


def _pending_reminder_from_context(request: AIRequest) -> dict[str, str]:
    turns = list(request.context_turns or [])
    if not turns:
        return {}
    turn = turns[-1]
    user_text = _clean(turn.get("user") or turn.get("user_input") or "")
    assistant_text = _clean(turn.get("assistant") or turn.get("assistant_text") or "")
    if not user_text or not assistant_text:
        return {}
    if "what should i remind you about" not in assistant_text.lower():
        return {}
    if classify_intent(user_text).intent != "reminder":
        return {}
    return {"request": user_text, "assistant": assistant_text}


def _looks_unrelated_to_pending_reminder(message: str) -> bool:
    lowered = message.lower().strip()
    if _looks_like_general_knowledge_query(lowered):
        return True
    if "?" in lowered or re.match(r"^(what|who|why|how|when|where|tell me about|describe|explain|design|debug|write|latest)\b", lowered):
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
    if re.search(r"\b(tomorrow morning|naalaikku kaalai|nalai kaalai)\b", text) or re.search(r"நாளை(?:க்கு)?\s*காலை", message):
        target = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    elif re.search(r"\b(tomorrow evening|naalaikku maalai|nalai maalai)\b", text) or re.search(r"நாளை(?:க்கு)?\s*மாலை", message):
        target = (now + timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    elif re.search(r"\btoday evening\b", text):
        target = now.replace(hour=18, minute=0, second=0, microsecond=0)
    elif re.search(r"\btonight\b", text):
        target = now.replace(hour=20, minute=0, second=0, microsecond=0)
    elif re.search(r"\b(tomorrow|naalaikku|nalai)\b", text) or re.search(r"நாளை|நாளைக்கு", message):
        target = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)

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


def _prefers_tamil(request: AIRequest, route: AIRoute) -> bool:
    value = str(request.reply_language or route.language or "").strip().lower()
    return value in {"ta", "tamil", "mixed", "tanglish"} or bool(re.search(r"[\u0b80-\u0bff]", request.message))


def classify_folder_category(message: str) -> str:
    text = str(message or "").lower()
    if re.search(r"\b(business|biz|client|customer|sales|marketing|invoice|startup)\b|வியாபாரம்|தொழில்", text):
        return "Business"
    if re.search(r"\b(work|office|project|meeting|standup|team|job)\b|வேலை|ஆபீஸ்", text):
        return "Work"
    if re.search(r"\b(home|house|family|amma|appa|eb bill|electricity bill)\b|வீட்டு|வீடு|அம்மா|அப்பா", text):
        return "Home"
    return "Other"


def _strip_note_command(message: str) -> str:
    text = _clean(message)
    text = re.sub(r"\b(?:save|remember|add|create)\s+(?:this\s+)?(?:note|notes?)\b", "", text, flags=re.I)
    text = re.sub(r"\bnotes?\b", "", text, flags=re.I)
    text = re.sub(r"\b(?:work|home|business|other)\s+folder\s+(?:ல\s+)?(?:வை|save|put)?\b", "", text, flags=re.I)
    text = re.sub(r"\b(?:folder|ல|la|save|வை|சேமி)\b", "", text, flags=re.I)
    return _clean(text)


def _strip_task_command(message: str) -> str:
    text = _clean(message)
    text = re.sub(r"\b(?:add|create|save|set)\s+(?:a\s+)?(?:task|todo|to-do)\b", "", text, flags=re.I)
    text = re.sub(r"\b(?:task|todo|to-do)\b", "", text, flags=re.I)
    return _clean(text)


def _extract_document_formats(message: str) -> list[str]:
    text = str(message or "").lower()
    formats: list[str] = []
    checks = (
        ("pdf", r"\bpdf\b"),
        ("docx", r"\b(docx|word document|word file)\b"),
        ("xlsx", r"\b(xlsx|excel|spreadsheet)\b"),
        ("pptx", r"\b(pptx|ppt|powerpoint|slides?)\b"),
    )
    for value, pattern in checks:
        if re.search(pattern, text, flags=re.I):
            formats.append(value)
    return formats or ["pdf"]


def _strip_document_command(message: str) -> str:
    text = _clean(message)
    text = re.sub(r"\b(?:make|create|generate|save|turn|convert)\b", " ", text, flags=re.I)
    text = re.sub(r"\b(?:as|into|to|file|document)\b", " ", text, flags=re.I)
    text = re.sub(r"\b(?:pdf|docx|word document|word file|xlsx|excel|spreadsheet|pptx|ppt|powerpoint|slides?)\b", " ", text, flags=re.I)
    text = re.sub(r"\b(?:work|home|business|other)\s+folder\s+(?:ல\s+)?(?:save|வை|put)?\b", " ", text, flags=re.I)
    text = re.sub(r"(?:ஆக்கி|aakki|akki|folder|ல|la|வை|சேமி|பண்ணு|pannu)", " ", text, flags=re.I)
    text = re.sub(r"^\s*இந்த\s+", "", text)
    return _clean(text)


def _creative_tool_kind(message: str) -> str:
    text = str(message or "").lower()
    if re.search(r"\b(video|clip|reel)\b", text):
        return "video"
    if re.search(r"\b(audio|song|voice edit|podcast)\b", text):
        return "audio"
    if re.search(r"\b(poster|image|photo|thumbnail)\b", text):
        return "image"
    return "creative"


def _looks_like_general_knowledge_query(lowered: str) -> bool:
    media_or_knowledge = r"\b(movie|film|padam|series|book|news|history|science|actor|actress|director|dhoom)\b|படம்|சினிமா|செய்தி|பத்தி"
    query_starter = r"^(tell me about|describe|explain|what is|who is|enna|என்ன|பத்தி சொல்லு)"
    if re.search(query_starter, lowered, flags=re.I):
        return True
    return bool(re.search(media_or_knowledge, lowered, flags=re.I))


def search_document_artifacts(session: Session, user_id: Optional[int], message: str, *, limit: int = 5) -> list[dict[str, Any]]:
    if user_id is None:
        return []
    try:
        rows = list(
            session.exec(
                select(DocumentArtifact)
                .where(DocumentArtifact.user_id == int(user_id))
                .order_by(DocumentArtifact.created_at.desc())
            ).all()
        )
    except Exception:
        session.rollback()
        return []

    category = classify_folder_category(message)
    date_filter = _artifact_date_filter(message)
    query_tokens = {
        token
        for token in re.findall(r"[a-z0-9\u0b80-\u0bff]+", str(message or "").lower())
        if token not in {"open", "find", "show", "get", "retrieve", "the", "i", "told", "you", "yesterday", "notes", "note", "file", "files", "folder", "business", "work", "home", "other", "நேத்து", "நேற்று", "சொன்ன"}
    }

    scored: list[tuple[int, DocumentArtifact]] = []
    for row in rows:
        score = 0
        if category != "Other" and str(row.category or "").lower() == category.lower():
            score += 4
        elif category != "Other":
            continue
        if date_filter is not None and row.created_at.date() != date_filter:
            continue
        haystack = f"{row.title or ''} {row.source_text or ''} {row.relative_path or ''}".lower()
        score += sum(1 for token in query_tokens if token in haystack)
        if score > 0 or category != "Other" or date_filter is not None:
            scored.append((score, row))

    scored.sort(key=lambda pair: (pair[0], pair[1].created_at), reverse=True)
    return [_artifact_payload(row) for _score, row in scored[:limit]]


def _artifact_payload(row: DocumentArtifact) -> dict[str, Any]:
    return {
        "id": row.id,
        "item_id": row.item_id,
        "title": row.title,
        "format": row.format,
        "category": row.category,
        "relative_path": row.relative_path,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _artifact_date_filter(message: str):
    text = str(message or "").lower()
    now = utc_now()
    if re.search(r"\b(yesterday|நேத்து|நேற்று)\b", text):
        return (now - timedelta(days=1)).date()
    if re.search(r"\b(today|இன்று)\b", text):
        return now.date()
    return None
