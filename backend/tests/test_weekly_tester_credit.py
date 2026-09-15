from datetime import datetime, timezone
from decimal import Decimal

from sqlmodel import Session

from app.auth import AuthUser, is_internal_test_user
from app.billing.errors import InsufficientCreditError
from app.billing.service import (
    create_usage_reservation, get_or_create_wallet, release_usage_reservation,
    settle_usage_reservation,
)
from app.billing.tester_credit import (
    allowance_to_micros, is_weekly_tester_eligible,
    tester_credit_window_summary as get_tester_credit_summary,
    weekly_window,
)
from app.database import SessionLocal
from app.models import User, WeeklyTesterCreditWindow
from app.web_api.usage_service import usage_summary


def _charge(session: Session, request_id: str, user_id: int, amount: int, **kwargs):
    return create_usage_reservation(
        session, request_id=request_id, user_id=user_id, thread_id=None,
        provider="openai", model="swico-test", reserved_micros=amount,
        pricing_snapshot_json="{}", swico_tier="lite", **kwargs,
    )


def _user(uid: str, email: str) -> User:
    with SessionLocal() as session:
        user = User(firebase_uid=uid, email=email, name="Tester", reply_language="en")
        session.add(user)
        session.commit()
        session.refresh(user)
        return user


def test_allowance_uses_exact_decimal_micros_and_verified_owned_email(monkeypatch):
    assert allowance_to_micros("40") == 40_000_000
    assert allowance_to_micros("0.000001") == 1
    config = {
        "SWICO_WEEKLY_TESTER_CREDITS_ENABLED": "true",
        "SWICO_WEEKLY_TESTER_EMAILS": "colleague@example.com",
        "SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES": "40",
    }
    from app.billing.tester_credit import weekly_tester_config
    cfg = weekly_tester_config(config)
    assert is_weekly_tester_eligible(
        email_verified=True, token_email=" Colleague@Example.com ",
        owned_email="colleague@example.com", config=cfg,
    )
    assert not is_weekly_tester_eligible(
        email_verified=False, token_email="colleague@example.com",
        owned_email="colleague@example.com", config=cfg,
    )
    assert not is_weekly_tester_eligible(
        email_verified=True, token_email="other@example.com",
        owned_email="colleague@example.com", config=cfg,
    )


def test_tester_reserve_settle_release_are_idempotent(monkeypatch):
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED", "true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS", "tester@example.com")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES", "1")
    user = _user("tester-credit", "tester@example.com")
    with SessionLocal() as session:
        charge = _charge(session, "tester-reserve", int(user.id), 600_000, tester_credit_eligible=True)
        assert charge.funding_source == "tester_credit"
        window = session.get(WeeklyTesterCreditWindow, charge.tester_credit_window_id)
        assert window is not None and window.reserved_micros == 600_000
        session.commit()
        settled = settle_usage_reservation(
            session, request_id=charge.request_id, provider_cost_amount=Decimal("0.4"),
            provider_cost_currency="INR", provider_cost_micros=400_000,
            input_tokens=10, cached_input_tokens=0, output_tokens=10,
            usage_source="actual", pricing_snapshot_json="{}",
        )
        session.commit()
        assert settled.funding_source == "tester_credit"
        assert settled.debited_micros == 400_000
        again = settle_usage_reservation(
            session, request_id=charge.request_id, provider_cost_amount=Decimal("0.4"),
            provider_cost_currency="INR", provider_cost_micros=400_000,
            input_tokens=10, cached_input_tokens=0, output_tokens=10,
            usage_source="actual", pricing_snapshot_json="{}",
        )
        assert again.id == settled.id
        window = session.get(WeeklyTesterCreditWindow, charge.tester_credit_window_id)
        assert window is not None and window.reserved_micros == 0 and window.consumed_micros == 400_000

        released = _charge(session, "tester-release", int(user.id), 200_000, tester_credit_eligible=True)
        session.commit()
        release_usage_reservation(session, released.request_id)
        session.commit()
        release_usage_reservation(session, released.request_id)
        window = session.get(WeeklyTesterCreditWindow, released.tester_credit_window_id)
        assert window is not None and window.reserved_micros == 0


def test_exhaustion_falls_through_to_wallet_and_voice_is_not_tester_funded(monkeypatch):
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED", "true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS", "tester@example.com")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES", "0.1")
    user = _user("tester-fallback", "tester@example.com")
    with SessionLocal() as session:
        wallet = get_or_create_wallet(session, int(user.id), "chat")
        wallet.balance_micros = 2_000_000
        session.add(wallet)
        session.commit()
        charge = _charge(session, "tester-fallback", int(user.id), 200_000, tester_credit_eligible=True)
        assert charge.funding_source == "wallet"
        voice_wallet = get_or_create_wallet(session, int(user.id), "voice")
        voice_wallet.balance_micros = 2_000_000
        session.add(voice_wallet)
        session.commit()
        voice = _charge(session, "tester-voice", int(user.id), 200_000, tester_credit_eligible=True, credit_bucket="voice", usage_kind="tts")
        assert voice.funding_source == "wallet"


def test_week_boundaries_and_reduced_allowance_never_go_negative(monkeypatch):
    monday = datetime(2026, 9, 14, 0, 0, tzinfo=timezone.utc)
    assert weekly_window(monday) == (monday, datetime(2026, 9, 21, tzinfo=timezone.utc))
    assert weekly_window(datetime(2026, 9, 20, 23, 59, tzinfo=timezone.utc))[0] == monday
    assert weekly_window(datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc))[0] == datetime(2026, 9, 21, tzinfo=timezone.utc)

    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED", "true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS", "tester@example.com")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES", "1")
    user = _user("tester-reduction", "tester@example.com")
    with SessionLocal() as session:
        charge = _charge(session, "tester-reduction", int(user.id), 800_000, tester_credit_eligible=True)
        session.commit()
        monkeypatch.setenv("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES", "0.1")
        summary = get_tester_credit_summary(
            session, user_id=int(user.id), swico_tier="lite", eligible=True,
            now=monday,
        )
        assert summary["available_micros"] == 0
        assert summary["allowance_micros"] >= 800_000
        assert int(summary["available_micros"]) >= 0
        assert charge.tester_credit_window_id is not None


def test_internal_allowlist_requires_verified_owned_identity_and_wins(monkeypatch):
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", " owner@example.com ")
    owner = _user("owner", "owner@example.com")
    assert is_internal_test_user(
        AuthUser(firebase_uid="owner", email="OWNER@example.com", email_verified=True), owner
    )
    assert not is_internal_test_user(
        AuthUser(firebase_uid="owner", email="owner@example.com", email_verified=False), owner
    )
    assert not is_internal_test_user(
        AuthUser(firebase_uid="owner", email="other@example.com", email_verified=True), owner
    )
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED", "true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS", "owner@example.com")
    with SessionLocal() as session:
        summary = get_tester_credit_summary(
            session, user_id=int(owner.id), swico_tier="lite", eligible=True,
            billing_exempt=True,
        )
        assert summary["source"] == "billing_exempt"
        assert summary["balance_display"] == "Unlimited"


def test_usage_summary_exposes_bounded_tester_credit_shape(monkeypatch):
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED", "true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS", "summary@example.com")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES", "40")
    user = _user("summary", "summary@example.com")
    with SessionLocal() as session:
        value = usage_summary(
            session, user=user, period="current_month", tester_credit_eligible=True,
        )
        assert value["tester_credit"]["source"] == "tester_credit"
        assert value["tester_credit"]["allowance_micros"] == 40_000_000
        assert "emails" not in value["tester_credit"]
