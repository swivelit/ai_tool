"""Read-only production readiness report for website subscriptions/referrals."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any

# Allow the documented `python scripts/subscription_release_check.py` form.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import func, inspect
from sqlmodel import select

from app.alembic_utils import repository_alembic_head
from app.database import engine, SessionLocal
from app.models import (
    PaymentOrder, ReferralAttribution, ReferralReward, SubscriptionEntitlement,
    SubscriptionUsageWindow, WalletLedger,
)


EXPECTED_HEAD = "b8f2c7d1e4a9"
EXPECTED_TABLES = {
    "subscription_entitlement", "subscription_usage_window", "subscription_usage_ledger",
    "subscription_preference", "referral_code", "referral_attribution", "referral_reward",
}


def _int(name: str, default: int) -> int | None:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return None


def _configuration() -> tuple[bool, list[str]]:
    expected = {
        "WEB_SUBSCRIPTION_1M_PRICE_PAISE": 150000,
        "WEB_SUBSCRIPTION_6M_PRICE_PAISE": 800000,
        "WEB_SUBSCRIPTION_1Y_PRICE_PAISE": 1200000,
        "WEB_SUBSCRIPTION_WEEKLY_ALLOWANCE_MICROS": 125000000,
        "WEB_REFERRAL_REWARD_1M_WEEKS": 1,
        "WEB_REFERRAL_REWARD_6M_WEEKS": 3,
        "WEB_REFERRAL_REWARD_1Y_MONTHS": 2,
    }
    errors: list[str] = []
    for name, value in expected.items():
        actual = _int(name, value)
        if actual is None or actual < 0 or actual != value:
            errors.append(name)
    for name in (
        "WEB_SUBSCRIPTIONS_ENABLED", "WEB_REFERRALS_ENABLED",
        "WEB_SUBSCRIPTION_PRORATE_FINAL_PARTIAL_WEEK",
        "WEB_SUBSCRIPTION_PAYG_FALLBACK_DEFAULT",
    ):
        if os.getenv(name, "false").lower() not in {"true", "false", "1", "0", "yes", "no", "on", "off"}:
            errors.append(name)
    return not errors, errors


def build_report() -> dict[str, Any]:
    config_ok, config_errors = _configuration()
    report: dict[str, Any] = {
        "status": "ok", "blocker_count": 0,
        "configuration_valid": config_ok,
        "configuration_errors": config_errors,
        "migration_table_constraint_readiness": {},
        "payment_fulfillment_invariants": {},
        "subscription_window_overdraw_count": 0,
        "duplicate_entitlement_count": 0,
        "duplicate_reward_count": 0,
        "invalid_referral_count": 0,
    }
    blockers = len(config_errors)
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        missing = sorted(EXPECTED_TABLES - tables)
        head = repository_alembic_head()
        constraints_ready = all(
            any(name in str(item.get("name")) for item in inspector.get_check_constraints(table))
            for table, name in (
                ("subscription_entitlement", "ck_subscription_entitlement"),
                ("subscription_usage_window", "ck_subscription_window"),
                ("subscription_usage_ledger", "ck_subscription_usage_ledger"),
            ) if table in tables
        ) if not missing else False
        report["migration_table_constraint_readiness"] = {
            "repository_head": head, "expected_head": EXPECTED_HEAD,
            "head_ready": head == EXPECTED_HEAD, "missing_tables": missing,
            "constraints_ready": constraints_ready,
        }
        blockers += int(head != EXPECTED_HEAD or bool(missing) or not constraints_ready)
    except Exception:
        report["migration_table_constraint_readiness"] = {"status": "unavailable"}
        blockers += 1

    try:
        with SessionLocal() as session:
            bad_credit = session.exec(select(func.count(PaymentOrder.id)).where(
                PaymentOrder.purchase_type == "subscription", PaymentOrder.credited_amount_micros != 0,
            )).one()
            fulfilled_missing = session.exec(select(func.count(PaymentOrder.id)).where(
                PaymentOrder.purchase_type == "subscription", PaymentOrder.fulfillment_status == "fulfilled",
                ~PaymentOrder.id.in_(select(SubscriptionEntitlement.source_payment_order_id).where(
                    SubscriptionEntitlement.source_payment_order_id.is_not(None),
                )),
            )).one()
            duplicate_entitlements = session.exec(select(
                func.count(SubscriptionEntitlement.source_payment_order_id)
            ).where(SubscriptionEntitlement.source_payment_order_id.is_not(None)).group_by(
                SubscriptionEntitlement.source_payment_order_id
            ).having(func.count(SubscriptionEntitlement.source_payment_order_id) > 1)).all()
            duplicate_rewards = session.exec(select(
                func.count(ReferralReward.qualifying_payment_order_id)
            ).group_by(ReferralReward.qualifying_payment_order_id).having(
                func.count(ReferralReward.qualifying_payment_order_id) > 1,
            )).all()
            overdraw = session.exec(select(func.count(SubscriptionUsageWindow.id)).where(
                SubscriptionUsageWindow.reserved_micros + SubscriptionUsageWindow.consumed_micros > SubscriptionUsageWindow.allowance_micros,
            )).one()
            invalid_referrals = session.exec(select(func.count(ReferralAttribution.id)).where(
                ReferralAttribution.referrer_user_id == ReferralAttribution.referred_user_id,
            )).one()
            payment_credit_refs = session.exec(select(func.count(WalletLedger.id)).join(
                PaymentOrder, PaymentOrder.id == WalletLedger.reference_id,
            ).where(
                PaymentOrder.purchase_type == "subscription", WalletLedger.entry_type == "payment_credit",
                WalletLedger.reference_type == "payment_order",
            )).one()
            report["payment_fulfillment_invariants"] = {
                "subscription_wallet_credit_count": int(bad_credit),
                "fulfilled_without_entitlement_count": int(fulfilled_missing),
                "subscription_payment_credit_ledger_count": int(payment_credit_refs),
            }
            report["subscription_window_overdraw_count"] = int(overdraw)
            report["duplicate_entitlement_count"] = sum(int(value) - 1 for value in duplicate_entitlements)
            report["duplicate_reward_count"] = sum(int(value) - 1 for value in duplicate_rewards)
            report["invalid_referral_count"] = int(invalid_referrals)
            blockers += sum(report["payment_fulfillment_invariants"].values())
            blockers += sum(report[key] for key in ("subscription_window_overdraw_count", "duplicate_entitlement_count", "duplicate_reward_count", "invalid_referral_count"))
    except Exception:
        report["payment_fulfillment_invariants"] = {"status": "unavailable"}
        blockers += 1
    report["blocker_count"] = blockers
    report["status"] = "blocked" if blockers else "ok"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = build_report()
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True, default=str))
    return 0 if report["blocker_count"] == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main())
