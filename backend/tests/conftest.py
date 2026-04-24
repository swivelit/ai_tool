from __future__ import annotations

import os
from pathlib import Path


TEST_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "db" / "pytest.sqlite3"
TEST_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Keep pytest isolated from developer/staging/production config values in .env.
# app.database calls load_dotenv(), which does not override existing environment
# variables, so these must be set before any app modules are imported.
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"
os.environ["AUTO_CREATE_TABLES"] = "true"
os.environ["JOB_WORKER_ENABLED"] = "false"
os.environ["RAG_ENABLE_FAST_RAG_SEMANTIC"] = "false"
os.environ["OPENAI_API_KEY"] = ""
os.environ["SARVAM_API_KEY"] = ""
os.environ["SENTRY_DSN"] = ""
os.environ["AUTH_ALLOW_DEV_TOKENS"] = "true"


import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, delete

from app.database import SessionLocal, engine
from app.main import app, _get_job_queue
from app.models import Conversation, DailyRoutine, Item, Job, QACache, RagEmbedding, User, UserProfile


def auth_headers(uid: str, email: str | None = None) -> dict[str, str]:
    token = f"dev:{uid}:{email or ''}" if email else f"dev:{uid}"
    return {"Authorization": f"Bearer {token}"}


def create_test_user(uid: str = "test-uid", email: str = "test@example.com", name: str = "Test User") -> User:
    with SessionLocal() as session:
        user = User(
            firebase_uid=uid,
            email=email,
            name=name,
            timezone="Asia/Kolkata",
            assistant_name="Elli",
            reply_language="en",
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user


@pytest.fixture(autouse=True)
def clean_db():
    SQLModel.metadata.create_all(engine)
    queue = _get_job_queue()
    queue.stop()
    with SessionLocal() as session:
        for model in [Job, RagEmbedding, Conversation, QACache, Item, DailyRoutine, UserProfile, User]:
            session.exec(delete(model))
        session.commit()
    yield
    queue.stop()
    with SessionLocal() as session:
        for model in [Job, RagEmbedding, Conversation, QACache, Item, DailyRoutine, UserProfile, User]:
            session.exec(delete(model))
        session.commit()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr("app.main._async_jobs_available", lambda: True)
    with TestClient(app) as test_client:
        _get_job_queue().stop()
        yield test_client
