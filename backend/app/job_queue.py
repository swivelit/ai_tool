from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, Optional

from sqlalchemy.orm import sessionmaker
from sqlmodel import Session, select

from .models import Job

logger = logging.getLogger(__name__)

JobHandler = Callable[[Session, Dict[str, Any]], Dict[str, Any]]


class DBJobQueue:
    def __init__(self, engine: Any, *, poll_seconds: float = 1.0) -> None:
        self.engine = engine
        self.poll_seconds = max(0.25, float(poll_seconds))
        self._handlers: Dict[str, JobHandler] = {}
        self._session_factory = sessionmaker(bind=engine, class_=Session, expire_on_commit=False)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

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
            run_at=datetime.utcnow() + timedelta(seconds=max(0, int(run_after_seconds))),
            started_at=None,
            finished_at=None,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        logger.info("job enqueued", extra={"job_id": job.id, "job_type": job.job_type, "user_id": user_id})
        return job

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run_loop, name="db-job-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

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

    def _process_one(self) -> bool:
        with self._session_factory() as session:
            job = session.exec(
                select(Job)
                .where(Job.status.in_(["queued", "retrying"]))
                .where(Job.run_at <= datetime.utcnow())
                .order_by(Job.created_at.asc())
            ).first()
            if job is None:
                return False

            job.status = "running"
            job.started_at = datetime.utcnow()
            job.updated_at = datetime.utcnow()
            session.add(job)
            session.commit()
            session.refresh(job)

            handler = self._handlers.get(job.job_type)
            if handler is None:
                job.status = "failed"
                job.error_message = f"No handler registered for {job.job_type}"
                job.finished_at = datetime.utcnow()
                job.updated_at = datetime.utcnow()
                session.add(job)
                session.commit()
                return True

            try:
                payload = json.loads(job.payload_json or "{}") if job.payload_json else {}
                result = handler(session, payload)
                job.status = "completed"
                job.result_json = json.dumps(result or {}, ensure_ascii=False)
                job.finished_at = datetime.utcnow()
                job.updated_at = datetime.utcnow()
                session.add(job)
                session.commit()
                logger.info("job completed", extra={"job_id": job.id, "job_type": job.job_type, "user_id": job.user_id})
            except Exception as exc:
                session.rollback()
                job = session.get(Job, job.id)
                if job is None:
                    return True
                job.attempts = int(job.attempts or 0) + 1
                should_retry = job.attempts < int(job.max_attempts or 1)
                job.status = "retrying" if should_retry else "failed"
                job.error_message = str(exc)
                job.updated_at = datetime.utcnow()
                if should_retry:
                    backoff_seconds = min(60, 2 ** max(1, job.attempts))
                    job.run_at = datetime.utcnow() + timedelta(seconds=backoff_seconds)
                else:
                    job.finished_at = datetime.utcnow()
                session.add(job)
                session.commit()
                logger.exception(
                    "job execution failed",
                    extra={"job_id": job.id, "job_type": job.job_type, "user_id": job.user_id, "attempt": job.attempts},
                )
            return True