from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
import shutil
import subprocess
import sys

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.billing.service import get_wallet_summary
from app.database import DATABASE_URL, SessionLocal
from app.models import PaymentOrder, UsageCharge, User, WalletAccount, WalletLedger
from app.time_utils import utc_now
from scripts import billing_maintenance
from scripts.billing_maintenance import (
    CONFIGURATION_ERROR_EXIT_CODE,
    FINDINGS_EXIT_CODE,
    MaintenanceConfigurationError,
    validate_maintenance_database,
    validate_razorpay_configuration,
)
from tests.conftest import create_test_user


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_render_cron_operator_instructions_are_complete() -> None:
    instructions = " ".join(
        (BACKEND_ROOT.parent / "docs" / "RENDER_WEB_DEPLOYMENT.md")
        .read_text(encoding="utf-8")
        .split()
    )
    required = (
        "branch `main`",
        "region **Virginia**",
        "blank Root Directory",
        "Render evaluates Cron schedules in UTC",
        "`billing-stale-reservations`: `*/10 * * * *`",
        "`razorpay-reconciliation`: `*/15 * * * *`",
        "`billing-financial-audit`: `*/5 * * * *`",
        "RAZORPAY_MODE=test",
        "RAZORPAY_KEY_ID=<matching rzp_test_ key>",
        "RAZORPAY_KEY_SECRET=<matching Test Mode secret>",
        "cd backend && python -m scripts.billing_maintenance stale-reservations --age-seconds 1800",
        "python -m scripts.billing_maintenance razorpay",
        "--internal-order-id <uuid>",
        "python -m scripts.billing_maintenance audit",
        "--captured-uncredited-age-seconds 900",
        "Cron Jobs have no migration or pre-deploy command",
        "service-level `DATABASE_URL`",
        "must be rotated manually in Render",
        "Never schedule `--apply`",
        "any actionable result exits `3`",
    )

    missing = [item for item in required if item not in instructions]
    assert missing == []


def test_razorpay_summary_only_is_readable_without_changing_dry_run_defaults() -> None:
    args = billing_maintenance._parser().parse_args(["razorpay", "--summary-only"])
    assert args.summary_only is True
    assert args.apply is False
    assert args.max_age_seconds == 2592000


def test_audit_summary_only_is_compact_and_full_audit_remains_detailed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    user = create_test_user(uid="maintenance-audit-summary", email="maintenance-audit-summary@example.test")
    old = utc_now() - timedelta(hours=2)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=int(user.id),
            receipt="maintenance-audit-summary-receipt",
            gross_amount_paise=1500,
            credited_amount_micros=7_500_000,
            platform_share_paise=750,
            status="captured",
            updated_at=old,
        )
        session.add(order)
        session.commit()
        order_id = order.id

    _configure_local_cli(monkeypatch)
    assert billing_maintenance.main(["audit", "--summary-only", "--fail-on-findings"]) == FINDINGS_EXIT_CODE
    summary_output = capsys.readouterr()
    summary = json.loads(summary_output.out)
    assert summary["audit"] == "financial_integrity"
    assert {"finding_count", "informational_finding_count", "warning_finding_count", "high_severity_count", "actionable_finding_count"} <= set(summary)
    assert "wallet_totals_by_bucket" in summary
    assert summary["actionable_internal_ids"] == [order_id]
    assert all(set(finding) == {"category", "severity", "actionable", "count"} for finding in summary["findings"])
    assert "items" not in summary_output.out
    assert json.loads(summary_output.err)["summary_only"] is True

    assert billing_maintenance.main(["audit", "--fail-on-findings"]) == FINDINGS_EXIT_CODE
    full_output = capsys.readouterr()
    full = json.loads(full_output.out)
    assert all("items" in finding for finding in full["findings"])
    assert all("internal_ids" not in finding for finding in full["findings"])
    assert json.loads(full_output.err)["summary_only"] is False


