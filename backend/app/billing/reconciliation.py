from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlmodel import Session, select

from ..models import PaymentOrder
from ..time_utils import utc_now
from .razorpay_client import RazorpayClient
from .service import credit_payment_once, reverse_credit_for_refund


def reconcile_razorpay_orders(
    session: Session, *, client: RazorpayClient, age_seconds: int = 900,
    apply: bool = False,
) -> list[dict[str, Any]]:
    """Inspect non-terminal Razorpay orders and refunds; optionally repair state.

    This is deliberately an internal command API, not an HTTP route. Existing
    ledger idempotency keys make repeated runs safe, including after duplicate
    webhook delivery.
    """
    cutoff = utc_now() - timedelta(seconds=max(60, int(age_seconds)))
    rows = session.exec(select(PaymentOrder).where(
        PaymentOrder.created_at < cutoff,
        PaymentOrder.status.in_(["created", "attempted", "captured", "credited", "partially_refunded"]),
    ).order_by(PaymentOrder.created_at.asc())).all()
    results: list[dict[str, Any]] = []
    for order in rows:
        outcome: dict[str, Any] = {"internal_order_id": order.id, "from_status": order.status, "action": "none"}
        if order.provider_order_id and order.status in {"created", "attempted", "captured"}:
            provider = client.fetch_order_payments(order.provider_order_id)
            payments = provider.get("items") if isinstance(provider, dict) else []
            captured = next((item for item in (payments or []) if item.get("status") == "captured"), None)
            if captured:
                payment_id = str(captured.get("id") or "")
                valid_capture = (
                    bool(payment_id)
                    and str(captured.get("order_id") or "") == str(order.provider_order_id)
                    and int(captured.get("amount", -1)) == int(order.gross_amount_paise)
                    and captured.get("currency") == "INR"
                )
                if not valid_capture:
                    outcome["action"] = "review_provider_mismatch"
                else:
                    outcome["action"] = "credit_captured_payment"
                    if apply:
                        order.provider_payment_id = payment_id
                        order.status = "captured"
                        credit_payment_once(session, order)
            elif order.status == "attempted":
                outcome["action"] = "review_long_lived_attempt"
        if order.provider_payment_id and order.status in {"credited", "partially_refunded", "refunded"}:
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
                outcome["action"] = "review_provider_mismatch"
                results.append(outcome)
                continue
            if total > order.refunded_amount_paise:
                outcome["action"] = "reconcile_refund"
                outcome["provider_refunded_amount_paise"] = total
                if apply:
                    reverse_credit_for_refund(session, order, total)
        results.append(outcome)
    if apply:
        session.commit()
    return results
