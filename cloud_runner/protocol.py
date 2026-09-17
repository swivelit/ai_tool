"""Small, dependency-free runner capability and isolation contracts.

This module deliberately contains no end-user authentication and no API-local
repository execution. A deployed runner receives a short-lived capability for
one job and must provide a verified OS isolation backend before it can run it.
"""
from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any


def _decode_attestation(value: str, secret: str, now: int | None = None) -> bool:
    """Verify runner-local evidence without treating a boolean as proof."""
    if not value or len(value) > 16_384 or not secret:
        return False
    try:
        encoded, signature = value.split(".", 1)
        body = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        supplied = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        expected = hmac.new(secret.encode(), body, hashlib.sha256).digest()
        data = json.loads(body)
        current = int(time.time()) if now is None else now
        return bool(
            hmac.compare_digest(supplied, expected)
            and str(data.get("runner_id", ""))
            and str(data.get("isolation", "")) in {"e2b", "bubblewrap", "sandbox-exec"}
            and int(data["verified_at"]) <= current < int(data["expires_at"])
            and int(data["expires_at"]) - int(data["verified_at"]) <= 900
        )
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeError):
        return False


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
    attestation = values.get("SWICO_RUNNER_ISOLATION_ATTESTATION", "").strip()
    evidence_verified = _decode_attestation(attestation, values.get("SWICO_RUNNER_SHARED_SECRET", ""))
    # The attestation is produced only after the selected runner's native
    # hostile verification. A legacy readiness boolean is deliberately ignored.
    return {
        "configured_backend": backend or None,
        "runner_auth_configured": shared_secret,
        "isolation_verified": evidence_verified,
        "ready": bool(shared_secret and backend and evidence_verified),
        "reason": "verified isolation evidence is current" if evidence_verified else "native hostile verification evidence is missing or expired",
    }
