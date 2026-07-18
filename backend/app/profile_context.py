from __future__ import annotations

import json
import re
from typing import Any, Optional

from sqlmodel import Session, select

from .age_utils import normalize_age_group
from .models import User, UserProfile


REQUIRED_PROFILE_SLOTS = {
    "preferred_language", "age_group", "occupation", "communication_tone",
    "answer_length", "assistant_persona", "main_goal", "dislikes",
}


def _load_answers(profile: UserProfile | None) -> dict[str, Any]:
    if not profile:
        return {}
    try:
        value = json.loads(profile.answers_json or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _completed_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def _compact(value: Any, limit: int = 800) -> Any:
    if isinstance(value, str):
        return re.sub(r"\s+", " ", value).strip()[:limit]
    if isinstance(value, list):
        return [_compact(item, 240) for item in value[:12]]
    if isinstance(value, dict):
        return {
            str(key)[:80]: _compact(entry, 240)
            for key, entry in list(value.items())[:24]
            if not any(marker in str(key).lower() for marker in (
                "firebase_uid", "email", "auth", "token", "secret", "api_key", "password",
            ))
        }
    return value


def _reply_language(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return "en" if normalized in {"en", "english"} else "ta"


def _infer_tone(summary: str) -> str:
    value = str(summary or "").lower()
    if any(word in value for word in ("short", "brief")):
        return "brief"
    if any(word in value for word in ("detail", "deep")):
        return "detailed"
    if any(word in value for word in ("casual", "friendly")):
        return "friendly_casual"
    if any(word in value for word in ("formal", "respectful")):
        return "respectful"
    return "warm"


def build_profile_prompt_context(session: Session, user_id: Optional[int]) -> dict[str, Any]:
    if not user_id:
        return {}
    user = session.get(User, int(user_id))
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == int(user_id))).first()
    answers = _load_answers(profile)
    summary = str(profile.profile_summary or "").strip() if profile else ""
    context: dict[str, Any] = {
        "user": {
            "name": user.name if user else "",
            "place": user.place if user else "",
            "timezone": user.timezone if user else "Asia/Kolkata",
            "assistant_name": user.assistant_name if user else "Elli",
            "reply_language": _reply_language(user.reply_language if user else "ta"),
        },
        "questionnaire_completed": bool(answers) and all(
            _completed_value(answers.get(slot)) for slot in REQUIRED_PROFILE_SLOTS
        ),
        "profile_summary": _compact(summary, 1200),
        "communication_tone": _compact(answers.get("communication_tone") or _infer_tone(summary), 120),
        "answer_length": _compact(answers.get("answer_length") or "medium", 80),
        "tamil_style": _compact(answers.get("tamil_style") or "chennai_conversational", 120),
        "onboarding_answers": _compact(answers, 240),
    }
    age_group = normalize_age_group(answers.get("age_group"))
    if age_group and age_group != "prefer_not_to_say":
        context["age_group"] = _compact(age_group, 40)
        if age_group in {"under_13", "13_17"}:
            context["age_safety_note"] = (
                "User is a minor age group. Keep explanations age-appropriate and avoid adult-style advice."
            )
    return context


def profile_prompt_context_text(profile_context: dict[str, Any]) -> str:
    return json.dumps(profile_context, ensure_ascii=False, sort_keys=True) if profile_context else ""


def add_effective_age_to_profile_context(
    profile_context: dict[str, Any], life_context: Optional[dict[str, Any]],
) -> str:
    answers = profile_context.get("onboarding_answers")
    answer_age = normalize_age_group(answers.get("age_group")) if isinstance(answers, dict) else ""
    if answer_age == "prefer_not_to_say":
        profile_context.pop("age_group", None)
        profile_context.pop("age_safety_note", None)
        return ""
    profile_age = normalize_age_group(profile_context.get("age_group"))
    life_age = normalize_age_group(life_context.get("ageGroup")) if isinstance(life_context, dict) else ""
    effective = profile_age or life_age
    if not effective or effective == "prefer_not_to_say":
        profile_context.pop("age_group", None)
        profile_context.pop("age_safety_note", None)
        return ""
    profile_context["age_group"] = effective
    if effective in {"under_13", "13_17"}:
        profile_context["age_safety_note"] = (
            "User is a minor age group. Keep explanations age-appropriate and avoid adult-style advice."
        )
    return effective
