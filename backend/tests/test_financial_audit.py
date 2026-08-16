import json
from datetime import timedelta

import pytest
from sqlmodel import select

from app.billing.audit import financial_audit
from app.billing.subscriptions import create_entitlement
from app.database import SessionLocal
from app.models import PaymentOrder, ProcessedWebhook, UsageCharge, WalletAccount, WalletLedger
from app.time_utils import utc_now
from scripts import billing_maintenance
from scripts.billing_maintenance import FINDINGS_EXIT_CODE
from scripts.subscription_release_check import financial_integrity_summary
from tests.conftest import create_test_user


def _categories(report):
    return {item["category"] for item in report["findings"]}


def _finding(report, category):
    return next(item for item in report["findings"] if item["category"] == category)


def _old_order(user_id: int, status: str) -> PaymentOrder:
    old = utc_now() - timedelta(hours=2)
    return PaymentOrder(
        user_id=user_id,
        receipt=f"audit-{status}-{user_id}",
        gross_amount_paise=1000,
        credited_amount_micros=5_000_000,
        platform_share_paise=500,
        provider_order_id=f"audit-provider-{status}-{user_id}",
        status=status,
        created_at=old,
        updated_at=old,
    )


def test_clean_audit():
    with SessionLocal() as session:
        report = financial_audit(session)
    assert report["finding_count"] == 0
    assert report["informational_finding_count"] == 0
    assert report["warning_finding_count"] == 0
    assert report["high_severity_count"] == 0
    assert report["actionable_finding_count"] == 0
    assert report["findings"] == []
    assert financial_integrity_summary(report)["ready"] is True


def test_old_created_order_is_informational_and_non_actionable():
    user = create_test_user()
    with SessionLocal() as session:
        session.add(_old_order(int(user.id), "created"))
        session.flush()
        report = financial_audit(session)
    finding = _finding(report, "abandoned_checkout_order")
    assert finding["severity"] == "info"
    assert finding["actionable"] is False
    assert report["informational_finding_count"] == 1
    assert report["high_severity_count"] == 0
    assert report["actionable_finding_count"] == 0
    assert financial_integrity_summary(report)["ready"] is True


def test_old_attempted_order_is_warning_and_non_actionable():
    user = create_test_user()
    with SessionLocal() as session:
        session.add(_old_order(int(user.id), "attempted"))
        session.flush()
        report = financial_audit(session)
    finding = _finding(report, "long_lived_payment_attempt")
    assert finding["severity"] == "warning"
    assert finding["actionable"] is False
    assert report["warning_finding_count"] == 1
    assert report["high_severity_count"] == 0
    assert report["actionable_finding_count"] == 0
    assert financial_integrity_summary(report)["ready"] is True


def test_negative_wallet_and_invalid_reservation():
    user = create_test_user(email="private-person@example.com", name="Private Person")
    with SessionLocal() as session:
        session.add(WalletAccount(user_id=int(user.id), balance_micros=-1, reserved_micros=10))
        session.flush()
        report = financial_audit(session)
    assert {"negative_wallet_balance", "invalid_wallet_reservation"} <= _categories(report)
    serialized = json.dumps(report)
    assert "private-person" not in serialized.lower()
    assert "private person" not in serialized.lower()


def test_captured_uncredited_failed_refund_and_stale_reservation():
    user = create_test_user()
    old = utc_now() - timedelta(hours=2)
    with SessionLocal() as session:
        session.add(WalletAccount(user_id=int(user.id), balance_micros=100, reserved_micros=100))
        order = PaymentOrder(user_id=int(user.id), receipt="audit-order", gross_amount_paise=1000,
            credited_amount_micros=5_000_000, platform_share_paise=500,
            provider_order_id="audit-provider-order", status="captured", created_at=old, updated_at=old)
        charge = UsageCharge(request_id="audit-stale", user_id=int(user.id), provider="sarvam",
            model="sarvam-30b", reserved_micros=100, status="reserved", created_at=old)
        webhook = ProcessedWebhook(provider="razorpay", event_id="audit-refund-event",
            event_type="refund.failed", payload_sha256="0" * 64, processed_at=old)
        session.add(order); session.add(charge); session.add(webhook); session.flush()
        report = financial_audit(session, captured_uncredited_age_seconds=900, stale_reservation_age_seconds=900)
    assert {"captured_payment_uncredited", "failed_refund", "stale_usage_reservation"} <= _categories(report)
    assert "reconciliation_worthy_order" not in _categories(report)
    captured = _finding(report, "captured_payment_uncredited")
    assert captured["severity"] == "high" and captured["actionable"] is True


def test_captured_order_is_not_double_counted():
    user = create_test_user()
    with SessionLocal() as session:
        session.add(_old_order(int(user.id), "captured"))
        session.flush()
        report = financial_audit(session)
    assert report["finding_count"] == 1
    assert _categories(report) == {"captured_payment_uncredited"}
    summary = financial_integrity_summary(report)
    assert summary["captured_payment_uncredited"] == 1
    assert summary["ready"] is False


