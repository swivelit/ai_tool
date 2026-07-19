from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlmodel import select

from app.billing.errors import InsufficientCreditError, UsageLimitReachedError
from app.billing.pricing import calculate_topup
from app.billing.service import (
    create_usage_reservation, credit_payment_once, get_wallet_summary,
    release_usage_reservation, settle_usage_reservation,
)
from app.billing.usage_limits import enforce_usage_limit, monthly_period_bounds
from app.database import SessionLocal
from app.models import PaymentOrder, UsageCharge, WebUsagePreferences
from app.web_api.usage_service import usage_summary
from tests.conftest import auth_headers, create_test_user


def _fund(user_id: int, amount_paise: int = 1000) -> None:
    credit, platform = calculate_topup(amount_paise)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id, receipt=f"usage-fund-{user_id}-{amount_paise}",
            provider_order_id=f"usage-order-{user_id}-{amount_paise}",
            gross_amount_paise=amount_paise, credited_amount_micros=credit,
            platform_share_paise=platform, status="captured",
        )
        session.add(order)
        session.flush()
        credit_payment_once(session, order)
        session.commit()


def _preferences(user_id: int, limit: int | None) -> None:
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=user_id, hard_limit_micros=limit))
        session.commit()


def _settled_charge(
    user_id: int, request_id: str, *, settled_at: datetime, provider: str = "openai",
    model: str = "gpt-5-nano", source: str = "actual", debit: int = 10_000,
    input_tokens: int = 100, cached_tokens: int = 25, output_tokens: int = 40,
    usage_kind: str = "chat", swico_tier: str | None = None,
    audio_milliseconds: int = 0, characters: int = 0,
) -> None:
    with SessionLocal() as session:
        session.add(UsageCharge(
            request_id=request_id, user_id=user_id, provider=provider, model=model,
            usage_kind=usage_kind, swico_tier=swico_tier,
            audio_milliseconds=audio_milliseconds, characters=characters,
            input_tokens=input_tokens, cached_input_tokens=cached_tokens,
            output_tokens=output_tokens, usage_source=source,
            provider_cost_amount_decimal=Decimal("0.01"), provider_cost_currency="INR",
            provider_cost_micros=debit, debited_micros=debit, status="settled",
            settled_at=settled_at, created_at=settled_at,
        ))
        session.commit()


def test_usage_summary_has_zero_filled_tiers_and_authoritative_voice_breakdown(client):
    user = create_test_user("usage-breakdown", "usage-breakdown@example.com")
    now = datetime.now(timezone.utc)
    _settled_charge(
        int(user.id), "tier-lite", settled_at=now, debit=20_000,
        swico_tier="lite", input_tokens=100, cached_tokens=20, output_tokens=40,
    )
    _settled_charge(
        int(user.id), "voice-stt", settled_at=now, debit=5_000,
        provider="sarvam", model="saaras:v3", usage_kind="stt",
        input_tokens=0, cached_tokens=0, output_tokens=0,
        audio_milliseconds=1500,
    )
    _settled_charge(
        int(user.id), "voice-tts", settled_at=now, debit=10_000,
        provider="sarvam", model="bulbul:v2", usage_kind="tts",
        input_tokens=0, cached_tokens=0, output_tokens=0, characters=25,
    )
    response = client.get(
        "/api/web/usage/summary?period=current_month",
        headers=auth_headers("usage-breakdown", "usage-breakdown@example.com"),
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body["by_tier"]) == {"lite", "standard", "pro"}
    assert body["by_tier"]["lite"]["request_count"] == 1
    assert body["by_tier"]["lite"]["total_tokens"] == 140
    assert body["by_tier"]["standard"]["request_count"] == 0
    assert body["by_tier"]["pro"]["debited_micros"] == 0
    assert body["voice"] == {
        "label": "Voice", "stt_request_count": 1, "tts_request_count": 1,
        "total_tts_characters": 25, "request_count": 2,
        "debited_micros": 15_000, "total_audio_seconds": 1.5,
        "debited_voice_credits": "0.015000",
            "period_debit_percentage": 42.86, "monthly_limit_percentage": 0.0,
            "utilization_percentage": 100.0,
            "utilization_basis": "available_plus_period_debit",
        }
    assert body["debited_micros"] == 35_000


