from __future__ import annotations

import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlmodel import select

from app.billing.errors import InsufficientCreditError
from app.billing.pricing import calculate_topup, openai_price, sarvam_price, snapshot_json
from app.billing.reconciliation import reconcile_razorpay_orders
from app.billing.service import (
    create_usage_reservation, credit_payment_once, get_wallet_summary,
    enforce_rate_limit, recover_stale_usage_reservations, release_usage_reservation,
    reverse_credit_for_refund, settle_usage_reservation,
)
from app.database import SessionLocal
from app.models import PaymentOrder, UsageCharge, WalletLedger
from app.time_utils import utc_now
from tests.conftest import auth_headers, create_test_user


def make_order(user_id: int, gross: int = 1000) -> PaymentOrder:
    credit, platform = calculate_topup(gross)
    return PaymentOrder(
        user_id=user_id, receipt=f"receipt-{user_id}-{gross}", gross_amount_paise=gross,
        credited_amount_micros=credit, platform_share_paise=platform,
        provider_order_id=f"order_{user_id}_{gross}", status="captured",
    )


def test_ten_rupees_credit_split_is_exact():
    assert calculate_topup(1000) == (5_000_000, 500)
    assert calculate_topup(1001) == (5_000_000, 501)  # fractional credit paise goes to platform


def test_credit_and_duplicate_are_idempotent():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush()
        credit_payment_once(session, order); credit_payment_once(session, order); session.commit()
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000
        assert len(session.exec(select(WalletLedger).where(WalletLedger.entry_type == "payment_credit")).all()) == 1


def test_reserve_settle_and_release_are_atomic():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        charge = create_usage_reservation(session, request_id="a" * 36, user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=1_000_000, pricing_snapshot_json="{}")
        assert get_wallet_summary(session, int(user.id))["available_micros"] == 4_000_000
        settle_usage_reservation(session, request_id=charge.request_id, provider_cost_amount=Decimal("0.25"), provider_cost_currency="INR", provider_cost_micros=250_000, input_tokens=10, cached_input_tokens=0, output_tokens=10, usage_source="estimated", pricing_snapshot_json="{}")
        summary = get_wallet_summary(session, int(user.id))
        assert summary["balance_micros"] == 4_750_000 and summary["reserved_micros"] == 0
        second = create_usage_reservation(session, request_id="b" * 36, user_id=int(user.id), thread_id=None, provider="openai", model="gpt-4o-mini", reserved_micros=500_000, pricing_snapshot_json="{}")
        release_usage_reservation(session, second.request_id)
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 0


def test_insufficient_credit_prevents_reservation():
    user = create_test_user()
    with SessionLocal() as session, pytest.raises(InsufficientCreditError) as caught:
        create_usage_reservation(session, request_id="c" * 36, user_id=int(user.id), thread_id=None, provider="openai", model="gpt-4o-mini", reserved_micros=1, pricing_snapshot_json="{}")
    assert caught.value.available_micros == 0


def test_rate_limit_count_is_read_as_a_scalar():
    """Covers the PostgreSQL INSERT ... RETURNING result shape as well as SQLite."""
    user = create_test_user()
    with SessionLocal() as session:
        enforce_rate_limit(session, user_id=int(user.id), action="regression", limit=2)
        enforce_rate_limit(session, user_id=int(user.id), action="regression", limit=2)
        session.commit()


def test_openai_and_sarvam_decimal_pricing(monkeypatch):
    monkeypatch.setenv("USD_TO_INR_BILLING_RATE", "100")
    monkeypatch.setenv("OPENAI_FX_BUFFER_PERCENT", "0")
    monkeypatch.setenv("OPENAI_PRICE_GPT_4O_MINI_INPUT_PER_1M", "1")
    monkeypatch.setenv("OPENAI_PRICE_GPT_4O_MINI_OUTPUT_PER_1M", "2")
    assert openai_price("gpt-4o-mini", 1_000_000, 1_000_000).micros == 300_000_000
    assert sarvam_price("sarvam-30b", 1_000_000, 1_000_000).micros == 12_500_000


