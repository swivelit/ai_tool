"""Deployable control boundary for a future isolated Swico Cloud runner.

The default service is intentionally not ready. It exposes health and a
capability-checked job boundary, but refuses execution until a separately
reviewed native/container executor has completed hostile verification.
"""
from __future__ import annotations

import os
from fastapi import FastAPI, Header, HTTPException

from .protocol import CapabilityError, runner_readiness, verify_capability

app = FastAPI(title="Swico Cloud Runner", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict[str, object]:
    readiness = runner_readiness()
    return {"service": "swico-cloud-runner", **readiness}


def _capability(job_id: str, value: str | None):
    runner_id = os.environ.get("SWICO_RUNNER_ID", "").strip()
    if not runner_id or not value:
        raise HTTPException(503, {"code": "runner_not_ready", "message": "Runner authentication is not configured."})
    try:
        return verify_capability(value, job_id=job_id, runner_id=runner_id)
    except CapabilityError as exc:
        raise HTTPException(403, {"code": "invalid_runner_capability", "message": str(exc)}) from exc


@app.post("/v1/jobs/{job_id}/claim")
def claim(job_id: str, capability: str | None = Header(default=None, alias="X-Swico-Runner-Capability")):
    _capability(job_id, capability)
    readiness = runner_readiness()
    if not readiness["ready"]:
        raise HTTPException(503, {"code": "runner_isolation_unverified", "message": "The runner has not passed native isolation verification."})
    # A verified executor is intentionally injected at deployment time. This
    # service never accepts an arbitrary command from the network.
    raise HTTPException(501, {"code": "runner_executor_not_installed", "message": "No reviewed job executor is installed."})


@app.post("/v1/jobs/{job_id}/cancel")
def cancel(job_id: str, capability: str | None = Header(default=None, alias="X-Swico-Runner-Capability")):
    _capability(job_id, capability)
    return {"job_id": job_id, "accepted": True, "status": "cancelling"}
