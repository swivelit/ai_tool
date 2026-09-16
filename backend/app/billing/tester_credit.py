from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_DOWN
import os
from typing import Mapping
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlmodel import Session, select

from ..auth import normalized_email
from ..database import IS_POSTGRES
from ..models import UsageCharge, WeeklyTesterCreditWindow
from ..time_utils import ensure_utc, utc_now
from .token_estimates import token_estimate


MICROS_PER_RUPEE = 1_000_000
TESTER_CREDIT_BUCKET = "chat"


class TesterCreditConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class WeeklyTesterCreditConfig:
    enabled: bool
    emails: frozenset[str]
    allowance_micros: int


def _bool(value: str) -> bool | None:
    value = str(value or "").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return None


def allowance_to_micros(value: str) -> int:
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise TesterCreditConfigurationError("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES must be a decimal") from None
    if not amount.is_finite() or amount < 0:
        raise TesterCreditConfigurationError("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES must be non-negative")
    scaled = amount * Decimal(MICROS_PER_RUPEE)
    if scaled != scaled.to_integral_value(rounding=ROUND_DOWN):
        raise TesterCreditConfigurationError("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES supports at most 6 decimal places")
    return int(scaled)


def weekly_tester_config(environ: Mapping[str, str] | None = None) -> WeeklyTesterCreditConfig:
    env = os.environ if environ is None else environ
    raw_enabled = env.get("SWICO_WEEKLY_TESTER_CREDITS_ENABLED", "false")
    enabled = _bool(raw_enabled)
    if enabled is None:
        raise TesterCreditConfigurationError("SWICO_WEEKLY_TESTER_CREDITS_ENABLED must be a boolean")
    emails = frozenset(
        normalized_email(item)
        for item in str(env.get("SWICO_WEEKLY_TESTER_EMAILS", "") or "").split(",")
        if normalized_email(item)
    )
    raw_allowance = str(env.get("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES", "40" if enabled else "0") or "").strip()
    allowance = allowance_to_micros(raw_allowance)
    if enabled and not emails:
        # An enabled feature with no exact subjects is safe but operationally
        # inert; it must not accidentally grant a broad default audience.
        allowance = 0
    return WeeklyTesterCreditConfig(enabled=enabled, emails=emails, allowance_micros=allowance)


def weekly_window(now: datetime | None = None) -> tuple[datetime, datetime]:
    current = ensure_utc(now or utc_now())
    start = datetime(current.year, current.month, current.day, tzinfo=timezone.utc)
    start -= timedelta(days=start.weekday())
    return start, start + timedelta(days=7)


def is_weekly_tester_eligible(
    *, email_verified: bool, token_email: str | None, owned_email: str | None,
    config: WeeklyTesterCreditConfig | None = None,
) -> bool:
    cfg = config or weekly_tester_config()
    token = normalized_email(token_email)
    owned = normalized_email(owned_email)
    return bool(cfg.enabled and cfg.allowance_micros > 0 and email_verified and token and token == owned and token in cfg.emails)


def is_configured_tester_email(email: str | None, config: WeeklyTesterCreditConfig | None = None) -> bool:
    cfg = config or weekly_tester_config()
    return bool(cfg.enabled and cfg.allowance_micros > 0 and normalized_email(email) in cfg.emails)


def _locked_window(
    session: Session, *, user_id: int, now: datetime, allowance_micros: int,
) -> WeeklyTesterCreditWindow:
    start, end = weekly_window(now)
    query = select(WeeklyTesterCreditWindow).where(
        WeeklyTesterCreditWindow.user_id == int(user_id),
        WeeklyTesterCreditWindow.credit_bucket == TESTER_CREDIT_BUCKET,
        WeeklyTesterCreditWindow.period_start == start,
    ).with_for_update()
    window = session.exec(query).first()
    if window is None:
        values = dict(
            id=str(uuid4()), user_id=int(user_id), credit_bucket=TESTER_CREDIT_BUCKET,
            period_start=start, period_end=end, allowance_micros=int(allowance_micros),
            reserved_micros=0, consumed_micros=0, version=0,
            created_at=now, updated_at=now,
        )
        if IS_POSTGRES:
            session.exec(postgresql_insert(WeeklyTesterCreditWindow).values(**values).on_conflict_do_nothing(
                index_elements=["user_id", "credit_bucket", "period_start"]
            ))
        else:
            try:
                with session.begin_nested():
                    session.add(WeeklyTesterCreditWindow(**values))
                    session.flush()
            except IntegrityError:
                pass
        window = session.exec(query).first()
    if window is None:
        raise RuntimeError("Unable to materialize weekly tester credit window")
    # Configuration changes apply to the current window, but never claw back
    # settled or in-flight capacity. The effective allowance floor preserves
    # the invariant while making availability zero after a reduction.
    minimum = int(window.consumed_micros) + int(window.reserved_micros)
    window.allowance_micros = max(int(allowance_micros), minimum)
    window.updated_at = now
    session.add(window)
    return window


