from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from ..ai.swico_tiers import SWICO_TIER_LABELS, default_swico_tier, normalize_swico_tier
from ..billing.pricing import MILLION
from ..billing.service import get_wallet_summaries
from ..billing.token_estimates import token_estimate
from ..billing.usage_limits import monthly_period_bounds, validated_timezone
from ..models import UsageCharge, User, WebUsagePreferences
from ..time_utils import ensure_utc, utc_now


def ai_credits(micros: int) -> str:
    return format(Decimal(int(micros)) / MILLION, ".6f")


def selected_swico_tier(session: Session, user_id: int) -> str:
    row = session.exec(
        select(WebUsagePreferences).where(WebUsagePreferences.user_id == int(user_id))
    ).first()
    # Keep the persisted public choice observable even while Free is
    # unavailable. Request admission performs the eligibility check and must
    # return an explicit unavailable response instead of silently routing paid.
    selected = row.assistant_tier if row else default_swico_tier()
    return normalize_swico_tier(selected)


def _period_bounds(
    session: Session, *, user: User, period: str, now: datetime,
) -> tuple[datetime, datetime, datetime | None]:
    if period == "current_month":
        start, end = monthly_period_bounds(user.timezone, now)
        return start, end, end
    if period == "30d":
        return now - timedelta(days=30), now, None
    if period == "all":
        first = session.exec(
            select(UsageCharge).where(
                UsageCharge.user_id == int(user.id),
                UsageCharge.status.in_(["settled", "billing_exempt", "free"]),
            ).order_by(UsageCharge.settled_at.asc())
        ).first()
        start = ensure_utc(first.settled_at) if first and first.settled_at else ensure_utc(user.created_at)
        return start, now, None
    raise ValueError("Unsupported usage period.")