def test_current_sarvam_cached_input_prices(monkeypatch):
    monkeypatch.delenv("SARVAM_PRICE_30B_CACHED_INPUT_INR_PER_1M", raising=False)
    monkeypatch.delenv("SARVAM_PRICE_105B_CACHED_INPUT_INR_PER_1M", raising=False)
    assert sarvam_price("sarvam-30b", 1_000_000, 0, 1_000_000).micros == 1_500_000
    assert sarvam_price("sarvam-105b", 1_000_000, 0, 1_000_000).micros == 2_500_000


def test_full_and_partial_refund_reclaim_credit_and_can_go_negative():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        reverse_credit_for_refund(session, order, 500)
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 2_500_000
        wallet = session.exec(select(__import__('app.models', fromlist=['WalletAccount']).WalletAccount)).one()
        wallet.balance_micros = 1_000_000; session.add(wallet)
        reverse_credit_for_refund(session, order, 1000)
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == -1_500_000
        with pytest.raises(InsufficientCreditError):
            create_usage_reservation(session, request_id="d" * 36, user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=1, pricing_snapshot_json="{}")


@pytest.mark.parametrize("bad_field,bad_value", [("amount", 999), ("currency", "USD"), ("status", "authorized")])
def test_verify_rejects_bad_provider_state(client, monkeypatch, bad_field, bad_value):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit(); order_id = order.id
    payment = {"id":"pay_1234", "order_id":f"order_{user.id}_1000", "amount":1000, "currency":"INR", "status":"captured"}
    payment[bad_field] = bad_value
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_payment", lambda self, payment_id: payment)
    signature = hmac.new(b"test_checkout_secret", f"order_{user.id}_1000|pay_1234".encode(), hashlib.sha256).hexdigest()
    response = client.post("/api/web/billing/verify", headers=auth_headers("test-uid", "test@example.com"), json={"internal_order_id":order_id,"razorpay_order_id":f"order_{user.id}_1000","razorpay_payment_id":"pay_1234","razorpay_signature":signature})
    if bad_field == "status":
        assert response.status_code == 200 and response.json()["status"] == "pending"
    else:
        assert response.status_code == 400
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_invalid_checkout_signature_never_credits(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit(); order_id = order.id
    response = client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json={"internal_order_id":order_id,"razorpay_order_id":f"order_{user.id}_1000","razorpay_payment_id":"pay_1234","razorpay_signature":"0"*64})
    assert response.status_code == 400


def _webhook(client, event_id: str, payload: dict):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(b"test_webhook_secret", raw, hashlib.sha256).hexdigest()
    return client.post("/api/web/billing/razorpay/webhook", content=raw, headers={"content-type":"application/json", "x-razorpay-signature":signature, "x-razorpay-event-id":event_id})


def test_duplicate_and_out_of_order_paid_webhooks_credit_once(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit()
    payment = {"id":"pay_once", "order_id":f"order_{user.id}_1000", "amount":1000, "currency":"INR", "status":"captured"}
    captured = {"event":"payment.captured", "payload":{"payment":{"entity":payment}}}
    assert _webhook(client, "evt-1", captured).status_code == 200
    assert _webhook(client, "evt-1", captured).json()["duplicate"] is True
    paid = {"event":"order.paid", "payload":{"order":{"entity":{"id":f"order_{user.id}_1000", "amount_paid":1000, "currency":"INR", "status":"paid"}}}}
    assert _webhook(client, "evt-2", paid).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000
        credits = session.exec(select(WalletLedger).where(WalletLedger.entry_type == "payment_credit")).all()
        assert len(credits) == 1


def test_duplicate_verify_does_not_double_credit(client, monkeypatch):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit(); order_id = order.id
    payment = {"id":"pay_repeat", "order_id":f"order_{user.id}_1000", "amount":1000, "currency":"INR", "status":"captured"}
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_payment", lambda self, payment_id: payment)
    signature = hmac.new(b"test_checkout_secret", f"order_{user.id}_1000|pay_repeat".encode(), hashlib.sha256).hexdigest()
    body = {"internal_order_id":order_id,"razorpay_order_id":f"order_{user.id}_1000","razorpay_payment_id":"pay_repeat","razorpay_signature":signature}
    assert client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json=body).status_code == 200
    assert client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json=body).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000


