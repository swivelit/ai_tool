"""Opt-in E2B executor for one-job Swico Cloud sandboxes.

The adapter is deliberately not selected by default. It accepts only bytes
already validated by the controller, writes them below /workspace, runs a
preinstalled Swico runner command with a task file, and destroys the sandbox in
all paths. It never receives Swico refresh tokens or provider credentials.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Callable, Mapping


class E2BConfigurationError(RuntimeError):
    pass


class E2BExecutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class SnapshotFile:
    path: str
    data: bytes
    sha256: str

    @property
    def normalized_path(self) -> str:
        return self.path.replace("\\", "/")

    def validate(self) -> None:
        normalized = self.normalized_path
        if not normalized or normalized.startswith(("/", "//")) or ".." in normalized.split("/") or "\x00" in normalized:
            raise E2BExecutionError("snapshot path is outside the workspace")
        parts = normalized.split("/")
        if normalized == ".swico-task.json" or normalized.startswith((".git/", ".swico/")) or normalized in {".git", ".swico", ".env", ".npmrc", ".pypirc"} or any(part.lower().startswith(".env.") for part in parts):
            raise E2BExecutionError("snapshot contains a protected path")
        if hashlib.sha256(self.data).hexdigest() != self.sha256:
            raise E2BExecutionError("snapshot hash mismatch")


@dataclass(frozen=True)
class E2BSettings:
    api_key: str
    template: str
    timeout_seconds: int = 300

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "E2BSettings":
        values = environ if environ is not None else os.environ
        api_key = values.get("E2B_API_KEY", "").strip()
        template = values.get("SWICO_E2B_TEMPLATE", "").strip()
        if not api_key or not template:
            raise E2BConfigurationError("E2B runner requires E2B_API_KEY and SWICO_E2B_TEMPLATE.")
        timeout = int(values.get("SWICO_RUNNER_JOB_TIMEOUT_SECONDS", "300"))
        if not 30 <= timeout <= 1800:
            raise E2BConfigurationError("SWICO_RUNNER_JOB_TIMEOUT_SECONDS must be between 30 and 1800.")
        return cls(api_key=api_key, template=template, timeout_seconds=timeout)


class E2BExecutor:
    def __init__(self, settings: E2BSettings):
        self.settings = settings
        self._active: dict[str, Any] = {}
        self._active_lock = threading.Lock()

    def cancel(self, job_id: str) -> bool:
        """Request termination of the sandbox currently executing one job."""
        with self._active_lock:
            sandbox = self._active.get(job_id)
        if sandbox is None:
            return False
        try:
            sandbox.kill()
            return True
        except Exception:
            return False

    def execute(self, *, job_id: str, task: str, files: list[SnapshotFile], actions: list[dict[str, Any]] | None = None, on_event: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        for item in files:
            item.validate()
        if len(files) > 5_000 or sum(len(item.data) for item in files) > 50 * 1024 * 1024:
            raise E2BExecutionError("snapshot exceeds runner bounds")
        normalized_paths = [item.normalized_path for item in files]
        if len(set(normalized_paths)) != len(normalized_paths):
            raise E2BExecutionError("snapshot contains duplicate paths")
        if not task.strip() or len(task) > 8_000:
            raise E2BExecutionError("task is outside runner bounds")
        try:
            from e2b import Sandbox
        except ImportError as exc:
            raise E2BConfigurationError("The pinned E2B SDK is not installed on this runner.") from exc

        sandbox = None
        try:
            # E2B's secure sandbox and disabled internet mode are deliberate;
            # the task runner must obtain any model result through Swico's
            # control-plane contract, not inherited provider credentials.
            sandbox = Sandbox.create(
                template=self.settings.template,
                timeout=self.settings.timeout_seconds,
                metadata={"swico_job_id": job_id},
                envs={"HOME": "/tmp/swico-home", "PATH": "/usr/local/bin:/usr/bin:/bin"},
                secure=True,
                allow_internet_access=False,
            )
            with self._active_lock:
                self._active[job_id] = sandbox
            for item in files:
                sandbox_path = item.normalized_path
                sandbox.files.write(f"/workspace/{sandbox_path}", item.data, request_timeout=15)
            sandbox.files.write("/workspace/.swico-task.json", json.dumps({"version": 2, "job_id": job_id, "task": task, "actions": actions or []}, separators=(",", ":")), request_timeout=15)
            if on_event:
                on_event({"event_type": "running", "job_id": job_id})
            # Transfer the exact reviewed runner module from this controller
            # build into the disposable sandbox. This keeps the template
            # reproducible without depending on an unexplained executable
            # installed by an operator, while the module receives no Swico or
            # provider credentials. It lives outside the repository so task
            # actions cannot alter the execution code.
            agent_source = Path(__file__).with_name("swico_cloud_agent.py").read_bytes()
            sandbox.files.write("/tmp/swico-cloud-agent.py", agent_source, request_timeout=15)
            command = "python /tmp/swico-cloud-agent.py --task-file /workspace/.swico-task.json --workspace /workspace"
            result = sandbox.commands.run(command, cwd="/workspace", timeout=self.settings.timeout_seconds, request_timeout=self.settings.timeout_seconds + 15)
            output = str(getattr(result, "stdout", ""))[-64 * 1024:]
            error = str(getattr(result, "stderr", ""))[-64 * 1024:]
            status = "completed" if int(getattr(result, "exit_code", 0) or 0) == 0 else "failed"
            structured: dict[str, Any] = {}
            try:
                raw_result = sandbox.files.read("/workspace/.swico-result.json")
                candidate = json.loads(raw_result.decode("utf-8") if isinstance(raw_result, bytes) else str(raw_result))
                if isinstance(candidate, dict) and candidate.get("protocol") == "swico-cloud-result-v1": structured = candidate
            except Exception:
                pass
            for line in reversed(output.splitlines()):
                try:
                    candidate = json.loads(line)
                    if isinstance(candidate, dict) and candidate.get("protocol") == "swico-cloud-result-v1" and not structured: structured = candidate; break
                except json.JSONDecodeError:
                    continue
            return {"status": status, "exit_code": int(getattr(result, "exit_code", 0) or 0), "stdout": output, "stderr": error, "job_id": job_id, "result": structured}
        except Exception as exc:
            raise E2BExecutionError("The isolated Cloud task failed safely.") from exc
        finally:
            with self._active_lock:
                self._active.pop(job_id, None)
            if sandbox is not None:
                try:
                    sandbox.kill()
                except Exception:
                    pass


def configured_e2b_executor(environ: Mapping[str, str] | None = None) -> E2BExecutor:
    return E2BExecutor(E2BSettings.from_environment(environ))
