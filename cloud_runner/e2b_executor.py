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
import shlex
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

    def validate(self) -> None:
        normalized = self.path.replace("\\", "/")
        if not normalized or normalized.startswith("/") or ".." in normalized.split("/") or "\x00" in normalized:
            raise E2BExecutionError("snapshot path is outside the workspace")
        if normalized.startswith((".git/", ".swico/")) or normalized in {".env", ".npmrc", ".pypirc"}:
            raise E2BExecutionError("snapshot contains a protected path")
        if hashlib.sha256(self.data).hexdigest() != self.sha256:
            raise E2BExecutionError("snapshot hash mismatch")


@dataclass(frozen=True)
class E2BSettings:
    api_key: str
    template: str
    runner_command: tuple[str, ...]
    timeout_seconds: int = 300

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "E2BSettings":
        values = environ if environ is not None else os.environ
        api_key = values.get("E2B_API_KEY", "").strip()
        template = values.get("SWICO_E2B_TEMPLATE", "").strip()
        command = values.get("SWICO_RUNNER_AGENT_COMMAND", "").strip()
        if not api_key or not template or not command:
            raise E2BConfigurationError("E2B runner requires E2B_API_KEY, SWICO_E2B_TEMPLATE, and SWICO_RUNNER_AGENT_COMMAND.")
        try:
            runner_command = tuple(shlex.split(command, posix=True))
        except ValueError as exc:
            raise E2BConfigurationError("SWICO_RUNNER_AGENT_COMMAND is malformed.") from exc
        if not runner_command or len(runner_command) > 8 or any(len(item) > 256 for item in runner_command):
            raise E2BConfigurationError("SWICO_RUNNER_AGENT_COMMAND is outside its bound.")
        timeout = int(values.get("SWICO_RUNNER_JOB_TIMEOUT_SECONDS", "300"))
        if not 30 <= timeout <= 1800:
            raise E2BConfigurationError("SWICO_RUNNER_JOB_TIMEOUT_SECONDS must be between 30 and 1800.")
        return cls(api_key=api_key, template=template, runner_command=runner_command, timeout_seconds=timeout)


class E2BExecutor:
    def __init__(self, settings: E2BSettings):
        self.settings = settings

    def execute(self, *, job_id: str, task: str, files: list[SnapshotFile], on_event: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        for item in files:
            item.validate()
        if len(files) > 5_000 or sum(len(item.data) for item in files) > 50 * 1024 * 1024:
            raise E2BExecutionError("snapshot exceeds runner bounds")
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
            for item in files:
                sandbox_path = item.path.replace("\\", "/")
                sandbox.files.write(f"/workspace/{sandbox_path}", item.data, request_timeout=15)
            sandbox.files.write("/workspace/.swico-task.json", json.dumps({"version": 1, "job_id": job_id, "task": task}, separators=(",", ":")), request_timeout=15)
            if on_event:
                on_event({"event_type": "running", "job_id": job_id})
            command = shlex.join([*self.settings.runner_command, "--task-file", "/workspace/.swico-task.json", "--workspace", "/workspace"])
            result = sandbox.commands.run(command, cwd="/workspace", timeout=self.settings.timeout_seconds, request_timeout=self.settings.timeout_seconds + 15)
            output = str(getattr(result, "stdout", ""))[-64 * 1024:]
            error = str(getattr(result, "stderr", ""))[-64 * 1024:]
            status = "completed" if int(getattr(result, "exit_code", 0) or 0) == 0 else "failed"
            return {"status": status, "exit_code": int(getattr(result, "exit_code", 0) or 0), "stdout": output, "stderr": error, "job_id": job_id}
        except Exception as exc:
            raise E2BExecutionError("The isolated Cloud task failed safely.") from exc
        finally:
            if sandbox is not None:
                try:
                    sandbox.kill()
                except Exception:
                    pass


def configured_e2b_executor(environ: Mapping[str, str] | None = None) -> E2BExecutor:
    return E2BExecutor(E2BSettings.from_environment(environ))
