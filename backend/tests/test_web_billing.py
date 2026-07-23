from __future__ import annotations

import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlmodel import Session, select

from app.billing.errors import InsufficientCreditError, PaymentValidationError
from app.billing.audit import financial_audit
from app.billing.pricing import calculate_topup, openai_price, sarvam_price, snapshot_json
from app.billing.reconciliation import reconcile_razorpay_orders
from app.billing.service import (
    create_billing_exempt_usage, create_usage_reservation, credit_payment_once, get_wallet_summary,
    enforce_rate_limit, recover_stale_usage_reservations, release_usage_reservation,
    reverse_credit_for_refund, settle_usage_reservation,
)
from app.database import SessionLocal
from app.models import PaymentOrder, UsageCharge, WalletLedger, WebUsagePreferences
from app.time_utils import utc_now
from tests.conftest import auth_headers, create_test_user


def make_order(user_id: int, gross: int = 1500) -> PaymentOrder:
    credit, platform = calculate_topup(gross)
    return PaymentOrder(
        user_id=user_id, receipt=f"receipt-{user_id}-{gross}", gross_amount_paise=gross,
        credited_amount_micros=credit, platform_share_paise=platform,
        provider_order_id=f"order_{user_id}_{gross}", status="captured",
    )


def test_fifteen_rupees_credit_split_is_exact():
    assert calculate_topup(1500) == (7_500_000, 750)
    assert calculate_topup(10_000) == (50_000_000, 5_000)
    assert calculate_topup(1501) == (7_500_000, 751)  # fractional credit paise goes to platform


def test_public_config_exposes_explicit_mode_and_checkout_boolean(client):
    response = client.get("/api/web/billing/public-config")
    assert response.status_code == 200
    body = response.json()
    assert body["razorpay_mode"] == "test"
    assert body["checkout_enabled"] is True
    assert body["custom_topup_enabled"] is True
    assert [item["gross_amount_paise"] for item in body["packages"]] == [1500, 29900]
    assert body["packages"][0]["credited_amount_micros"] == 7_500_000
    assert body["packages"][0]["token_estimate"]["estimated_blended_tokens"] > 0
    estimate = body["packages"][0]["token_estimate"]
    assert estimate["tier"] == "lite"
    assert "reference_model" not in estimate
    assert "reference_provider" not in estimate
    assert "pricing_snapshot" not in estimate
    assert "RAZORPAY_KEY_SECRET" not in json.dumps(body)


def test_public_config_reports_package_enforcement(client, monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCE_TOPUP_PACKAGES", "true")
    response = client.get("/api/web/billing/public-config")
    assert response.status_code == 200
    assert response.json()["custom_topup_enabled"] is False


@pytest.mark.parametrize("gross", [1500, 29900, 7500])
def test_topup_estimate_accepts_presets_and_custom_without_charging(client, gross):
    create_test_user()
    response = client.get(
        f"/api/web/billing/estimate?gross_amount_paise={gross}",
        headers=auth_headers("test-uid"),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["gross_amount_paise"] == gross
    assert set(body["token_estimate"]) == {
        "tier", "tier_label", "estimated_blended_tokens",
        "range_min_tokens", "range_max_tokens",
    }
    assert body["token_estimate"]["estimated_blended_tokens"] > 0
    assert "provider" not in json.dumps(body).lower()
    assert "model" not in json.dumps(body).lower()
    with SessionLocal() as session:
        assert session.exec(select(PaymentOrder)).all() == []
        assert session.exec(select(WalletLedger)).all() == []
        assert session.exec(select(UsageCharge)).all() == []


def test_topup_estimate_uses_selected_tier_and_does_not_require_checkout(client, monkeypatch):
    user = create_test_user()
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier="standard"))
        session.commit()
    monkeypatch.setenv("BILLING_CHECKOUT_ENABLED", "false")
    monkeypatch.setenv("RAZORPAY_KEY_ID", "not-configured-for-checkout")
    response = client.get(
        "/api/web/billing/estimate?gross_amount_paise=7500",
        headers=auth_headers("test-uid"),
    )
    assert response.status_code == 200
    assert response.json()["token_estimate"]["tier"] == "standard"
    assert response.json()["token_estimate"]["tier_label"] == "Swico"


