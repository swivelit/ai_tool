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

from sqlalchemy import func, inspect, text
from sqlmodel import select

from app.alembic_utils import repository_alembic_head
from app.database import engine, SessionLocal
from app.models import (
    PaymentOrder, ReferralAttribution, ReferralReward, SubscriptionEntitlement,
    SubscriptionUsageWindow, WalletLedger,
)
from app.billing.pricing import calculate_topup
from app.billing.audit import financial_audit
from app.billing.subscriptions import weekly_allowance_micros
from app.billing.token_estimates import token_estimate
from app.billing.topups import topup_packages


EXPECTED_HEAD = "b8f2c7d1e4a9"
EXPECTED_TABLES = {
    "subscription_entitlement", "subscription_usage_window", "subscription_usage_ledger",
    "subscription_preference", "referral_code", "referral_attribution", "referral_reward",
}


def financial_integrity_summary(audit_report: dict[str, Any]) -> dict[str, Any]:
    """Reduce the audit to safe release-gate counts without financial identifiers."""
    findings = audit_report.get("findings")
    if not isinstance(findings, list):
        raise ValueError("financial audit findings are unavailable")
    counts_by_category: dict[str, int] = {}
    counts_by_severity: dict[str, int] = {}
    for finding in findings:
        if not isinstance(finding, dict):
            raise ValueError("financial audit finding is malformed")
        category = str(finding.get("category") or "unknown")
        count = int(finding.get("count") or 0)
        severity = str(finding.get("severity") or "unknown")
        counts_by_category[category] = counts_by_category.get(category, 0) + count
        counts_by_severity[severity] = counts_by_severity.get(severity, 0) + count
    actionable = int(audit_report.get("actionable_finding_count") or 0)
    high_actionable = sum(
        int(finding.get("count") or 0)
        for finding in findings
        if isinstance(finding, dict)
        and finding.get("severity") == "high"
        and finding.get("actionable") is True
    )
    return {
        "actionable_finding_count": actionable,
        "high_actionable_finding_count": high_actionable,
        "counts_by_category": dict(sorted(counts_by_category.items())),
        "counts_by_severity": dict(sorted(counts_by_severity.items())),
        "captured_payment_uncredited": counts_by_category.get("captured_payment_uncredited", 0),
        "payment_state_inconsistency": counts_by_category.get("payment_state_inconsistency", 0),
        "stale_usage_reservation": counts_by_category.get("stale_usage_reservation", 0),
        "duplicate_ledger_reference": counts_by_category.get("duplicate_ledger_reference", 0),
        "failed_refund": counts_by_category.get("failed_refund", 0),
        "refund_credit_reversal_shortfall": counts_by_category.get("refund_credit_reversal_shortfall", 0),
        "ready": actionable == 0 and high_actionable == 0,
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


def _database_head() -> str | None:
    """Read the connected database version without changing database state."""
    with engine.connect() as connection:
        versions = [str(value) for value in connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()]
    return versions[0] if len(versions) == 1 else None


def _token_estimation_readiness() -> dict[str, Any]:
    checks: dict[str, Any] = {
        "payg_positive_packages_ready": True,
        "weekly_allowance_ready": False,
        "free_selected_paid_fallback_ready": False,
        "invalid_pricing_unavailable_ready": False,
    }
    tier = os.getenv("SWICO_DEFAULT_TIER", "lite")
    package_results = []
    for amount in topup_packages():
        credit_micros, _ = calculate_topup(amount)
        estimate = token_estimate(credit_micros, tier=tier)
        ready = bool(
            estimate.get("estimate_available")
            and int(estimate.get("estimated_blended_tokens") or 0) > 0
            and int(estimate.get("range_min_tokens") or 0) > 0
            and int(estimate.get("range_max_tokens") or 0) > 0
        )
        package_results.append(ready)
    checks["payg_positive_packages_ready"] = bool(package_results) and all(package_results)

    weekly = token_estimate(weekly_allowance_micros(), tier=tier)
    checks["weekly_allowance_ready"] = bool(
        weekly.get("estimate_available") and int(weekly.get("estimated_blended_tokens") or 0) > 0
    )
    free = token_estimate(1_000_000, tier="free")
    checks["free_selected_paid_fallback_ready"] = bool(
        free.get("selected_tier") == "free"
        and free.get("display_tier") != "free"
        and free.get("estimate_available")
        and int(free.get("estimated_blended_tokens") or 0) > 0
    )

    original_primary = os.environ.get("SWICO_LITE_MODEL_PRIMARY")
    os.environ["SWICO_LITE_MODEL_PRIMARY"] = "__invalid_pricing_readiness_model__"
    try:
        invalid = token_estimate(1_000_000, tier="lite")
        checks["invalid_pricing_unavailable_ready"] = bool(
            invalid.get("availability") == "unavailable"
            and invalid.get("estimated_blended_tokens") is None
            and invalid.get("range_min_tokens") is None
            and invalid.get("range_max_tokens") is None
        )
    finally:
        if original_primary is None:
            os.environ.pop("SWICO_LITE_MODEL_PRIMARY", None)
        else:
            os.environ["SWICO_LITE_MODEL_PRIMARY"] = original_primary
    checks["ready"] = all(bool(value) for value in checks.values())
    return checks


def build_report() -> dict[str, Any]:
    config_ok, config_errors = _configuration()
    repository_head = repository_alembic_head()
    report: dict[str, Any] = {
        "status": "ok", "blocker_count": 0,
        "expected_head": EXPECTED_HEAD,
        "repository_head": repository_head,
        "database_head": None,
        "repository_head_ready": repository_head == EXPECTED_HEAD,
        "database_head_ready": False,
        "configuration_valid": config_ok,
        "configuration_errors": config_errors,
        "migration_table_constraint_readiness": {},
        "payment_fulfillment_invariants": {},
        "subscription_window_overdraw_count": 0,
        "duplicate_entitlement_count": 0,
        "duplicate_reward_count": 0,
        "invalid_referral_count": 0,
        "token_estimation_readiness": {},
        "financial_integrity": {},
    }
    blockers = len(config_errors) + int(repository_head != EXPECTED_HEAD)
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        missing = sorted(EXPECTED_TABLES - tables)
        head = repository_head
        constraints_ready = all(
            any(name in str(item.get("name")) for item in inspector.get_check_constraints(table))
            for table, name in (
                ("subscription_entitlement", "ck_subscription_entitlement"),
                ("subscription_usage_window", "ck_subscription_window"),
                ("subscription_usage_ledger", "ck_subscription_usage_ledger"),
            ) if table in tables
        ) if not missing else False
        database_head = _database_head()
        repository_head_ready = head == EXPECTED_HEAD
        database_head_ready = database_head == EXPECTED_HEAD
        report["database_head"] = database_head
        report["repository_head_ready"] = repository_head_ready
        report["database_head_ready"] = database_head_ready
        report["migration_table_constraint_readiness"] = {
            "repository_head": head, "database_head": database_head, "expected_head": EXPECTED_HEAD,
            "repository_head_ready": repository_head_ready, "database_head_ready": database_head_ready,
            "head_ready": repository_head_ready and database_head_ready, "missing_tables": missing,
            "constraints_ready": constraints_ready,
        }
        blockers += int(not repository_head_ready or not database_head_ready or bool(missing) or not constraints_ready)
    except Exception:
        report["migration_table_constraint_readiness"] = {
            "expected_head": EXPECTED_HEAD,
            "repository_head": repository_head,
            "database_head": report["database_head"],
            "repository_head_ready": report["repository_head_ready"],
            "database_head_ready": report["database_head_ready"],
            "status": "unavailable",
        }
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
    try:
        with SessionLocal() as session:
            report["financial_integrity"] = financial_integrity_summary(financial_audit(session))
        blockers += int(not report["financial_integrity"].get("ready", False))
    except Exception:
        report["financial_integrity"] = {
            "status": "unavailable",
            "actionable_finding_count": None,
            "counts_by_category": {},
            "counts_by_severity": {},
            "captured_payment_uncredited": None,
            "payment_state_inconsistency": None,
            "stale_usage_reservation": None,
            "duplicate_ledger_reference": None,
            "failed_refund": None,
            "refund_credit_reversal_shortfall": None,
            "ready": False,
        }
        blockers += 1
    try:
        report["token_estimation_readiness"] = _token_estimation_readiness()
        blockers += int(not report["token_estimation_readiness"].get("ready", False))
    except Exception:
        report["token_estimation_readiness"] = {"ready": False, "status": "unavailable"}
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
