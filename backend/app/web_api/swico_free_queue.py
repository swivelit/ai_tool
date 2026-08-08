"""Durable, claim-isolated FIFO queue for provider-backed Swico Free turns.

The Job table remains the source of truth.  Payloads contain references only;
the user message and attachment rows remain in the normal web-chat tables.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import timedelta
from statistics import mean
from time import monotonic
from typing import Any

from sqlmodel import Session, select

from ..ai.providers.swico_free_provider import (
    SwicoFreeBusyError,
    SwicoFreeProviderError,
    SwicoFreeUnavailableError,
)
from ..ai.providers.base import GenerationCancellation, GenerationCancelled
from ..job_queue import DBJobQueue, JobRetryLater
from ..models import Job, UsageCharge, WebChatMessage
from ..time_utils import utc_now

SWICO_FREE_CHAT_JOB_TYPE = "swico_free_chat"
ACTIVE_STATUSES = ("queued", "retrying", "running")
_running_cancellations: dict[str, GenerationCancellation] = {}
_running_lock = threading.Lock()


def _env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def durable_queue_enabled() -> bool:
    return _env_bool("SWICO_FREE_DURABLE_QUEUE_ENABLED")


def queue_worker_enabled() -> bool:
    return durable_queue_enabled() and _env_bool("SWICO_FREE_QUEUE_WORKER_ENABLED")


def _payload(job: Job) -> dict[str, Any]:
    try:
        value = json.loads(job.payload_json or "{}")
    except (TypeError, ValueError):
        value = {}
    return value if isinstance(value, dict) else {}


def _elapsed(now, value) -> float:
    if value is None:
        return 0.0
    if value.tzinfo is None and now.tzinfo is not None:
        value = value.replace(tzinfo=now.tzinfo)
    elif value.tzinfo is not None and now.tzinfo is None:
        value = value.replace(tzinfo=None)
    return max(0.0, (now - value).total_seconds())


def request_id_from_job(job: Job) -> str:
    return str(_payload(job).get("request_id") or "")


def find_request_job(session: Session, request_id: str, *, user_id: int | None = None) -> Job | None:
    statement = select(Job).where(Job.job_type == SWICO_FREE_CHAT_JOB_TYPE)
    if user_id is not None:
        statement = statement.where(Job.user_id == int(user_id))
    for job in session.exec(statement.order_by(Job.created_at.asc(), Job.id.asc())).all():
        if request_id_from_job(job) == str(request_id):
            return job
    return None


def enqueue_swico_free_chat(session: Session, *, user_id: int, payload: dict[str, Any]) -> Job:
    request_id = str(payload.get("request_id") or "")
    if not request_id:
        raise ValueError("Swico Free queue payload requires request_id")
    existing = find_request_job(session, request_id, user_id=user_id)
    if existing is not None:
        return existing
    # Only IDs and bounded control values are persisted.  In particular, the
    # prompt, documents, tokens, and provider settings never enter this JSON.
    safe = {
        "request_id": request_id,
        "thread_id": str(payload.get("thread_id") or ""),
        "attachment_ids": [str(v) for v in (payload.get("attachment_ids") or [])][:16],
        "repository_id": str(payload.get("repository_id") or "") or None,
        "input_mode": "text",
        "continue_message_id": str(payload.get("continue_message_id") or "") or None,
        "edit_message_id": str(payload.get("edit_message_id") or "") or None,
        "regenerate_message_id": str(payload.get("regenerate_message_id") or "") or None,
        "billing_exempt": bool(payload.get("billing_exempt")),
    }
    job = Job(
        user_id=int(user_id), job_type=SWICO_FREE_CHAT_JOB_TYPE, status="queued",
        payload_json=json.dumps(safe, ensure_ascii=False, separators=(",", ":")),
        attempts=0, max_attempts=1, run_at=utc_now(),
        created_at=utc_now(), updated_at=utc_now(),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def _completed_message(session: Session, payload: dict[str, Any]) -> WebChatMessage | None:
    request_id = str(payload.get("request_id") or "")
    user_id = int(payload.get("_user_id") or payload.get("user_id") or 0)
    return session.exec(select(WebChatMessage).where(
        WebChatMessage.user_id == user_id,
        WebChatMessage.request_id == request_id,
        WebChatMessage.role == "assistant",
        WebChatMessage.status == "complete",
    )).first()


def _release_cancelled(session: Session, *, user_id: int, request_id: str) -> None:
    from ..billing.service import release_swico_free_usage

    release_swico_free_usage(session, request_id, reason="cancelled_while_queued")
    user_message = session.exec(select(WebChatMessage).where(
        WebChatMessage.user_id == user_id,
        WebChatMessage.request_id == request_id,
        WebChatMessage.role == "user",
    )).first()
    if user_message is not None:
        user_message.status = "cancelled"
        session.add(user_message)


def _stale_recovery(session: Session, job: Job) -> bool:
    payload = _payload(job)
    payload["_stale_recoveries"] = int(payload.get("_stale_recoveries") or 0) + 1
    job.payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    assistant = _completed_message(session, {**payload, "user_id": job.user_id})
    if assistant is not None:
        job.status = "completed"
        job.result_json = json.dumps({"request_id": request_id_from_job(job), "message_id": assistant.id})
        job.finished_at = utc_now()
        job.updated_at = utc_now()
        return True
    return False


def _handle_swico_free_chat(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    from .chat_service import execute_web_turn, prepare_web_turn
    from ..web_ai.settings import TriagSettings

    request_id = str(payload.get("request_id") or "")
    user_id = int(payload.get("_user_id") or payload.get("user_id") or 0)
    job = session.get(Job, int(payload.get("_job_id") or 0))
    if job is None:
        raise RuntimeError("swico_free_queue_job_missing")
    with _running_lock:
        pending_signal = _running_cancellations.get(request_id)
    if pending_signal is not None and pending_signal.cancelled:
        job.status = "cancelled"
        _release_cancelled(session, user_id=user_id, request_id=request_id)
        return {"request_id": request_id, "cancelled": True}
    assistant = _completed_message(session, payload)
    if assistant is not None:
        return {"request_id": request_id, "message_id": assistant.id, "thread_id": assistant.thread_id}
    charge = session.exec(select(UsageCharge).where(
        UsageCharge.request_id == request_id, UsageCharge.user_id == user_id,
    )).first()
    if charge is None or charge.status != "free_pending":
        job.status = "cancelled"
        _release_cancelled(session, user_id=user_id, request_id=request_id)
        return {"request_id": request_id, "cancelled": True}

    try:
        user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "user",
        )).first()
        if user_message is None:
            raise RuntimeError("swico_free_request_message_missing")
        started = monotonic()
        prepared = prepare_web_turn(
            user_id=user_id, message=user_message.content, request_id=request_id,
            thread_id=str(payload.get("thread_id") or user_message.thread_id),
            reply_language=None,
            attachment_ids=[str(v) for v in (payload.get("attachment_ids") or [])],
            billing_exempt=bool(payload.get("billing_exempt")), input_mode="text",
            continue_message_id=payload.get("continue_message_id"),
            edit_message_id=payload.get("edit_message_id"),
            regenerate_message_id=payload.get("regenerate_message_id"),
            repository_id=payload.get("repository_id"), billing_credit_bucket="chat",
            swico_free_eligible=True, resume_accepted_queue=True,
            triag_settings=TriagSettings.from_environ(),
        )
        if prepared.route.provider != "swico_free":
            raise RuntimeError("swico_free_route_changed")
        signal = GenerationCancellation()
        prepared.ai_request.metadata["cancellation_signal"] = signal
        with _running_lock:
            _running_cancellations[request_id] = signal
        try:
            completed = execute_web_turn(prepared)
        except GenerationCancelled:
            job.status = "cancelled"
            _release_cancelled(session, user_id=user_id, request_id=request_id)
            return {"request_id": request_id, "cancelled": True}
        finally:
            with _running_lock:
                _running_cancellations.pop(request_id, None)
        return {
            "request_id": request_id, "message_id": completed.message.id,
            "thread_id": completed.thread_id,
            "service_seconds": round(max(0.0, monotonic() - started), 3),
        }
    except (SwicoFreeBusyError, SwicoFreeUnavailableError) as exc:
        # execute_web_turn normally releases a provider reservation on an
        # error.  A transient queue-head retry is different: the accepted
        # request remains pending and must retain its FIFO place.
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id,
            UsageCharge.user_id == user_id,
        )).first()
        if charge is not None:
            charge.status = "free_pending"
            charge.settled_at = None
            session.add(charge)
        payload["_transient_busy"] = int(payload.get("_transient_busy") or 0) + int(exc.code == "swico_free_busy")
        payload["_transient_unavailable"] = int(payload.get("_transient_unavailable") or 0) + int(exc.code != "swico_free_busy")
        job.payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        session.commit()
        raise JobRetryLater(exc.code, delay_seconds=2.0)
    except SwicoFreeProviderError:
        raise


def build_swico_free_queue(engine: Any) -> DBJobQueue:
    queue = DBJobQueue(
        engine,
        poll_seconds=max(0.25, float(os.getenv("SWICO_FREE_QUEUE_POLL_SECONDS", "0.25"))),
        allowed_job_types=(SWICO_FREE_CHAT_JOB_TYPE,),
        strict_fifo=True,
        stale_running_seconds=float(os.getenv("SWICO_FREE_QUEUE_STALE_RUNNING_SECONDS", "120")),
        stale_recovery_handler=_stale_recovery,
    )
    queue.register(SWICO_FREE_CHAT_JOB_TYPE, _handle_swico_free_chat)
    return queue


def queue_position(session: Session, *, job: Job) -> dict[str, Any]:
    active = session.exec(select(Job).where(
        Job.job_type == SWICO_FREE_CHAT_JOB_TYPE,
        Job.status.in_(ACTIVE_STATUSES),
    ).order_by(Job.created_at.asc(), Job.id.asc())).all()
    waiting = [row for row in active if row.status in {"queued", "retrying"}]
    own = next((row for row in active if row.id == job.id), job)
    if own.status == "running":
        return {"running": True, "queue_position": None}
    if own.status not in {"queued", "retrying"}:
        return {"running": False, "queue_position": None}
    return {"running": False, "queue_position": next((i + 1 for i, row in enumerate(waiting) if row.id == own.id), None)}


def queue_metrics(session: Session) -> dict[str, Any]:
    rows = session.exec(select(Job).where(Job.job_type == SWICO_FREE_CHAT_JOB_TYPE)).all()
    now = utc_now()
    completed = [row for row in rows if row.status == "completed" and row.finished_at]
    service = [max(0.0, (row.finished_at - row.started_at).total_seconds()) for row in completed if row.started_at]
    def count_since(seconds: int) -> int:
        return sum(1 for row in completed if row.finished_at and _elapsed(now, row.finished_at) <= seconds)
    waiting = [row for row in rows if row.status in {"queued", "retrying"}]
    oldest = min((_elapsed(now, row.created_at) for row in waiting), default=0.0)
    busy = sum(int(_payload(row).get("_transient_busy") or 0) for row in rows)
    unavailable = sum(int(_payload(row).get("_transient_unavailable") or 0) for row in rows)
    stale = sum(int(_payload(row).get("_stale_recoveries") or 0) for row in rows)
    ordered = sorted(service)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] if ordered else 0.0
    return {
        "queued_count": sum(row.status == "queued" for row in rows),
        "running_count": sum(row.status == "running" for row in rows),
        "completed_count": sum(row.status == "completed" for row in rows),
        "cancelled_count": sum(row.status == "cancelled" for row in rows),
        "failed_count": sum(row.status == "failed" for row in rows),
        "retrying_count": sum(row.status == "retrying" for row in rows),
        "oldest_queue_wait_seconds": round(oldest, 3),
        "completed_last_minute": count_since(60),
        "completed_last_5_minutes": count_since(300),
        "average_service_seconds": round(mean(service), 3) if service else 0.0,
        "p95_service_seconds": round(p95, 3),
        "transient_laptop_busy_count": busy,
        "transient_laptop_unavailable_count": unavailable,
        "stale_job_recoveries": stale,
    }


def cancel_queued_job(session: Session, *, user_id: int, request_id: str) -> str | None:
    job = find_request_job(session, request_id, user_id=user_id)
    if job is None:
        return None
    if job.status in {"queued", "retrying"}:
        job.status = "cancelled"
        job.finished_at = utc_now()
        job.updated_at = utc_now()
        _release_cancelled(session, user_id=user_id, request_id=request_id)
        session.add(job)
        session.commit()
        return "stopped"
    if job.status == "running":
        with _running_lock:
            signal = _running_cancellations.get(request_id)
        if signal is not None:
            signal.cancel(reason="user_cancelled")
        return "running"
    return job.status
