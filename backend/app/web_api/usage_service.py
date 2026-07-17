from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from ..billing.pricing import MILLION
from ..billing.service import get_wallet_summary
from ..billing.token_estimates import token_estimate
from ..billing.usage_limits import monthly_period_bounds, validated_timezone
from ..models import UsageCharge, User, WebUsagePreferences
from ..time_utils import ensure_utc, utc_now


def ai_credits(micros: int) -> str:
    return format(Decimal(int(micros)) / MILLION, ".6f")


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
                UsageCharge.user_id == int(user.id), UsageCharge.status == "settled"
            ).order_by(UsageCharge.settled_at.asc())
        ).first()
        start = ensure_utc(first.settled_at) if first and first.settled_at else ensure_utc(user.created_at)
        return start, now, None
    raise ValueError("Unsupported usage period.")


def usage_summary(
    session: Session, *, user: User, period: str, now: datetime | None = None,
) -> dict[str, Any]:
    current = ensure_utc(now or utc_now())
    zone: ZoneInfo = validated_timezone(user.timezone)
    start, end, next_reset = _period_bounds(
        session, user=user, period=period, now=current
    )
    rows = session.exec(
        select(UsageCharge).where(
            UsageCharge.user_id == int(user.id),
            UsageCharge.status == "settled",
            UsageCharge.debited_micros > 0,
            UsageCharge.settled_at >= start,
            UsageCharge.settled_at < end,
        ).order_by(UsageCharge.settled_at.asc())
    ).all()
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
    providers: dict[str, dict[str, int | str]] = {}
    models: dict[tuple[str, str], dict[str, int | str]] = {}
    for row in rows:
        total_tokens = int(row.input_tokens) + int(row.output_tokens)
        totals["request_count"] += 1
        totals["input_tokens"] += int(row.input_tokens)
        totals["cached_input_tokens"] += int(row.cached_input_tokens)
        totals["output_tokens"] += int(row.output_tokens)
        totals["total_tokens"] += total_tokens
        totals["debited_micros"] += int(row.debited_micros)
        totals[f"{row.usage_source}_usage_count"] += 1
        local_day = ensure_utc(row.settled_at or row.created_at).astimezone(zone).date().isoformat()
        day = daily[local_day]
        for key, value in (
            ("request_count", 1), ("input_tokens", int(row.input_tokens)),
            ("cached_input_tokens", int(row.cached_input_tokens)),
            ("output_tokens", int(row.output_tokens)), ("total_tokens", total_tokens),
            ("debited_micros", int(row.debited_micros)),
        ):
            day[key] += value
        provider = providers.setdefault(row.provider, {
            "provider": row.provider, "request_count": 0, "input_tokens": 0,
            "cached_input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
            "debited_micros": 0,
        })
        model_key = (row.provider, row.model)
        model = models.setdefault(model_key, {
            "provider": row.provider, "model": row.model, "request_count": 0,
            "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0,
            "total_tokens": 0, "debited_micros": 0,
        })
        for bucket in (provider, model):
            for key, value in (
                ("request_count", 1), ("input_tokens", int(row.input_tokens)),
                ("cached_input_tokens", int(row.cached_input_tokens)),
                ("output_tokens", int(row.output_tokens)), ("total_tokens", total_tokens),
                ("debited_micros", int(row.debited_micros)),
            ):
                bucket[key] = int(bucket[key]) + value
    wallet = get_wallet_summary(session, int(user.id))
    for day, values in daily.items():
        values["debited_ai_credits"] = ai_credits(values["debited_micros"])
    for bucket in [*providers.values(), *models.values()]:
        bucket["debited_ai_credits"] = ai_credits(int(bucket["debited_micros"]))
    return {
        "period": period,
        "timezone": user.timezone,
        "period_start": start,
        "period_end": end,
        "next_reset_at": next_reset,
        **totals,
        "debited_ai_credits": ai_credits(totals["debited_micros"]),
        "available_micros": int(wallet["available_micros"]),
        "available_ai_credits": ai_credits(int(wallet["available_micros"])),
        "daily": [{"date": day, **values} for day, values in sorted(daily.items())],
        "provider_breakdown": sorted(providers.values(), key=lambda item: str(item["provider"])),
        "model_breakdown": sorted(models.values(), key=lambda item: (str(item["provider"]), str(item["model"]))),
        "estimated_tokens_remaining": wallet["token_estimate"],
        "token_estimate": wallet["token_estimate"],
    }


def usage_preferences_dict(
    session: Session, *, user: User, row: WebUsagePreferences | None = None,
) -> dict[str, Any]:
    if row is None:
        row = session.exec(select(WebUsagePreferences).where(
            WebUsagePreferences.user_id == int(user.id)
        )).first()
    summary = usage_summary(session, user=user, period="current_month")
    hard_limit = int(row.hard_limit_micros) if row and row.hard_limit_micros is not None else None
    threshold = int(row.warning_threshold_percent) if row else 80
    used = int(summary["debited_micros"])
    return {
        "period": row.period if row else "monthly",
        "hard_limit_micros": hard_limit,
        "hard_limit_ai_credits": ai_credits(hard_limit) if hard_limit is not None else None,
        "hard_limit_token_estimate": token_estimate(hard_limit) if hard_limit is not None else None,
        "warning_threshold_percent": threshold,
        "notify_at_threshold": bool(row.notify_at_threshold) if row else True,
        "current_usage_micros": used,
        "current_usage_ai_credits": ai_credits(used),
        "remaining_micros": None if hard_limit is None else max(0, hard_limit - used),
        "remaining_token_estimate": token_estimate(max(0, hard_limit - used)) if hard_limit is not None else None,
        "warning_reached": bool(hard_limit and used * 100 >= hard_limit * threshold),
        "next_reset_at": summary["next_reset_at"],
        "timezone": user.timezone,
        "updated_at": row.updated_at if row else None,
    }