def test_voice_estimate_uses_speech_units_not_tokens(client):
    create_test_user()
    response = client.get(
        "/api/web/billing/estimate?gross_amount_paise=1500&credit_bucket=voice",
        headers=auth_headers("test-uid"),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["credit_bucket"] == "voice" and body["token_estimate"] is None
    assert body["voice_estimate"]["estimated_stt_seconds"] > 0
    assert body["voice_estimate"]["estimated_tts_characters"] > 0
    assert body["voice_estimate"]["pricing_version"]


@pytest.mark.parametrize("gross", [900, 50100, 7501])
def test_topup_estimate_rejects_out_of_bounds_or_fractional_rupee_amounts(client, gross):
    create_test_user()
    response = client.get(
        f"/api/web/billing/estimate?gross_amount_paise={gross}",
        headers=auth_headers("test-uid"),
    )
    assert response.status_code == 422


def test_topup_estimate_rejects_unlisted_custom_amount_when_enforced(client, monkeypatch):
    create_test_user()
    monkeypatch.setenv("BILLING_ENFORCE_TOPUP_PACKAGES", "true")
    response = client.get(
        "/api/web/billing/estimate?gross_amount_paise=7500",
        headers=auth_headers("test-uid"),
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Select an available top-up package."


def test_public_config_rejects_mixed_razorpay_mode_and_key(client, monkeypatch):
    monkeypatch.setenv("RAZORPAY_MODE", "live")
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_mixed")
    response = client.get("/api/web/billing/public-config")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "billing_configuration_invalid"


def test_checkout_kill_switch_rejects_before_order_or_provider_call(client, monkeypatch):
    create_test_user()
    called = {"provider": False}
    monkeypatch.setenv("BILLING_CHECKOUT_ENABLED", "false")
    monkeypatch.setattr(
        "app.web_api.router.RazorpayClient.create_order",
        lambda *args, **kwargs: called.update(provider=True),
    )
    response = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise": 1500, "idempotency_key": "disabled-checkout",
    })
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "checkout_disabled"
    assert called["provider"] is False
    with SessionLocal() as session:
        assert session.exec(select(PaymentOrder)).all() == []


def test_checkout_enabled_creates_server_order_before_provider_order(client, monkeypatch):
    user = create_test_user()

    def create_provider_order(_self, amount, receipt):
        with SessionLocal() as session:
            internal = session.exec(select(PaymentOrder).where(PaymentOrder.receipt == receipt)).one()
            assert internal.status == "creating"
            assert internal.user_id == int(user.id)
        return {"id": "order_enabled", "amount": amount, "currency": "INR"}

    monkeypatch.setenv("BILLING_CHECKOUT_ENABLED", "true")
    monkeypatch.setattr("app.web_api.router.RazorpayClient.create_order", create_provider_order)
    response = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise": 1500, "idempotency_key": "enabled-checkout",
    })
    assert response.status_code == 201
    assert response.json()["credited_amount_micros"] == 7_500_000


def test_order_idempotency_key_cannot_change_credit_bucket(client, monkeypatch):
    create_test_user()
    monkeypatch.setattr(
        "app.web_api.router.RazorpayClient.create_order",
        lambda _self, amount, _receipt: {"id":"order_bucket", "amount":amount, "currency":"INR"},
    )
    first = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise":1500, "credit_bucket":"voice", "idempotency_key":"same-bucket-key",
    })
    changed = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise":1500, "credit_bucket":"chat", "idempotency_key":"same-bucket-key",
    })
    assert first.status_code == 201 and first.json()["credit_bucket"] == "voice"
    assert changed.status_code == 409
    with SessionLocal() as session:
        assert session.exec(select(PaymentOrder)).one().credit_bucket == "voice"


@pytest.mark.parametrize("gross", [1500, 29900, 2500, 7500, 35000])
def test_order_creation_accepts_presets_and_custom_and_sends_exact_paise(client, monkeypatch, gross):
    create_test_user()
    received: list[int] = []

    def create_provider_order(_self, amount, receipt):
        received.append(amount)
        return {"id": f"order_exact_{amount}", "amount": amount, "currency": "INR"}

    monkeypatch.setattr("app.web_api.router.RazorpayClient.create_order", create_provider_order)
    response = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise": gross, "idempotency_key": f"exact-{gross}",
    })
    assert response.status_code == 201
    assert response.json()["amount"] == gross
    assert received == [gross]
    with SessionLocal() as session:
        order = session.exec(select(PaymentOrder)).one()
        assert order.gross_amount_paise == gross
        assert order.credited_amount_micros == calculate_topup(gross)[0]


