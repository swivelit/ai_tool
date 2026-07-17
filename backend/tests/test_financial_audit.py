import json
from datetime import timedelta

from sqlmodel import select

from app.billing.audit import financial_audit
from app.database import SessionLocal
from app.models import PaymentOrder, ProcessedWebhook, UsageCharge, WalletAccount, WalletLedger
from app.time_utils import utc_now
from scripts import billing_maintenance
from scripts.billing_maintenance import FINDINGS_EXIT_CODE
from tests.conftest import create_test_user


def _categories(report):
    return {item["category"] for item in report["findings"]}


def test_clean_audit():
    with SessionLocal() as session:
        report = financial_audit(session)
    assert report["finding_count"] == 0
    assert report["findings"] == []


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
    assert {"captured_payment_uncredited", "failed_refund", "stale_usage_reservation", "reconciliation_worthy_order"} <= _categories(report)


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
