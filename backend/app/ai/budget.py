from __future__ import annotations

import os
from typing import Optional

from fastapi import HTTPException
from sqlmodel import Session

from .usage import get_provider_daily_spend, get_user_daily_text_count, get_user_daily_voice_seconds


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        parsed = int(str(os.getenv(name, default)).strip())
    except Exception:
        parsed = int(default)
    return max(minimum, parsed)


def _env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    try:
        parsed = float(str(os.getenv(name, default)).strip())
    except Exception:
        parsed = float(default)
    return max(minimum, parsed)


def is_admin_email(email: Optional[str]) -> bool:
    normalized = str(email or "").strip().lower()
    if not normalized:
        return False
    admins = {
        item.strip().lower()
        for item in str(os.getenv("ADMIN_EMAILS", "")).split(",")
        if item.strip()
    }
    return normalized in admins


def enforce_free_text_quota(session: Session, user_id: Optional[int], *, admin_email: Optional[str] = None) -> None:
    if user_id is None or is_admin_email(admin_email):
        return
    limit = _env_int("FREE_DAILY_TEXT_LIMIT", 40, minimum=0)
    if limit <= 0:
        return
    if get_user_daily_text_count(session, user_id) >= limit:
        raise HTTPException(
            status_code=429,
            detail="Daily free text limit reached. Please try again tomorrow or upgrade.",
        )


def enforce_free_voice_quota(
    session: Session,
    user_id: Optional[int],
    *,
    additional_seconds: float = 0.0,
    admin_email: Optional[str] = None,
) -> None:
    if user_id is None or is_admin_email(admin_email):
        return
    limit = _env_int("FREE_DAILY_VOICE_SECONDS", 180, minimum=0)
    if limit <= 0:
        return
    used = get_user_daily_voice_seconds(session, user_id)
    if used + max(0.0, float(additional_seconds or 0.0)) > limit:
        raise HTTPException(
            status_code=429,
            detail="Daily free voice limit reached. Please try again tomorrow or upgrade.",
        )


def enforce_provider_budget(session: Session, provider: str, *, currency: str = "") -> None:
    provider_key = str(provider or "").strip().lower()
    currency_key = str(currency or "").strip().upper()
    if provider_key == "sarvam":
        budget = _env_float("SARVAM_DAILY_BUDGET_INR", 0.0, minimum=0.0)
        if budget > 0 and get_provider_daily_spend(session, "sarvam", "INR") >= budget:
            raise HTTPException(
                status_code=503,
                detail="Sarvam daily budget exceeded; cache-only response unavailable.",
            )
    if provider_key == "openai":
        budget = _env_float("OPENAI_DAILY_BUDGET_USD", 0.0, minimum=0.0)
        if budget > 0 and get_provider_daily_spend(session, "openai", "USD") >= budget:
            raise HTTPException(
                status_code=503,
                detail="OpenAI daily budget exceeded; cache-only response unavailable.",
            )
    ai_budget_inr = _env_float("AI_DAILY_BUDGET_INR", 0.0, minimum=0.0)
    if ai_budget_inr > 0 and currency_key == "INR" and get_provider_daily_spend(session, provider_key, "INR") >= ai_budget_inr:
        raise HTTPException(
            status_code=503,
            detail="AI daily budget exceeded; cache-only response unavailable.",
        )
