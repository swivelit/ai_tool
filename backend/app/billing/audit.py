from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Iterable

from sqlmodel import Session, select

from ..models import PaymentOrder, ProcessedWebhook, UsageCharge, WalletAccount, WalletLedger
from ..time_utils import ensure_utc, utc_now


def _age_seconds(value: datetime | None, now: datetime) -> int:
    return max(0, int((now - ensure_utc(value or now)).total_seconds()))


def _item(row: Any, now: datetime, *, timestamp: str = "created_at") -> dict[str, Any]:
    return {
        "internal_id": str(row.id),
        "age_seconds": _age_seconds(getattr(row, timestamp, None), now),
        "status": str(getattr(row, "status", "finding")),
    }


def _finding(
    category: str,
    rows: Iterable[dict[str, Any]],
    *,
    severity: str = "high",
    actionable: bool = True,
) -> dict[str, Any] | None:
    items = list(rows)
    if not items:
        return None
    return {
        "category": category,
        "severity": severity,
        "actionable": actionable,
        "count": len(items),
        "items": items[:50],
    }


def financial_audit(
    session: Session, *, captured_uncredited_age_seconds: int = 900,
    stale_reservation_age_seconds: int = 1800, now: datetime | None = None,
) -> dict[str, Any]:
    """Return a read-only, PII-free financial integrity report."""
    current = ensure_utc(now or utc_now())
    payment_cutoff = current - timedelta(seconds=max(60, int(captured_uncredited_age_seconds)))
    reservation_cutoff = current - timedelta(seconds=max(60, int(stale_reservation_age_seconds)))
    wallets = list(session.exec(select(WalletAccount)).all())
    charges = list(session.exec(select(UsageCharge)).all())
    orders = list(session.exec(select(PaymentOrder)).all())
    ledgers = list(session.exec(select(WalletLedger)).all())
    webhooks = list(session.exec(select(ProcessedWebhook)).all())

    active_reserved_by_wallet: dict[tuple[int, str], int] = defaultdict(int)
    for charge in charges:
        if charge.status == "reserved":
            active_reserved_by_wallet[(int(charge.user_id), str(charge.credit_bucket))] += max(0, int(charge.reserved_micros))

    findings: list[dict[str, Any]] = []
    candidates = (
        _finding("negative_wallet_balance", (_item(row, current, timestamp="updated_at") for row in wallets if int(row.balance_micros) < 0)),
        _finding("negative_wallet_reservation", (_item(row, current, timestamp="updated_at") for row in wallets if int(row.reserved_micros) < 0)),
        _finding("invalid_wallet_reservation", (
            _item(row, current, timestamp="updated_at") for row in wallets
            if int(row.reserved_micros) > max(0, int(row.balance_micros))
            or int(row.reserved_micros) != active_reserved_by_wallet.get(
                (int(row.user_id), str(row.credit_bucket)), 0
            )
        )),
    )
    findings.extend(item for item in candidates if item)

    payment_credit_refs = {
        str(row.reference_id) for row in ledgers
        if row.entry_type == "payment_credit" and row.reference_type == "payment_order"
    }
    captured = [
        row for row in orders
        if row.status == "captured" and ensure_utc(row.updated_at) < payment_cutoff
        and str(row.id) not in payment_credit_refs
    ]
    finding = _finding("captured_payment_uncredited", (_item(row, current, timestamp="updated_at") for row in captured))
    if finding:
        findings.append(finding)

    duplicate_keys = Counter(str(row.idempotency_key) for row in ledgers)
    duplicate_refs = Counter(
        (str(row.entry_type), str(row.reference_type), str(row.reference_id))
        for row in ledgers if row.entry_type in {"payment_credit", "usage_debit"}
    )
    duplicate_rows = [
        {"internal_id": str(row.id), "age_seconds": _age_seconds(row.created_at, current), "status": row.entry_type}
        for row in ledgers
        if duplicate_keys[str(row.idempotency_key)] > 1
        or duplicate_refs[(str(row.entry_type), str(row.reference_type), str(row.reference_id))] > 1
    ]
    finding = _finding("duplicate_ledger_reference", duplicate_rows)
    if finding:
        findings.append(finding)

    failed_refunds = [row for row in webhooks if row.event_type == "refund.failed"]
    finding = _finding("failed_refund", (
        {"internal_id": str(row.id), "age_seconds": _age_seconds(row.processed_at, current), "status": row.event_type}
        for row in failed_refunds
    ))
    if finding:
        findings.append(finding)

    stale = [row for row in charges if row.status == "reserved" and ensure_utc(row.created_at) < reservation_cutoff]
    finding = _finding("stale_usage_reservation", (_item(row, current) for row in stale))
    if finding:
        findings.append(finding)

    credited_without_ledger = [
        row for row in orders
        if row.status in {"credited", "partially_refunded", "refunded"}
        and str(row.id) not in payment_credit_refs
    ]
    finding = _finding(
        "credited_order_missing_ledger",
        (_item(row, current, timestamp="updated_at") for row in credited_without_ledger),
    )
    if finding:
        findings.append(finding)

    inconsistent = [
        row for row in orders
        if int(row.refunded_amount_paise) < 0
        or int(row.refunded_amount_paise) > int(row.gross_amount_paise)
        or (row.status == "refunded" and int(row.refunded_amount_paise) != int(row.gross_amount_paise))
        or (row.status == "partially_refunded" and not (0 < int(row.refunded_amount_paise) < int(row.gross_amount_paise)))
        or (row.status == "captured" and str(row.id) in payment_credit_refs)
        or (row.status in {"creating", "created", "attempted", "failed"} and row.paid_at is not None)
    ]
    finding = _finding("payment_state_inconsistency", (_item(row, current, timestamp="updated_at") for row in inconsistent))
    if finding:
        findings.append(finding)

    reversed_by_order: dict[str, int] = defaultdict(int)
    for row in ledgers:
        if row.entry_type == "refund_debit" and row.reference_type == "payment_refund":
            reversed_by_order[str(row.reference_id)] += -min(0, int(row.amount_micros))
    short_refunds = []
    for row in orders:
        if not row.gross_amount_paise or not row.refunded_amount_paise:
            continue
        expected = (
            int(row.credited_amount_micros) * int(row.refunded_amount_paise)
            // int(row.gross_amount_paise)
        )
        if reversed_by_order.get(str(row.id), 0) < expected:
            short_refunds.append(row)
    finding = _finding(
        "refund_credit_reversal_shortfall",
        (_item(row, current, timestamp="updated_at") for row in short_refunds),
    )
    if finding:
        findings.append(finding)

    abandoned = [
        row for row in orders
        if row.status == "created"
        and ensure_utc(row.updated_at) < payment_cutoff
    ]
    finding = _finding(
        "abandoned_checkout_order",
        (_item(row, current, timestamp="updated_at") for row in abandoned),
        severity="info",
        actionable=False,
    )
    if finding:
        findings.append(finding)

    attempts = [
        row for row in orders
        if row.status == "attempted"
        and ensure_utc(row.updated_at) < payment_cutoff
    ]
    finding = _finding(
        "long_lived_payment_attempt",
        (_item(row, current, timestamp="updated_at") for row in attempts),
        severity="warning",
        actionable=False,
    )
    if finding:
        findings.append(finding)

    info_count = sum(int(item["count"]) for item in findings if item["severity"] == "info")
    warning_count = sum(int(item["count"]) for item in findings if item["severity"] == "warning")
    high_count = sum(int(item["count"]) for item in findings if item["severity"] == "high")
    actionable_count = sum(int(item["count"]) for item in findings if item["actionable"])
    return {
        "audit": "financial_integrity",
        "generated_at": current.isoformat(),
        "finding_count": sum(int(item["count"]) for item in findings),
        "informational_finding_count": info_count,
        "warning_finding_count": warning_count,
        "high_severity_count": high_count,
        "actionable_finding_count": actionable_count,
        "findings": findings,
        "wallet_totals_by_bucket": {
            bucket: {
                "balance_micros": sum(int(row.balance_micros) for row in wallets if row.credit_bucket == bucket),
                "reserved_micros": sum(int(row.reserved_micros) for row in wallets if row.credit_bucket == bucket),
                "debited_micros": sum(int(row.debited_micros) for row in charges if row.credit_bucket == bucket),
            }
            for bucket in ("chat", "voice")
        },
    }
