from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check-ops-readiness.py"


def complete_data() -> dict[str, object]:
    return {
        "primary_on_call": "synthetic-role-alpha",
        "backup_on_call": "synthetic-role-beta",
        "incident_commander": "synthetic-role-command",
        "checkout_disable_owner": "synthetic-role-checkout",
        "refund_owner": "synthetic-role-refund",
        "ledger_adjustment_approvers": ["synthetic-approver-one", "synthetic-approver-two"],
        "customer_communications_owner": "synthetic-role-comms",
        "razorpay_owner": "synthetic-role-provider",
        "render_database_owner": "synthetic-role-database",
        "incident_channel": "synthetic-private-channel",
        "backup_contact_method": "synthetic-backup-method",
        "acknowledgement_target_minutes": 10,
        "customer_update_target_minutes": 30,
        "evidence_location": "synthetic-private-evidence-store",
        "last_access_tested_at": "2026-07-01T10:00:00+05:30",
        "last_drill_completed_at": "2026-07-02T10:00:00Z",
    }


def run_checker(tmp_path: Path, data: dict[str, object]) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "ops-ownership.json"
    source.write_text(json.dumps(data), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--file", str(source)],
        check=False,
        capture_output=True,
        text=True,
    )


def test_complete_synthetic_file_passes(tmp_path: Path):
    result = run_checker(tmp_path, complete_data())
    assert result.returncode == 0
    assert result.stdout.strip() == "operational readiness check passed"


def test_missing_fields_are_reported_by_name(tmp_path: Path):
    data = complete_data()
    del data["refund_owner"]
    result = run_checker(tmp_path, data)
    assert result.returncode != 0
    assert result.stdout.strip() == "missing: refund_owner"


def test_duplicate_primary_and_backup_are_rejected(tmp_path: Path):
    data = complete_data()
    data["backup_on_call"] = data["primary_on_call"]
    result = run_checker(tmp_path, data)
    assert result.returncode != 0
    assert "invalid: primary_on_call" in result.stdout
    assert "invalid: backup_on_call" in result.stdout


def test_supplied_values_are_never_printed(tmp_path: Path):
    data = complete_data()
    sensitive_synthetic_value = "synthetic-private-value-never-print"
    data["primary_on_call"] = sensitive_synthetic_value
    data["backup_on_call"] = sensitive_synthetic_value
    data["acknowledgement_target_minutes"] = 0
    result = run_checker(tmp_path, data)
    assert result.returncode != 0
    assert sensitive_synthetic_value not in result.stdout
    assert sensitive_synthetic_value not in result.stderr


def test_targets_timestamps_and_two_distinct_approvers_are_validated(tmp_path: Path):
    data = complete_data()
    data["ledger_adjustment_approvers"] = ["synthetic-approver-one", "synthetic-approver-one"]
    data["customer_update_target_minutes"] = -1
    data["last_access_tested_at"] = "not-a-timestamp"
    result = run_checker(tmp_path, data)
    assert result.returncode != 0
    assert set(result.stdout.splitlines()) == {
        "invalid: ledger_adjustment_approvers",
        "invalid: customer_update_target_minutes",
        "invalid: last_access_tested_at",
    }
