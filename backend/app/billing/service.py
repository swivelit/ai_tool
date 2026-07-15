from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_FLOOR
from typing import Any
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlmodel import Session, select

from ..models import ApiRateLimit, PaymentOrder, UsageCharge, WalletAccount, WalletLedger
from ..database import IS_POSTGRES
from ..time_utils import utc_now
from .errors import InsufficientCreditError, PaymentValidationError, RateLimitError


LEDGER_TYPES = {
    "payment_credit", "usage_debit", "reservation", "reservation_release",
    "refund_debit", "manual_adjustment",
}


def _locked_wallet(session: Session, user_id: int) -> WalletAccount:
    wallet = session.exec(
        select(WalletAccount).where(WalletAccount.user_id == int(user_id)).with_for_update()
    ).first()
    if wallet is None:
        if IS_POSTGRES:
            now = utc_now()
            session.exec(
                postgresql_insert(WalletAccount).values(
                    id=str(uuid4()), user_id=int(user_id), balance_micros=0,
                    reserved_micros=0, version=0, created_at=now, updated_at=now,
                ).on_conflict_do_nothing(index_elements=["user_id"])
            )
            wallet = session.exec(
                select(WalletAccount).where(WalletAccount.user_id == int(user_id)).with_for_update()
            ).one()
        else:
            wallet = WalletAccount(user_id=int(user_id))
            try:
                with session.begin_nested():
                    session.add(wallet)
                    session.flush()
            except IntegrityError:
                wallet = session.exec(
                    select(WalletAccount).where(WalletAccount.user_id == int(user_id)).with_for_update()
                ).one()
    return wallet


def get_or_create_wallet(session: Session, user_id: int) -> WalletAccount:
    return _locked_wallet(session, user_id)


def wallet_dict(wallet: WalletAccount) -> dict[str, int]:
    return {
        "balance_micros": int(wallet.balance_micros),
        "reserved_micros": int(wallet.reserved_micros),
        "available_micros": int(wallet.balance_micros - wallet.reserved_micros),
        "version": int(wallet.version),
    }


def get_wallet_summary(session: Session, user_id: int) -> dict[str, int]:
    return wallet_dict(get_or_create_wallet(session, user_id))


def _ledger(
    session: Session, wallet: WalletAccount, *, entry_type: str, amount_micros: int,
    reference_type: str, reference_id: str, idempotency_key: str, metadata: dict[str, Any] | None = None,
) -> WalletLedger:
    if entry_type not in LEDGER_TYPES:
        raise ValueError("Unsupported ledger entry type")
    existing = session.exec(select(WalletLedger).where(WalletLedger.idempotency_key == idempotency_key)).first()
    if existing:
        return existing
    row = WalletLedger(
        user_id=wallet.user_id, entry_type=entry_type, amount_micros=int(amount_micros),
        balance_after_micros=int(wallet.balance_micros), reference_type=reference_type,
        reference_id=reference_id, idempotency_key=idempotency_key,
        metadata_json=json.dumps(metadata or {}, sort_keys=True, separators=(",", ":")),
    )
    session.add(row)
    session.flush()
    return row


def credit_payment_once(session: Session, order: PaymentOrder) -> WalletLedger:
    key = f"payment-credit:{order.id}"
    existing = session.exec(select(WalletLedger).where(WalletLedger.idempotency_key == key)).first()
    if existing:
        if order.status != "credited":
            order.status = "credited"
            order.updated_at = utc_now()
            session.add(order)
        return existing
    wallet = _locked_wallet(session, order.user_id)
    wallet.balance_micros += int(order.credited_amount_micros)
    wallet.version += 1
    wallet.updated_at = utc_now()
    session.add(wallet)
    entry = _ledger(
        session, wallet, entry_type="payment_credit", amount_micros=order.credited_amount_micros,
        reference_type="payment_order", reference_id=order.id, idempotency_key=key,
        metadata={"provider": order.provider, "gross_amount_paise": order.gross_amount_paise},
    )
    order.status = "credited"
    order.paid_at = order.paid_at or utc_now()
    order.updated_at = utc_now()
    session.add(order)
    return entry