def usage_summary(
    session: Session, *, user: User, period: str, now: datetime | None = None,
    billing_exempt: bool = False,
) -> dict[str, Any]:
    current = ensure_utc(now or utc_now())
    swico_tier = selected_swico_tier(session, int(user.id))
    zone: ZoneInfo = validated_timezone(user.timezone)
    start, end, next_reset = _period_bounds(
        session, user=user, period=period, now=current
    )
    rows = session.exec(
        select(UsageCharge).where(
            UsageCharge.user_id == int(user.id),
            UsageCharge.status.in_(["settled", "billing_exempt", "free"]),
            UsageCharge.settled_at >= start,
            UsageCharge.settled_at < end,
        ).order_by(UsageCharge.settled_at.asc())
    ).all()
    preferences = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == int(user.id)
    )).first()
    monthly_limit = (
        int(preferences.hard_limit_micros)
        if preferences and preferences.hard_limit_micros is not None else None
    )
    totals = {
        "request_count": 0,
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "actual_usage_count": 0,
        "estimated_usage_count": 0,
        "debited_micros": 0,
    }
    daily: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "request_count": 0, "input_tokens": 0, "cached_input_tokens": 0,
            "output_tokens": 0, "total_tokens": 0, "debited_micros": 0,
        }
    )
    by_tier: dict[str, dict[str, Any]] = {
        tier: {
            "label": SWICO_TIER_LABELS[tier], "request_count": 0,
            "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0,
            "total_tokens": 0, "debited_micros": 0,
        }
        for tier in ("free", "lite", "standard", "pro")
    }
    voice: dict[str, Any] = {
        "label": "Voice", "stt_request_count": 0, "tts_request_count": 0,
        "llm_request_count": 0, "llm_input_tokens": 0,
        "llm_cached_input_tokens": 0, "llm_output_tokens": 0,
        "llm_total_tokens": 0,
        "total_audio_milliseconds": 0, "total_tts_characters": 0,
        "request_count": 0, "debited_micros": 0,
    }
    for row in rows:
        total_tokens = int(row.input_tokens) + int(row.output_tokens)
        totals["request_count"] += 1
        totals["input_tokens"] += int(row.input_tokens)
        totals["cached_input_tokens"] += int(row.cached_input_tokens)
        totals["output_tokens"] += int(row.output_tokens)
        totals["total_tokens"] += total_tokens
        totals["debited_micros"] += int(row.debited_micros)
        totals[f"{row.usage_source}_usage_count"] += 1
        usage_kind = getattr(row, "usage_kind", "chat") or "chat"
        credit_bucket = getattr(row, "credit_bucket", "chat") or "chat"
        if credit_bucket == "chat" and usage_kind == "chat" and row.swico_tier in by_tier:
            tier_values = by_tier[str(row.swico_tier)]
            tier_values["request_count"] += 1
            tier_values["input_tokens"] += int(row.input_tokens)
            tier_values["cached_input_tokens"] += int(row.cached_input_tokens)
            tier_values["output_tokens"] += int(row.output_tokens)
            tier_values["total_tokens"] += total_tokens
            tier_values["debited_micros"] += int(row.debited_micros)
        elif credit_bucket == "voice":
            voice["request_count"] += 1
            voice["debited_micros"] += int(row.debited_micros)
            if usage_kind == "stt":
                voice["stt_request_count"] += 1
                voice["total_audio_milliseconds"] += int(row.audio_milliseconds)
            elif usage_kind == "tts":
                voice["tts_request_count"] += 1
                voice["total_tts_characters"] += int(row.characters)
            elif usage_kind == "chat":
                voice["llm_request_count"] += 1
                voice["llm_input_tokens"] += int(row.input_tokens)
                voice["llm_cached_input_tokens"] += int(row.cached_input_tokens)
                voice["llm_output_tokens"] += int(row.output_tokens)
                voice["llm_total_tokens"] += total_tokens
        local_day = ensure_utc(row.settled_at or row.created_at).astimezone(zone).date().isoformat()
        day = daily[local_day]
        for key, value in (
            ("request_count", 1), ("input_tokens", int(row.input_tokens)),
            ("cached_input_tokens", int(row.cached_input_tokens)),
            ("output_tokens", int(row.output_tokens)), ("total_tokens", total_tokens),
            ("debited_micros", int(row.debited_micros)),
        ):
            day[key] += value
    wallets = get_wallet_summaries(
        session, int(user.id), swico_tier=swico_tier,
        billing_exempt=billing_exempt,
    )
    chat_wallet = wallets["chat"]
    voice_wallet = wallets["voice"]
    for day, values in daily.items():
        values["debited_ai_credits"] = ai_credits(values["debited_micros"])

    def percent(numerator: int, denominator: int | None) -> float:
        if not denominator or denominator <= 0:
            return 0.0
        return float((Decimal(numerator) * Decimal("100") / Decimal(denominator)).quantize(Decimal("0.01")))

    period_debit = int(totals["debited_micros"])
    chat_period_debit = sum(int(values["debited_micros"]) for values in by_tier.values())
    chat_basis = monthly_limit if monthly_limit is not None else int(chat_wallet["available_micros"]) + chat_period_debit
    for tier_id, values in by_tier.items():
        debit = int(values["debited_micros"])
        values["debited_token_credits"] = ai_credits(debit)
        values["token_estimate"] = token_estimate(debit, tier=tier_id)
        values["period_debit_percentage"] = percent(debit, period_debit)
        values["monthly_limit_percentage"] = percent(debit, monthly_limit)
        values["utilization_percentage"] = 0.0 if billing_exempt else percent(debit, chat_basis)
        values["utilization_basis"] = "monthly_hard_limit" if monthly_limit is not None else "available_plus_period_debit"
    voice_debit = int(voice["debited_micros"])
    voice["total_audio_seconds"] = float(
        Decimal(int(voice.pop("total_audio_milliseconds"))) / Decimal("1000")
    )
    voice["debited_voice_credits"] = ai_credits(voice_debit)
    voice["token_estimate"] = token_estimate(voice_debit, tier=swico_tier)
    voice["period_debit_percentage"] = percent(voice_debit, period_debit)
    voice["monthly_limit_percentage"] = percent(voice_debit, monthly_limit)
    voice_basis = monthly_limit if monthly_limit is not None else int(voice_wallet["available_micros"]) + voice_debit
    voice["utilization_percentage"] = 0.0 if billing_exempt else percent(voice_debit, voice_basis)
    voice["utilization_basis"] = "monthly_hard_limit" if monthly_limit is not None else "available_plus_period_debit"
    chat_available_token_estimate = token_estimate(
        int(chat_wallet["available_micros"]), tier=swico_tier,
    )
    voice_available_token_estimate = token_estimate(
        int(voice_wallet["available_micros"]), tier=swico_tier,
    )
    return {
        "period": period,
        "tier": swico_tier,
        "tier_label": SWICO_TIER_LABELS[swico_tier],
        "timezone": user.timezone,
        "period_start": start,
        "period_end": end,
        "next_reset_at": next_reset,
        **totals,
        "debited_ai_credits": ai_credits(totals["debited_micros"]),
        "available_micros": int(chat_wallet["available_micros"]),
        "available_ai_credits": ai_credits(int(chat_wallet["available_micros"])),
        "chat_available_micros": int(chat_wallet["available_micros"]),
        "chat_available_credits": ai_credits(int(chat_wallet["available_micros"])),
        "chat_available_token_estimate": chat_available_token_estimate,
        "voice_available_micros": int(voice_wallet["available_micros"]),
        "voice_available_credits": ai_credits(int(voice_wallet["available_micros"])),
        "voice_available_token_estimate": voice_available_token_estimate,
        "wallets": wallets,
        "daily": [{"date": day, **values} for day, values in sorted(daily.items())],
        "by_tier": by_tier,
        "voice": voice,
        "monthly_hard_limit_micros": monthly_limit,
        "estimated_tokens_remaining": chat_wallet["token_estimate"],
        "token_estimate": chat_wallet["token_estimate"],
        "billing_exempt": bool(billing_exempt),
        **({"balance_display": "Unlimited"} if billing_exempt else {}),
    }


