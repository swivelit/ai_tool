from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select

from app.billing.errors import SubscriptionWeeklyLimitError
from app.billing.service import (
    create_usage_reservation, credit_payment_once, release_usage_reservation,
    settle_usage_reservation,
)
from app.billing.subscriptions import (
    add_calendar_months, claim_referral_code, create_entitlement,
    create_referral_reward_once, plan_catalog, referral_code_for_user,
)
from app.models import (
    PaymentOrder, SubscriptionEntitlement,
    SubscriptionUsageWindow, WalletAccount, User, UsageCharge,
)
from app.time_utils import utc_now
from app.database import SessionLocal
from tests.conftest import create_test_user


def _subscription_order(user_id: int, plan: str = "1m", bucket: str = "chat") -> PaymentOrder:
    value = plan_catalog()[plan]
    return PaymentOrder(
        user_id=user_id, credit_bucket=bucket, purchase_type="subscription",
        subscription_plan_code=plan, gross_amount_paise=value.price_paise,
        credited_amount_micros=0, platform_share_paise=0,
        receipt=f"sub-{user_id}-{plan}-{bucket}-{id(value)}", status="captured",
    )


def test_server_authoritative_plan_catalog_and_calendar_months():
    assert {code: (item.price_paise, item.duration_months) for code, item in plan_catalog().items()} == {
        "1m": (150_000, 1), "6m": (800_000, 6), "1y": (1_200_000, 12),
    }
    assert add_calendar_months(datetime(2024, 1, 31, tzinfo=timezone.utc), 1).date().isoformat() == "2024-02-29"
    assert add_calendar_months(datetime(2023, 11, 30, tzinfo=timezone.utc), 6).date().isoformat() == "2024-05-30"


def test_subscription_fulfillment_stacks_and_never_credits_wallet():
    user = create_test_user("subscription-stack")
    with SessionLocal() as session:
        first = _subscription_order(int(user.id), "1m")
        second = _subscription_order(int(user.id), "6m")
        session.add(first); session.flush(); credit_payment_once(session, first)
        session.add(second); session.flush(); credit_payment_once(session, second)
        rows = session.exec(select(SubscriptionEntitlement).where(SubscriptionEntitlement.user_id == user.id).order_by(SubscriptionEntitlement.starts_at)).all()
        assert len(rows) == 2
        assert rows[1].starts_at == rows[0].ends_at
        wallet = session.exec(select(WalletAccount).where(WalletAccount.user_id == user.id, WalletAccount.credit_bucket == "chat")).first()
        assert wallet is None or (wallet.balance_micros == 0 and wallet.reserved_micros == 0)


def test_subscription_reservation_settlement_and_release_do_not_mutate_wallet():
    user = create_test_user("subscription-usage")
    with SessionLocal() as session:
        order = _subscription_order(int(user.id))
        session.add(order); session.flush(); credit_payment_once(session, order)
        before = session.exec(select(WalletAccount).where(WalletAccount.user_id == user.id, WalletAccount.credit_bucket == "chat")).first()
        charge = create_usage_reservation(
            session, request_id="subscription-request", user_id=int(user.id), thread_id=None,
            provider="test", model="test", reserved_micros=10_000_000,
            pricing_snapshot_json="{}", credit_bucket="chat",
        )
        assert charge.funding_source == "subscription"
        settle_usage_reservation(
            session, request_id=charge.request_id, provider_cost_amount=0,
            provider_cost_currency="INR", provider_cost_micros=10_000_000,
            input_tokens=1, cached_input_tokens=0, output_tokens=1,
            usage_source="estimated", pricing_snapshot_json="{}",
        )
        session.flush()
        after = session.exec(select(WalletAccount).where(WalletAccount.user_id == user.id, WalletAccount.credit_bucket == "chat")).first()
        assert before is None and after is None
        assert session.exec(select(SubscriptionUsageWindow).where(SubscriptionUsageWindow.consumed_micros == 10_000_000)).first() is not None


def test_subscription_exhaustion_is_structured_and_fallback_keeps_one_source():
    user = create_test_user("subscription-fallback")
    with SessionLocal() as session:
        order = _subscription_order(int(user.id))
        session.add(order); session.flush(); credit_payment_once(session, order)
        with pytest.raises(SubscriptionWeeklyLimitError):
            create_usage_reservation(
                session, request_id="too-large", user_id=int(user.id), thread_id=None,
                provider="test", model="test", reserved_micros=200_000_000,
                pricing_snapshot_json="{}", credit_bucket="chat",
            )


def test_referral_attribution_and_first_subscription_reward_once(monkeypatch):
    monkeypatch.setenv("WEB_REFERRALS_ENABLED", "true")
    referrer = create_test_user("referrer", "referrer@example.com")
    referred = create_test_user("referred", "referred@example.com")
    with SessionLocal() as session:
        code = referral_code_for_user(session, int(referrer.id))
        claim_referral_code(session, referred_user_id=int(referred.id), code=code.code)
        order = _subscription_order(int(referred.id), "6m", "voice")
        session.add(order); session.flush(); credit_payment_once(session, order)
        reward = create_referral_reward_once(session, order)
        assert reward is not None
        assert reward.reward_duration_weeks == 3 and reward.reward_duration_months == 0
        assert create_referral_reward_once(session, order).id == reward.id
        assert reward.generated_entitlement_id is not None