def test_usage_summary_aggregates_authoritative_settled_rows_and_ownership(client):
    owner = create_test_user("usage-owner", "usage-owner@example.com")
    other = create_test_user("usage-other", "usage-other@example.com")
    _fund(int(owner.id))
    now = datetime.now(timezone.utc)
    _settled_charge(int(owner.id), "summary-actual", settled_at=now - timedelta(days=1))
    _settled_charge(
        int(owner.id), "summary-estimated", settled_at=now, provider="sarvam",
        model="sarvam-30b", source="estimated", debit=20_000,
        input_tokens=200, cached_tokens=50, output_tokens=80,
    )
    _settled_charge(int(other.id), "summary-private", settled_at=now, debit=99_000)
    with SessionLocal() as session:
        session.add(UsageCharge(
            request_id="summary-released", user_id=int(owner.id), provider="openai",
            model="gpt-5-nano", status="released", debited_micros=0,
        ))
        session.commit()

    response = client.get(
        "/api/web/usage/summary?period=current_month",
        headers=auth_headers("usage-owner", "usage-owner@example.com"),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["request_count"] == 2
    assert body["input_tokens"] == 300
    assert body["cached_input_tokens"] == 75
    assert body["output_tokens"] == 120
    assert body["total_tokens"] == 420
    assert body["actual_usage_count"] == body["estimated_usage_count"] == 1
    assert body["debited_micros"] == 30_000
    assert "provider_breakdown" not in body
    assert "model_breakdown" not in body
    assert len(body["daily"]) >= 1
    estimate = body["estimated_tokens_remaining"]
    assert estimate["tier"] == "lite"
    assert estimate["tier_label"] == "Swico Lite"
    assert "reference_provider" not in estimate
    assert "reference_model" not in estimate
    assert "pricing_snapshot" not in estimate
    assert estimate["range_min_tokens"] <= estimate["range_max_tokens"]
    assert "Estimated for Swico Lite" in estimate["explanation"]


def test_profile_settings_are_owner_scoped_and_validated(client):
    owner = create_test_user("profile-owner", "profile-owner@example.com")
    create_test_user("profile-other", "profile-other@example.com")
    headers = auth_headers("profile-owner", "profile-owner@example.com")
    response = client.patch("/api/web/settings/profile", headers=headers, json={
        "name": "  Hari   S  ", "place": "  Chennai  ", "timezone": "Europe/London",
        "assistant_name": "  Kavi  ", "reply_language": "ta",
    })
    assert response.status_code == 200
    assert response.json() == {
        "name": "Hari S", "place": "Chennai", "timezone": "Europe/London",
        "assistant_name": "Kavi", "reply_language": "ta",
        "email": "profile-owner@example.com", "email_editable": False,
    }
    assert client.patch("/api/web/settings/profile", headers=headers, json={"timezone": "Mars/Olympus"}).status_code == 422
    assert client.patch("/api/web/settings/profile", headers=headers, json={"reply_language": "fr"}).status_code == 422
    assert client.patch("/api/web/settings/profile", headers=headers, json={"name": "   "}).status_code == 422
    assert client.patch("/api/web/settings/profile", headers=headers, json={"email": "changed@example.com"}).status_code == 422
    other = client.get("/api/web/settings/profile", headers=auth_headers("profile-other", "profile-other@example.com"))
    assert other.json()["name"] == "Test User"
    with SessionLocal() as session:
        assert session.get(type(owner), int(owner.id)).name == "Hari S"


def test_assistant_tier_defaults_persists_and_does_not_change_value_limits(
    client, monkeypatch,
):
    monkeypatch.setenv("SWICO_DEFAULT_TIER", "lite")
    monkeypatch.setenv("SWICO_TIER_SELECTION_ENABLED", "true")
    monkeypatch.setenv("SWICO_PRO_ENABLED", "false")
    user = create_test_user("tier-owner", "tier-owner@example.com")
    _fund(int(user.id))
    _preferences(int(user.id), 2_500_000)
    headers = auth_headers("tier-owner", "tier-owner@example.com")

    initial = client.get("/api/web/settings/assistant", headers=headers)
    assert initial.status_code == 200
    assert initial.json()["tier"] == "lite"
    assert {item["label"] for item in initial.json()["tiers"]} == {
        "Swico Lite", "Swico", "Swico Pro",
    }
    with SessionLocal() as session:
        before_wallet = get_wallet_summary(session, int(user.id))["balance_micros"]

    saved = client.patch(
        "/api/web/settings/assistant", headers=headers, json={"tier": "standard"}
    )
    assert saved.status_code == 200 and saved.json()["tier"] == "standard"
    assert client.get("/api/web/settings/assistant", headers=headers).json()["tier"] == "standard"
    bootstrap = client.get("/api/web/bootstrap", headers=headers).json()
    assert bootstrap["assistant"]["tier"] == "standard"
    assert bootstrap["wallet"]["token_estimate"]["tier"] == "standard"
    with SessionLocal() as session:
        row = session.exec(select(WebUsagePreferences).where(
            WebUsagePreferences.user_id == int(user.id)
        )).one()
        assert row.assistant_tier == "standard"
        assert row.hard_limit_micros == 2_500_000
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == before_wallet


def test_assistant_tier_rejects_invalid_unknown_and_disabled_pro(client, monkeypatch):
    create_test_user("tier-validation", "tier-validation@example.com")
    headers = auth_headers("tier-validation", "tier-validation@example.com")
    monkeypatch.setenv("SWICO_TIER_SELECTION_ENABLED", "true")
    monkeypatch.setenv("SWICO_PRO_ENABLED", "false")
    assert client.patch(
        "/api/web/settings/assistant", headers=headers, json={"tier": "ultra"}
    ).status_code == 422
    assert client.patch(
        "/api/web/settings/assistant", headers=headers,
        json={"tier": "lite", "model": "arbitrary"},
    ).status_code == 422
    rejected = client.patch(
        "/api/web/settings/assistant", headers=headers, json={"tier": "pro"}
    )
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "tier_unavailable"


def test_invalid_persisted_assistant_tier_falls_back_to_lite(client):
    user = create_test_user("tier-corrupt", "tier-corrupt@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier="corrupt"))
        session.commit()
    response = client.get(
        "/api/web/settings/assistant",
        headers=auth_headers("tier-corrupt", "tier-corrupt@example.com"),
    )
    assert response.status_code == 200
    assert response.json()["tier"] == "lite"


def test_usage_preference_validation_and_null_unlimited(client):
    create_test_user("pref-owner", "pref-owner@example.com")
    headers = auth_headers("pref-owner", "pref-owner@example.com")
    initial = client.get("/api/web/settings/usage", headers=headers)
    assert initial.status_code == 200 and initial.json()["hard_limit_micros"] is None
    saved = client.patch("/api/web/settings/usage", headers=headers, json={
        "hard_limit_micros": 2_500_000, "warning_threshold_percent": 75,
        "notify_at_threshold": True,
    })
    assert saved.status_code == 200
    assert saved.json()["hard_limit_ai_credits"] == "2.500000"
    assert saved.json()["hard_limit_token_estimate"]["estimated_blended_tokens"] > 0
    estimated = client.patch("/api/web/settings/usage", headers=headers, json={
        "hard_limit_estimated_tokens": 100_000,
    })
    assert estimated.status_code == 200
    assert estimated.json()["hard_limit_micros"] > 0
    assert estimated.json()["hard_limit_token_estimate"]["estimated_blended_tokens"] >= 100_000
    assert client.patch("/api/web/settings/usage", headers=headers, json={
        "hard_limit_micros": 1, "hard_limit_estimated_tokens": 1,
    }).status_code == 422
    cleared = client.patch("/api/web/settings/usage", headers=headers, json={"hard_limit_micros": None})
    assert cleared.status_code == 200 and cleared.json()["hard_limit_micros"] is None
    for payload in (
        {"hard_limit_micros": 0}, {"hard_limit_micros": 1.5},
        {"warning_threshold_percent": 0}, {"warning_threshold_percent": 101},
        {"period": "weekly"}, {"user_id": 999},
    ):
        assert client.patch("/api/web/settings/usage", headers=headers, json=payload).status_code == 422


def test_monthly_limit_boundaries_release_and_wallet_error_precedence():
    user = create_test_user()
    _fund(int(user.id))
    _preferences(int(user.id), 1_000_000)
    with SessionLocal() as session:
        below = create_usage_reservation(
            session, request_id="below-limit", user_id=int(user.id), thread_id=None,
            provider="openai", model="gpt-5-nano", reserved_micros=999_999,
            pricing_snapshot_json="{}",
        )
        session.commit()
    with SessionLocal() as session:
        release_usage_reservation(session, below.request_id)
        session.commit()
        exact = create_usage_reservation(
            session, request_id="exact-limit", user_id=int(user.id), thread_id=None,
            provider="openai", model="gpt-5-nano", reserved_micros=1_000_000,
            pricing_snapshot_json="{}",
        )
        session.commit()
    with SessionLocal() as session:
        with pytest.raises(UsageLimitReachedError) as caught:
            create_usage_reservation(
                session, request_id="above-limit", user_id=int(user.id), thread_id=None,
                provider="openai", model="gpt-5-nano", reserved_micros=1,
                pricing_snapshot_json="{}",
            )
        assert caught.value.current_usage_micros == 1_000_000
        assert caught.value.remaining_micros == 0
        session.rollback()
    with SessionLocal() as session:
        release_usage_reservation(session, exact.request_id, reason="cancelled")
        session.commit()
        create_usage_reservation(
            session, request_id="after-cancel", user_id=int(user.id), thread_id=None,
            provider="openai", model="gpt-5-nano", reserved_micros=1_000_000,
            pricing_snapshot_json="{}",
        )
        session.commit()

    low_wallet = create_test_user("low-wallet", "low-wallet@example.com")
    _preferences(int(low_wallet.id), 1)
    with SessionLocal() as session:
        with pytest.raises(InsufficientCreditError):
            create_usage_reservation(
                session, request_id="wallet-first", user_id=int(low_wallet.id), thread_id=None,
                provider="openai", model="gpt-5-nano", reserved_micros=2,
                pricing_snapshot_json="{}",
            )


def test_unlimited_and_monthly_timezone_reset_semantics():
    user = create_test_user()
    _fund(int(user.id))
    now = datetime(2026, 8, 1, 0, 30, tzinfo=timezone.utc)
    start, end = monthly_period_bounds("Asia/Kolkata", now)
    assert start == datetime(2026, 7, 31, 18, 30, tzinfo=timezone.utc)
    assert end == datetime(2026, 8, 31, 18, 30, tzinfo=timezone.utc)
    _settled_charge(int(user.id), "prior-month", settled_at=start - timedelta(microseconds=1), debit=900_000)
    _settled_charge(int(user.id), "new-month", settled_at=start, debit=100_000)
    _preferences(int(user.id), 500_000)
    with SessionLocal() as session:
        state = enforce_usage_limit(session, user_id=int(user.id), required_micros=400_000, now=now)
        assert state["settled_micros"] == 100_000
        with pytest.raises(UsageLimitReachedError):
            enforce_usage_limit(session, user_id=int(user.id), required_micros=400_001, now=now)
        session.rollback()
    with SessionLocal() as session:
        pref = session.exec(select(WebUsagePreferences).where(WebUsagePreferences.user_id == int(user.id))).one()
        pref.hard_limit_micros = None
        session.add(pref)
        session.commit()
    with SessionLocal() as session:
        enforce_usage_limit(session, user_id=int(user.id), required_micros=50_000_000, now=now)


def test_simultaneous_reservations_cannot_collectively_exceed_limit():
    user = create_test_user()
    _fund(int(user.id))
    _preferences(int(user.id), 700_000)
    barrier = threading.Barrier(2)
    results: list[str] = []

    def reserve(request_id: str) -> None:
        barrier.wait()
        try:
            with SessionLocal() as session:
                create_usage_reservation(
                    session, request_id=request_id, user_id=int(user.id), thread_id=None,
                    provider="openai", model="gpt-5-nano", reserved_micros=400_000,
                    pricing_snapshot_json="{}",
                )
                session.commit()
            results.append("reserved")
        except UsageLimitReachedError:
            results.append("limited")

    threads = [threading.Thread(target=reserve, args=(f"concurrent-{index}",)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert sorted(results) == ["limited", "reserved"]
    with SessionLocal() as session:
        active = session.exec(select(UsageCharge).where(UsageCharge.status == "reserved")).all()
        assert sum(row.reserved_micros for row in active) == 400_000
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 400_000


def test_chat_limit_error_has_stable_402_contract(client, monkeypatch):
    user = create_test_user("limit-contract", "limit-contract@example.com")

    def reject_turn(**_kwargs):
        raise UsageLimitReachedError(
            current_usage_micros=900_000,
            configured_limit_micros=1_000_000,
            remaining_micros=100_000,
            reset_at="2026-08-31T18:30:00+00:00",
        )

    monkeypatch.setattr("app.web_api.router.prepare_web_turn", reject_turn)
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers(str(user.firebase_uid), str(user.email)),
        json={"request_id": "de5bc3ce-ca86-4bd0-8b19-0cf26662ce8d", "message": "hello"},
    )
    assert response.status_code == 402
    assert response.json() == {"error": {
        "code": "usage_limit_reached",
        "message": "Your monthly AI usage limit has been reached.",
        "current_usage_micros": 900_000,
        "configured_limit_micros": 1_000_000,
        "remaining_micros": 100_000,
        "reset_at": "2026-08-31T18:30:00+00:00",
        "credit_bucket": "chat",
    }}