def usage_preferences_dict(
    session: Session, *, user: User, row: WebUsagePreferences | None = None,
    billing_exempt: bool = False,
) -> dict[str, Any]:
    if row is None:
        row = session.exec(select(WebUsagePreferences).where(
            WebUsagePreferences.user_id == int(user.id)
        )).first()
    summary = usage_summary(
        session, user=user, period="current_month", billing_exempt=billing_exempt,
    )
    swico_tier = selected_swico_tier(session, int(user.id))
    hard_limit = int(row.hard_limit_micros) if row and row.hard_limit_micros is not None else None
    threshold = int(row.warning_threshold_percent) if row else 80
    used = int(summary["debited_micros"])
    return {
        "period": row.period if row else "monthly",
        "hard_limit_micros": hard_limit,
        "hard_limit_ai_credits": ai_credits(hard_limit) if hard_limit is not None else None,
        "tier": swico_tier,
        "tier_label": SWICO_TIER_LABELS[swico_tier],
        "hard_limit_token_estimate": token_estimate(hard_limit, tier=swico_tier) if hard_limit is not None else None,
        "warning_threshold_percent": threshold,
        "notify_at_threshold": bool(row.notify_at_threshold) if row else True,
        "current_usage_micros": used,
        "current_usage_ai_credits": ai_credits(used),
        "remaining_micros": None if hard_limit is None else max(0, hard_limit - used),
        "remaining_token_estimate": token_estimate(max(0, hard_limit - used), tier=swico_tier) if hard_limit is not None else None,
        "warning_reached": bool(hard_limit and used * 100 >= hard_limit * threshold),
        "next_reset_at": summary["next_reset_at"],
        "timezone": user.timezone,
        "updated_at": row.updated_at if row else None,
        "billing_exempt": bool(billing_exempt),
    }
