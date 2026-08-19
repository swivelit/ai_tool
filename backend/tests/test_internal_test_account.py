from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.auth import AuthUser, is_internal_test_email, is_internal_test_user
from app.billing.service import create_swico_free_usage, settle_swico_free_usage
from app.database import SessionLocal
from app.models import UsageCharge, User, WalletLedger, WebChatMessage, WebUsagePreferences
from app.web_api.router import _enforce_swico_free_limits
from tests.conftest import auth_headers, create_test_user


TEST_EMAIL = "capability.tester@example.test"


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", f"  {TEST_EMAIL.upper()}  ")


def test_internal_email_allowlist_is_exact_case_insensitive_and_owned(monkeypatch):
    _configure(monkeypatch)
    assert is_internal_test_email(TEST_EMAIL.upper()) is True
    assert is_internal_test_email(f"x{TEST_EMAIL}") is False
    user = User(id=7, firebase_uid="owned", email=TEST_EMAIL, name="Tester")
    assert is_internal_test_user(
        AuthUser(firebase_uid="owned", email=TEST_EMAIL.upper(), email_verified=True), user
    ) is True
    assert is_internal_test_user(
        AuthUser(firebase_uid="owned", email=TEST_EMAIL, email_verified=False), user
    ) is False
    assert is_internal_test_user(
        AuthUser(firebase_uid="owned", email="other@example.test", email_verified=True), user
    ) is False


def test_request_body_email_cannot_grant_exemption(client, monkeypatch):
    _configure(monkeypatch)
    create_test_user("ordinary", "ordinary@example.test")
    response = client.post("/api/web/chat/stream", headers=auth_headers(
        "ordinary", "ordinary@example.test"
    ), json={
        "request_id": "20000000-0000-4000-8000-000000000001",
        "message": "Explain database indexes",
        "email": TEST_EMAIL,
    })
    assert response.status_code == 422


def test_verified_internal_account_bypasses_swico_free_user_limits(monkeypatch):
    _configure(monkeypatch)
    user = create_test_user("internal-free-limits", TEST_EMAIL)
    monkeypatch.setenv("SWICO_FREE_RATE_LIMIT_PER_MINUTE", "1")
    monkeypatch.setenv("SWICO_FREE_DAILY_MESSAGE_LIMIT", "1")

    # Saturate both ordinary user-level controls first. The secured route
    # passes the result of is_internal_test_user as internal_account=True.
    _enforce_swico_free_limits(int(user.id))
    with SessionLocal() as session:
        create_swico_free_usage(
            session, request_id="internal-free-completed", user_id=int(user.id),
            thread_id=None, pricing_snapshot_json="{}",
        )
        settle_swico_free_usage(
            session, request_id="internal-free-completed", input_tokens=2,
            cached_input_tokens=0, output_tokens=3, usage_source="actual",
            pricing_snapshot_json="{}",
        )
        session.commit()

    _enforce_swico_free_limits(int(user.id), internal_account=True)


def test_ordinary_account_still_hits_general_web_chat_limit(client, monkeypatch):
    create_test_user("ordinary-chat-limit", "ordinary-chat-limit@example.test")
    monkeypatch.setenv("WEB_CHAT_RATE_LIMIT_PER_MINUTE", "1")
    headers = auth_headers("ordinary-chat-limit", "ordinary-chat-limit@example.test")
    first = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "21000000-0000-4000-8000-000000000001",
        "message": "hello",
    })
    second = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "21000000-0000-4000-8000-000000000002",
        "message": "hello",
    })
    assert first.status_code == 200
    assert second.status_code == 429