@pytest.mark.parametrize("gross", [900, 50100, 7501, 7500.5, "7500"])
def test_order_creation_rejects_invalid_custom_amounts_before_provider_call(client, monkeypatch, gross):
    create_test_user()
    called = False

    def unexpected_provider(*_args, **_kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr("app.web_api.router.RazorpayClient.create_order", unexpected_provider)
    response = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise": gross, "idempotency_key": "invalid-custom",
    })
    assert response.status_code == 422
    assert called is False
    with SessionLocal() as session:
        assert session.exec(select(PaymentOrder)).all() == []


def test_fixed_package_enforcement_still_rejects_custom_order(client, monkeypatch):
    create_test_user()
    monkeypatch.setenv("BILLING_ENFORCE_TOPUP_PACKAGES", "true")
    response = client.post("/api/web/billing/orders", headers=auth_headers("test-uid"), json={
        "gross_amount_paise": 7500, "idempotency_key": "fixed-package-only",
    })
    assert response.status_code == 422
    assert response.json()["detail"] == "Select an available top-up package."


def test_credit_and_duplicate_are_idempotent():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush()
        credit_payment_once(session, order); credit_payment_once(session, order); session.commit()
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000
        assert get_wallet_summary(session, int(user.id))["token_estimate"]["estimated_blended_tokens"] > 0
        assert len(session.exec(select(WalletLedger).where(WalletLedger.entry_type == "payment_credit")).all()) == 1


def test_reserve_settle_and_release_are_atomic():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        charge = create_usage_reservation(session, request_id="a" * 36, user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=1_000_000, pricing_snapshot_json="{}")
        assert get_wallet_summary(session, int(user.id))["available_micros"] == 6_500_000
        settle_usage_reservation(session, request_id=charge.request_id, provider_cost_amount=Decimal("0.25"), provider_cost_currency="INR", provider_cost_micros=250_000, input_tokens=10, cached_input_tokens=0, output_tokens=10, usage_source="estimated", pricing_snapshot_json="{}")
        summary = get_wallet_summary(session, int(user.id))
        assert summary["balance_micros"] == 7_250_000 and summary["reserved_micros"] == 0
        second = create_usage_reservation(session, request_id="b" * 36, user_id=int(user.id), thread_id=None, provider="openai", model="gpt-4o-mini", reserved_micros=500_000, pricing_snapshot_json="{}")
        release_usage_reservation(session, second.request_id)
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 0


def test_released_and_billing_exempt_request_ids_cannot_switch_wallet_bucket():
    user = create_test_user("usage-bucket-idempotency", "usage-bucket-idempotency@example.com")
    with SessionLocal() as session:
        chat_order = make_order(int(user.id)); session.add(chat_order); session.flush(); credit_payment_once(session, chat_order)
        voice_order = make_order(int(user.id)); voice_order.receipt += "-voice"; voice_order.provider_order_id += "-voice"; voice_order.credit_bucket = "voice"
        session.add(voice_order); session.flush(); credit_payment_once(session, voice_order)
        create_usage_reservation(
            session, request_id="bucket-release-id", user_id=int(user.id), thread_id=None,
            provider="openai", model="gpt-5.4-mini", reserved_micros=100,
            pricing_snapshot_json="{}", credit_bucket="chat",
        )
        release_usage_reservation(session, "bucket-release-id")
        with pytest.raises(PaymentValidationError, match="another credit bucket"):
            create_usage_reservation(
                session, request_id="bucket-release-id", user_id=int(user.id), thread_id=None,
                provider="openai", model="gpt-5.4-mini", reserved_micros=100,
                pricing_snapshot_json="{}", credit_bucket="voice",
            )
        create_billing_exempt_usage(
            session, request_id="bucket-exempt-id", user_id=int(user.id), thread_id=None,
            provider="openai", model="gpt-5.4-mini", pricing_snapshot_json="{}",
            credit_bucket="voice",
        )
        with pytest.raises(PaymentValidationError, match="another credit bucket"):
            create_billing_exempt_usage(
                session, request_id="bucket-exempt-id", user_id=int(user.id), thread_id=None,
                provider="openai", model="gpt-5.4-mini", pricing_snapshot_json="{}",
                credit_bucket="chat",
            )


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


def test_full_and_partial_refund_reclaim_credit_without_negative_balance():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush(); credit_payment_once(session, order)
        reverse_credit_for_refund(session, order, 500)
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000
        wallet = session.exec(select(__import__('app.models', fromlist=['WalletAccount']).WalletAccount)).one()
        wallet.balance_micros = 1_000_000; session.add(wallet)
        reverse_credit_for_refund(session, order, 1500)
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0
        with pytest.raises(InsufficientCreditError):
            create_usage_reservation(session, request_id="d" * 36, user_id=int(user.id), thread_id=None, provider="sarvam", model="sarvam-30b", reserved_micros=1, pricing_snapshot_json="{}")