def create_usage_reservation(
    session: Session, *, request_id: str, user_id: int, thread_id: str | None,
    provider: str, model: str, reserved_micros: int, pricing_snapshot_json: str,
) -> UsageCharge:
    existing = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id)).first()
    if existing and existing.status != "released":
        return existing
    required = max(0, int(reserved_micros))
    wallet = _locked_wallet(session, user_id)
    available = int(wallet.balance_micros - wallet.reserved_micros)
    if available < required or wallet.balance_micros <= 0:
        raise InsufficientCreditError(available, required)
    attempt = 1
    if existing:
        charge = existing
        try:
            prior_snapshot = json.loads(charge.pricing_snapshot_json or "{}")
            attempt = int(prior_snapshot.get("reservation_attempt") or 1) + 1
        except (TypeError, ValueError):
            attempt = 2
        charge.provider = provider
        charge.model = model
        charge.reserved_micros = required
        charge.status = "reserved"
        charge.settled_at = None
        charge.pricing_snapshot_json = pricing_snapshot_json
    else:
        charge = UsageCharge(
            request_id=request_id, user_id=user_id, thread_id=thread_id, provider=provider,
            model=model, reserved_micros=required, status="reserved",
            pricing_snapshot_json=pricing_snapshot_json,
        )
    try:
        reservation_snapshot = json.loads(pricing_snapshot_json or "{}")
    except (TypeError, ValueError):
        reservation_snapshot = {}
    reservation_snapshot["reservation_attempt"] = attempt
    charge.pricing_snapshot_json = json.dumps(reservation_snapshot, sort_keys=True, separators=(",", ":"))
    session.add(charge)
    wallet.reserved_micros += required
    wallet.version += 1
    wallet.updated_at = utc_now()
    session.add(wallet)
    session.flush()
    _ledger(
        session, wallet, entry_type="reservation", amount_micros=-required,
        reference_type="usage_charge", reference_id=charge.id,
        idempotency_key=f"usage-reserve:{request_id}:attempt:{attempt}",
        metadata={"request_id": request_id, "attempt": attempt},
    )
    return charge


def settle_usage_reservation(
    session: Session, *, request_id: str, provider_cost_amount: Decimal,
    provider_cost_currency: str, provider_cost_micros: int, input_tokens: int,
    cached_input_tokens: int, output_tokens: int, usage_source: str,
    pricing_snapshot_json: str, usd_to_inr_rate: Decimal | None = None,
    assistant_message_id: str | None = None,
) -> UsageCharge:
    charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id).with_for_update()).first()
    if charge is None:
        raise PaymentValidationError("Usage reservation not found.")
    if charge.status == "settled":
        return charge
    if charge.status != "reserved":
        raise PaymentValidationError("Usage reservation is not active.")
    wallet = _locked_wallet(session, charge.user_id)
    provider_debit = max(0, int(provider_cost_micros))
    reserved = int(charge.reserved_micros)
    reservation_attempt = _reservation_attempt(charge)
    wallet.reserved_micros = max(0, wallet.reserved_micros - reserved)
    # Provider usage can rarely exceed a conservative reservation. Consume any
    # remaining wallet balance under the same lock, but normal usage must never
    # create a negative balance. The unmatched provider cost remains explicit on
    # the charge as a platform-absorbed overage for reconciliation.
    debit = min(provider_debit, max(0, int(wallet.balance_micros)))
    absorbed_overage = max(0, provider_debit - debit)
    wallet.balance_micros -= debit
    wallet.version += 1
    wallet.updated_at = utc_now()
    session.add(wallet)
    charge.provider_cost_amount_decimal = provider_cost_amount
    charge.provider_cost_currency = provider_cost_currency
    charge.provider_cost_micros = provider_debit
    charge.debited_micros = debit
    charge.input_tokens = max(0, input_tokens)
    charge.cached_input_tokens = max(0, cached_input_tokens)
    charge.output_tokens = max(0, output_tokens)
    charge.usage_source = usage_source if usage_source in {"actual", "estimated"} else "estimated"
    try:
        pricing_snapshot = json.loads(pricing_snapshot_json or "{}")
    except (TypeError, ValueError):
        pricing_snapshot = {}
    if absorbed_overage:
        pricing_snapshot["reconciliation"] = {
            "state": "platform_absorbed_overage",
            "amount_micros": absorbed_overage,
        }
    charge.pricing_snapshot_json = json.dumps(pricing_snapshot, sort_keys=True, separators=(",", ":"))
    charge.usd_to_inr_rate = usd_to_inr_rate
    charge.assistant_message_id = assistant_message_id
    charge.status = "settled"
    charge.settled_at = utc_now()
    session.add(charge)
    _ledger(
        session, wallet, entry_type="usage_debit", amount_micros=-debit,
        reference_type="usage_charge", reference_id=charge.id,
        idempotency_key=f"usage-debit:{request_id}",
        metadata={
            "provider": charge.provider, "model": charge.model,
            "usage_source": charge.usage_source,
            "provider_cost_micros": provider_debit,
            "platform_absorbed_overage_micros": absorbed_overage,
        },
    )
    _ledger(
        session, wallet, entry_type="reservation_release", amount_micros=reserved,
        reference_type="usage_charge", reference_id=charge.id,
        idempotency_key=f"usage-release:{request_id}:attempt:{reservation_attempt}",
        metadata={"unused_micros": max(0, reserved - debit), "attempt": reservation_attempt},
    )
    return charge


def release_usage_reservation(
    session: Session, request_id: str, *, reason: str = "provider_failed_or_cancelled"
) -> UsageCharge | None:
    charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id).with_for_update()).first()
    if charge is None or charge.status in {"released", "settled", "failed"}:
        return charge
    wallet = _locked_wallet(session, charge.user_id)
    reservation_attempt = _reservation_attempt(charge)
    wallet.reserved_micros = max(0, wallet.reserved_micros - int(charge.reserved_micros))
    wallet.version += 1
    wallet.updated_at = utc_now()
    session.add(wallet)
    charge.status = "released"
    charge.settled_at = utc_now()
    session.add(charge)
    _ledger(
        session, wallet, entry_type="reservation_release", amount_micros=int(charge.reserved_micros),
        reference_type="usage_charge", reference_id=charge.id,
        idempotency_key=f"usage-release:{request_id}:attempt:{reservation_attempt}",
        metadata={"reason": reason, "attempt": reservation_attempt},
    )
    return charge


