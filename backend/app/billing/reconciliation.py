from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlmodel import Session, select

from ..models import PaymentOrder
from ..time_utils import utc_now
from .razorpay_client import RazorpayClient
from .service import credit_payment_once, reverse_credit_for_refund


_SAFE_PROVIDER_ORDER_STATUSES = {"created", "attempted", "paid"}


def reconciliation_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Return safe, compact diagnostics for scheduled reconciliation logs."""
    by_action: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    actionable = 0
    actionable_order_ids: list[str] = []
    for result in results:
        action = str(result.get("action") or "unknown")
        severity = str(result.get("severity") or "unknown")
        by_action[action] = by_action.get(action, 0) + 1
        by_severity[severity] = by_severity.get(severity, 0) + 1
        if result.get("actionable") is True:
            actionable += 1
            if severity == "high" and result.get("internal_order_id"):
                actionable_order_ids.append(str(result["internal_order_id"]))
    return {
        "total_inspected": len(results),
        "count_by_action": dict(sorted(by_action.items())),
        "count_by_severity": dict(sorted(by_severity.items())),
        "actionable_count": actionable,
        "actionable_high_internal_order_ids": sorted(set(actionable_order_ids)),
    }


def _safe_provider_order_status(provider: Any) -> str | None:
    if not isinstance(provider, dict) or provider.get("status") is None:
        return None
    status = str(provider.get("status"))
    return status if status in _SAFE_PROVIDER_ORDER_STATUSES else "unknown"


def reconcile_razorpay_orders(
    session: Session, *, client: RazorpayClient, age_seconds: int = 900,
    apply: bool = False, internal_order_id: str | None = None,
) -> list[dict[str, Any]]:
    """Inspect non-terminal Razorpay orders and refunds; optionally repair state.

    This is deliberately an internal command API, not an HTTP route. Existing
    ledger idempotency keys make repeated runs safe, including after duplicate
    webhook delivery.
    """
    cutoff = utc_now() - timedelta(seconds=max(60, int(age_seconds)))
    statement = select(PaymentOrder).where(PaymentOrder.status.in_([
        "created", "attempted", "captured", "credited", "fulfilled", "partially_refunded", "refunded",
    ]))
    if internal_order_id is None:
        statement = statement.where(PaymentOrder.created_at < cutoff)
    else:
        statement = statement.where(PaymentOrder.id == internal_order_id)
    rows = session.exec(statement.order_by(PaymentOrder.created_at.asc())).all()
    results: list[dict[str, Any]] = []
    for order in rows:
        outcome: dict[str, Any] = {
            "internal_order_id": order.id,
            "from_status": order.status,
            "provider_order_status": None,
            "provider_payment_count": 0,
            "captured_payment_present": False,
            "action": (
                "already_fulfilled" if order.purchase_type == "subscription" and order.status in {"fulfilled", "partially_refunded", "refunded"}
                else "already_credited" if order.status in {"credited", "partially_refunded", "refunded"}
                else "none"
            ),
            "severity": "info",
            "actionable": False,
        }
        if order.status in {"created", "attempted", "captured"} and not order.provider_order_id:
            outcome.update(action="review_provider_mismatch", severity="high", actionable=True)
        elif order.provider_order_id and order.status in {"created", "attempted", "captured"}:
            provider = client.fetch_order_payments(order.provider_order_id)
            outcome["provider_order_status"] = _safe_provider_order_status(provider)
            payments = provider.get("items") if isinstance(provider, dict) else None
            if not isinstance(payments, list):
                outcome.update(action="review_provider_mismatch", severity="high", actionable=True)
                results.append(outcome)
                continue
            outcome["provider_payment_count"] = len(payments)
            captured_payments = [
                item for item in payments
                if isinstance(item, dict) and item.get("status") == "captured"
            ]
            captured = captured_payments[0] if len(captured_payments) == 1 else None
            outcome["captured_payment_present"] = bool(captured_payments)
            if len(captured_payments) > 1:
                outcome.update(action="review_provider_mismatch", severity="high", actionable=True)
                results.append(outcome)
                continue
            if captured:
                payment_id = str(captured.get("id") or "")
                try:
                    provider_amount = int(captured.get("amount", -1))
                except (TypeError, ValueError):
                    provider_amount = -1
                valid_capture = bool(payment_id) and (
                    str(captured.get("order_id") or "") == str(order.provider_order_id)
                    and provider_amount == int(order.gross_amount_paise)
                    and captured.get("currency") == "INR"
                    and captured.get("status") == "captured"
                )
                if not valid_capture:
                    outcome.update(action="review_provider_mismatch", severity="high", actionable=True)
                else:
                    outcome.update(action="credit_captured_payment", severity="high", actionable=True)
                    if apply:
                        order.provider_payment_id = payment_id
                        order.status = "captured"
                        credit_payment_once(session, order)
            elif order.status == "created":
                outcome.update(
                    action=("no_action_no_captured_payment" if outcome["provider_payment_count"] else "no_action_unattempted_checkout"),
                    severity="info", actionable=False,
                )
            elif order.status == "attempted":
                outcome.update(action="review_long_lived_attempt", severity="warning", actionable=False)
            else:
                outcome.update(action="review_provider_mismatch", severity="high", actionable=True)
        if order.provider_payment_id and order.status in {"credited", "fulfilled", "partially_refunded", "refunded"}:
            provider_refunds = client.fetch_payment_refunds(order.provider_payment_id)
            items = provider_refunds.get("items") if isinstance(provider_refunds, dict) else []
            processed = [item for item in (items or []) if item.get("status") == "processed"]
            valid_refunds = all(
                int(item.get("amount") or 0) > 0
                and item.get("currency") in {None, "INR"}
                and str(item.get("payment_id") or order.provider_payment_id) == str(order.provider_payment_id)
                for item in processed
            )
            total = sum(int(item.get("amount") or 0) for item in processed)
            if not valid_refunds or total > order.gross_amount_paise:
                outcome.update(action="review_provider_mismatch", severity="high", actionable=True)
                results.append(outcome)
                continue
            if total > order.refunded_amount_paise:
                outcome.update(action="reconcile_refund", severity="high", actionable=True)
                outcome["provider_refunded_amount_paise"] = total
                if apply:
                    reverse_credit_for_refund(session, order, total)
        results.append(outcome)
    if apply:
        session.commit()
    return results