def test_payment_history_adds_grant_and_reversal_estimates_without_removing_legacy_fields(client):
    user = create_test_user(uid="history-owner", email="history@example.com")
    with SessionLocal() as session:
        order = make_order(int(user.id))
        order.refunded_amount_paise = 500
        order.status = "partially_refunded"
        session.add(order); session.commit()
    response = client.get("/api/web/billing/payments", headers=auth_headers("history-owner", "history@example.com"))
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["credited_amount_micros"] == 7_500_000
    assert item["platform_share_paise"] == 750
    assert item["credit_reversal_micros"] == 2_500_000
    assert item["token_estimate"]["estimated_blended_tokens"] > 0
    assert item["reversal_token_estimate"]["estimated_blended_tokens"] > 0
    assert item["payment_received"] is True
    assert item["credit_applied"] is False
    assert {"created_at", "updated_at", "paid_at", "refunded_at"} <= item.keys()


def test_payment_history_uses_authoritative_payment_and_ledger_semantics(client):
    user = create_test_user(uid="history-truth", email="history-truth@example.test")
    with SessionLocal() as session:
        created = make_order(int(user.id)); created.status = "created"
        created.receipt += "-created"; created.provider_order_id += "-created"
        captured = make_order(int(user.id)); captured.status = "captured"
        captured.receipt += "-captured"; captured.provider_order_id += "-captured"
        credited = make_order(int(user.id)); credited.receipt += "-credited"; credited.provider_order_id += "-credited"
        session.add(created); session.add(captured); session.add(credited); session.flush()
        credit_payment_once(session, credited)
        session.commit()
        ids = {"created": created.id, "captured": captured.id, "credited": credited.id}

    response = client.get(
        "/api/web/billing/payments",
        headers=auth_headers("history-truth", "history-truth@example.test"),
    )
    items = {item["id"]: item for item in response.json()["items"]}
    assert items[ids["created"]]["payment_received"] is False
    assert items[ids["created"]]["credit_applied"] is False
    assert items[ids["captured"]]["payment_received"] is True
    assert items[ids["captured"]]["credit_applied"] is False
    assert items[ids["credited"]]["payment_received"] is True
    assert items[ids["credited"]]["credit_applied"] is True


def test_payment_history_batches_payment_credit_ledger_lookup(client, monkeypatch):
    user = create_test_user(uid="history-batch", email="history-batch@example.test")
    with SessionLocal() as session:
        for suffix in ("first", "second"):
            order = make_order(int(user.id))
            order.status = "created"
            order.receipt += f"-{suffix}"
            order.provider_order_id += f"-{suffix}"
            session.add(order)
        session.commit()

    original_exec = Session.exec
    ledger_queries = 0

    def counted_exec(self, statement, *args, **kwargs):
        nonlocal ledger_queries
        if "wallet_ledger" in str(statement).lower():
            ledger_queries += 1
        return original_exec(self, statement, *args, **kwargs)

    monkeypatch.setattr(Session, "exec", counted_exec)
    response = client.get(
        "/api/web/billing/payments",
        headers=auth_headers("history-batch", "history-batch@example.test"),
    )
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2
    assert ledger_queries == 1


@pytest.mark.parametrize("bad_field,bad_value", [("amount", 999), ("currency", "USD"), ("status", "authorized")])
def test_verify_rejects_bad_provider_state(client, monkeypatch, bad_field, bad_value):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit(); order_id = order.id
    payment = {"id":"pay_1234", "order_id":f"order_{user.id}_1500", "amount":1500, "currency":"INR", "status":"captured"}
    payment[bad_field] = bad_value
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_payment", lambda self, payment_id: payment)
    signature = hmac.new(b"test_checkout_secret", f"order_{user.id}_1500|pay_1234".encode(), hashlib.sha256).hexdigest()
    response = client.post("/api/web/billing/verify", headers=auth_headers("test-uid", "test@example.com"), json={"internal_order_id":order_id,"razorpay_order_id":f"order_{user.id}_1500","razorpay_payment_id":"pay_1234","razorpay_signature":signature})
    if bad_field == "status":
        assert response.status_code == 200 and response.json()["status"] == "pending"
    else:
        assert response.status_code == 400
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_custom_capture_amount_mismatch_is_rejected(client, monkeypatch):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id), 7500)
        session.add(order); session.commit(); order_id = order.id
    payment = {
        "id": "pay_custom_mismatch", "order_id": f"order_{user.id}_7500",
        "amount": 7400, "currency": "INR", "status": "captured",
    }
    monkeypatch.setattr(
        "app.web_api.router.RazorpayClient.fetch_payment",
        lambda self, payment_id: payment,
    )
    signature = hmac.new(
        b"test_checkout_secret",
        f"order_{user.id}_7500|pay_custom_mismatch".encode(), hashlib.sha256,
    ).hexdigest()
    response = client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json={
        "internal_order_id": order_id, "razorpay_order_id": f"order_{user.id}_7500",
        "razorpay_payment_id": "pay_custom_mismatch", "razorpay_signature": signature,
    })
    assert response.status_code == 400
    assert response.json()["detail"] == "Payment amount does not match."
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_invalid_checkout_signature_never_credits(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit(); order_id = order.id
    response = client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json={"internal_order_id":order_id,"razorpay_order_id":f"order_{user.id}_1500","razorpay_payment_id":"pay_1234","razorpay_signature":"0"*64})
    assert response.status_code == 400


