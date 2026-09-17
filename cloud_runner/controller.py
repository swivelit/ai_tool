"""Durable Swico Cloud controller.

This process is intentionally separate from both the Render API and the
isolated executor. It claims one leased job from the API, forwards only the
job-scoped capability and bounded task input to the private runner, renews the
lease while the runner works, and reports one terminal result. It never opens
or executes a repository on the controller host.

The first connected path supports ``task_only`` jobs. Repository snapshots are
rejected until a byte-transfer endpoint is configured; a manifest alone is not
treated as a repository.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from threading import Event, Thread
import time
from typing import Any, Callable
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class ControllerConfigurationError(RuntimeError):
    pass


def _safe_url(value: str, *, allow_http_localhost: bool = False) -> str:
    parsed = urlparse(value.strip().rstrip("/"))
    allowed_http = allow_http_localhost and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if parsed.scheme != "https" and not allowed_http:
        raise ControllerConfigurationError("Cloud controller URLs must use HTTPS.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.netloc:
        raise ControllerConfigurationError("Cloud controller URL contains unsupported components.")
    return value.strip().rstrip("/")


@dataclass(frozen=True)
class ControllerSettings:
    backend_url: str
    runner_id: str
    runner_token: str
    poll_seconds: float = 5.0
    heartbeat_seconds: float = 20.0

    @classmethod
    def from_environment(cls, environ: dict[str, str] | None = None) -> "ControllerSettings":
        values = environ if environ is not None else os.environ
        backend_url = values.get("SWICO_RUNNER_CONTROL_URL", "").strip()
        runner_id = values.get("SWICO_RUNNER_ID", "").strip()
        token = values.get("SWICO_RUNNER_CONTROL_TOKEN", values.get("SWICO_CLI_CLOUD_RUNNER_TOKEN", "")).strip()
        if not backend_url or not runner_id or not token:
            raise ControllerConfigurationError("SWICO_RUNNER_CONTROL_URL, SWICO_RUNNER_ID, and runner token are required.")
        return cls(
            backend_url=_safe_url(backend_url, allow_http_localhost=True),
            runner_id=runner_id[:128],
            runner_token=token,
            poll_seconds=max(1.0, min(60.0, float(values.get("SWICO_RUNNER_POLL_SECONDS", "5")))),
            heartbeat_seconds=max(5.0, min(60.0, float(values.get("SWICO_RUNNER_HEARTBEAT_SECONDS", "20")))),
        )


Transport = Callable[[str, str, dict[str, Any] | None, dict[str, str]], dict[str, Any]]
MAX_CONTROL_RESPONSE = 80 * 1024 * 1024


def _urllib_transport(method: str, url: str, body: dict[str, Any] | None, headers: dict[str, str]) -> dict[str, Any]:
    encoded = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = Request(url, data=encoded, headers={"Accept": "application/json", "Content-Type": "application/json", **headers}, method=method)
    # Runner execution can outlive a normal control request, while an
    # explicitly consented snapshot can approach the 50 MiB decoded bound.
    # Read a bounded complete response and reject oversize JSON instead of
    # silently accepting a truncated document.
    timeout = 1_900 if "/v1/jobs/" in url and method == "POST" else 45
    with urlopen(request, timeout=timeout) as response:
        raw = response.read(MAX_CONTROL_RESPONSE + 1)
    if len(raw) > MAX_CONTROL_RESPONSE:
        raise RuntimeError("Cloud control response exceeds the supported bound.")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("Cloud control response was not an object.")
    return parsed


class CloudController:
    def __init__(self, settings: ControllerSettings, transport: Transport = _urllib_transport):
        self.settings = settings
        self.transport = transport

    def _control(self, method: str, path: str, body: dict[str, Any] | None = None, capability: str | None = None) -> dict[str, Any]:
        headers = {
            "X-Swico-Runner-Id": self.settings.runner_id,
            "X-Swico-Runner-Token": self.settings.runner_token,
        }
        if capability:
            headers["X-Swico-Runner-Capability"] = capability
        return self.transport(method, f"{self.settings.backend_url}/api/cli/v1{path}", body, headers)

    def _runner(self, method: str, runner_url: str, path: str, capability: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.transport(method, f"{runner_url.rstrip('/')}{path}", body, {"X-Swico-Runner-Capability": capability})

    def run_once(self) -> dict[str, Any] | None:
        claimed = self._control("POST", "/cloud/runner/jobs/claim", {})
        job = claimed.get("job")
        if not isinstance(job, dict):
            return None
        job_id = str(job.get("id") or "")
        runner_url = str(claimed.get("runner_url") or "")
        capability = str(claimed.get("runner_capability") or "")
        if not job_id or not capability or not runner_url:
            raise RuntimeError("The control plane returned an incomplete runner lease.")
        _safe_url(runner_url)
        source = str(job.get("source") or "")
        snapshot = claimed.get("snapshot")
        files = snapshot.get("files") if isinstance(snapshot, dict) else None
        if source != "task_only" and not isinstance(files, list):
            # A manifest or host path is not a snapshot. Marking this failed is
            # safer than asking an executor to guess what the repository was.
            result = {"status": "failed", "failure_code": "snapshot_transfer_unavailable", "result": {"job_id": job_id}}
            self._control("POST", f"/cloud/runner/jobs/{job_id}/result", result, capability)
            return result

        stop = Event()
        heartbeat_error: list[BaseException] = []
        cancellation_forwarded = Event()

        def heartbeat() -> None:
            while not stop.wait(self.settings.heartbeat_seconds):
                try:
                    heartbeat_result = self._control("POST", f"/cloud/runner/jobs/{job_id}/heartbeat", capability=capability)
                    if heartbeat_result.get("status") == "cancelling" and not cancellation_forwarded.is_set():
                        self._runner("POST", runner_url, f"/v1/jobs/{job_id}/cancel", capability)
                        cancellation_forwarded.set()
                except BaseException as exc:  # surfaced after execution; never silently renew a lost lease
                    heartbeat_error.append(exc)
                    # Once the controller loses lease authority, stop the
                    # live sandbox immediately. The execution result is then
                    # reconciled as a bounded failure; it is never retried
                    # automatically because the side effect may have run.
                    try:
                        self._runner("POST", runner_url, f"/v1/jobs/{job_id}/cancel", capability)
                    except Exception:
                        pass
                    return

        thread = Thread(target=heartbeat, name=f"swico-cloud-heartbeat-{job_id}", daemon=True)
        thread.start()
        try:
            execution = self._runner("POST", runner_url, f"/v1/jobs/{job_id}/execute", capability, {"task": str(job.get("task") or ""), "files": files if isinstance(files, list) else []})
            status = "cancelled" if cancellation_forwarded.is_set() else ("completed" if execution.get("status") == "completed" else "failed")
            failure = None if status == "completed" else ("cancelled" if status == "cancelled" else str(execution.get("failure_code") or "runner_execution_failed")[:64])
            result = {"status": status, "failure_code": failure, "result": {"job_id": job_id, "exit_code": execution.get("exit_code"), "stdout": str(execution.get("stdout") or "")[-64 * 1024:], "stderr": str(execution.get("stderr") or "")[-64 * 1024:]}}
            if heartbeat_error:
                result = {"status": "failed", "failure_code": "lease_renewal_failed", "result": {"job_id": job_id}}
            self._control("POST", f"/cloud/runner/jobs/{job_id}/result", result, capability)
            return result
        except Exception:
            # The runner may have executed before the response was lost. The
            # controller reports a bounded failure and never retries the side
            # effect automatically; lease recovery is the control plane's job.
            result = {"status": "cancelled" if cancellation_forwarded.is_set() else "failed", "failure_code": "cancelled" if cancellation_forwarded.is_set() else "runner_transport_unknown", "result": {"job_id": job_id}}
            try:
                self._control("POST", f"/cloud/runner/jobs/{job_id}/result", result, capability)
            except Exception:
                pass
            return result
        finally:
            stop.set()
            thread.join(timeout=2)

    def serve_forever(self) -> None:
        while True:
            result = self.run_once()
            if result is None:
                time.sleep(self.settings.poll_seconds)


def main() -> None:
    CloudController(ControllerSettings.from_environment()).serve_forever()


if __name__ == "__main__":
    main()
