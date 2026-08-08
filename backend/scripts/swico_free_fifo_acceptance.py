"""Observe a manually driven, production Swico Free FIFO acceptance run.

This script never creates requests or users.  Start it first, then submit the
requested turns from the existing internal test account in the browser.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlmodel import Session, func, select  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.models import Job, UsageCharge, WebChatMessage  # noqa: E402
from app.web_api.swico_free_queue import SWICO_FREE_CHAT_JOB_TYPE  # noqa: E402


_WAITING = {"queued", "retrying"}
_TERMINAL = {"completed", "cancelled", "failed"}


def _payload(job: Job) -> dict[str, object]:
    try:
        value = json.loads(job.payload_json or "{}")
    except (TypeError, ValueError):
        value = {}
    return value if isinstance(value, dict) else {}


def _runtime_worker_running() -> bool | None:
    try:
        port = int(os.getenv("PORT", "10000"))
        if not 1 <= port <= 65535:
            return None
        request = Request(
            f"http://127.0.0.1:{port}/internal/swico-free-queue-runtime",
            headers={"Accept": "application/json"}, method="GET",
        )
        with urlopen(request, timeout=0.5) as response:
            if int(getattr(response, "status", 200)) != 200:
                return None
            value = json.loads(response.read(2048).decode("utf-8"))
        return value.get("worker_running") if isinstance(value, dict) and isinstance(value.get("worker_running"), bool) else None
    except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _new_jobs(session: Session, baseline_id: int) -> list[Job]:
    return session.exec(select(Job).where(
        Job.job_type == SWICO_FREE_CHAT_JOB_TYPE,
        Job.id > baseline_id,
    ).order_by(Job.created_at.asc(), Job.id.asc())).all()


def _persisted_checks(session: Session, job: Job) -> tuple[bool, bool]:
    request_id = str(_payload(job).get("request_id") or "")
    if not request_id or job.user_id is None:
        return False, False
    assistant = session.exec(select(WebChatMessage.id).where(
        WebChatMessage.user_id == job.user_id,
        WebChatMessage.request_id == request_id,
        WebChatMessage.role == "assistant",
        WebChatMessage.status == "complete",
    )).first()
    charge = session.exec(select(UsageCharge).where(
        UsageCharge.user_id == job.user_id,
        UsageCharge.request_id == request_id,
    )).first()
    zero_cost = bool(
        charge is not None
        and charge.status == "free"
        and charge.provider == "swico_free"
        and charge.swico_tier == "free"
        and int(charge.reserved_micros or 0) == 0
        and int(charge.provider_cost_micros or 0) == 0
        and int(charge.debited_micros or 0) == 0
    )
    return assistant is not None, zero_cost


def _state(job: Job, *, persisted: bool, zero_cost: bool) -> dict[str, object]:
    return {
        "status": str(job.status),
        "transitions": [],
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "persisted": persisted,
        "zero_cost": zero_cost,
    }


def _print_report(report: dict[str, object], *, pretty: bool) -> None:
    if not pretty:
        print(" ".join(f"{key}={value}" for key, value in report.items()))
        return
    for key, value in report.items():
        if isinstance(value, list):
            value = ",".join(str(item) for item in value)
        print(f"{key}={value}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Observe a Swico Free FIFO acceptance run")
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.count <= 20:
        parser.error("--count must be between 1 and 20")
    if not 1 <= args.timeout_seconds <= 3600:
        parser.error("--timeout-seconds must be between 1 and 3600")

    with SessionLocal() as session:
        baseline_id = int(session.exec(select(func.max(Job.id)).where(
            Job.job_type == SWICO_FREE_CHAT_JOB_TYPE,
        )).one() or 0)
    print("OBSERVER_READY=PASS", flush=True)

    jobs: list[Job] = []
    states: dict[int, dict[str, object]] = {}
    waiting_observed = False
    worker_seen = False
    worker_observable = False
    deadline = time.monotonic() + float(args.timeout_seconds)

    while time.monotonic() < deadline:
        worker = _runtime_worker_running()
        if worker is not None:
            worker_observable = True
            worker_seen = worker_seen or worker
        with SessionLocal() as session:
            current = _new_jobs(session, baseline_id)
            if len(current) > args.count:
                jobs = current[:args.count]
                too_many = True
            else:
                jobs = current
                too_many = False
            for index, job in enumerate(jobs):
                previous = states.setdefault(job.id, _state(job, persisted=False, zero_cost=False))
                if not previous["transitions"] or previous["transitions"][-1] != job.status:
                    previous["transitions"].append(str(job.status))
                persisted, zero_cost = _persisted_checks(session, job) if job.status == "completed" else (False, False)
                previous.update({
                    "status": str(job.status),
                    "started_at": job.started_at.isoformat() if job.started_at else None,
                    "finished_at": job.finished_at.isoformat() if job.finished_at else None,
                    "persisted": persisted,
                    "zero_cost": zero_cost,
                })
            if len(jobs) >= 2 and jobs[0].status == "running" and jobs[1].status in _WAITING:
                waiting_observed = True
            if len(jobs) >= args.count and all(job.status in _TERMINAL for job in jobs):
                break
        time.sleep(0.25)
    else:
        too_many = False

    jobs = sorted(jobs, key=lambda job: (job.created_at, int(job.id or 0)))
    first = jobs[0] if len(jobs) >= 1 else None
    second = jobs[1] if len(jobs) >= 2 else None
    first_state = states.get(first.id, {}) if first and first.id is not None else {}
    second_state = states.get(second.id, {}) if second and second.id is not None else {}
    exact = len(jobs) == args.count and not too_many
    order = bool(
        exact and first and second
        and first.created_at <= second.created_at
        and first.started_at is not None and second.started_at is not None
        and first.started_at < second.started_at
        and first.finished_at is not None and second.finished_at is not None
        and first.finished_at <= second.started_at
    )
    completed_1 = bool(first and first.status == "completed")
    completed_2 = bool(second and second.status == "completed")
    persisted = bool(first_state.get("persisted")) and bool(second_state.get("persisted"))
    zero_cost = bool(first_state.get("zero_cost")) and bool(second_state.get("zero_cost"))
    no_lost = exact and completed_1 and completed_2
    waiting_value = "PASS" if waiting_observed else "NOT_OBSERVED"
    overall = "PASS" if all((worker_seen, exact, order, waiting_observed, completed_1, completed_2, persisted, zero_cost, no_lost)) else "RETRY_REQUIRED" if not waiting_observed and exact and completed_1 and completed_2 else "FAIL"
    report: dict[str, object] = {
        "WORKER_RUNNING": "PASS" if worker_seen and worker_observable else "NOT_OBSERVED",
        "FIFO_ORDER": "PASS" if order else "FAIL",
        "WAITING_OBSERVED": waiting_value,
        "REQUEST_1_COMPLETED": "PASS" if completed_1 else "FAIL",
        "REQUEST_2_COMPLETED": "PASS" if completed_2 else "FAIL",
        "ANSWERS_PERSISTED": "PASS" if persisted else "FAIL",
        "ZERO_COST_ACCOUNTING": "PASS" if zero_cost else "FAIL",
        "NO_REQUEST_LOST": "PASS" if no_lost else "FAIL",
        "OVERALL": overall,
    }
    for label, state in (("request_1", first_state), ("request_2", second_state)):
        report[f"{label}_statuses"] = state.get("transitions", [])
        report[f"{label}_started_at"] = state.get("started_at")
        report[f"{label}_finished_at"] = state.get("finished_at")
    if overall == "RETRY_REQUIRED":
        report["INSTRUCTION"] = "Submit two Swico Free requests quickly in separate browser tabs so request_2 is queued while request_1 is generating, then retry."
    _print_report(report, pretty=bool(args.pretty))
    return 0 if overall == "PASS" else 2 if overall == "RETRY_REQUIRED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