def _webhook(client, event_id: str, payload: dict):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(b"test_webhook_secret", raw, hashlib.sha256).hexdigest()
    return client.post("/api/web/billing/razorpay/webhook", content=raw, headers={"content-type":"application/json", "x-razorpay-signature":signature, "x-razorpay-event-id":event_id})


def test_duplicate_and_out_of_order_paid_webhooks_credit_once(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit()
    payment = {"id":"pay_once", "order_id":f"order_{user.id}_1500", "amount":1500, "currency":"INR", "status":"captured"}
    captured = {"event":"payment.captured", "payload":{"payment":{"entity":payment}}}
    assert _webhook(client, "evt-1", captured).status_code == 200
    assert _webhook(client, "evt-1", captured).json()["duplicate"] is True
    paid = {"event":"order.paid", "payload":{"order":{"entity":{"id":f"order_{user.id}_1500", "amount_paid":1500, "currency":"INR", "status":"paid"}}}}
    assert _webhook(client, "evt-2", paid).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000
        credits = session.exec(select(WalletLedger).where(WalletLedger.entry_type == "payment_credit")).all()
        assert len(credits) == 1


def test_duplicate_verify_does_not_double_credit(client, monkeypatch):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit(); order_id = order.id
    payment = {"id":"pay_repeat", "order_id":f"order_{user.id}_1500", "amount":1500, "currency":"INR", "status":"captured"}
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_payment", lambda self, payment_id: payment)
    signature = hmac.new(b"test_checkout_secret", f"order_{user.id}_1500|pay_repeat".encode(), hashlib.sha256).hexdigest()
    body = {"internal_order_id":order_id,"razorpay_order_id":f"order_{user.id}_1500","razorpay_payment_id":"pay_repeat","razorpay_signature":signature}
    assert client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json=body).status_code == 200
    assert client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json=body).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000


def test_custom_duplicate_verify_and_webhook_credit_only_once(client, monkeypatch):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id), 7500)
        session.add(order); session.commit(); order_id = order.id
    payment = {
        "id": "pay_custom_once", "order_id": f"order_{user.id}_7500",
        "amount": 7500, "currency": "INR", "status": "captured",
    }
    monkeypatch.setattr(
        "app.web_api.router.RazorpayClient.fetch_payment",
        lambda self, payment_id: payment,
    )
    signature = hmac.new(
        b"test_checkout_secret",
        f"order_{user.id}_7500|pay_custom_once".encode(), hashlib.sha256,
    ).hexdigest()
    request = {
        "internal_order_id": order_id, "razorpay_order_id": f"order_{user.id}_7500",
        "razorpay_payment_id": "pay_custom_once", "razorpay_signature": signature,
    }
    assert client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json=request).status_code == 200
    assert client.post("/api/web/billing/verify", headers=auth_headers("test-uid"), json=request).status_code == 200
    captured = {"event": "payment.captured", "payload": {"payment": {"entity": payment}}}
    assert _webhook(client, "custom-captured", captured).status_code == 200
    assert _webhook(client, "custom-captured", captured).json()["duplicate"] is True
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 37_500_000
        assert len(session.exec(select(WalletLedger).where(
            WalletLedger.entry_type == "payment_credit"
        )).all()) == 1


