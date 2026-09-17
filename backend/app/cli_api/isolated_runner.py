"""Control-plane boundary for future cloud execution.

The API process deliberately has no implementation that can execute a
repository.  A separately deployed runner must implement this protocol and
authenticate a short-lived, job-scoped capability before this module can be
enabled.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from secrets import token_urlsafe
import time
from typing import Protocol


class IsolatedRunner(Protocol):
    def submit(self, *, job_id: str, task: str, snapshot_ref: str) -> None:
        """Submit metadata only; repository bytes are never accepted here."""

    def cancel(self, *, job_id: str) -> None:
        """Revoke the runner capability for a job."""


@dataclass(frozen=True)
class UnavailableIsolatedRunner:
    reason: str = "no isolated runner is configured"

    def submit(self, *, job_id: str, task: str, snapshot_ref: str) -> None:
        raise RuntimeError(f"Cloud execution unavailable: {self.reason}")

    def cancel(self, *, job_id: str) -> None:
        raise RuntimeError(f"Cloud execution unavailable: {self.reason}")


def issue_runner_capability(*, job_id: str, runner_id: str, actions: tuple[str, ...], attempt: int = 0, ttl_seconds: int = 300) -> str:
    """Create a short-lived capability for one claimed job.

    The API only issues this after an authenticated runner claim. It is not an
    end-user token and contains no repository bytes or provider credentials.
    """
    secret = os.environ.get("SWICO_CLI_CLOUD_RUNNER_TOKEN", "").strip()
    if not secret or not job_id or not runner_id or not actions:
        raise RuntimeError("runner capability configuration is incomplete")
    now = int(time.time())
    body = json.dumps({
        "job_id": job_id,
        "runner_id": runner_id,
        "attempt": max(0, int(attempt)),
        "nonce": token_urlsafe(24),
        "expires_at": now + max(30, min(900, int(ttl_seconds))),
        "actions": list(dict.fromkeys(actions)),
    }, separators=(",", ":"), sort_keys=True)
    signature = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def verify_runner_capability(value: str, *, job_id: str, runner_id: str, attempt: int, action: str) -> bool:
    """Verify the API-side copy of a job/attempt capability.

    Runner capabilities are deliberately short-lived and scoped to one
    attempt. The control plane checks them again on heartbeat/result so a
    delayed worker cannot affect a replacement lease.
    """
    secret = os.environ.get("SWICO_CLI_CLOUD_RUNNER_TOKEN", "").strip()
    if not value or not secret or len(value) > 16_384:
        return False
    try:
        body, signature = value.rsplit(".", 1)
        expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        data = json.loads(body)
        return bool(
            hmac.compare_digest(signature, expected)
            and data.get("job_id") == job_id
            and data.get("runner_id") == runner_id
            and int(data.get("attempt", -1)) == int(attempt)
            and action in data.get("actions", [])
            and int(data["expires_at"]) > int(time.time())
        )
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        return False


@dataclass(frozen=True)
class HttpIsolatedRunner:
    """Metadata-only control-plane client for a separately deployed runner."""

    url: str
    reason: str = "isolated runner is configured; dispatch is owned by the controller"

    def submit(self, *, job_id: str, task: str, snapshot_ref: str) -> None:
        raise RuntimeError("Cloud dispatch must run in the separate controller, not the API process.")

    def cancel(self, *, job_id: str) -> None:
        # The controller observes the durable cancellation flag and forwards
        # the job-scoped capability to the runner. The API never executes code.
        return None


def configured_isolated_runner() -> IsolatedRunner:
    """Return only a reviewed runner; never fall back to API-local execution."""
    url = os.environ.get("SWICO_CLI_CLOUD_RUNNER_URL", "").strip().rstrip("/")
    token = os.environ.get("SWICO_CLI_CLOUD_RUNNER_TOKEN", "").strip()
    if url and token:
        return HttpIsolatedRunner(url)
    return UnavailableIsolatedRunner()