def _reservation_attempt(charge: UsageCharge) -> int:
    try:
        return max(1, int(json.loads(charge.pricing_snapshot_json or "{}").get("reservation_attempt") or 1))
    except (TypeError, ValueError):
        return 1


def recover_stale_usage_reservations(
    session: Session, *, age_seconds: int, now: datetime | None = None,
    reason: str = "stale_reservation_recovery",
) -> list[str]:
    """Release reservations older than a conservative operator-selected age.

    The operation is row-locked and idempotent. Render should invoke the bundled
    command from a scheduled job with an age longer than the maximum provider
    timeout; it must not be run with a threshold that overlaps active requests.
    """
    minimum_age = max(60, int(age_seconds))
    cutoff = (now or utc_now()) - timedelta(seconds=minimum_age)
    rows = list(session.exec(
        select(UsageCharge).where(
            UsageCharge.status == "reserved", UsageCharge.created_at < cutoff
        ).order_by(UsageCharge.created_at.asc()).with_for_update()
    ).all())
    recovered: list[str] = []
    for charge in rows:
        released = release_usage_reservation(session, charge.request_id, reason=reason)
        if released is not None and released.status == "released":
            recovered.append(charge.request_id)
    return recovered


def reverse_credit_for_refund(session: Session, order: PaymentOrder, new_refunded_amount_paise: int) -> int:
    total_refunded = min(max(0, int(new_refunded_amount_paise)), int(order.gross_amount_paise))
    target_reversal = int(
        (Decimal(order.credited_amount_micros) * Decimal(total_refunded) / Decimal(order.gross_amount_paise))
        .to_integral_value(rounding=ROUND_FLOOR)
    )
    existing_entries = session.exec(
        select(WalletLedger).where(
            WalletLedger.reference_type == "payment_refund",
            WalletLedger.reference_id == order.id,
            WalletLedger.entry_type == "refund_debit",
        )
    ).all()
    already_reversed = -sum(min(0, int(entry.amount_micros)) for entry in existing_entries)
    delta = max(0, target_reversal - already_reversed)
    if delta:
        wallet = _locked_wallet(session, order.user_id)
        wallet.balance_micros -= delta
        wallet.version += 1
        wallet.updated_at = utc_now()
        session.add(wallet)
        _ledger(
            session, wallet, entry_type="refund_debit", amount_micros=-delta,
            reference_type="payment_refund", reference_id=order.id,
            idempotency_key=f"refund:{order.id}:{total_refunded}",
            metadata={"cumulative_refund_paise": total_refunded},
        )
    order.refunded_amount_paise = max(order.refunded_amount_paise, total_refunded)
    order.status = "refunded" if total_refunded >= order.gross_amount_paise else "partially_refunded"
    order.refunded_at = utc_now() if order.status == "refunded" else order.refunded_at
    order.updated_at = utc_now()
    session.add(order)
    return delta


def list_wallet_ledger(session: Session, user_id: int, *, limit: int = 50, offset: int = 0) -> list[WalletLedger]:
    return list(session.exec(
        select(WalletLedger).where(WalletLedger.user_id == user_id)
        .order_by(WalletLedger.created_at.desc()).offset(offset).limit(limit)
    ).all())


def enforce_rate_limit(session: Session, *, user_id: int, action: str, limit: int, window_seconds: int = 60) -> None:
    now = utc_now()
    epoch = int(now.timestamp())
    start = datetime.fromtimestamp(epoch - (epoch % window_seconds), tz=timezone.utc)
    scope = f"{action}:{user_id}"
    if IS_POSTGRES:
        statement = postgresql_insert(ApiRateLimit).values(
            id=str(uuid4()), scope_key=scope, window_started_at=start,
            request_count=1, updated_at=now,
        ).on_conflict_do_update(
            constraint="uq_api_rate_limit_scope_window",
            set_={"request_count": ApiRateLimit.request_count + 1, "updated_at": now},
        ).returning(ApiRateLimit.request_count)
        count = int(session.exec(statement).one())
        if count > limit:
            raise RateLimitError("Rate limit exceeded. Please try again shortly.")
        return
    row = session.exec(
        select(ApiRateLimit).where(ApiRateLimit.scope_key == scope, ApiRateLimit.window_started_at == start).with_for_update()
    ).first()
    if row is None:
        row = ApiRateLimit(scope_key=scope, window_started_at=start, request_count=0)
    if row.request_count >= limit:
        raise RateLimitError("Rate limit exceeded. Please try again shortly.")
    row.request_count += 1
    row.updated_at = now
    session.add(row)
    session.flush()
