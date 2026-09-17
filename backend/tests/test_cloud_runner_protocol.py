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
from cloud_runner.controller import CloudController, ControllerConfigurationError, ControllerSettings
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
    SnapshotFile("empty.txt", b"", __import__("hashlib").sha256(b"").hexdigest()).validate()
    with pytest.raises(E2BExecutionError):
        SnapshotFile(".swico-task.json", b"ok", item.sha256).validate()
    with pytest.raises(E2BConfigurationError):
        E2BSettings.from_environment({"E2B_API_KEY": "only-key"})


def test_controller_executes_only_task_jobs_and_reports_terminal_result():
    calls: list[tuple[str, str, dict | None, dict[str, str]]] = []

    def transport(method: str, url: str, body: dict | None, headers: dict[str, str]) -> dict:
        calls.append((method, url, body, headers))
        if url.endswith("/cloud/runner/jobs/claim"):
            return {"job": {"id": "job-1", "source": "task_only", "task": "run the bounded task"}, "runner_url": "https://runner.example.test", "runner_capability": "capability"}
        if url.endswith("/v1/jobs/job-1/execute"):
            assert headers["X-Swico-Runner-Capability"] == "capability"
            assert body == {"task": "run the bounded task", "files": []}
            return {"status": "completed", "exit_code": 0, "stdout": "ok", "stderr": ""}
        if url.endswith("/cloud/runner/jobs/job-1/result"):
            return {"status": "completed"}
        raise AssertionError(url)

    controller = CloudController(ControllerSettings("https://api.example.test", "runner-1", "secret"), transport)
    assert controller.run_once() == {"status": "completed", "failure_code": None, "result": {"job_id": "job-1", "exit_code": 0, "stdout": "ok", "stderr": ""}}
    assert [call[1] for call in calls] == [
        "https://api.example.test/api/cli/v1/cloud/runner/jobs/claim",
        "https://runner.example.test/v1/jobs/job-1/execute",
        "https://api.example.test/api/cli/v1/cloud/runner/jobs/job-1/result",
    ]


def test_controller_rejects_non_https_configuration_and_snapshot_job_without_bytes():
    with pytest.raises(ControllerConfigurationError):
        ControllerSettings.from_environment({"SWICO_RUNNER_CONTROL_URL": "http://api.example.test", "SWICO_RUNNER_ID": "r", "SWICO_RUNNER_CONTROL_TOKEN": "x"})

    calls: list[tuple[str, str, dict | None, dict[str, str]]] = []
    def transport(method: str, url: str, body: dict | None, headers: dict[str, str]) -> dict:
        calls.append((method, url, body, headers))
        if url.endswith("/cloud/runner/jobs/claim"):
            return {"job": {"id": "job-2", "source": "workspace_snapshot", "task": "inspect"}, "runner_url": "https://runner.example.test", "runner_capability": "capability"}
        return {"status": "failed"}
    result = CloudController(ControllerSettings("https://api.example.test", "runner-1", "secret"), transport).run_once()
    assert result == {"status": "failed", "failure_code": "snapshot_transfer_unavailable", "result": {"job_id": "job-2"}}
    assert len(calls) == 2
