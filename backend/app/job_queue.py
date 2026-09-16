from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta
from typing import Any, Callable, Collection, Dict, Optional

from sqlalchemy import update as sql_update
from sqlalchemy.orm import sessionmaker
from sqlmodel import Session, select

from .models import Job
from .time_utils import utc_now

logger = logging.getLogger(__name__)


def _comparable_datetime(value: datetime | None, reference: datetime) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None and reference.tzinfo is not None:
        return value.replace(tzinfo=reference.tzinfo)
    if value.tzinfo is not None and reference.tzinfo is None:
        return value.replace(tzinfo=None)
    return value

JobHandler = Callable[[Session, Dict[str, Any]], Dict[str, Any]]


class JobRetryLater(RuntimeError):
    """Retry a job without allowing a younger strict-FIFO job to pass it."""

    def __init__(self, message: str, *, delay_seconds: float = 2.0) -> None:
        super().__init__(message)
        self.delay_seconds = max(0.25, min(60.0, float(delay_seconds)))


class DBJobQueue:
    def __init__(
        self,
        engine: Any,
        *,
        poll_seconds: float = 1.0,
        allowed_job_types: Collection[str] | None = None,
        excluded_job_types: Collection[str] | None = None,
        knowledge_embedding_provider_factory: Callable[
            [Session, dict[str, object]], Any
        ] | None = None,
        chain_knowledge_jobs: bool = False,
        strict_fifo: bool = False,
        stale_running_seconds: float | None = None,
        stale_recovery_handler: Callable[[Session, Job], bool] | None = None,
    ) -> None:
        self.engine = engine
        self.poll_seconds = max(0.25, float(poll_seconds))
        self.allowed_job_types = (
            tuple(sorted({str(value) for value in allowed_job_types}))
            if allowed_job_types is not None
            else None
        )
        self.excluded_job_types = tuple(
            sorted({str(value) for value in (excluded_job_types or ())})
        )
        if self.allowed_job_types is not None and (
            set(self.allowed_job_types) & set(self.excluded_job_types)
        ):
            raise ValueError("allowed and excluded job types must not overlap")
        self._chain_knowledge_jobs = bool(chain_knowledge_jobs)
        self.strict_fifo = bool(strict_fifo)
        self.stale_running_seconds = (
            max(30.0, float(stale_running_seconds))
            if stale_running_seconds is not None else None
        )
        self.stale_recovery_handler = stale_recovery_handler
        self._handlers: Dict[str, JobHandler] = {}
        self._session_factory = sessionmaker(bind=engine, class_=Session, expire_on_commit=False)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.register("web_post_turn_distillation", _handle_web_post_turn_distillation)
        self.register("web_memory_embedding_backfill", _handle_web_memory_embedding_backfill)
        self.register("global_qa_embedding_backfill", _handle_global_qa_embedding_backfill)
        self.register("web_knowledge_ingest", _handle_web_knowledge_ingest)
        self.register("web_embedding_backfill", _handle_web_embedding_backfill)
        self.register("web_triplet_extract", _handle_web_triplet_extract)
        self.register("web_hierarchy_build", _handle_web_hierarchy_build)
        self.register("reminder_email", _handle_reminder_email)
        if knowledge_embedding_provider_factory is not None:
            self.register(
                "web_embedding_backfill",
                lambda session, payload: _handle_web_embedding_backfill(
                    session,
                    payload,
                    provider_factory=knowledge_embedding_provider_factory,
                    enforce_feature_policy=True,
                ),
            )

    def register(self, job_type: str, handler: JobHandler) -> None:
        self._handlers[str(job_type)] = handler

    def enqueue(
        self,
        session: Session,
        *,
        job_type: str,
        payload: Dict[str, Any],
        user_id: Optional[int] = None,
        max_attempts: int = 3,
        run_after_seconds: int = 0,
    ) -> Job:
        job = Job(
            user_id=user_id,
            job_type=job_type,
            status="queued",
            payload_json=json.dumps(payload, ensure_ascii=False),
            result_json=None,
            error_message=None,
            attempts=0,
            max_attempts=max(1, int(max_attempts)),
            run_at=utc_now() + timedelta(seconds=max(0, int(run_after_seconds))),
            started_at=None,
            finished_at=None,
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        logger.info("job enqueued", extra={"job_id": job.id, "job_type": job.job_type, "user_id": user_id})
        return job

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, name="db-job-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def get_job(self, session: Session, job_id: int) -> Optional[Job]:
        return session.get(Job, job_id)

    def _run_loop(self) -> None:  # pragma: no cover
        while not self._stop.is_set():
            try:
                worked = self._process_one()
                if not worked:
                    self._stop.wait(self.poll_seconds)
            except Exception:
                logger.exception("job worker loop failed")
                self._stop.wait(self.poll_seconds)

    def _claim_next_job(self, session: Session) -> Optional[Job]:
        now = utc_now()
        if self.strict_fifo and self.stale_running_seconds is not None:
            self._recover_stale_jobs(session, now)
            # A dedicated FIFO worker must never let a second process claim a
            # younger job while an older generation is still running.
            running_statement = select(Job.id).where(Job.status == "running")
            if self.allowed_job_types is not None:
                running_statement = running_statement.where(Job.job_type.in_(self.allowed_job_types))
            if self.excluded_job_types:
                running_statement = running_statement.where(Job.job_type.notin_(self.excluded_job_types))
            if session.exec(running_statement).first() is not None:
                return None
        statement = (
            select(Job.id)
            .where(Job.status.in_(["queued", "retrying"]))
            .order_by(Job.created_at.asc(), Job.id.asc())
        )
        if self.allowed_job_types is not None:
            statement = statement.where(
                Job.job_type.in_(self.allowed_job_types)
            )
        if self.excluded_job_types:
            statement = statement.where(
                Job.job_type.notin_(self.excluded_job_types)
            )
        # In strict FIFO mode, a delayed head blocks all younger work.
        candidate_id = session.exec(statement).first()
        if candidate_id is None:
            return None
        candidate = session.get(Job, candidate_id)
        candidate_run_at = _comparable_datetime(candidate.run_at, now) if candidate else None
        if candidate is None or (candidate_run_at is not None and candidate_run_at > now):
            return None

        claim_statement = (
            sql_update(Job)
            .where(Job.id == candidate_id)
            .where(Job.status.in_(["queued", "retrying"]))
            .where(Job.run_at <= now)
        )
        if self.allowed_job_types is not None:
            claim_statement = claim_statement.where(
                Job.job_type.in_(self.allowed_job_types)
            )
        if self.excluded_job_types:
            claim_statement = claim_statement.where(
                Job.job_type.notin_(self.excluded_job_types)
            )
        claim_result = session.exec(
            claim_statement.execution_options(synchronize_session=False).values(
                status="running",
                started_at=now,
                updated_at=now,
            )
        )
        if int(getattr(claim_result, "rowcount", 0) or 0) != 1:
            session.rollback()
            return None

        session.commit()
        return session.get(Job, candidate_id)

    def _recover_stale_jobs(self, session: Session, now) -> None:
        if self.stale_recovery_handler is None:
            return
        cutoff = now - timedelta(seconds=self.stale_running_seconds or 120)
        statement = select(Job).where(Job.status == "running", Job.started_at <= cutoff)
        if self.allowed_job_types is not None:
            statement = statement.where(Job.job_type.in_(self.allowed_job_types))
        for job in session.exec(statement.order_by(Job.started_at.asc(), Job.id.asc())).all():
            try:
                completed = bool(self.stale_recovery_handler(session, job))
            except Exception:
                logger.exception("strict FIFO stale job recovery failed", extra={"job_id": job.id})
                continue
            if not completed:
                job.status = "queued"
                job.started_at = None
                job.run_at = now
                job.updated_at = now
            session.add(job)
            session.commit()

    def _process_one(self) -> bool:
        with self._session_factory() as session:
            job = self._claim_next_job(session)
            if job is None:
                return False

            handler = self._handlers.get(job.job_type)
            if handler is None:
                job.status = "failed"
                job.error_message = f"No handler registered for {job.job_type}"
                job.finished_at = utc_now()
                job.updated_at = utc_now()
                session.add(job)
                session.commit()
                return True

            try:
                payload = json.loads(job.payload_json or "{}") if job.payload_json else {}
                if job.job_type.startswith("web_") and job.job_type in {
                    "web_knowledge_ingest",
                    "web_embedding_backfill",
                    "web_triplet_extract",
                    "web_hierarchy_build",
                }:
                    payload["_job_id"] = job.id
                if self.strict_fifo:
                    payload["_job_id"] = job.id
                    payload["_user_id"] = job.user_id
                result = handler(session, payload)
                session.refresh(job)
                if job.status == "cancelled" or bool((result or {}).get("cancelled")):
                    job.status = "cancelled"
                    job.result_json = json.dumps(result or {}, ensure_ascii=False)
                    job.finished_at = utc_now()
                    job.updated_at = utc_now()
                    session.add(job)
                    session.commit()
                    return True
                job.status = "completed"
                job.result_json = json.dumps(result or {}, ensure_ascii=False)
                job.finished_at = utc_now()
                job.updated_at = utc_now()
                session.add(job)
                if (
                    self._chain_knowledge_jobs
                    and job.job_type in _knowledge_job_types()
                ):
                    from .web_ai.knowledge_jobs import enqueue_next_knowledge_job

                    enqueue_next_knowledge_job(
                        session,
                        completed_job_type=job.job_type,
                        payload=payload,
                        result=result or {},
                    )
                session.commit()
                logger.info("job completed", extra={"job_id": job.id, "job_type": job.job_type, "user_id": job.user_id})
                if (
                    job.job_type == "global_qa_embedding_backfill"
                    and bool((result or {}).get("has_more"))
                ):
                    enqueue_global_qa_embedding_backfill(
                        session,
                        batch_size=int((result or {}).get("batch_size") or 50),
                        after_id=int((result or {}).get("next_after_id") or 0),
                    )
            except JobRetryLater as exc:
                retry_payload = job.payload_json
                session.rollback()
                job = session.get(Job, job.id)
                if job is None:
                    return True
                job.attempts = int(job.attempts or 0) + 1
                job.status = "retrying"
                job.error_message = str(exc)
                if retry_payload:
                    job.payload_json = retry_payload
                job.run_at = utc_now() + timedelta(seconds=exc.delay_seconds)
                job.updated_at = utc_now()
                session.add(job)
                session.commit()
                logger.warning("job deferred", extra={"job_id": job.id, "job_type": job.job_type})
            except Exception as exc:
                session.rollback()
                job = session.get(Job, job.id)
                if job is None:
                    return True
                job.attempts = int(job.attempts or 0) + 1
                should_retry = job.attempts < int(job.max_attempts or 1)
                job.status = "retrying" if should_retry else "failed"
                job.error_message = (
                    "knowledge_job_failed"
                    if job.job_type in {
                        "web_knowledge_ingest",
                        "web_embedding_backfill",
                        "web_triplet_extract",
                        "web_hierarchy_build",
                    }
                    else str(exc)
                )
                job.updated_at = utc_now()
                if should_retry:
                    job.run_at = utc_now() + timedelta(seconds=min(60, max(2, job.attempts * 2)))
                else:
                    job.finished_at = utc_now()
                    if job.job_type == "reminder_email":
                        from .models import Reminder

                        reminder = session.get(Reminder, int(json.loads(job.payload_json or "{}")["reminder_id"]))
                        if reminder is not None and reminder.status == "pending":
                            reminder.status = "failed"
                            reminder.updated_at = utc_now()
                            session.add(reminder)
                session.add(job)
                session.commit()
                logger.exception("job failed", extra={"job_id": job.id, "job_type": job.job_type, "user_id": job.user_id})
            return True


def _handle_web_post_turn_distillation(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .continuous_learning import distill_web_turn_facts

    return distill_web_turn_facts(
        session,
        user_id=int(payload["user_id"]),
        user_message_id=str(payload["user_message_id"]),
        assistant_message_id=str(payload["assistant_message_id"]),
        thread_id=str(payload["thread_id"]),
    )


def _handle_web_memory_embedding_backfill(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .web_api.web_memory import backfill_memory_fact_embeddings

    return backfill_memory_fact_embeddings(
        session,
        user_id=int(payload["user_id"]),
        batch_size=int(payload.get("batch_size") or 20),
    )


def _handle_global_qa_embedding_backfill(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .global_qa_cache import backfill_global_qa_embeddings

    batch_size = max(1, min(100, int(payload.get("batch_size") or 50)))
    result = backfill_global_qa_embeddings(
        session,
        batch_size=batch_size,
        after_id=max(0, int(payload.get("after_id") or 0)),
    )
    return {**result, "batch_size": batch_size}


def _handle_web_knowledge_ingest(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .web_ai.knowledge_jobs import handle_knowledge_ingest

    return handle_knowledge_ingest(session, payload)


def _handle_web_embedding_backfill(
    session: Session,
    payload: Dict[str, Any],
    *,
    provider_factory: Callable[[Session, dict[str, object]], Any] | None = None,
    enforce_feature_policy: bool = False,
) -> Dict[str, Any]:
    from .web_ai.knowledge_jobs import handle_embedding_backfill

    # The shared worker never implicitly constructs a provider. Only the
    # dedicated worker injects one after its isolated claim.
    return handle_embedding_backfill(
        session,
        payload,
        provider=None,
        provider_factory=provider_factory,
        enforce_feature_policy=enforce_feature_policy,
    )


def _handle_web_triplet_extract(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .web_ai.knowledge_jobs import handle_triplet_extract

    return handle_triplet_extract(session, payload)


def _handle_web_hierarchy_build(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .web_ai.knowledge_jobs import handle_hierarchy_build

    return handle_hierarchy_build(session, payload)


def _handle_reminder_email(
    session: Session, payload: Dict[str, Any]
) -> Dict[str, Any]:
    from .email_service import get_email_sender
    from .models import Reminder, User

    reminder = session.exec(
        select(Reminder).where(Reminder.id == int(payload["reminder_id"])).with_for_update()
    ).first()
    if reminder is None or reminder.status != "pending":
        return {"skipped": True, "reason": "reminder_not_pending"}
    user = session.get(User, reminder.user_id)
    if user is None or not str(user.email or "").strip():
        raise RuntimeError("Reminder account email is unavailable")

    body = reminder.title
    if reminder.message:
        body += f"\n\n{reminder.message}"
    get_email_sender().send(
        to_email=str(user.email).strip(),
        subject=f"Reminder: {reminder.title}",
        text_body=body,
    )
    now = utc_now()
    reminder.status = "sent"
    reminder.sent_at = now
    reminder.updated_at = now
    session.add(reminder)
    return {"sent": True, "reminder_id": reminder.id}


def _knowledge_job_types() -> tuple[str, ...]:
    from .web_ai.knowledge_jobs import KNOWLEDGE_JOB_TYPES

    return KNOWLEDGE_JOB_TYPES


def enqueue_memory_embedding_backfill(
    session: Session, *, user_id: int, batch_size: int = 20
) -> Job:
    existing = session.exec(
        select(Job).where(
            Job.user_id == user_id,
            Job.job_type == "web_memory_embedding_backfill",
            Job.status.in_(["queued", "running", "retrying"]),
        )
    ).first()
    if existing is not None:
        return existing
    job = Job(
        user_id=user_id,
        job_type="web_memory_embedding_backfill",
        status="queued",
        payload_json=json.dumps(
            {"user_id": user_id, "batch_size": max(1, min(100, int(batch_size)))},
            ensure_ascii=False,
        ),
        attempts=0,
        max_attempts=3,
        run_at=utc_now(),
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def enqueue_post_turn_distillation(
    session: Session,
    *,
    user_id: int,
    user_message_id: str,
    assistant_message_id: str,
    thread_id: str,
) -> Job:
    """Persist a distillation job without coupling chat_service to app.main."""
    # Completion callbacks and HTTP retries may race.  Reuse any existing job
    # for the completed assistant message, including a completed one.
    recent = session.exec(
        select(Job).where(
            Job.user_id == user_id,
            Job.job_type == "web_post_turn_distillation",
        ).order_by(Job.created_at.desc()).limit(200)
    ).all()
    for existing in recent:
        try:
            existing_payload = json.loads(existing.payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if str(existing_payload.get("assistant_message_id") or "") == assistant_message_id:
            return existing
    job = Job(
        user_id=user_id,
        job_type="web_post_turn_distillation",
        status="queued",
        payload_json=json.dumps(
            {
                "user_id": user_id,
                "user_message_id": user_message_id,
                "assistant_message_id": assistant_message_id,
                "thread_id": thread_id,
            },
            ensure_ascii=False,
        ),
        attempts=0,
        max_attempts=3,
        run_at=utc_now(),
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def enqueue_global_qa_embedding_backfill(
    session: Session, *, batch_size: int = 50, after_id: int = 0
) -> Job:
    """Ensure that at most one bounded global-QA backfill job is active."""
    existing = session.exec(
        select(Job).where(
            Job.job_type == "global_qa_embedding_backfill",
            Job.status.in_(["queued", "running", "retrying"]),
        ).order_by(Job.created_at.asc())
    ).first()
    if existing is not None:
        return existing
    job = Job(
        user_id=None,
        job_type="global_qa_embedding_backfill",
        status="queued",
        payload_json=json.dumps(
            {
                "batch_size": max(1, min(100, int(batch_size))),
                "after_id": max(0, int(after_id)),
            },
            ensure_ascii=False,
        ),
        attempts=0,
        max_attempts=3,
        run_at=utc_now(),
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job
