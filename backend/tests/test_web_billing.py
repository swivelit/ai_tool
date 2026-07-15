from __future__ import annotations

import hashlib
import hmac
import json
from decimal import Decimal

import pytest
from sqlmodel import select

from app.billing.errors import InsufficientCreditError
from app.billing.pricing import calculate_topup, openai_price, sarvam_price, snapshot_json
from app.billing.service import (
    create_usage_reservation, credit_payment_once, get_wallet_summary,
    release_usage_reservation, reverse_credit_for_refund, settle_usage_reservation,
)
from app.database import SessionLocal
from app.models import PaymentOrder, WalletLedger
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


def test_openai_and_sarvam_decimal_pricing(monkeypatch):
    monkeypatch.setenv("USD_TO_INR_BILLING_RATE", "100")
    monkeypatch.setenv("OPENAI_FX_BUFFER_PERCENT", "0")
    monkeypatch.setenv("OPENAI_PRICE_GPT_4O_MINI_INPUT_PER_1M", "1")
    monkeypatch.setenv("OPENAI_PRICE_GPT_4O_MINI_OUTPUT_PER_1M", "2")
    assert openai_price("gpt-4o-mini", 1_000_000, 1_000_000).micros == 300_000_000
    assert sarvam_price("sarvam-30b", 1_000_000, 1_000_000).micros == 12_500_000


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
