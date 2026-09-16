"""Small, dependency-free runner capability and isolation contracts.

This module deliberately contains no end-user authentication and no API-local
repository execution. A deployed runner receives a short-lived capability for
one job and must provide a verified OS isolation backend before it can run it.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import os
import time
from typing import Any


class CapabilityError(ValueError):
    pass


@dataclass(frozen=True)
class RunnerCapability:
    job_id: str
    runner_id: str
    nonce: str
    expires_at: int
    actions: tuple[str, ...]

    def encoded(self) -> str:
        body = json.dumps({
            "job_id": self.job_id, "runner_id": self.runner_id,
            "nonce": self.nonce, "expires_at": self.expires_at,
            "actions": list(self.actions),
        }, separators=(",", ":"), sort_keys=True)
        secret = os.environ.get("SWICO_RUNNER_SHARED_SECRET", "").encode()
        if not secret:
            raise CapabilityError("runner shared secret is not configured")
        signature = hmac.new(secret, body.encode(), hashlib.sha256).hexdigest()
        return f"{body}.{signature}"


def verify_capability(value: str, *, job_id: str, runner_id: str, now: int | None = None) -> RunnerCapability:
    if not value or len(value) > 16_384:
        raise CapabilityError("capability is missing or oversized")
    try:
        body, signature = value.rsplit(".", 1)
        data = json.loads(body)
        capability = RunnerCapability(
            job_id=str(data["job_id"]), runner_id=str(data["runner_id"]),
            nonce=str(data["nonce"]), expires_at=int(data["expires_at"]),
            actions=tuple(str(item) for item in data["actions"]),
        )
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise CapabilityError("capability is malformed") from exc
    secret = os.environ.get("SWICO_RUNNER_SHARED_SECRET", "").encode()
    if not secret or not hmac.compare_digest(signature, hmac.new(secret, body.encode(), hashlib.sha256).hexdigest()):
        raise CapabilityError("capability signature is invalid")
    if capability.job_id != job_id or capability.runner_id != runner_id:
        raise CapabilityError("capability is bound to another job or runner")
    if capability.expires_at <= (int(time.time()) if now is None else now):
        raise CapabilityError("capability has expired")
    if not capability.nonce or len(capability.actions) > 16:
        raise CapabilityError("capability bounds are invalid")
    return capability


def runner_readiness(environ: dict[str, str] | None = None) -> dict[str, Any]:
    values = environ if environ is not None else os.environ
    backend = values.get("SWICO_RUNNER_ISOLATION_BACKEND", "").strip().lower()
    shared_secret = bool(values.get("SWICO_RUNNER_SHARED_SECRET", "").strip())
    # bwrap is checked by the service process before advertising readiness.
    return {
        "configured_backend": backend or None,
        "runner_auth_configured": shared_secret,
        "isolation_verified": False,
        "ready": False,
        "reason": "native hostile verification has not been completed",
    }