def test_partial_then_full_refund_webhooks_reverse_proportionally(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_refund"; session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    partial = {"event":"refund.processed", "payload":{"refund":{"entity":{"id":"rfnd_1", "payment_id":"pay_refund", "amount":250, "currency":"INR"}}}}
    full_rest = {"event":"refund.processed", "payload":{"refund":{"entity":{"id":"rfnd_2", "payment_id":"pay_refund", "amount":1250, "currency":"INR"}}}}
    assert _webhook(client, "refund-1", partial).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 6_250_000
    assert _webhook(client, "refund-2", full_rest).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_custom_partial_and_full_refunds_use_exact_original_gross(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id), 7500)
        order.provider_payment_id = "pay_custom_refund"
        session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    partial = {"event": "refund.processed", "payload": {"refund": {"entity": {
        "id": "rfnd_custom_1", "payment_id": "pay_custom_refund",
        "amount": 2500, "currency": "INR",
    }}}}
    full_rest = {"event": "refund.processed", "payload": {"refund": {"entity": {
        "id": "rfnd_custom_2", "payment_id": "pay_custom_refund",
        "amount": 5000, "currency": "INR",
    }}}}
    assert _webhook(client, "custom-refund-1", partial).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 25_000_000
    assert _webhook(client, "custom-refund-2", full_rest).status_code == 200
    with SessionLocal() as session:
        order = session.exec(select(PaymentOrder)).one()
        assert order.refunded_amount_paise == 7500
        assert order.status == "refunded"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_same_refund_id_under_a_new_event_id_is_idempotent(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_refund_replay"; session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    payload = {"event":"refund.processed", "payload":{"refund":{"entity":{"id":"rfnd_replay", "payment_id":"pay_refund_replay", "amount":250, "currency":"INR"}}}}
    assert _webhook(client, "refund-replay-1", payload).status_code == 200
    assert _webhook(client, "refund-replay-2", payload).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 6_250_000
        assert len(session.exec(select(WalletLedger).where(WalletLedger.entry_type == "refund_debit")).all()) == 1


def test_refund_requires_provider_refund_id(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.provider_payment_id = "pay_missing_refund_id"; session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    payload = {"event":"refund.processed", "payload":{"refund":{"entity":{"payment_id":"pay_missing_refund_id", "amount":250, "currency":"INR"}}}}
    assert _webhook(client, "refund-missing-id", payload).status_code == 400
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000


def test_out_of_order_refund_links_and_credits_before_reversal(client):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.commit()
    payment = {"id":"pay_early_refund", "order_id":f"order_{user.id}_1500", "amount":1500, "currency":"INR", "status":"captured"}
    payload = {"event":"refund.processed", "payload":{
        "payment":{"entity":payment},
        "refund":{"entity":{"id":"rfnd_early", "payment_id":"pay_early_refund", "amount":500, "currency":"INR"}},
    }}
    assert _webhook(client, "refund-early", payload).status_code == 200
    with SessionLocal() as session:
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 5_000_000


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
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000
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
    (250_000, 500_000, 7_250_000), (500_000, 500_000, 7_000_000), (750_000, 500_000, 6_750_000),
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
        assert settled.provider_cost_micros == 8_000_000 and settled.debited_micros == 7_500_000
        assert json.loads(settled.pricing_snapshot_json)["reconciliation"]["amount_micros"] == 500_000


def test_stale_voice_reservation_recovery_uses_original_bucket_and_is_idempotent():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.credit_bucket = "voice"; session.add(order); session.flush(); credit_payment_once(session, order)
        stale = create_usage_reservation(session, request_id="stale-charge", user_id=int(user.id), thread_id=None, provider="openai", model="gpt-5.4-mini", reserved_micros=100_000, pricing_snapshot_json="{}", usage_kind="chat", credit_bucket="voice")
        fresh = create_usage_reservation(session, request_id="fresh-charge", user_id=int(user.id), thread_id=None, provider="openai", model="gpt-5.4-mini", reserved_micros=100_000, pricing_snapshot_json="{}", usage_kind="chat", credit_bucket="voice")
        stale.created_at = utc_now() - timedelta(hours=2); session.add(stale); session.flush()
        assert recover_stale_usage_reservations(session, age_seconds=1800) == ["stale-charge"]
        assert recover_stale_usage_reservations(session, age_seconds=1800) == []
        assert session.get(UsageCharge, fresh.id).status == "reserved"
        ledger = session.exec(select(WalletLedger).where(WalletLedger.reference_id == stale.id, WalletLedger.entry_type == "reservation_release")).one()
        assert ledger.credit_bucket == "voice"
        assert get_wallet_summary(session, int(user.id), credit_bucket="chat")["balance_micros"] == 0
        assert get_wallet_summary(session, int(user.id), credit_bucket="voice")["reserved_micros"] == 100_000
        assert json.loads(ledger.metadata_json)["reason"] == "stale_reservation_recovery"


def test_payment_status_requires_auth_and_enforces_ownership(client):
    owner = create_test_user(uid="owner", email="owner@example.com")
    with SessionLocal() as session:
        order = make_order(int(owner.id)); session.add(order); session.commit(); order_id = order.id
    assert client.get(f"/api/web/billing/payments/{order_id}").status_code == 401
    assert client.get(f"/api/web/billing/payments/{order_id}", headers=auth_headers("other", "other@example.com")).status_code == 404
    response = client.get(f"/api/web/billing/payments/{order_id}", headers=auth_headers("owner", "owner@example.com"))
    assert response.status_code == 200
    assert response.json()["gross_amount_paise"] == 1500
    assert "checkout_signature" not in response.json()


class _ReconciliationClient:
    def __init__(self, payment: dict | None, refunds: list[dict] | None = None):
        self.payment = payment
        self.refunds = refunds or []
        self.requested_orders: list[str] = []

    def fetch_order_payments(self, order_id: str) -> dict:
        self.requested_orders.append(order_id)
        return {"status": "paid" if self.payment and self.payment.get("status") == "captured" else "attempted", "items": [self.payment] if self.payment else []}

    def fetch_payment_refunds(self, payment_id: str) -> dict:
        return {"items": self.refunds}


def test_reconciliation_dry_run_is_non_mutating_and_apply_is_idempotent():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "attempted"; order.created_at = utc_now() - timedelta(hours=1); session.add(order); session.commit(); order_id = order.id
        payment = {"id":"pay_reconcile", "order_id":order.provider_order_id, "amount":1500, "currency":"INR", "status":"captured"}
        client = _ReconciliationClient(payment)
        dry_run = reconcile_razorpay_orders(session, client=client, apply=False)[0]
        assert dry_run["action"] == "credit_captured_payment"
        assert dry_run["severity"] == "high" and dry_run["actionable"] is True
        assert dry_run["provider_payment_count"] == 1
        assert dry_run["captured_payment_present"] is True
        session.refresh(order)
        assert order.status == "attempted"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0
        assert reconcile_razorpay_orders(session, client=client, apply=True)[0]["action"] == "credit_captured_payment"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000
        order = session.get(PaymentOrder, order_id); order.created_at = utc_now() - timedelta(hours=1); order.status = "captured"; session.add(order); session.commit()
        reconcile_razorpay_orders(session, client=client, apply=True)
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 7_500_000


def test_voice_reconciliation_and_refund_stay_in_original_bucket():
    user = create_test_user(uid="voice-reconcile", email="voice-reconcile@example.com")
    with SessionLocal() as session:
        order = make_order(int(user.id))
        order.credit_bucket = "voice"
        order.status = "attempted"
        order.created_at = utc_now() - timedelta(hours=1)
        session.add(order); session.commit()
        payment = {
            "id":"pay_voice_reconcile", "order_id":order.provider_order_id,
            "amount":1500, "currency":"INR", "status":"captured",
        }
        result = reconcile_razorpay_orders(
            session, client=_ReconciliationClient(payment), apply=True,
        )[0]
        assert result["action"] == "credit_captured_payment"
        assert get_wallet_summary(session, int(user.id), credit_bucket="chat")["balance_micros"] == 0
        assert get_wallet_summary(session, int(user.id), credit_bucket="voice")["balance_micros"] == 7_500_000
        assert reverse_credit_for_refund(session, order, 500) == 2_500_000
        session.commit()
        assert get_wallet_summary(session, int(user.id), credit_bucket="chat")["balance_micros"] == 0
        assert get_wallet_summary(session, int(user.id), credit_bucket="voice")["balance_micros"] == 5_000_000
        assert financial_audit(session)["wallet_totals_by_bucket"]["voice"]["balance_micros"] == 5_000_000


def test_custom_reconciliation_and_financial_audit_remain_exact_and_clean():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id), 7500)
        order.status = "attempted"
        order.created_at = utc_now() - timedelta(hours=1)
        session.add(order); session.commit()
        payment = {
            "id": "pay_custom_reconcile", "order_id": order.provider_order_id,
            "amount": 7500, "currency": "INR", "status": "captured",
        }
        client = _ReconciliationClient(payment)
        first = reconcile_razorpay_orders(session, client=client, apply=True)
        second = reconcile_razorpay_orders(session, client=client, apply=True)
        assert first[0]["action"] == "credit_captured_payment"
        assert second[0]["action"] == "already_credited"
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 37_500_000
        assert len(session.exec(select(WalletLedger).where(
            WalletLedger.entry_type == "payment_credit"
        )).all()) == 1
        report = financial_audit(session)
        assert report["high_severity_count"] == 0
        assert report["actionable_finding_count"] == 0