def test_audit_summary_only_uses_complete_actionable_id_list(monkeypatch, capsys):
    internal_ids = [f"actionable-{index:02d}" for index in range(60)]
    report = {
        "audit": "financial_integrity",
        "generated_at": "2026-08-17T00:00:00+00:00",
        "finding_count": 60,
        "informational_finding_count": 0,
        "warning_finding_count": 0,
        "high_severity_count": 60,
        "actionable_finding_count": 60,
        "wallet_totals_by_bucket": {"chat": {}, "voice": {}},
        "findings": [{
            "category": "test_actionable",
            "severity": "high",
            "actionable": True,
            "count": 60,
            "items": [{"internal_id": value} for value in internal_ids[:50]],
            "internal_ids": internal_ids,
        }],
    }
    monkeypatch.setattr("app.billing.audit.financial_audit", lambda session, **kwargs: report)
    _configure_local_cli(monkeypatch)
    assert billing_maintenance.main(["audit", "--summary-only"]) == 0
    output = capsys.readouterr().out
    summary = json.loads(output)
    assert summary["actionable_internal_ids"] == internal_ids
    assert all("items" not in finding for finding in summary["findings"])
    assert {"finding_count", "informational_finding_count", "warning_finding_count", "high_severity_count", "actionable_finding_count"} <= set(summary)
    assert "wallet_totals_by_bucket" in summary


def _subprocess_environment(**updates: str) -> dict[str, str]:
    env = {
        "PYTHONPATH": str(BACKEND_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
    }
    env.update(updates)
    return env


def _run_cli(
    *arguments: str,
    environ: dict[str, str] | None = None,
    backend_root: Path = BACKEND_ROOT,
    profile_imports: bool = False,
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable]
    if profile_imports:
        command.extend(["-X", "importtime"])
    command.extend(["-m", "scripts.billing_maintenance", *arguments])
    env = _subprocess_environment()
    env["PYTHONPATH"] = str(backend_root)
    env.update(environ or {})
    return subprocess.run(
        command,
        cwd=backend_root,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )


def _isolated_backend(tmp_path: Path) -> Path:
    root = tmp_path / "isolated-backend"
    (root / "app").mkdir(parents=True)
    (root / "scripts").mkdir()
    for relative in (
        "app/__init__.py",
        "app/database.py",
        "app/database_url.py",
        "scripts/__init__.py",
        "scripts/billing_maintenance.py",
    ):
        source = BACKEND_ROOT / relative
        destination = root / relative
        shutil.copy2(source, destination)
    return root


def test_missing_database_url_fails_before_importing_app_database(tmp_path: Path) -> None:
    isolated = _isolated_backend(tmp_path)

    result = _run_cli(
        "stale-reservations",
        backend_root=isolated,
        profile_imports=True,
    )

    assert result.returncode == CONFIGURATION_ERROR_EXIT_CODE
    assert "DATABASE_URL" in result.stderr
    assert "app.database\n" not in result.stderr
    assert not (isolated / "data").exists()


def test_missing_database_url_does_not_create_default_sqlite_file(tmp_path: Path) -> None:
    isolated = _isolated_backend(tmp_path)

    result = _run_cli("stale-reservations", backend_root=isolated)

    assert result.returncode == CONFIGURATION_ERROR_EXIT_CODE
    assert not (isolated / "data" / "db" / "ai_tool.sqlite3").exists()


def test_blank_database_url_fails() -> None:
    result = _run_cli("stale-reservations", environ={"DATABASE_URL": "   "})

    assert result.returncode == CONFIGURATION_ERROR_EXIT_CODE
    assert "DATABASE_URL" in result.stderr


def test_sqlite_is_rejected_by_default() -> None:
    with pytest.raises(MaintenanceConfigurationError, match="DATABASE_URL"):
        validate_maintenance_database(
            {"APP_ENV": "test", "DATABASE_URL": "sqlite:///maintenance.sqlite3"}
        )


def test_sqlite_is_rejected_in_production_even_with_override() -> None:
    with pytest.raises(MaintenanceConfigurationError, match="PostgreSQL"):
        validate_maintenance_database(
            {
                "APP_ENV": "production",
                "DATABASE_URL": "sqlite:///maintenance.sqlite3",
                "BILLING_MAINTENANCE_ALLOW_SQLITE": "true",
            }
        )


@pytest.mark.parametrize("app_env", ["test", "development"])
def test_sqlite_is_accepted_only_with_explicit_local_override(app_env: str) -> None:
    configured = validate_maintenance_database(
        {
            "APP_ENV": app_env,
            "DATABASE_URL": "sqlite:///maintenance.sqlite3",
            "BILLING_MAINTENANCE_ALLOW_SQLITE": "true",
        }
    )

    assert configured.backend == "sqlite"
    assert configured.app_env == app_env


def test_sqlite_override_is_not_accepted_outside_test_or_development() -> None:
    with pytest.raises(MaintenanceConfigurationError, match="APP_ENV"):
        validate_maintenance_database(
            {
                "APP_ENV": "staging",
                "DATABASE_URL": "sqlite:///maintenance.sqlite3",
                "BILLING_MAINTENANCE_ALLOW_SQLITE": "true",
            }
        )


@pytest.mark.parametrize(
    ("database_url", "normalized_prefix"),
    [
        ("postgres://configured", "postgresql+psycopg://"),
        ("postgresql://configured", "postgresql+psycopg://"),
        ("postgresql+psycopg://configured", "postgresql+psycopg://"),
        ("postgresql+psycopg2://configured", "postgresql+psycopg://"),
    ],
)
def test_supported_postgresql_url_forms_pass_validation(
    database_url: str, normalized_prefix: str
) -> None:
    configured = validate_maintenance_database(
        {"APP_ENV": "production", "DATABASE_URL": database_url}
    )

    assert configured.backend == "postgresql"
    assert configured.url.startswith(normalized_prefix)


@pytest.mark.parametrize(
    "database_url",
    ["mysql://configured", "mariadb://configured", "configured-without-a-scheme"],
)
def test_unsupported_database_url_schemes_fail_safely(database_url: str) -> None:
    with pytest.raises(MaintenanceConfigurationError) as caught:
        validate_maintenance_database(
            {"APP_ENV": "production", "DATABASE_URL": database_url}
        )

    assert database_url not in str(caught.value)


def test_configuration_errors_never_echo_supplied_sensitive_values() -> None:
    unsafe_url = "mysql://billing-user:db-password-value@database.invalid/billing"
    complete_key_id = "complete_unexpected_key_identifier_123456789"
    key_secret = "razorpay-secret-value-for-test"

    with pytest.raises(MaintenanceConfigurationError) as database_error:
        validate_maintenance_database(
            {"APP_ENV": "production", "DATABASE_URL": unsafe_url}
        )
    with pytest.raises(MaintenanceConfigurationError) as razorpay_error:
        validate_razorpay_configuration(
            {
                "RAZORPAY_MODE": "test",
                "RAZORPAY_KEY_ID": complete_key_id,
                "RAZORPAY_KEY_SECRET": key_secret,
            }
        )

    combined = f"{database_error.value} {razorpay_error.value}"
    for value in (unsafe_url, "db-password-value", complete_key_id, key_secret):
        assert value not in combined


def _create_stale_test_database(database_path: Path) -> tuple[str, str]:
    database_url = f"sqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url, connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(
            firebase_uid="maintenance-user",
            email="maintenance@example.com",
            name="Maintenance User",
        )
        session.add(user)
        session.flush()
        wallet = WalletAccount(
            user_id=int(user.id),
            balance_micros=1_000_000,
            reserved_micros=100_000,
        )
        charge = UsageCharge(
            request_id="maintenance-stale-charge",
            user_id=int(user.id),
            provider="sarvam",
            model="sarvam-30b",
            reserved_micros=100_000,
            status="reserved",
            pricing_snapshot_json='{"reservation_attempt":1}',
            created_at=utc_now().replace(year=2020),
        )
        session.add(wallet)
        session.add(charge)
        session.commit()
        return wallet.id, charge.id


