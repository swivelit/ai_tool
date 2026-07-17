from pathlib import Path

import pytest

from scripts import verify_restore
from scripts.verify_restore import RestoreConfigurationError, validate_restore_environment


def test_restore_refuses_production_and_non_postgres():
    with pytest.raises(RestoreConfigurationError, match="production"):
        validate_restore_environment({"APP_ENV":"production", "RESTORE_DRILL_CONFIRMATION":"disposable", "DATABASE_URL":"postgresql://example"})
    with pytest.raises(RestoreConfigurationError, match="PostgreSQL"):
        validate_restore_environment({"APP_ENV":"staging", "RESTORE_DRILL_CONFIRMATION":"disposable", "DATABASE_URL":"sqlite:///restore.db"})


def test_restore_requires_disposable_confirmation():
    with pytest.raises(RestoreConfigurationError, match="disposable"):
        validate_restore_environment({"APP_ENV":"staging", "DATABASE_URL":"postgresql://example"})


def test_restore_accepts_staging_or_test_postgres_without_exposing_url():
    configured = validate_restore_environment({
        "APP_ENV":"staging", "RESTORE_DRILL_CONFIRMATION":"disposable",
        "DATABASE_URL":"postgresql://restore-probe.invalid/db",
    })
    assert configured.app_env == "staging"
    assert "restore-probe.invalid" not in repr(configured)


def test_restore_main_reports_invariants_without_database_url(monkeypatch, capsys):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("RESTORE_DRILL_CONFIRMATION", "disposable")
    monkeypatch.setenv("DATABASE_URL", "postgresql://restore-probe.invalid/db")
    monkeypatch.setattr(verify_restore, "verify_restore", lambda config: {
        "read_only": True, "row_counts": {"user": 2}, "invariant_counts": {}, "failures": [],
    })
    assert verify_restore.main([]) == 0
    assert "restore-probe.invalid" not in capsys.readouterr().out


def test_restore_verifier_contains_no_mutating_sql():
    source = (Path(__file__).resolve().parents[1] / "scripts" / "verify_restore.py").read_text(encoding="utf-8").lower()
    for statement in ("insert into", "update ", "delete from", "drop table", "alter table", "create table"):
        assert statement not in source
