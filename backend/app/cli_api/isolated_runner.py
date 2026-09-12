"""Control-plane boundary for future cloud execution.

The API process deliberately has no implementation that can execute a
repository.  A separately deployed runner must implement this protocol and
authenticate a short-lived, job-scoped capability before this module can be
enabled.
"""
from __future__ import annotations

from dataclasses import dataclass
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


def configured_isolated_runner() -> IsolatedRunner:
    """Return only a reviewed runner; never fall back to API-local execution."""
    return UnavailableIsolatedRunner()