@pytest.mark.parametrize("field,value", [("amount", 999), ("currency", "USD"), ("order_id", "order_wrong"), ("id", "")])
def test_reconciliation_never_credits_mismatched_capture(field, value):
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "attempted"; order.created_at = utc_now() - timedelta(hours=1); session.add(order); session.commit()
        payment = {"id":"pay_reconcile_bad", "order_id":order.provider_order_id, "amount":1500, "currency":"INR", "status":"captured"}
        payment[field] = value
        result = reconcile_razorpay_orders(session, client=_ReconciliationClient(payment), apply=True)
        assert result[0]["action"] == "review_provider_mismatch"
        assert result[0]["severity"] == "high" and result[0]["actionable"] is True
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == 0


def test_created_order_without_provider_payment_is_informational():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "created"; order.created_at = utc_now() - timedelta(hours=1)
        session.add(order); session.commit()
        result = reconcile_razorpay_orders(session, client=_ReconciliationClient(None))[0]
    assert result["action"] == "no_action_unattempted_checkout"
    assert result["severity"] == "info" and result["actionable"] is False
    assert result["provider_payment_count"] == 0
    assert result["captured_payment_present"] is False


def test_attempted_order_without_captured_payment_is_warning():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "attempted"; order.created_at = utc_now() - timedelta(hours=1)
        session.add(order); session.commit()
        authorized = {"id":"pay_pending", "order_id":order.provider_order_id, "amount":1500, "currency":"INR", "status":"authorized"}
        result = reconcile_razorpay_orders(session, client=_ReconciliationClient(authorized))[0]
    assert result["action"] == "review_long_lived_attempt"
    assert result["severity"] == "warning" and result["actionable"] is False
    assert result["provider_payment_count"] == 1
    assert result["captured_payment_present"] is False