def test_partial_then_full_refund_webhooks_reverse_proportionally(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_refund"; session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    partial = {"event":"refund.processed", "payload":{"refund":{"entity":{"id":"rfnd_1", "payment_id":"pay_refund", "amount":250, "currency":"INR"}}}}
    full_rest = {"event":"refund.processed", "payload":{"refund":{"entity":{"id":"rfnd_2", "payment_id":"pay_refund", "amount":750, "currency":"INR"}}}}
    assert _webhook(client, "refund-1", partial).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 3_750_000
    assert _webhook(client, "refund-2", full_rest).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_same_refund_id_under_a_new_event_id_is_idempotent(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_refund_replay"; session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    payload = {"event":"refund.processed", "payload":{"refund":{"entity":{"id":"rfnd_replay", "payment_id":"pay_refund_replay", "amount":250, "currency":"INR"}}}}
    assert _webhook(client, "refund-replay-1", payload).status_code == 200
    assert _webhook(client, "refund-replay-2", payload).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 3_750_000
        assert len(session.exec(select(WalletLedger).where(WalletLedger.entry_type == "refund_debit")).all()) == 1


def test_refund_requires_provider_refund_id(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_missing_refund_id"; session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    payload = {"event":"refund.processed", "payload":{"refund":{"entity":{"payment_id":"pay_missing_refund_id", "amount":250, "currency":"INR"}}}}
    assert _webhook(client, "refund-missing-id", payload).status_code == 400
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000


def test_out_of_order_refund_links_and_credits_before_reversal(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit()
    payment = {"id":"pay_early_refund", "order_id":f"order_{user.id}_1000", "amount":1000, "currency":"INR", "status":"captured"}
    payload = {"event":"refund.processed", "payload":{
        "payment":{"entity":payment},
        "refund":{"entity":{"id":"rfnd_early", "payment_id":"pay_early_refund", "amount":500, "currency":"INR"}},
    }}
    assert _webhook(client, "refund-early", payload).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 2_500_000


def test_webhook_requires_signature_but_not_firebase(client):
    assert client.post("/api/web/billing/razorpay/webhook", content=b"{}").status_code == 400


def test_webhook_rejects_oversized_body_before_processing(client, monkeypatch):
    monkeypatch.setenv("RAZORPAY_WEBHOOK_MAX_BYTES", "32")
    response = client.post(
        "/api/web/billing/razorpay/webhook",
        content=b"x" * 33,
        headers={"x-razorpay-signature": "0" * 64, "x-razorpay-event-id": "too-large"},
    )
    assert response.status_code == 413


def test_failed_refund_is_recorded_without_reversing_credit(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_failed_refund"
        session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    payload = {"event":"refund.failed", "payload":{"refund":{"entity":{
        "id":"rfnd_failed", "payment_id":"pay_failed_refund", "amount":500, "currency":"INR",
    }}}}
    assert _webhook(client, "refund-failed", payload).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000
        assert session.exec(select(WalletLedger).where(WalletLedger.entry_type == "refund_debit")).all() == []


def test_payment_credit_is_rolled_back_with_database_transaction():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush()
        credit_payment_once(session, order)
        session.rollback()
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0
        assert session.exec(select(WalletLedger).where(WalletLedger.entry_type == "payment_credit")).all() == []


@pytest.mark.parametrize("actual,reserved,expected_balance", [
    (250_000, 500_000, 4_750_000), (500_000, 500_000, 4_500_000), (750_000, 500_000, 4_250_000),
])
def test_settlement_less_equal_and_greater_than_reservation(actual, reserved, expected_balance):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        charge = create_usage_reservation(session, request_id=f"settle-{actual}", user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=reserved, pricing_snapshot_json="{}")
        settle_usage_reservation(session, request_id=charge.request_id, provider_cost_amount=Decimal("1"), provider_cost_currency="INR", provider_cost_micros=actual, input_tokens=10, cached_input_tokens=0, output_tokens=10, usage_source="actual", pricing_snapshot_json="{}")
        summary = get_wallet_summary(session, int(user.id))
        assert summary["balance_micros"] == expected_balance and summary["reserved_micros"] == 0


def test_provider_overage_is_absorbed_instead_of_making_normal_wallet_negative():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        charge = create_usage_reservation(session, request_id="absorbed-overage", user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=1_000_000, pricing_snapshot_json="{}")
        settled = settle_usage_reservation(session, request_id=charge.request_id, provider_cost_amount=Decimal("8"), provider_cost_currency="INR", provider_cost_micros=8_000_000, input_tokens=10, cached_input_tokens=0, output_tokens=10, usage_source="actual", pricing_snapshot_json="{}")
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0
        assert settled.provider_cost_micros == 8_000_000 and settled.debited_micros == 5_000_000
        assert json.loads(settled.pricing_snapshot_json)["reconciliation"]["amount_micros"] == 3_000_000


def test_stale_reservation_recovery_is_aged_idempotent_and_records_reason():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        stale = create_usage_reservation(session, request_id="stale-charge", user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=100_000, pricing_snapshot_json="{}")
        fresh = create_usage_reservation(session, request_id="fresh-charge", user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=100_000, pricing_snapshot_json="{}")
        stale.created_at = utc_now() - timedelta(hours=2); session.add(stale); session.flush()
        assert recover_stale_usage_reservations(session, age_seconds=1800) == ["stale-charge"]
        assert recover_stale_usage_reservations(session, age_seconds=1800) == []
        assert session.get(UsageCharge, fresh.id).status == "reserved"
        ledger = session.exec(select(WalletLedger).where(WalletLedger.reference_id == stale.id, WalletLedger.entry_type == "reservation_release")).one()
        assert json.loads(ledger.metadata_json)["reason"] == "stale_reservation_recovery"


def test_payment_status_requires_auth_and_enforces_ownership(client):
    owner = create_test_user(uid="owner", email="owner@example.com")
    with SessionLocal() as session:
        order = make_order(int(owner.id)); session.add(order); session.commit(); order_id = order.id
    assert client.get(f"/api/web/billing/payments/{order_id}").status_code == 401
    assert client.get(f"/api/web/billing/payments/{order_id}", headers=auth_headers("other", "other@example.com")).status_code == 404
    response = client.get(f"/api/web/billing/payments/{order_id}", headers=auth_headers("owner", "owner@example.com"))
    assert response.status_code == 200
    assert response.json()["gross_amount_paise"] == 1000
    assert "checkout_signature" not in response.json()


class _ReconciliationClient:
    def __init__(self, payment: dict, refunds: list[dict] | None = None):
        self.payment = payment
        self.refunds = refunds or []

    def fetch_order_payments(self, order_id: str) -> dict:
        return {"items": [self.payment]}

    def fetch_payment_refunds(self, payment_id: str) -> dict:
        return {"items": self.refunds}


def test_reconciliation_dry_run_is_non_mutating_and_apply_is_idempotent():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "attempted"; order.created_at = utc_now() - timedelta(hours=1); session.add(order); session.commit(); order_id = order.id
        payment = {"id":"pay_reconcile", "order_id":order.provider_order_id, "amount":1000, "currency":"INR", "status":"captured"}
        client = _ReconciliationClient(payment)
        assert reconcile_razorpay_orders(session, client=client, apply=False)[0]["action"] == "credit_captured_payment"
        session.refresh(order)
        assert order.status == "attempted"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0
        assert reconcile_razorpay_orders(session, client=client, apply=True)[0]["action"] == "credit_captured_payment"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000
        order = session.get(PaymentOrder, order_id); order.created_at = utc_now() - timedelta(hours=1); order.status = "captured"; session.add(order); session.commit()
        reconcile_razorpay_orders(session, client=client, apply=True)
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000


@pytest.mark.parametrize("field,value", [("amount", 999), ("currency", "USD"), ("order_id", "order_wrong"), ("id", "")])
def test_reconciliation_never_credits_mismatched_capture(field, value):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "attempted"; order.created_at = utc_now() - timedelta(hours=1); session.add(order); session.commit()
        payment = {"id":"pay_reconcile_bad", "order_id":order.provider_order_id, "amount":1000, "currency":"INR", "status":"captured"}
        payment[field] = value
        result = reconcile_razorpay_orders(session, client=_ReconciliationClient(payment), apply=True)
        assert result[0]["action"] == "review_provider_mismatch"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0
