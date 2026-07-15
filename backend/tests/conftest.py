from __future__ import annotations

import os
from pathlib import Path


TEST_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "db" / "pytest.sqlite3"
TEST_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Keep pytest isolated from developer/staging/production config values in .env.
# app.database calls load_dotenv(), which does not override existing environment
# variables, so these must be set before any app modules are imported.
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"
os.environ["APP_ENV"] = "test"
os.environ["AUTO_CREATE_TABLES"] = "true"
os.environ["JOB_WORKER_ENABLED"] = "false"
os.environ["RAG_ENABLE_FAST_RAG_SEMANTIC"] = "false"
os.environ["OPENAI_API_KEY"] = ""
os.environ["GLOBAL_QA_CACHE_ENABLED"] = "true"
os.environ["GLOBAL_QA_PROMOTE_HITS"] = "2"
os.environ["GLOBAL_QA_MIN_SIMILARITY"] = "0.90"
os.environ["GLOBAL_QA_REQUIRE_DISTINCT_USERS"] = "true"
os.environ["AI_ROUTER_GLOBAL_CACHE_LOOKUP_ENABLED"] = "true"
os.environ["AI_ROUTER_GLOBAL_CACHE_RECORD_ENABLED"] = "true"
os.environ["USER_QA_SYNC_MIN_HITS"] = "2"
os.environ["USER_QA_SYNC_TTL_DAYS"] = "30"
os.environ["SARVAM_API_KEY"] = ""
os.environ["SENTRY_DSN"] = ""
os.environ["AUTH_ALLOW_DEV_TOKENS"] = "true"
os.environ["WEB_APP_ENABLED"] = "true"
os.environ["RAZORPAY_KEY_ID"] = "rzp_test_public"
os.environ["RAZORPAY_KEY_SECRET"] = "test_checkout_secret"
os.environ["RAZORPAY_WEBHOOK_SECRET"] = "test_webhook_secret"
for name in (
    "FIREBASE_CREDENTIALS_JSON",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT",
    "GCLOUD_PROJECT",
    "FIREBASE_CONFIG",
):
    os.environ.pop(name, None)


import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, delete

from app.database import SessionLocal, engine
from app.main import app, _get_job_queue
from app.models import AIUsageEvent, AgentRun, AgentStep, ApiRateLimit, Conversation, DailyRoutine, DocumentArtifact, EmailOtpCode, GlobalQACache, GlobalQAObservation, GlobalQATombstone, Item, Job, OpenAIUsageLog, PaymentOrder, ProcessedWebhook, QACache, RagEmbedding, UsageCharge, User, UserProfile, WalletAccount, WalletLedger, WebChatMessage, WebChatThread

WEB_MODELS = [ProcessedWebhook, WalletLedger, UsageCharge, WebChatMessage, WebChatThread, PaymentOrder, WalletAccount, ApiRateLimit]


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
        for model in [*WEB_MODELS, AgentStep, AgentRun, AIUsageEvent, OpenAIUsageLog, GlobalQAObservation, GlobalQATombstone, GlobalQACache, Job, RagEmbedding, Conversation, QACache, DocumentArtifact, Item, DailyRoutine, UserProfile, User, EmailOtpCode]:
            session.exec(delete(model))
        session.commit()
    yield
    queue.stop()
    with SessionLocal() as session:
        for model in [*WEB_MODELS, AgentStep, AgentRun, AIUsageEvent, OpenAIUsageLog, GlobalQAObservation, GlobalQATombstone, GlobalQACache, Job, RagEmbedding, Conversation, QACache, DocumentArtifact, Item, DailyRoutine, UserProfile, User, EmailOtpCode]:
            session.exec(delete(model))
        session.commit()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr("app.main._async_jobs_available", lambda: True)
    with TestClient(app) as test_client:
        _get_job_queue().stop()
        yield test_client