def test_created_order_with_valid_captured_provider_payment_is_actionable():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); order.status = "created"; order.created_at = utc_now() - timedelta(hours=1)
        session.add(order); session.commit()
        payment = {"id":"pay_created_capture", "order_id":order.provider_order_id, "amount":1500, "currency":"INR", "status":"captured"}
        result = reconcile_razorpay_orders(session, client=_ReconciliationClient(payment), apply=False)[0]
        session.refresh(order)
    assert result["action"] == "credit_captured_payment"
    assert result["severity"] == "high" and result["actionable"] is True
    assert order.status == "created"


def test_targeted_reconciliation_inspects_only_requested_internal_order():
    first_user = create_test_user(uid="target-first", email="first@example.test")
    second_user = create_test_user(uid="target-second", email="second@example.test")
    with SessionLocal() as session:
        first = make_order(int(first_user.id)); first.status = "created"
        second = make_order(int(second_user.id)); second.status = "created"
        session.add(first); session.add(second); session.commit()
        client = _ReconciliationClient(None)
        results = reconcile_razorpay_orders(
            session, client=client, internal_order_id=second.id,
        )
    assert [item["internal_order_id"] for item in results] == [second.id]
    assert client.requested_orders == [second.provider_order_id]


def test_already_credited_reconciliation_is_informational():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush()
        order.provider_payment_id = "pay_already_credited"
        credit_payment_once(session, order)
        order.created_at = utc_now() - timedelta(hours=1)
        session.commit()
        result = reconcile_razorpay_orders(session, client=_ReconciliationClient(None))[0]
    assert result["action"] == "already_credited"
    assert result["severity"] == "info" and result["actionable"] is False


def test_refund_requiring_reconciliation_is_high_and_actionable():
    user = create_test_user()
    with SessionLocal() as session:
        order = make_order(int(user.id)); session.add(order); session.flush()
        order.provider_payment_id = "pay_refund_reconcile"
        credit_payment_once(session, order)
        order.created_at = utc_now() - timedelta(hours=1)
        session.commit()
        refund = {
            "id":"rfnd_reconcile", "payment_id":order.provider_payment_id,
            "amount":500, "currency":"INR", "status":"processed",
        }
        result = reconcile_razorpay_orders(
            session, client=_ReconciliationClient(None, [refund]), apply=False,
        )[0]
        session.refresh(order)
    assert result["action"] == "reconcile_refund"
    assert result["severity"] == "high" and result["actionable"] is True
    assert order.refunded_amount_paise == 0