def test_internal_account_is_zero_debit_but_provider_cost_is_audited(
    client, monkeypatch,
):
    _configure(monkeypatch)
    user = create_test_user("internal-test", TEST_EMAIL)
    with SessionLocal() as session:
        session.add(WebUsagePreferences(
            user_id=int(user.id), assistant_tier="standard", hard_limit_micros=1,
        ))
        session.commit()

    def fake_stream(self, request, route, on_delta):
        on_delta("Audited response")
        return AIProviderResponse(
            text="Audited response", provider="openai", model=route.model,
            route=route.route, reason=route.reason, language="en", intent=route.intent,
            input_tokens=120, output_tokens=40,
            raw={"usage_actual": True, "cached_input_tokens": 20},
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete", fake_stream
    )
    headers = auth_headers("internal-test", TEST_EMAIL.upper())
    request_id = "20000000-0000-4000-8000-000000000002"
    response = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": request_id, "message": "Plan a safe database migration",
    })
    assert response.status_code == 200
    assert "Audited response" in response.text

    bootstrap = client.get("/api/web/bootstrap", headers=headers).json()
    assert bootstrap["wallet"]["billing_exempt"] is True
    assert bootstrap["wallet"]["balance_display"] == "Unlimited"
    assert bootstrap["wallet"]["token_estimate"] is None
    assert "provider" not in json.dumps(bootstrap).lower()
    assert "gpt-" not in json.dumps(bootstrap).lower()

    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id
        )).one()
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "assistant",
        )).one()
        assert charge.status == "billing_exempt"
        assert charge.billing_exemption_reason == "internal_capability_test"
        assert charge.swico_tier == "standard"
        assert charge.provider == "openai" and charge.model
        assert charge.input_tokens == 120 and charge.cached_input_tokens == 20
        assert charge.output_tokens == 40 and charge.usage_source == "actual"
        assert charge.provider_cost_micros > 0
        assert charge.reserved_micros == charge.debited_micros == 0
        assert assistant.charge_micros == 0
        assert session.exec(select(WalletLedger).where(
            WalletLedger.user_id == int(user.id)
        )).all() == []


def test_internal_account_keeps_rate_limit_safety_and_provider_budget(
    client, monkeypatch,
):
    fixed_window_time = datetime(
        2031, 11, 17, 12, 34, 30, tzinfo=timezone.utc,
    )
    monkeypatch.setattr(
        "app.billing.service.utc_now", lambda: fixed_window_time,
    )
    _configure(monkeypatch)
    create_test_user("internal-guards", TEST_EMAIL)
    headers = auth_headers("internal-guards", TEST_EMAIL)

    monkeypatch.setenv("WEB_CHAT_RATE_LIMIT_PER_MINUTE", "2")
    for index in range(3):
        assert client.post("/api/web/chat/stream", headers=headers, json={
            "request_id": f"30000000-0000-4000-8000-{index:012d}",
            "message": "hello",
        }).status_code == 200

    # A new user/window isolates the remaining guards from the rate-limit proof.
    second_email = "second.tester@example.test"
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", f"{TEST_EMAIL},{second_email}")
    create_test_user("internal-guards-2", second_email)
    second_headers = auth_headers("internal-guards-2", second_email)
    safety = client.post("/api/web/chat/stream", headers=second_headers, json={
        "request_id": "30000000-0000-4000-8000-000000000004",
        "message": "I want to hurt myself",
    })
    assert "safer alternative" in safety.text

    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "0.000000001")
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider._client_or_create",
        lambda self: object(),
    )
    budget = client.post("/api/web/chat/stream", headers=second_headers, json={
        "request_id": "30000000-0000-4000-8000-000000000005",
        "message": "Explain database indexing in depth",
    })
    assert "service_budget_reached" in budget.text
    assert "Swico has reached today’s service capacity." in budget.text
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "30000000-0000-4000-8000-000000000005"
        )).one()
        assert charge.status == "released"
        assert charge.reserved_micros == charge.debited_micros == 0


def test_internal_account_cannot_create_razorpay_order(client, monkeypatch):
    _configure(monkeypatch)
    create_test_user("internal-payment", TEST_EMAIL)
    called = {"value": False}
    monkeypatch.setattr(
        "app.web_api.router.RazorpayClient.create_order",
        lambda *args, **kwargs: called.update(value=True),
    )
    response = client.post("/api/web/billing/orders", headers=auth_headers(
        "internal-payment", TEST_EMAIL
    ), json={"gross_amount_paise": 1000, "idempotency_key": "internal-denied"})
    assert response.status_code == 403
    assert response.json()["detail"]["message"] == (
        "Payments are not available for this internal testing account."
    )
    assert called["value"] is False


def test_internal_account_cannot_request_payment_estimates(client, monkeypatch):
    _configure(monkeypatch)
    create_test_user("internal-estimate", TEST_EMAIL)
    response = client.get(
        "/api/web/billing/estimate?gross_amount_paise=7500",
        headers=auth_headers("internal-estimate", TEST_EMAIL),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "payments_unavailable"
