from __future__ import annotations

import time
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from cloud_runner.protocol import CapabilityError, RunnerCapability, runner_readiness, verify_capability
from cloud_runner.snapshot import SnapshotError, create_snapshot_manifest
from cloud_runner.e2b_executor import E2BConfigurationError, E2BSettings, E2BExecutionError, SnapshotFile
from app.cli_api.runner_attestation import make_test_attestation, verify_runner_attestation


def test_runner_capability_is_job_runner_and_time_bound(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_RUNNER_SHARED_SECRET", "synthetic-secret")
    capability = RunnerCapability("job-1", "runner-1", "nonce-1", int(time.time()) + 60, ("claim", "cancel"))
    encoded = capability.encoded()
    assert verify_capability(encoded, job_id="job-1", runner_id="runner-1").nonce == "nonce-1"
    with pytest.raises(CapabilityError):
        verify_capability(encoded, job_id="job-2", runner_id="runner-1")
    with pytest.raises(CapabilityError):
        verify_capability(encoded, job_id="job-1", runner_id="runner-1", now=capability.expires_at)


def test_runner_default_readiness_is_fail_closed(monkeypatch: pytest.MonkeyPatch):
    assert runner_readiness({"SWICO_RUNNER_SHARED_SECRET": "secret"})["ready"] is False


def test_runner_attestation_is_expiring_signed_evidence():
    evidence = make_test_attestation(secret="secret", now=100)
    assert verify_runner_attestation(evidence, secret="secret", now=200)
    assert not verify_runner_attestation(evidence, secret="wrong", now=200)
    assert not verify_runner_attestation(evidence, secret="secret", now=701)


def test_snapshot_manifest_is_bounded_hashed_and_secret_aware():
    with TemporaryDirectory() as root:
        base = Path(root); (base / "src").mkdir(); (base / "src" / "main.py").write_text("print('ok')\n"); (base / ".env").write_text("secret")
        manifest = create_snapshot_manifest(base)
        assert manifest["file_count"] == 1
        assert manifest["files"][0]["path"] == "src/main.py"
        with pytest.raises(SnapshotError): create_snapshot_manifest(base, max_files=0)


def test_e2b_executor_configuration_and_snapshot_bytes_are_bounded():
    settings = E2BSettings.from_environment({
        "E2B_API_KEY": "synthetic", "SWICO_E2B_TEMPLATE": "swico-runner",
        "SWICO_RUNNER_AGENT_COMMAND": "swico-runner --safe",
    })
    assert settings.runner_command == ("swico-runner", "--safe")
    item = SnapshotFile("src/main.py", b"ok", __import__("hashlib").sha256(b"ok").hexdigest())
    item.validate()
    with pytest.raises(E2BExecutionError):
        SnapshotFile("../outside", b"ok", item.sha256).validate()
    with pytest.raises(E2BConfigurationError):
        E2BSettings.from_environment({"E2B_API_KEY": "only-key"})