def test_stale_reservations_cli_commits_aged_idempotent_recovery(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "initialized-maintenance.sqlite3"
    wallet_id, charge_id = _create_stale_test_database(database_path)
    env = {
        "APP_ENV": "test",
        "DATABASE_URL": f"sqlite:///{database_path.as_posix()}",
        "BILLING_MAINTENANCE_ALLOW_SQLITE": "true",
    }

    first = _run_cli("stale-reservations", "--age-seconds", "1800", environ=env)
    second = _run_cli("stale-reservations", "--age-seconds", "1800", environ=env)

    assert first.returncode == 0, first.stderr
    assert json.loads(first.stdout) == {"recovered_count": 1}
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout) == {"recovered_count": 0}
    startup = json.loads(first.stderr)
    assert startup == {
        "APP_ENV": "test",
        "command": "stale-reservations",
        "database_backend": "sqlite",
    }
    engine = create_engine(env["DATABASE_URL"])
    with Session(engine) as session:
        assert session.get(UsageCharge, charge_id).status == "released"
        assert session.get(WalletAccount, wallet_id).reserved_micros == 0
        releases = session.exec(
            select(WalletLedger).where(
                WalletLedger.reference_id == charge_id,
                WalletLedger.entry_type == "reservation_release",
            )
        ).all()
        assert len(releases) == 1