def tester_credit_window_summary(
    session: Session, *, user_id: int, swico_tier: str, eligible: bool,
    billing_exempt: bool = False, now: datetime | None = None,
) -> dict[str, object]:
    if billing_exempt:
        return {"active": False, "source": "billing_exempt", "category": "chat", "balance_display": "Unlimited"}
    cfg = weekly_tester_config()
    if not eligible or not cfg.enabled or cfg.allowance_micros <= 0:
        return {"active": False, "source": "none", "category": "chat"}
    current = ensure_utc(now or utc_now())
    window = _locked_window(session, user_id=user_id, now=current, allowance_micros=cfg.allowance_micros)
    available = max(0, int(window.allowance_micros) - int(window.reserved_micros) - int(window.consumed_micros))
    return {
        "active": True, "source": "tester_credit", "category": "chat",
        "allowance_micros": int(window.allowance_micros),
        "reserved_micros": int(window.reserved_micros),
        "consumed_micros": int(window.consumed_micros),
        "available_micros": available,
        "token_estimate": token_estimate(available, tier=swico_tier),
        "period_start": ensure_utc(window.period_start),
        "period_end": ensure_utc(window.period_end),
    }


def reserve_tester_credit(
    session: Session, *, user_id: int, amount_micros: int, request_id: str,
    eligible: bool, swico_tier: str | None = None,
) -> WeeklyTesterCreditWindow | None:
    if not eligible or amount_micros <= 0:
        return None
    cfg = weekly_tester_config()
    if not cfg.enabled or cfg.allowance_micros <= 0:
        return None
    window = _locked_window(session, user_id=user_id, now=utc_now(), allowance_micros=cfg.allowance_micros)
    available = int(window.allowance_micros) - int(window.reserved_micros) - int(window.consumed_micros)
    if available < int(amount_micros):
        return None
    window.reserved_micros += int(amount_micros)
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
    return window


def settle_tester_credit(
    session: Session, *, charge: UsageCharge, provider_cost_micros: int,
    customer_debit_micros: int | None = None,
) -> int:
    window = session.exec(select(WeeklyTesterCreditWindow).where(
        WeeklyTesterCreditWindow.id == charge.tester_credit_window_id,
    ).with_for_update()).one()
    reserved = int(charge.reserved_micros)
    window.reserved_micros = max(0, int(window.reserved_micros) - reserved)
    source = max(0, int(provider_cost_micros) if customer_debit_micros is None else int(customer_debit_micros))
    debit = min(source, max(0, int(window.allowance_micros) - int(window.consumed_micros)))
    window.consumed_micros += debit
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
    return debit


def expand_tester_credit(
    session: Session, *, charge: UsageCharge, additional_micros: int,
    expansion_id: str,
) -> UsageCharge:
    """Grow a tester reservation once for a streaming expansion."""
    import json

    try:
        snapshot = json.loads(charge.pricing_snapshot_json or "{}")
    except (TypeError, ValueError):
        snapshot = {}
    expansions = snapshot.setdefault("tester_expansions", [])
    if expansion_id in expansions:
        return charge
    window = session.exec(select(WeeklyTesterCreditWindow).where(
        WeeklyTesterCreditWindow.id == charge.tester_credit_window_id,
    ).with_for_update()).one()
    available = int(window.allowance_micros) - int(window.reserved_micros) - int(window.consumed_micros)
    delta = max(0, int(additional_micros))
    if available < delta:
        from .errors import InsufficientCreditError
        raise InsufficientCreditError(available, delta)
    window.reserved_micros += delta
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
    expansions.append(str(expansion_id))
    snapshot["tester_expansions"] = expansions[-32:]
    charge.pricing_snapshot_json = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
    charge.reserved_micros += delta
    session.add(charge)
    return charge


def release_tester_credit(session: Session, *, charge: UsageCharge) -> None:
    window = session.exec(select(WeeklyTesterCreditWindow).where(
        WeeklyTesterCreditWindow.id == charge.tester_credit_window_id,
    ).with_for_update()).one()
    window.reserved_micros = max(0, int(window.reserved_micros) - int(charge.reserved_micros))
    window.version += 1
    window.updated_at = utc_now()
    session.add(window)
