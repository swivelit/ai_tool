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
    expected: dict[str, str] | None = None,
) -> bool:
    """Return true only for bounded, signed, unexpired isolation evidence."""
    if not value or len(value) > 16_384 or not secret:
        return False
    try:
        encoded_body, signature = value.split(".", 1)
        body = _unb64(encoded_body)
        expected_signature = hmac.new(secret.encode(), body, hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64(signature), expected_signature):
            return False
        data = json.loads(body)
        verified_at = int(data["verified_at"])
        expires_at = int(data["expires_at"])
        protocol_version = str(data["protocol_version"])
        audience = str(data["audience"])
        executor = str(data["executor"])
        template = str(data["template_id_or_digest"])
        runner_revision = str(data["runner_revision"])
        policy = str(data["policy_sha256"])
        network_policy = str(data["network_policy"])
        hostile_verified = bool(data["hostile_verified"])
        key_epoch = str(data["key_epoch"])
        isolation = str(data["isolation"])
        runner_id = str(data["runner_id"])
        current = int(time.time()) if now is None else now
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeError):
        return False
    if not runner_id or protocol_version != "1" or not audience or not executor or not template or not runner_revision or not policy or not network_policy or not key_epoch or not hostile_verified or isolation not in {"e2b", "bubblewrap", "sandbox-exec"}:
        return False
    expected = expected or {}
    observed = {"runner_id": runner_id, "audience": audience, "executor": executor, "template_id_or_digest": template, "runner_revision": runner_revision, "policy_sha256": policy, "network_policy": network_policy}
    if any(expected.get(key) and expected[key] != value for key, value in observed.items()):
        return False
    if verified_at > current or expires_at <= current:
        return False
    return expires_at - verified_at <= max_age_seconds and current - verified_at <= max_age_seconds


def make_test_attestation(*, secret: str, runner_id: str = "test-runner", now: int | None = None, template_id_or_digest: str = "test-template", runner_revision: str = "test-revision", policy_sha256: str = "test-policy", audience: str = "swico-backend", key_epoch: str = "test-epoch") -> str:
    """Create deterministic test evidence; not used by production code."""
    current = int(time.time()) if now is None else now
    body = json.dumps(
        {"protocol_version": "1", "runner_id": runner_id, "audience": audience, "executor": "e2b", "template_id_or_digest": template_id_or_digest, "runner_revision": runner_revision, "policy_sha256": policy_sha256, "network_policy": "disabled", "hostile_verified": True, "key_epoch": key_epoch, "isolation": "e2b", "verified_at": current, "expires_at": current + 600},
        separators=(",", ":"), sort_keys=True,
    ).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    return f"{_b64(body)}.{_b64(signature)}"
