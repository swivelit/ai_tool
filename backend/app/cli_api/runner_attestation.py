"""Short-lived, signed evidence that a cloud runner passed its own checks.

The backend must not treat an operator-set boolean as proof of isolation.  A
runner health process creates this compact attestation after its native
verification and signs it with the job-control secret.  The API only accepts
fresh, bounded evidence and never exposes its contents to clients.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_runner_attestation(
    value: str,
    *,
    secret: str,
    now: int | None = None,
    max_age_seconds: int = 900,
) -> bool:
    """Return true only for bounded, signed, unexpired isolation evidence."""
    if not value or len(value) > 16_384 or not secret:
        return False
    try:
        encoded_body, signature = value.split(".", 1)
        body = _unb64(encoded_body)
        expected = hmac.new(secret.encode(), body, hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64(signature), expected):
            return False
        data = json.loads(body)
        verified_at = int(data["verified_at"])
        expires_at = int(data["expires_at"])
        isolation = str(data["isolation"])
        runner_id = str(data["runner_id"])
        current = int(time.time()) if now is None else now
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeError):
        return False
    if not runner_id or isolation not in {"e2b", "bubblewrap", "sandbox-exec"}:
        return False
    if verified_at > current or expires_at <= current:
        return False
    return expires_at - verified_at <= max_age_seconds and current - verified_at <= max_age_seconds


def make_test_attestation(*, secret: str, runner_id: str = "test-runner", now: int | None = None) -> str:
    """Create deterministic test evidence; not used by production code."""
    current = int(time.time()) if now is None else now
    body = json.dumps(
        {"runner_id": runner_id, "isolation": "e2b", "verified_at": current, "expires_at": current + 600},
        separators=(",", ":"), sort_keys=True,
    ).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    return f"{_b64(body)}.{_b64(signature)}"
