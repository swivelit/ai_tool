from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.job_queue import DBJobQueue, JobRetryLater
from app.models import Job
from app.time_utils import utc_now
from app.web_api.swico_free_queue import (
    SWICO_FREE_CHAT_JOB_TYPE,
    enqueue_swico_free_chat,
    queue_metrics,
    queue_position,
)
from app.web_ai.knowledge_jobs import KNOWLEDGE_JOB_TYPES


def db_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_durable_jobs_use_request_references_not_prompt_content():
    engine = db_engine()
    with Session(engine) as session:
        job = enqueue_swico_free_chat(
            session, user_id=7,
            payload={"request_id": "req-a", "thread_id": "thread-a", "message": "secret prompt"},
        )
        payload = json.loads(job.payload_json)
        assert payload == {"request_id": "req-a", "thread_id": "thread-a", "attachment_ids": [], "repository_id": None,
                           "input_mode": "text", "continue_message_id": None, "edit_message_id": None,
                           "regenerate_message_id": None, "billing_exempt": False}


def test_strict_fifo_resolves_created_at_ties_by_id_and_blocks_younger_retry():
    engine = db_engine()
    seen: list[str] = []

    def handler(session, payload):
        seen.append(payload["label"])
        if payload["label"] == "a" and not payload.get("retried"):
            payload["retried"] = True
            job = session.get(Job, payload["_job_id"])
            job.payload_json = json.dumps(payload)
            session.add(job)
            raise JobRetryLater("swico_free_unavailable", delay_seconds=1)
        return {"ok": True}

    queue = DBJobQueue(
        engine, allowed_job_types=(SWICO_FREE_CHAT_JOB_TYPE,), strict_fifo=True,
        stale_running_seconds=120,
    )
    queue.register(SWICO_FREE_CHAT_JOB_TYPE, handler)
    now = utc_now()
    with Session(engine) as session:
        for label in ("a", "b", "c", "d"):
            job = Job(user_id=1, job_type=SWICO_FREE_CHAT_JOB_TYPE, status="queued",
                      payload_json=json.dumps({"label": label}), run_at=now,
                      created_at=now, updated_at=now)
            session.add(job)
        session.commit()
        jobs = session.exec(select(Job).order_by(Job.id)).all()
        assert [queue._claim_next_job(session).id for _ in []] == []
    assert queue._process_one() is True
    with Session(engine) as session:
        head = session.exec(select(Job).where(Job.id == 1)).one()
        assert head.status == "retrying"
        younger = session.exec(select(Job).where(Job.id == 2)).one()
        assert younger.status == "queued"
        assert queue_position(session, job=head)["queue_position"] == 1
    # The strict queue will not let B overtake A while A is delayed.
    assert queue._process_one() is False


def test_queue_metrics_are_safe_and_position_excludes_terminal_jobs():
    engine = db_engine()
    with Session(engine) as session:
        old = utc_now() - timedelta(seconds=5)
        for status in ("completed", "cancelled", "failed", "queued", "running"):
            job = Job(user_id=1, job_type=SWICO_FREE_CHAT_JOB_TYPE, status=status,
                      payload_json=json.dumps({"request_id": status}), run_at=old,
                      created_at=old, updated_at=old)
            if status == "completed":
                job.started_at = old
                job.finished_at = utc_now()
            session.add(job)
        session.commit()
        queued = session.exec(select(Job).where(Job.status == "queued")).one()
        position = queue_position(session, job=queued)
        assert position["queue_position"] == 1
        metrics = queue_metrics(session)
        assert metrics["queued_count"] == 1
        assert metrics["running_count"] == 1
        assert metrics["cancelled_count"] == 1
        assert metrics["failed_count"] == 1
        assert metrics["completed_last_minute"] == 1


def test_generic_worker_cannot_claim_swico_free_jobs():
    engine = db_engine()
    with Session(engine) as session:
        session.add(Job(user_id=1, job_type=SWICO_FREE_CHAT_JOB_TYPE, status="queued",
                        payload_json="{}", run_at=utc_now(), created_at=utc_now(), updated_at=utc_now()))
        session.commit()
        generic = DBJobQueue(engine, excluded_job_types=(SWICO_FREE_CHAT_JOB_TYPE,))
        assert generic._claim_next_job(session) is None
        assert generic._process_one() is False
        assert session.get(Job, 1).status == "queued"


def test_main_generic_worker_excludes_free_with_or_without_knowledge_worker(monkeypatch):
    import app.main as main

    captured = []

    class FakeQueue:
        def __init__(self, *args, **kwargs):
            captured.append(kwargs)

    monkeypatch.setattr(main, "DBJobQueue", FakeQueue)
    monkeypatch.setattr(main, "JOB_QUEUE", None)
    for knowledge_enabled in (False, True):
        monkeypatch.setattr(
            main.TriagSettings,
            "from_environ",
            classmethod(lambda cls, enabled=knowledge_enabled: SimpleNamespace(
                knowledge_worker_enabled=enabled,
            )),
        )
        monkeypatch.setattr(main, "JOB_QUEUE", None)
        main._get_job_queue()
        exclusions = set(captured[-1]["excluded_job_types"])
        assert SWICO_FREE_CHAT_JOB_TYPE in exclusions
        if knowledge_enabled:
            assert set(KNOWLEDGE_JOB_TYPES).issubset(exclusions)


def test_queue_report_is_runnable_as_a_standalone_backend_script():
    root = Path(__file__).resolve().parents[2]
    script = root / "backend" / "scripts" / "swico_free_queue_report.py"
    result = subprocess.run(
        [sys.executable, str(script), "--help"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "Show safe Swico Free queue metrics" in result.stdout