def test_captured_subscription_awaiting_fulfillment_blocks_financial_release():
    user = create_test_user()
    order = _old_order(int(user.id), "captured")
    order.purchase_type = "subscription"
    order.subscription_plan_code = "1m"
    order.credited_amount_micros = 0
    order.fulfillment_status = "pending"
    with SessionLocal() as session:
        session.add(order)
        session.flush()
        report = financial_audit(session)
    assert "payment_state_inconsistency" in _categories(report)
    summary = financial_integrity_summary(report)
    assert summary["payment_state_inconsistency"] == 1
    assert summary["ready"] is False


@pytest.mark.parametrize("status", ["captured", "fulfilled", "partially_refunded", "refunded"])
def test_subscription_status_not_terminal_only_fires_for_stranded_fulfillment(status):
    user = create_test_user(uid=f"subscription-audit-{status}", email=f"subscription-audit-{status}@example.test")
    old = utc_now() - timedelta(hours=2)
    with SessionLocal() as session:
        order = _old_order(int(user.id), status)
        order.purchase_type = "subscription"
        order.subscription_plan_code = "1m"
        order.credited_amount_micros = 0
        order.fulfillment_status = "fulfilled"
        order.status = status
        order.updated_at = old
        if status == "partially_refunded":
            order.refunded_amount_paise = 500
        elif status == "refunded":
            order.refunded_amount_paise = order.gross_amount_paise
        session.add(order)
        session.flush()
        create_entitlement(
            session,
            user_id=int(user.id),
            credit_bucket="chat",
            plan_code="1m",
            source="purchase",
            source_payment_order_id=order.id,
            price_paise=150_000,
            starts_at=old,
        )
        order.updated_at = old
        session.add(order)
        session.flush()
        report = financial_audit(session)
    categories = _categories(report)
    if status == "captured":
        finding = _finding(report, "subscription_status_not_terminal")
        assert finding["severity"] == "high"
        assert finding["actionable"] is True
    else:
        assert "subscription_status_not_terminal" not in categories


def test_credited_order_missing_ledger_is_high_and_actionable():
    user = create_test_user()
    with SessionLocal() as session:
        session.add(_old_order(int(user.id), "credited"))
        session.flush()
        report = financial_audit(session)
    finding = _finding(report, "credited_order_missing_ledger")
    assert finding["severity"] == "high" and finding["actionable"] is True
    assert report["high_severity_count"] == 1
    assert report["actionable_finding_count"] == 1


def test_duplicate_financial_reference_is_reported():
    user = create_test_user()
    with SessionLocal() as session:
        for suffix in ("a", "b"):
            session.add(WalletLedger(user_id=int(user.id), entry_type="payment_credit", amount_micros=1,
                balance_after_micros=1, reference_type="payment_order", reference_id="same-order",
                idempotency_key=f"audit-duplicate-{suffix}"))
        session.flush()
        assert "duplicate_ledger_reference" in _categories(financial_audit(session))


def test_audit_cli_exit_code_output_safety_and_no_mutation(monkeypatch, capsys):
    user = create_test_user(email="secret-user@example.com", name="Secret User")
    with SessionLocal() as session:
        wallet = WalletAccount(user_id=int(user.id), balance_micros=-10, reserved_micros=0)
        session.add(wallet); session.commit(); wallet_id = wallet.id
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("BILLING_MAINTENANCE_ALLOW_SQLITE", "true")
    monkeypatch.setenv("SENTRY_DSN", "")
    assert billing_maintenance.main(["audit", "--fail-on-findings"]) == FINDINGS_EXIT_CODE
    output = capsys.readouterr().out
    assert "secret-user" not in output.lower() and "secret user" not in output.lower()
    with SessionLocal() as session:
        assert session.get(WalletAccount, wallet_id).balance_micros == -10
        assert session.exec(select(WalletLedger)).all() == []


def _configure_audit_cli(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("BILLING_MAINTENANCE_ALLOW_SQLITE", "true")


@pytest.mark.parametrize("status", ["created", "attempted"])
def test_non_actionable_audit_exits_zero_and_does_not_report_to_sentry(
    status, monkeypatch, capsys,
):
    user = create_test_user()
    with SessionLocal() as session:
        session.add(_old_order(int(user.id), status))
        session.commit()
    sentry_calls = []
    _configure_audit_cli(monkeypatch)
    monkeypatch.setenv("SENTRY_DSN", "configured-test-dsn")
    monkeypatch.setattr("app.observability.bootstrap_observability", lambda: sentry_calls.append("bootstrap"))
    monkeypatch.setattr("app.observability.add_sentry_context", lambda *args: sentry_calls.append("context"))
    monkeypatch.setattr("app.observability.capture_exception", lambda *args: sentry_calls.append("exception"))

    assert billing_maintenance.main(["audit", "--fail-on-findings"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["actionable_finding_count"] == 0
    assert sentry_calls == []


def test_captured_uncredited_audit_exits_three(monkeypatch, capsys):
    user = create_test_user()
    with SessionLocal() as session:
        session.add(_old_order(int(user.id), "captured"))
        session.commit()
    _configure_audit_cli(monkeypatch)
    monkeypatch.setenv("SENTRY_DSN", "")

    assert billing_maintenance.main(["audit", "--fail-on-findings"]) == FINDINGS_EXIT_CODE
    report = json.loads(capsys.readouterr().out)
    assert report["actionable_finding_count"] == 1