def _create_reconciliation_order() -> tuple[int, str, str]:
    user = create_test_user(uid="maintenance-reconcile")
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=int(user.id),
            receipt="maintenance-reconcile-receipt",
            gross_amount_paise=1000,
            credited_amount_micros=5_000_000,
            platform_share_paise=500,
            provider_order_id="order_maintenance_reconcile",
            status="attempted",
            created_at=utc_now().replace(year=2020),
        )
        session.add(order)
        session.commit()
        return int(user.id), order.id, str(order.provider_order_id)


def _configure_local_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("BILLING_MAINTENANCE_ALLOW_SQLITE", "true")
    monkeypatch.setenv("RAZORPAY_MODE", "test")
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_cli")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "cli-provider-secret")


def test_razorpay_cli_dry_run_does_not_mutate_order_wallet_or_ledger(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    user_id, order_id, provider_order_id = _create_reconciliation_order()
    _configure_local_cli(monkeypatch)
    monkeypatch.setattr(
        "app.billing.razorpay_client.RazorpayClient.fetch_order_payments",
        lambda self, order_id: {
            "status": "cli-provider-secret",
            "items": [
                {
                    "id": "pay_maintenance_reconcile",
                    "order_id": provider_order_id,
                    "amount": 1000,
                    "currency": "INR",
                    "status": "mystery",
                },
                {
                    "id": "pay_maintenance_reconcile_captured",
                    "order_id": provider_order_id,
                    "amount": 1000,
                    "currency": "INR",
                    "status": "captured",
                }
            ]
        },
    )

    assert billing_maintenance.main([
        "razorpay", "--internal-order-id", order_id, "--age-seconds", "900",
    ]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.err) == {
        "APP_ENV": "test",
        "apply": False,
        "command": "razorpay",
        "database_backend": "sqlite",
        "max_age_seconds": 2592000,
        "razorpay_mode": "test",
        "summary_only": False,
    }
    safe_output = captured.out
    assert "test@example.com" not in safe_output
    assert "cli-provider-secret" not in safe_output
    assert "pay_maintenance_reconcile" not in safe_output
    assert json.loads(safe_output)["results"][0]["provider_payment_statuses"] == ["captured", "unknown"]

    with SessionLocal() as session:
        assert session.get(PaymentOrder, order_id).status == "attempted"
        assert get_wallet_summary(session, user_id)["balance_micros"] == 0
        assert session.exec(select(WalletLedger)).all() == []

    assert billing_maintenance.main([
        "razorpay", "--age-seconds", "900", "--max-age-seconds", "315360000", "--fail-on-findings",
    ]) == FINDINGS_EXIT_CODE
    capsys.readouterr()
    with SessionLocal() as session:
        assert session.get(PaymentOrder, order_id).status == "attempted"
        assert get_wallet_summary(session, user_id)["balance_micros"] == 0
        assert session.exec(select(WalletLedger)).all() == []


def test_razorpay_info_and_warning_results_do_not_fail(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _user_id, order_id, _provider_order_id = _create_reconciliation_order()
    _configure_local_cli(monkeypatch)
    monkeypatch.setattr(
        "app.billing.razorpay_client.RazorpayClient.fetch_order_payments",
        lambda self, internal_order_id: {"items": []},
    )

    assert billing_maintenance.main([
        "razorpay", "--internal-order-id", order_id, "--fail-on-findings",
    ]) == 0
    warning = json.loads(capsys.readouterr().out)["results"][0]
    assert warning["severity"] == "warning" and warning["actionable"] is False

    with SessionLocal() as session:
        order = session.get(PaymentOrder, order_id)
        order.status = "created"
        session.add(order)
        session.commit()
    assert billing_maintenance.main([
        "razorpay", "--internal-order-id", order_id, "--fail-on-findings",
    ]) == 0
    info = json.loads(capsys.readouterr().out)["results"][0]
    assert info["severity"] == "info" and info["actionable"] is False


def test_invalid_targeted_internal_order_uuid_is_configuration_error(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    supplied = "not-a-valid-private-order-value"
    _configure_local_cli(monkeypatch)
    assert billing_maintenance.main([
        "razorpay", "--internal-order-id", supplied,
    ]) == CONFIGURATION_ERROR_EXIT_CODE
    output = capsys.readouterr()
    assert "--internal-order-id" in output.err
    assert supplied not in output.err


def test_razorpay_cli_apply_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    user_id, order_id, provider_order_id = _create_reconciliation_order()
    _configure_local_cli(monkeypatch)
    monkeypatch.setattr(
        "app.billing.razorpay_client.RazorpayClient.fetch_order_payments",
        lambda self, order_id: {
            "items": [
                {
                    "id": "pay_maintenance_apply",
                    "order_id": provider_order_id,
                    "amount": 1000,
                    "currency": "INR",
                    "status": "captured",
                }
            ]
        },
    )
    monkeypatch.setattr(
        "app.billing.razorpay_client.RazorpayClient.fetch_payment_refunds",
        lambda self, payment_id: {"items": []},
    )

    assert billing_maintenance.main([
        "razorpay", "--age-seconds", "900", "--max-age-seconds", "315360000", "--apply",
    ]) == 0
    assert billing_maintenance.main([
        "razorpay", "--age-seconds", "900", "--max-age-seconds", "315360000", "--apply",
    ]) == 0

    with SessionLocal() as session:
        assert session.get(PaymentOrder, order_id).status == "credited"
        assert get_wallet_summary(session, user_id)["balance_micros"] == 5_000_000
        credits = session.exec(
            select(WalletLedger).where(WalletLedger.entry_type == "payment_credit")
        ).all()
        assert len(credits) == 1


def test_missing_razorpay_configuration_fails_before_database_or_network_access(
    tmp_path: Path,
) -> None:
    isolated = _isolated_backend(tmp_path)
    result = _run_cli(
        "razorpay",
        environ={
            "APP_ENV": "production",
            "DATABASE_URL": "postgresql://configured",
        },
        backend_root=isolated,
        profile_imports=True,
    )

    assert result.returncode == CONFIGURATION_ERROR_EXIT_CODE
    assert "RAZORPAY_MODE" in result.stderr
    assert "RAZORPAY_KEY_ID" in result.stderr
    assert "RAZORPAY_KEY_SECRET" in result.stderr
    assert "app.database\n" not in result.stderr
    assert "requests\n" not in result.stderr
    assert not (isolated / "data").exists()


@pytest.mark.parametrize(
    ("mode", "key_id", "expected_prefix"),
    [
        ("test", "complete_live_style_key_identifier", "rzp_test_"),
        ("live", "complete_test_style_key_identifier", "rzp_live_"),
    ],
)
def test_razorpay_key_prefix_mismatch_fails_before_network_access(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    key_id: str,
    expected_prefix: str,
) -> None:
    network_called = False

    def unexpected_network(*args, **kwargs):
        nonlocal network_called
        network_called = True
        raise AssertionError("network access is prohibited in this test")

    monkeypatch.setattr("requests.request", unexpected_network)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("BILLING_MAINTENANCE_ALLOW_SQLITE", "true")
    monkeypatch.setenv("RAZORPAY_MODE", mode)
    monkeypatch.setenv("RAZORPAY_KEY_ID", key_id)
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "provider-secret-value")

    assert billing_maintenance.main(["razorpay"]) == CONFIGURATION_ERROR_EXIT_CODE
    assert network_called is False
    with pytest.raises(MaintenanceConfigurationError, match=expected_prefix):
        validate_razorpay_configuration(
            {
                "RAZORPAY_MODE": mode,
                "RAZORPAY_KEY_ID": key_id,
                "RAZORPAY_KEY_SECRET": "provider-secret-value",
            }
        )


def test_runtime_exception_rolls_back_and_closes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSession:
        rolled_back = False
        closed = False

        def rollback(self) -> None:
            self.rolled_back = True

        def close(self) -> None:
            self.closed = True

    fake_session = FakeSession()

    def fail_recovery(session, *, age_seconds):
        raise RuntimeError("synthetic maintenance failure")

    monkeypatch.setattr("app.database.SessionLocal", lambda: fake_session)
    monkeypatch.setattr(
        "app.billing.service.recover_stale_usage_reservations", fail_recovery
    )
    args = billing_maintenance._parser().parse_args(["stale-reservations"])

    with pytest.raises(RuntimeError, match="synthetic maintenance failure"):
        billing_maintenance._run_command(args, None)

    assert fake_session.rolled_back is True
    assert fake_session.closed is True
