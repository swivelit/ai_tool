#!/usr/bin/env python3
"""Secret-safe final operational check for the released Swico Free path.

This is intentionally an observer.  It does not enqueue chat, mutate queue
rows, or change rollout configuration.  It reuses the existing inference
probe and durable-queue metrics rather than implementing another provider
client.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
from typing import Mapping

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import httpx  # noqa: E402
from alembic.migration import MigrationContext  # noqa: E402
from sqlmodel import Session  # noqa: E402

from app.alembic_utils import repository_alembic_head  # noqa: E402
from app.database import engine  # noqa: E402
from app.production_config import production_configuration_errors  # noqa: E402
from app.web_api.swico_free_queue import queue_diagnostics  # noqa: E402
from scripts import swico_free_probe as probe  # noqa: E402
from scripts.swico_free_queue_report import live_runtime_status  # noqa: E402


# These are warnings only.  A backlog is normal operation for a durable FIFO
# queue; the release check must not turn it into an admission cap or delete it.
QUEUE_COUNT_WARNING_THRESHOLD = 3
OLDEST_QUEUE_WAIT_WARNING_SECONDS = 60.0
TRANSIENT_WARNING_THRESHOLD = 1


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str = ""


def _bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def configuration_checks(environ: Mapping[str, str] | None = None) -> list[Check]:
    env = os.environ if environ is None else environ
    errors = production_configuration_errors(env)
    checks = [
        Check(
            "production_configuration",
            "pass" if not errors else "fail",
            "valid" if not errors else "invalid",
        ),
        Check(
            "swico_free_enabled",
            "pass" if _bool(env.get("SWICO_FREE_ENABLED")) else "fail",
            "enabled" if _bool(env.get("SWICO_FREE_ENABLED")) else "disabled",
        ),
    ]
    try:
        rollout = int(str(env.get("SWICO_FREE_ROLLOUT_PERCENT", "0")).strip())
        rollout_valid = 0 <= rollout <= 100
        rollout_detail = str(rollout) if rollout_valid else "invalid"
    except (TypeError, ValueError):
        rollout_valid, rollout_detail = False, "invalid"
    checks.append(Check("rollout_percent", "pass" if rollout_valid else "fail", rollout_detail))
    return checks


def queue_warning_checks(metrics: Mapping[str, object]) -> list[Check]:
    def number(name: str) -> float:
        try:
            return float(metrics.get(name, 0) or 0)
        except (TypeError, ValueError):
            return 0.0

    queued = number("queued_count")
    oldest = number("oldest_queue_wait_seconds")
    unavailable = number(
        "transient_laptop_unavailable_recent"
        if "transient_laptop_unavailable_recent" in metrics
        else "transient_laptop_unavailable_count"
    )
    busy = number(
        "transient_laptop_busy_recent"
        if "transient_laptop_busy_recent" in metrics
        else "transient_laptop_busy_count"
    )
    checks: list[Check] = []
    if queued > 0:
        checks.append(Check("queued_work", "warn", f"{int(queued)} queued"))
    if queued >= QUEUE_COUNT_WARNING_THRESHOLD:
        checks.append(Check("queue_backlog", "warn", "backlog_above_normal_warning_threshold"))
    if oldest >= OLDEST_QUEUE_WAIT_WARNING_SECONDS:
        checks.append(Check("oldest_queue_wait", "warn", "wait_above_warning_threshold"))
    if unavailable >= TRANSIENT_WARNING_THRESHOLD:
        checks.append(Check("transient_laptop_unavailable_recent", "warn", "observed"))
    if busy >= TRANSIENT_WARNING_THRESHOLD:
        checks.append(Check("transient_laptop_busy_recent", "warn", "observed"))
    return checks


def _database_checks() -> tuple[list[Check], dict[str, object]]:
    expected = repository_alembic_head()
    if expected is None:
        return [Check("alembic_current", "fail", "repository_head_unavailable")], {}
    try:
        with engine.connect() as connection:
            current = tuple(sorted(MigrationContext.configure(connection).get_current_heads()))
        matches = current == (expected,)
        return [
            Check("alembic_current", "pass" if matches else "fail", "current" if matches else "head_mismatch"),
        ], {"repository_head": expected, "database_heads": list(current)}
    except Exception:
        return [Check("alembic_current", "fail", "database_unavailable")], {"repository_head": expected}


def _inference_checks() -> list[Check]:
    base_url, token_or_error = probe._base_url()
    if base_url is None:
        return [Check("inference_configuration", "fail", str(token_or_error))]
    connect_retries = probe._connect_retries()
    if connect_retries is None:
        return [Check("inference_configuration", "fail", "invalid_connect_retries")]
    timeout_seconds = probe._timeout_seconds()
    timeout = httpx.Timeout(timeout_seconds, connect=min(10.0, timeout_seconds))
    with httpx.Client(
        base_url=base_url,
        headers={"Authorization": f"Bearer {token_or_error}", "Accept": "application/json"},
        timeout=timeout,
        transport=httpx.HTTPTransport(retries=connect_retries),
    ) as client:
        health = probe._check(client, "/health", "GET", "/health")
        results: list[probe.ProbeResult] = [health]
        if health.ok:
            results.extend([
                probe._check(client, "/v1/embed", "POST", "/v1/embed", {
                    "texts": ["swico free release check"], "modes": ["query"],
                }),
                probe._check(client, "/v1/generate", "POST", "/v1/generate", {
                    "messages": [{"role": "user", "content": "Reply with exactly OK."}],
                    "max_output_tokens": 8,
                }),
                probe._check_stream(client),
            ])
        else:
            results.extend([
                probe._skip("/v1/embed"),
                probe._skip("/v1/generate"),
                probe._skip("/v1/generate/stream"),
            ])
    checks: list[Check] = []
    for result in results:
        if result.skipped:
            status = "warn"
        else:
            status = "pass" if result.ok else "fail"
        checks.append(Check(result.name, status, result.category or "ok"))
    checks.append(Check(
        "embedding_dimensions",
        "pass" if any(result.name == "/v1/embed" and result.ok for result in results) else "fail",
        "384" if any(result.name == "/v1/embed" and result.ok for result in results) else "not_verified",
    ))
    return checks


def build_report() -> dict[str, object]:
    checks = configuration_checks()
    if _bool(os.getenv("SWICO_FREE_DURABLE_QUEUE_ENABLED")):
        checks.append(Check("durable_queue_enabled", "pass", "enabled"))
    else:
        checks.append(Check("durable_queue_enabled", "fail", "disabled"))
    if _bool(os.getenv("SWICO_FREE_QUEUE_WORKER_ENABLED")):
        checks.append(Check("queue_worker_enabled", "pass", "enabled"))
    else:
        checks.append(Check("queue_worker_enabled", "fail", "disabled"))

    live = live_runtime_status()
    checks.append(Check(
        "queue_worker_running",
        "pass" if live and live.get("worker_running") is True else "fail",
        "live_process" if live else "live_process_unavailable",
    ))

    database_checks, database_meta = _database_checks()
    checks.extend(database_checks)
    metrics: dict[str, object] = {}
    try:
        with Session(engine) as session:
            metrics = queue_diagnostics(session)
        checks.append(Check("queue_query", "pass", "available"))
    except Exception:
        checks.append(Check("queue_query", "fail", "database_unavailable"))
    checks.extend(queue_warning_checks(metrics))
    checks.extend(_inference_checks())

    blockers = sum(check.status == "fail" for check in checks)
    warnings = sum(check.status == "warn" for check in checks)
    overall = "fail" if blockers else "warn" if warnings else "pass"
    safe_metrics = {
        key: metrics.get(key)
        for key in (
            "queued_count", "running_count", "completed_count", "cancelled_count",
            "failed_count", "retrying_count", "oldest_queue_wait_seconds",
            "transient_laptop_unavailable_recent", "transient_laptop_busy_recent",
            "transient_laptop_unavailable_lifetime", "transient_laptop_busy_lifetime",
            "stale_job_recoveries",
        )
        if key in metrics
    }
    return {
        "status": overall,
        "blocker_count": blockers,
        "warning_count": warnings,
        "checks": [check.__dict__ for check in checks],
        "queue": safe_metrics,
        **database_meta,
    }


def render_report(report: Mapping[str, object], *, pretty: bool) -> str:
    if not pretty:
        return json.dumps(report, sort_keys=True, separators=(",", ":"))
    lines = [
        f"status={report['status']}",
        f"blocker_count={report['blocker_count']}",
        f"warning_count={report['warning_count']}",
    ]
    for check in report.get("checks", []):
        if isinstance(check, dict):
            lines.append(f"{check.get('status')} {check.get('name')} {check.get('detail', '')}".rstrip())
    queue = report.get("queue")
    if isinstance(queue, dict):
        for key, value in queue.items():
            lines.append(f"queue_{key}={value}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the safe Swico Free production closeout check")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = build_report()
    except Exception:
        # Operational checks must fail closed without printing exception text,
        # which could contain deployment-specific connection details.
        report = {"status": "fail", "blocker_count": 1, "warning_count": 0,
                  "checks": [{"name": "release_check", "status": "fail", "detail": "check_error"}]}
    print(render_report(report, pretty=args.pretty))
    return 1 if int(report.get("blocker_count", 1) or 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
