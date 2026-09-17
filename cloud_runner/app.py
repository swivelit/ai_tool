"""Deployable control boundary for an isolated Swico Cloud runner.

The service includes an opt-in E2B executor, but remains fail-closed until a
separately reviewed runner has fresh signed native/container verification.
"""
from __future__ import annotations

import os
import base64
import threading
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .protocol import CapabilityError, runner_readiness, verify_capability
from .e2b_executor import E2BConfigurationError, E2BExecutionError, SnapshotFile, configured_e2b_executor

app = FastAPI(title="Swico Cloud Runner", docs_url=None, redoc_url=None)
_consumed_actions: set[tuple[str, str]] = set()
_consumed_actions_lock = threading.Lock()
_active_executors: dict[str, object] = {}
_active_executors_lock = threading.Lock()


class SnapshotFileInput(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    # Empty files are valid repository contents. The decoded byte and total
    # snapshot bounds are enforced by E2BExecutor after validation.
    data_base64: str = Field(min_length=0, max_length=8 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ExecuteRequest(BaseModel):
    task: str = Field(min_length=1, max_length=8_000)
    files: list[SnapshotFileInput] = Field(default_factory=list, max_length=5_000)


@app.get("/health")
def health() -> dict[str, object]:
    readiness = runner_readiness()
    return {"service": "swico-cloud-runner", **readiness}


def _capability(job_id: str, value: str | None, required_action: str, *, consume: bool = False):
    runner_id = os.environ.get("SWICO_RUNNER_ID", "").strip()
    if not runner_id or not value:
        raise HTTPException(503, {"code": "runner_not_ready", "message": "Runner authentication is not configured."})
    try:
        capability = verify_capability(value, job_id=job_id, runner_id=runner_id)
        if required_action not in capability.actions:
            raise CapabilityError("capability does not authorize this action")
        if consume:
            key = (capability.nonce, required_action)
            with _consumed_actions_lock:
                if key in _consumed_actions:
                    raise CapabilityError("capability action has already been consumed")
                # Keep bounded in-process replay state. Durable attempt fencing
                # remains the backend's authority after a runner restart.
                if len(_consumed_actions) >= 4096:
                    _consumed_actions.clear()
                _consumed_actions.add(key)
        return capability
    except CapabilityError as exc:
        raise HTTPException(403, {"code": "invalid_runner_capability", "message": str(exc)}) from exc


@app.post("/v1/jobs/{job_id}/claim")
def claim(job_id: str, capability: str | None = Header(default=None, alias="X-Swico-Runner-Capability")):
    _capability(job_id, capability, "claim")
    readiness = runner_readiness()
    if not readiness["ready"]:
        raise HTTPException(503, {"code": "runner_isolation_unverified", "message": "The runner has not passed native isolation verification."})
    if os.environ.get("SWICO_RUNNER_EXECUTOR", "").strip().lower() != "e2b":
        raise HTTPException(501, {"code": "runner_executor_not_installed", "message": "No reviewed job executor is installed."})
    return {"job_id": job_id, "status": "claimed", "executor": "e2b"}


@app.post("/v1/jobs/{job_id}/execute")
def execute(job_id: str, payload: ExecuteRequest, capability: str | None = Header(default=None, alias="X-Swico-Runner-Capability")):
    """Execute only through an explicitly selected isolated adapter.

    The endpoint accepts bounded snapshot bytes from the controller, never a
    host path or arbitrary shell command. Readiness remains fail-closed until
    signed native verification evidence is current.
    """
    _capability(job_id, capability, "execute", consume=True)
    if os.environ.get("SWICO_RUNNER_EXECUTOR", "").strip().lower() != "e2b":
        raise HTTPException(501, {"code": "runner_executor_not_installed", "message": "No reviewed job executor is installed."})
    if not runner_readiness()["ready"]:
        raise HTTPException(503, {"code": "runner_isolation_unverified", "message": "The runner has not passed native isolation verification."})
    try:
        files = [SnapshotFile(path=item.path, data=base64.b64decode(item.data_base64, validate=True), sha256=item.sha256) for item in payload.files]
        executor = configured_e2b_executor()
        with _active_executors_lock:
            _active_executors[job_id] = executor
        try:
            return executor.execute(job_id=job_id, task=payload.task, files=files)
        finally:
            with _active_executors_lock:
                _active_executors.pop(job_id, None)
    except (ValueError, E2BConfigurationError, E2BExecutionError) as exc:
        raise HTTPException(422, {"code": "invalid_runner_input", "message": str(exc)}) from exc


@app.post("/v1/jobs/{job_id}/cancel")
def cancel(job_id: str, capability: str | None = Header(default=None, alias="X-Swico-Runner-Capability")):
    _capability(job_id, capability, "cancel")
    with _active_executors_lock:
        executor = _active_executors.get(job_id)
    cancelled = bool(executor and getattr(executor, "cancel", lambda _job_id: False)(job_id))
    return {"job_id": job_id, "accepted": cancelled, "status": "cancelling" if cancelled else "not_running"}
