from __future__ import annotations

import time
import sys
import base64
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from cloud_runner.protocol import CapabilityError, RunnerCapability, runner_readiness, verify_capability
from cloud_runner.snapshot import SnapshotError, create_snapshot_manifest
from cloud_runner.e2b_executor import E2BConfigurationError, E2BSettings, E2BExecutionError, SnapshotFile
from cloud_runner.controller import CloudController, ControllerConfigurationError, ControllerSettings
from app.cli_api.runner_attestation import make_test_attestation, verify_runner_attestation
from app.cli_api.config import CliConfigurationError, cli_settings


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
    assert not verify_runner_attestation(evidence, secret="secret", now=200, expected={"runner_id": "different-runner"})
    assert not verify_runner_attestation(evidence, secret="secret", now=200, expected={"template_id_or_digest": "different-template"})
    assert not verify_runner_attestation(evidence, secret="wrong", now=200)
    assert not verify_runner_attestation(evidence, secret="secret", now=701)


def test_render_private_http_transport_is_explicit_and_host_pinned():
    common = {
        "SWICO_CLI_ENABLED": "true",
        "SWICO_CLI_AGENT_ENABLED": "true",
        "SWICO_CLI_AGENT_ALLOWED_EMAILS": "pilot@example.test",
        "SWICO_CLI_CLOUD_AGENT_ENABLED": "true",
        "SWICO_CLI_CLOUD_RUNNER_TOKEN": "secret",
        "SWICO_CLI_CLOUD_RUNNER_ID": "runner-1",
        "SWICO_CLI_CLOUD_RUNNER_AUDIENCE": "swico-backend",
        "SWICO_CLI_CLOUD_RUNNER_EXECUTOR": "e2b",
        "SWICO_CLI_CLOUD_TEMPLATE": "template-1",
        "SWICO_CLI_CLOUD_RUNNER_REVISION": "revision-1",
        "SWICO_CLI_CLOUD_POLICY_SHA256": "policy-1",
        "SWICO_CLI_CLOUD_NETWORK_POLICY": "disabled",
    }
    evidence = make_test_attestation(secret="secret", runner_id="runner-1", template_id_or_digest="template-1", runner_revision="revision-1", policy_sha256="policy-1")
    common["SWICO_CLI_CLOUD_RUNNER_ATTESTATION"] = evidence
    https = cli_settings({**common, "SWICO_CLI_CLOUD_RUNNER_URL": "https://runner.example.test"})
    assert https.cloud_runner_configured and https.cloud_runner_handshake
    private = cli_settings({**common, "SWICO_CLI_CLOUD_RUNNER_URL": "http://runner.internal:10000", "SWICO_CLI_CLOUD_RUNNER_TRANSPORT": "render_private_http", "SWICO_CLI_CLOUD_RUNNER_PRIVATE_HOST": "runner.internal"})
    assert private.cloud_runner_transport == "render_private_http"
    with pytest.raises(CliConfigurationError): cli_settings({**common, "SWICO_CLI_CLOUD_RUNNER_URL": "http://runner.example.test"})
    with pytest.raises(CliConfigurationError): cli_settings({**common, "SWICO_CLI_CLOUD_RUNNER_URL": "https://user:password@runner.example.test"})
    with pytest.raises(CliConfigurationError): cli_settings({**common, "SWICO_CLI_CLOUD_RUNNER_URL": "http://other.internal:10000", "SWICO_CLI_CLOUD_RUNNER_TRANSPORT": "render_private_http", "SWICO_CLI_CLOUD_RUNNER_PRIVATE_HOST": "runner.internal"})


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
    })
    assert not hasattr(settings, "runner_command")
    item = SnapshotFile("src/main.py", b"ok", __import__("hashlib").sha256(b"ok").hexdigest())
    item.validate()
    with pytest.raises(E2BExecutionError):
        SnapshotFile("../outside", b"ok", item.sha256).validate()
    SnapshotFile("empty.txt", b"", __import__("hashlib").sha256(b"").hexdigest()).validate()
    with pytest.raises(E2BExecutionError):
        SnapshotFile(".swico-task.json", b"ok", item.sha256).validate()
    with pytest.raises(E2BConfigurationError): E2BSettings.from_environment({"E2B_API_KEY": "only-key"})


def test_controller_executes_only_task_jobs_and_reports_terminal_result():
    calls: list[tuple[str, str, dict | None, dict[str, str]]] = []

    def transport(method: str, url: str, body: dict | None, headers: dict[str, str]) -> dict:
        calls.append((method, url, body, headers))
        if url.endswith("/cloud/runner/jobs/claim"):
            return {"job": {"id": "job-1", "source": "task_only", "task": "run the bounded task"}, "runner_url": "https://runner.example.test", "runner_capability": "capability"}
        if url.endswith("/v1/jobs/job-1/execute"):
            assert headers["X-Swico-Runner-Capability"] == "capability"
            assert body == {"task": "run the bounded task", "files": [], "actions": []}
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


def test_controller_uploads_structured_artifacts_before_terminal_result():
    patch = b"diff --git a/main.py b/main.py\n"
    terminal: dict | None = None
    calls: list[str] = []

    def transport(method: str, url: str, body: dict | None, headers: dict[str, str]) -> dict:
        calls.append(url)
        if url.endswith("/cloud/runner/jobs/claim"):
            return {"job": {"id": "job-artifact", "source": "task_only", "task": "repair", "actions": [{"type": "read", "path": "main.py"}]}, "runner_url": "https://runner.example.test", "runner_capability": "capability"}
        if url.endswith("/v1/jobs/job-artifact/execute"):
            return {"status": "completed", "exit_code": 0, "result": {"protocol": "swico-cloud-result-v1", "summary": "repaired", "artifacts": [{"kind": "patch", "content_type": "text/x-diff", "content_base64": base64.b64encode(patch).decode(), "sha256": hashlib.sha256(patch).hexdigest()}]}}
        if url.endswith("/cloud/runner/jobs/job-artifact/artifacts"):
            assert body is not None and "content_base64" in body
            return {"id": "artifact-1", "kind": "patch", "sha256": body["sha256"], "size_bytes": len(patch)}
        if url.endswith("/cloud/runner/jobs/job-artifact/result"):
            nonlocal terminal
            terminal = body
            return {"status": "completed"}
        raise AssertionError(url)

    result = CloudController(ControllerSettings("https://api.example.test", "runner-1", "secret"), transport).run_once()
    assert result is not None and result["status"] == "completed"
    assert terminal is not None
    assert terminal["result"]["artifacts"] == [{"id": "artifact-1", "kind": "patch", "sha256": hashlib.sha256(patch).hexdigest(), "size_bytes": len(patch)}]
    assert "content_base64" not in json.dumps(terminal)
    assert calls.index("https://api.example.test/api/cli/v1/cloud/runner/jobs/job-artifact/artifacts") < calls.index("https://api.example.test/api/cli/v1/cloud/runner/jobs/job-artifact/result")


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
