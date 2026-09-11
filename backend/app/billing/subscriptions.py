from __future__ import annotations

import calendar
import json
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..database import IS_POSTGRES
from ..models import (
    PaymentOrder,
    ReferralAttribution,
    ReferralCode,
    ReferralReward,
    SubscriptionEntitlement,
    SubscriptionPreference,
    SubscriptionUsageLedger,
    SubscriptionUsageWindow,
)
from ..time_utils import utc_now


WEEK_SECONDS = 604800
DEFAULT_WEEKLY_ALLOWANCE_MICROS = 125_000_000
PLAN_CODES = ("1m", "6m", "1y")


@dataclass(frozen=True)
class SubscriptionPlan:
    code: str
    label: str
    price_paise: int
    duration_months: int


def _integer(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)).strip())
    except (TypeError, ValueError):
        return default


def subscriptions_enabled() -> bool:
    return os.getenv("WEB_SUBSCRIPTIONS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def referrals_enabled() -> bool:
    return os.getenv("WEB_REFERRALS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def weekly_allowance_micros() -> int:
    return _integer("WEB_SUBSCRIPTION_WEEKLY_ALLOWANCE_MICROS", DEFAULT_WEEKLY_ALLOWANCE_MICROS)


def plan_catalog() -> dict[str, SubscriptionPlan]:
    return {
        "1m": SubscriptionPlan("1m", "1 month", _integer("WEB_SUBSCRIPTION_1M_PRICE_PAISE", 150_000), 1),
        "6m": SubscriptionPlan("6m", "6 months", _integer("WEB_SUBSCRIPTION_6M_PRICE_PAISE", 800_000), 6),
        "1y": SubscriptionPlan("1y", "1 year", _integer("WEB_SUBSCRIPTION_1Y_PRICE_PAISE", 1_200_000), 12),
    }


def referral_reward_mapping() -> dict[str, dict[str, int]]:
    return {
        "1m": {"weeks": _integer("WEB_REFERRAL_REWARD_1M_WEEKS", 1), "months": 0},
        "6m": {"weeks": _integer("WEB_REFERRAL_REWARD_6M_WEEKS", 3), "months": 0},
        "1y": {"weeks": 0, "months": _integer("WEB_REFERRAL_REWARD_1Y_MONTHS", 2)},
    }


def add_calendar_months(value: datetime, months: int) -> datetime:
    """Add calendar months while preserving a valid end-of-month date."""
    total = value.year * 12 + (value.month - 1) + int(months)
    year, month_zero = divmod(total, 12)
    month = month_zero + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def ensure_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def plan_or_raise(code: str | None) -> SubscriptionPlan:
    plan = plan_catalog().get(str(code or "").strip().lower())
    if plan is None:
        raise ValueError("Unsupported subscription plan.")
    return plan


def subscription_config_public(swico_tier: str = "lite") -> dict[str, Any]:
    from .token_estimates import token_estimate

    plans = plan_catalog()
    return {
        "enabled": subscriptions_enabled(),
        "plans": [
            {"code": plan.code, "label": plan.label, "price_paise": plan.price_paise, "duration_months": plan.duration_months}
            for plan in plans.values()
        ],
        "weekly_allowance_micros": weekly_allowance_micros(),
        "weekly_token_estimate": token_estimate(
            weekly_allowance_micros(), tier=swico_tier,
        ),
        "weekly_allowance_rupees": weekly_allowance_micros() / 1_000_000,
        "no_rollover": True,
        "prorate_final_partial_week": os.getenv("WEB_SUBSCRIPTION_PRORATE_FINAL_PARTIAL_WEEK", "true").strip().lower() in {"1", "true", "yes", "on"},
        "prepaid_non_renewing": True,
        "referral_reward_mapping": referral_reward_mapping(),
    }


def _preference(session: Session, user_id: int, bucket: str, *, create: bool = True) -> SubscriptionPreference | None:
    row = session.exec(select(SubscriptionPreference).where(
        SubscriptionPreference.user_id == int(user_id), SubscriptionPreference.credit_bucket == bucket,
    ).with_for_update()).first()
    if row is None and create:
        default = os.getenv("WEB_SUBSCRIPTION_PAYG_FALLBACK_DEFAULT", "false").strip().lower() in {"1", "true", "yes", "on"}
        row = SubscriptionPreference(user_id=int(user_id), credit_bucket=bucket, payg_fallback_enabled=default)
        session.add(row)
        session.flush()
    return row


def payg_fallback_enabled(session: Session, user_id: int, bucket: str) -> bool:
    row = _preference(session, user_id, bucket)
    return bool(row and row.payg_fallback_enabled)


def set_payg_fallback(session: Session, user_id: int, bucket: str, enabled: bool) -> SubscriptionPreference:
    row = _preference(session, user_id, bucket)
    assert row is not None
    row.payg_fallback_enabled = bool(enabled)
    row.updated_at = utc_now()
    session.add(row)
    return row


def _latest_entitlement(session: Session, user_id: int, bucket: str) -> SubscriptionEntitlement | None:
    return session.exec(select(SubscriptionEntitlement).where(
        SubscriptionEntitlement.user_id == int(user_id),
        SubscriptionEntitlement.credit_bucket == bucket,
        SubscriptionEntitlement.status != "cancelled",
    ).order_by(SubscriptionEntitlement.ends_at.desc()).with_for_update()).first()


def _set_entitlement_status(entitlement: SubscriptionEntitlement, now: datetime) -> None:
    if entitlement.status == "cancelled":
        return
    if ensure_utc(entitlement.ends_at) <= now:
        entitlement.status = "expired"
    elif ensure_utc(entitlement.starts_at) <= now:
        entitlement.status = "active"
    else:
        entitlement.status = "queued"
    entitlement.updated_at = now


def create_entitlement(
    session: Session,
    *, user_id: int,
    credit_bucket: str,
    plan_code: str,
    source: str,
    source_payment_order_id: str | None = None,
    source_referral_reward_id: str | None = None,
    starts_at: datetime | None = None,
    duration_months: int | None = None,
    reward_weeks: int = 0,
    price_paise: int = 0,
) -> SubscriptionEntitlement:
    if credit_bucket not in {"chat", "voice"}:
        raise ValueError("Unsupported credit bucket")
    _preference(session, user_id, credit_bucket)
    now = ensure_utc(starts_at or utc_now())
    if source_payment_order_id:
        existing = session.exec(select(SubscriptionEntitlement).where(SubscriptionEntitlement.source_payment_order_id == source_payment_order_id)).first()
        if existing:
            return existing
    if source_referral_reward_id:
        existing = session.exec(select(SubscriptionEntitlement).where(SubscriptionEntitlement.source_referral_reward_id == source_referral_reward_id)).first()
        if existing:
            return existing
    if source == "purchase":
        plan = plan_or_raise(plan_code)
        months = plan.duration_months
        price = plan.price_paise
    else:
        months = max(0, int(duration_months or 0))
        price = max(0, int(price_paise))
    if months:
        ends_at = add_calendar_months(now, months)
    else:
        ends_at = now + timedelta(weeks=max(0, int(reward_weeks)))
    latest = _latest_entitlement(session, user_id, credit_bucket)
    if latest is not None and ensure_utc(latest.ends_at) > now:
        now = ensure_utc(latest.ends_at)
        ends_at = add_calendar_months(now, months) if months else now + timedelta(weeks=max(0, int(reward_weeks)))
    entitlement = SubscriptionEntitlement(
        user_id=int(user_id), credit_bucket=credit_bucket, source=source, plan_code=plan_code,
        source_payment_order_id=source_payment_order_id, source_referral_reward_id=source_referral_reward_id,
        starts_at=now, ends_at=ends_at, weekly_allowance_micros=max(0, weekly_allowance_micros()),
        price_paise=price, duration_months=months, reward_weeks=max(0, int(reward_weeks)), status="queued",
        rule_snapshot_json=json.dumps({
            "weekly_allowance_micros": weekly_allowance_micros(),
            "no_rollover": True,
            "prorate_final_partial_week": os.getenv("WEB_SUBSCRIPTION_PRORATE_FINAL_PARTIAL_WEEK", "true").strip().lower() in {"1", "true", "yes", "on"},
        }, sort_keys=True, separators=(",", ":")),
    )
    _set_entitlement_status(entitlement, ensure_utc(utc_now()))
    session.add(entitlement)
    session.flush()
    return entitlement


def fulfill_subscription_payment(session: Session, order: PaymentOrder) -> SubscriptionEntitlement:
    """Fulfill one captured subscription order and its eligible referral reward."""
    if order.purchase_type != "subscription":
        raise ValueError("Payment order is not a subscription")
    if order.credited_amount_micros != 0:
        raise ValueError("Subscription orders cannot contain wallet credit")
    plan = plan_or_raise(order.subscription_plan_code)
    if order.gross_amount_paise != plan.price_paise:
        raise ValueError("Subscription price does not match server configuration")
    entitlement = create_entitlement(
        session, user_id=order.user_id, credit_bucket=order.credit_bucket,
        plan_code=plan.code, source="purchase", source_payment_order_id=order.id,
        price_paise=plan.price_paise,
    )
    order.fulfillment_status = "fulfilled"
    order.status = "fulfilled"
    order.paid_at = order.paid_at or utc_now()
    order.updated_at = utc_now()
    session.add(order)
    create_referral_reward_once(session, order)
    return entitlement


def materialize_windows(session: Session, entitlement: SubscriptionEntitlement, *, now: datetime | None = None) -> list[SubscriptionUsageWindow]:
    """Create the deterministic windows for an entitlement on demand."""
    current = ensure_utc(now or utc_now())
    starts = ensure_utc(entitlement.starts_at)
    ends = ensure_utc(entitlement.ends_at)
    existing = {row.window_index: row for row in session.exec(select(SubscriptionUsageWindow).where(SubscriptionUsageWindow.entitlement_id == entitlement.id)).all()}
    cursor = starts
    index = 0
    # Windows are small (at most 53 for a yearly plan) and remain a lazy
    # materialization: future entitlements are not touched until they are read.
    while cursor < ends and (cursor <= current or index == 0):
        period_end = min(cursor + timedelta(seconds=WEEK_SECONDS), ends)
        duration = max(0, int((period_end - cursor).total_seconds()))
        allowance = int(entitlement.weekly_allowance_micros * duration // WEEK_SECONDS)
        row = existing.get(index)
        if row is None:
            row = SubscriptionUsageWindow(
                entitlement_id=entitlement.id, user_id=entitlement.user_id, credit_bucket=entitlement.credit_bucket,
                window_index=index, period_start=cursor, period_end=period_end,
                allowance_micros=allowance,
            )
            session.add(row)
            session.flush()
            existing[index] = row
        cursor = period_end
        index += 1
    return [existing[key] for key in sorted(existing)]


def active_window(session: Session, user_id: int, bucket: str, *, now: datetime | None = None) -> SubscriptionUsageWindow | None:
    current = ensure_utc(now or utc_now())
    entitlements = session.exec(select(SubscriptionEntitlement).where(
        SubscriptionEntitlement.user_id == int(user_id), SubscriptionEntitlement.credit_bucket == bucket,
        SubscriptionEntitlement.status != "cancelled", SubscriptionEntitlement.ends_at > current,
    ).order_by(SubscriptionEntitlement.starts_at.asc()).with_for_update()).all()
    for entitlement in entitlements:
        _set_entitlement_status(entitlement, current)
        session.add(entitlement)
        if ensure_utc(entitlement.starts_at) <= current < ensure_utc(entitlement.ends_at):
            windows = materialize_windows(session, entitlement, now=current)
            for window in windows:
                if ensure_utc(window.period_start) <= current < ensure_utc(window.period_end):
                    return session.exec(select(SubscriptionUsageWindow).where(SubscriptionUsageWindow.id == window.id).with_for_update()).one()
    return None


def subscription_ledger_once(session: Session, *, window: SubscriptionUsageWindow, entitlement_id: str, user_id: int, bucket: str, entry_type: str, amount_micros: int, idempotency_key: str, usage_charge_id: str | None = None, metadata: dict[str, Any] | None = None) -> SubscriptionUsageLedger:
    existing = session.exec(select(SubscriptionUsageLedger).where(SubscriptionUsageLedger.idempotency_key == idempotency_key)).first()
    if existing:
        return existing
    row = SubscriptionUsageLedger(
        user_id=int(user_id), credit_bucket=bucket, entitlement_id=entitlement_id, window_id=window.id,
        usage_charge_id=usage_charge_id, entry_type=entry_type, amount_micros=max(0, int(amount_micros)),
        idempotency_key=idempotency_key, metadata_json=json.dumps(metadata or {}, sort_keys=True, separators=(",", ":")),
    )
    session.add(row)
    session.flush()
    return row


def reserve_subscription_window(
    session: Session, *, user_id: int, bucket: str, request_id: str,
    amount_micros: int, usage_charge_id: str | None = None,
) -> SubscriptionUsageWindow | None:
    """Reserve a complete request from the current subscription window."""
    required = max(0, int(amount_micros))
    if required == 0:
        return None
    window = active_window(session, user_id, bucket)
    if window is None:
        return None
    remaining = max(0, int(window.allowance_micros - window.reserved_micros - window.consumed_micros))
    if remaining < required:
        return window
    window.reserved_micros += required
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
    subscription_ledger_once(
        session, window=window, entitlement_id=window.entitlement_id,
        user_id=user_id, bucket=bucket, entry_type="reservation",
        amount_micros=required, usage_charge_id=usage_charge_id,
        idempotency_key=f"subscription-reserve:{request_id}",
        metadata={"request_id": request_id},
    )
    return window


def subscription_window_remaining(window: SubscriptionUsageWindow) -> int:
    return max(0, int(window.allowance_micros - window.reserved_micros - window.consumed_micros))


def settle_subscription_window(
    session: Session, *, charge: Any, provider_cost_micros: int,
    request_id: str, metadata: dict[str, Any] | None = None,
    customer_debit_micros: int | None = None,
) -> int:
    """Settle without touching a wallet; provider overage is platform absorbed."""
    if not charge.subscription_window_id:
        raise ValueError("Subscription charge has no usage window")
    window = session.exec(select(SubscriptionUsageWindow).where(
        SubscriptionUsageWindow.id == charge.subscription_window_id,
    ).with_for_update()).one()
    reserved = max(0, int(charge.reserved_micros))
    debit_source = (
        provider_cost_micros
        if customer_debit_micros is None else customer_debit_micros
    )
    debit = min(max(0, int(debit_source)), reserved)
    window.reserved_micros = max(0, int(window.reserved_micros) - reserved)
    window.consumed_micros += debit
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
    subscription_ledger_once(
        session, window=window, entitlement_id=window.entitlement_id,
        user_id=charge.user_id, bucket=charge.credit_bucket,
        entry_type="usage_debit", amount_micros=debit,
        usage_charge_id=charge.id, idempotency_key=f"subscription-debit:{request_id}",
        metadata={"provider_cost_micros": max(0, int(provider_cost_micros)), **(metadata or {})},
    )
    if reserved > debit:
        subscription_ledger_once(
            session, window=window, entitlement_id=window.entitlement_id,
            user_id=charge.user_id, bucket=charge.credit_bucket,
            entry_type="reservation_release", amount_micros=reserved - debit,
            usage_charge_id=charge.id, idempotency_key=f"subscription-release:{request_id}",
            metadata={"unused_micros": reserved - debit},
        )
    return debit


def release_subscription_window(
    session: Session, *, charge: Any, request_id: str, reason: str,
) -> None:
    if not charge.subscription_window_id:
        return
    window = session.exec(select(SubscriptionUsageWindow).where(
        SubscriptionUsageWindow.id == charge.subscription_window_id,
    ).with_for_update()).one()
    reserved = max(0, int(charge.reserved_micros))
    window.reserved_micros = max(0, int(window.reserved_micros) - reserved)
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
    subscription_ledger_once(
        session, window=window, entitlement_id=window.entitlement_id,
        user_id=charge.user_id, bucket=charge.credit_bucket,
        entry_type="reservation_release", amount_micros=reserved,
        usage_charge_id=charge.id, idempotency_key=f"subscription-release:{request_id}",
        metadata={"reason": str(reason)[:80]},
    )


def referral_code_for_user(session: Session, user_id: int) -> ReferralCode:
    existing = session.exec(select(ReferralCode).where(ReferralCode.user_id == int(user_id))).first()
    if existing:
        return existing
    for _ in range(5):
        code = secrets.token_urlsafe(9).replace("-", "").replace("_", "").upper()[:12]
        row = ReferralCode(user_id=int(user_id), code=code)
        try:
            session.add(row)
            session.flush()
            return row
        except IntegrityError:
            session.rollback()
    raise RuntimeError("Unable to generate referral code")


def claim_referral_code(session: Session, *, referred_user_id: int, code: str) -> ReferralAttribution:
    if not referrals_enabled():
        raise ValueError("Referral rewards are not available.")
    existing = session.exec(select(ReferralAttribution).where(ReferralAttribution.referred_user_id == int(referred_user_id))).first()
    if existing:
        raise ValueError("A referral code has already been claimed.")
    referral = session.exec(select(ReferralCode).where(ReferralCode.code == str(code or "").strip().upper(), ReferralCode.disabled.is_(False))).first()
    if referral is None:
        raise ValueError("Referral code is invalid.")
    if referral.user_id == int(referred_user_id):
        raise ValueError("You cannot refer yourself.")
    if session.exec(select(PaymentOrder).where(PaymentOrder.user_id == int(referred_user_id), PaymentOrder.purchase_type == "subscription", PaymentOrder.status.in_(["captured", "fulfilled", "partially_refunded", "refunded"]))).first():
        raise ValueError("Referral codes can only be claimed before your first subscription purchase.")
    row = ReferralAttribution(referrer_user_id=referral.user_id, referred_user_id=int(referred_user_id), referral_code_id=referral.id)
    session.add(row)
    session.flush()
    return row


def create_referral_reward_once(session: Session, order: PaymentOrder) -> ReferralReward | None:
    if not referrals_enabled() or order.purchase_type != "subscription" or order.status not in {"captured", "fulfilled"}:
        return None
    if not order.subscription_plan_code:
        return None
    attribution = session.exec(select(ReferralAttribution).where(ReferralAttribution.referred_user_id == order.user_id, ReferralAttribution.status == "claimed").with_for_update()).first()
    if attribution is None:
        return None
    if session.exec(select(ReferralReward).where(ReferralReward.qualifying_payment_order_id == order.id)).first():
        return session.exec(select(ReferralReward).where(ReferralReward.qualifying_payment_order_id == order.id)).one()
    prior = session.exec(select(ReferralReward).where(ReferralReward.referred_user_id == order.user_id, ReferralReward.status.in_(["pending", "earned", "fulfilled"]))).first()
    if prior:
        return None
    mapping = referral_reward_mapping()[order.subscription_plan_code]
    reward = ReferralReward(
        referrer_user_id=attribution.referrer_user_id, referred_user_id=order.user_id,
        qualifying_payment_order_id=order.id, credit_bucket=order.credit_bucket,
        purchased_plan_code=order.subscription_plan_code, purchased_price_paise=order.gross_amount_paise,
        reward_duration_months=mapping["months"], reward_duration_weeks=mapping["weeks"], status="pending",
    )
    session.add(reward)
    session.flush()
    entitlement = create_entitlement(
        session, user_id=reward.referrer_user_id, credit_bucket=reward.credit_bucket,
        plan_code=f"reward-{order.subscription_plan_code}", source="referral_reward",
        source_referral_reward_id=reward.id, duration_months=reward.reward_duration_months,
        reward_weeks=reward.reward_duration_weeks, price_paise=0,
    )
    reward.generated_entitlement_id = entitlement.id
    reward.status = "fulfilled"
    reward.updated_at = utc_now()
    session.add(reward)
    return reward


def subscription_summary(session: Session, user_id: int, *, swico_tier: str = "lite", billing_exempt: bool = False) -> dict[str, Any]:
    from .token_estimates import token_estimate

    result: dict[str, Any] = {"enabled": subscriptions_enabled(), "chat": None, "voice": None}
    for bucket in ("chat", "voice"):
        now = ensure_utc(utc_now())
        rows = session.exec(select(SubscriptionEntitlement).where(
            SubscriptionEntitlement.user_id == int(user_id), SubscriptionEntitlement.credit_bucket == bucket,
            SubscriptionEntitlement.status != "cancelled", SubscriptionEntitlement.ends_at > now,
        ).order_by(SubscriptionEntitlement.starts_at.asc())).all()
        active = active_window(session, user_id, bucket, now=now)
        active_entitlement = session.get(SubscriptionEntitlement, active.entitlement_id) if active else None
        queued = [row for row in rows if active_entitlement is None or row.id != active_entitlement.id]
        remaining = max(0, int(active.allowance_micros - active.reserved_micros - active.consumed_micros)) if active else 0
        used = int(active.consumed_micros) if active else 0
        reserved = int(active.reserved_micros) if active else 0
        allowance_tokens = None if billing_exempt or not active else token_estimate(
            int(active.allowance_micros), tier=swico_tier,
        )
        consumed_tokens = None if billing_exempt or not active else token_estimate(
            used, tier=swico_tier,
        )
        reserved_tokens = None if billing_exempt or not active else token_estimate(
            reserved, tier=swico_tier,
        )
        remaining_tokens = None if billing_exempt or not active else token_estimate(
            remaining, tier=swico_tier,
        )
        summary: dict[str, Any] = {
            "active": active is not None,
            "source": active_entitlement.source if active_entitlement else None,
            "plan": active_entitlement.plan_code if active_entitlement else None,
            "starts_at": active_entitlement.starts_at if active_entitlement else None,
            "expires_at": active_entitlement.ends_at if active_entitlement else None,
            "current_window_start": active.period_start if active else None,
            "next_reset_at": active.period_end if active else None,
            "allowance_micros": int(active.allowance_micros) if active else 0,
            "consumed_micros": used,
            "reserved_micros": reserved,
            "remaining_micros": remaining,
            "progress_percent": min(100, ((used + reserved) * 100 / active.allowance_micros)) if active and active.allowance_micros else 0,
            "allowance_token_estimate": allowance_tokens,
            "consumed_token_estimate": consumed_tokens,
            "reserved_token_estimate": reserved_tokens,
            "remaining_token_estimate": remaining_tokens,
            "queued_entitlements": [{"source": row.source, "plan": row.plan_code, "starts_at": row.starts_at, "expires_at": row.ends_at} for row in queued],
            "payg_fallback_enabled": payg_fallback_enabled(session, user_id, bucket),
        }
        if bucket == "chat":
            summary["token_estimate"] = remaining_tokens
        else:
            summary["voice_estimate"] = {
                "remaining_token_estimate": remaining_tokens,
                "note": "Estimated token equivalent. Voice usage can include speech processing and AI response generation.",
            } if remaining_tokens is not None else None
        result[bucket] = summary
    return result
