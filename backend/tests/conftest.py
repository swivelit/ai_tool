from __future__ import annotations

import os
from pathlib import Path
import tempfile


TEST_DB_PATH = Path(tempfile.mkdtemp(prefix="swico-pytest-db-")) / "pytest.sqlite3"
TEST_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Keep pytest isolated from developer/staging/production config values in .env.
# app.database calls load_dotenv(), which does not override existing environment
# variables, so these must be set before any app modules are imported.
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL", f"sqlite:///{TEST_DB_PATH.as_posix()}")
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
os.environ["WEB_TURN_OPTIMIZER_ENABLED"] = "true"
os.environ["WEB_SIMPLE_TURN_TIER_DOWNSHIFT_ENABLED"] = "false"
os.environ["WEB_SAME_THREAD_CONTEXT_MODE"] = "explicit_only"
os.environ["WEB_SWICO_BRAND_GUARD_ENABLED"] = "true"
os.environ["WEB_CONTEXT_MAX_TURNS"] = "2"
os.environ["WEB_CONTEXT_MAX_CHARS"] = "900"
os.environ["WEB_PROFILE_PROMPT_MAX_CHARS"] = "500"
os.environ["WEB_SIMPLE_MAX_OUTPUT_TOKENS"] = "220"
os.environ["WEB_NORMAL_MAX_OUTPUT_TOKENS"] = "320"
os.environ["WEB_DETAILED_MAX_OUTPUT_TOKENS"] = "700"
os.environ["WEB_CACHE_BEFORE_BILLING_ENABLED"] = "true"
os.environ["WEB_PROMPT_CACHE_ENABLED"] = "false"
os.environ["WEB_PROMPT_CACHE_VERSION"] = "v1"
os.environ["WEB_MAX_PROVIDER_ATTEMPTS"] = "2"
os.environ["WEB_ATTACHMENTS_ENABLED"] = "true"
os.environ["WEB_VOICE_RECORDING_ENABLED"] = "true"
os.environ["WEB_VOICE_REPLY_ENABLED"] = "true"
os.environ["WEB_VOICE_BILLING_ENABLED"] = "true"
os.environ["WEB_REALTIME_VOICE_ENABLED"] = "false"
os.environ["WEB_SEPARATE_VOICE_CREDITS_ENABLED"] = "false"
os.environ["WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS"] = "60"
os.environ["WEB_REALTIME_VOICE_MAX_SESSION_SECONDS"] = "900"
os.environ["WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS"] = "60"
os.environ["WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER"] = "1"
os.environ["WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["WEB_UPLOAD_TTL_SECONDS"] = "300"
os.environ["WEB_UPLOAD_MAX_FILE_BYTES"] = "10485760"
os.environ["WEB_UPLOAD_MAX_FILES_PER_MESSAGE"] = "5"
os.environ["WEB_UPLOAD_MAX_TOTAL_BYTES"] = "26214400"
os.environ["WEB_UPLOAD_MAX_EXTRACTED_CHARS"] = "100000"
os.environ["WEB_ATTACHMENT_PROMPT_MAX_CHARS"] = "8000"
os.environ["WEB_AUDIO_MAX_SECONDS"] = "30"
os.environ["WEB_TTS_MAX_CHARACTERS"] = "5000"
os.environ["WEB_STT_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["WEB_TTS_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["WEB_UPLOAD_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["RAZORPAY_KEY_ID"] = "rzp_test_public"
os.environ["RAZORPAY_KEY_SECRET"] = "test_checkout_secret"
os.environ["RAZORPAY_WEBHOOK_SECRET"] = "test_webhook_secret"
os.environ["RAZORPAY_MODE"] = "test"
os.environ["BILLING_CHECKOUT_ENABLED"] = "true"
os.environ["BILLING_MIN_TOPUP_PAISE"] = "1500"
os.environ["BILLING_MAX_TOPUP_PAISE"] = "50000"
os.environ["BILLING_TOPUP_PACKAGES_PAISE"] = "1500,29900"
os.environ["BILLING_ENFORCE_TOPUP_PACKAGES"] = "false"
os.environ["SWICO_DEFAULT_TIER"] = "lite"
os.environ["SWICO_TIER_SELECTION_ENABLED"] = "true"
os.environ["SWICO_PRO_ENABLED"] = "false"
os.environ["SWICO_LITE_MODEL_PRIMARY"] = "gpt-5.4-mini"
os.environ["SWICO_LITE_MODEL_FALLBACKS"] = "gpt-5.4-nano"
os.environ["SWICO_STANDARD_MODEL_PRIMARY"] = "gpt-5.6-terra"
os.environ["SWICO_STANDARD_MODEL_FALLBACKS"] = "gpt-5.5"
os.environ["SWICO_PRO_MODEL_PRIMARY"] = "gpt-5.6-sol"
os.environ["SWICO_PRO_MODEL_FALLBACKS"] = "gpt-5.6-terra"
# Empty credential variables prevent load_dotenv() from importing a developer's
# local Firebase Admin path into the disposable test process. Individual auth
# tests still override these values with monkeypatch when exercising validation.
os.environ["FIREBASE_CREDENTIALS_JSON"] = ""
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = ""
for name in (
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
from app.models import AIUsageEvent, AgentRun, AgentStep, ApiRateLimit, CliAgentRun, CliAgentStep, CliDeviceGrant, CliPendingAction, CliSession, Conversation, DailyRoutine, DocumentArtifact, EmailOtpCode, GlobalQACache, GlobalQAObservation, GlobalQATombstone, Item, Job, OpenAIUsageLog, PaymentOrder, ProcessedWebhook, QACache, RagEmbedding, ReferralAttribution, ReferralCode, ReferralReward, SubscriptionEntitlement, SubscriptionPreference, SubscriptionUsageLedger, SubscriptionUsageWindow, UsageCharge, User, UserProfile, WalletAccount, WalletLedger, WebAnswerCheck, WebChatMessage, WebChatThread, WebCodeEdge, WebCodeFile, WebCodeRepository, WebCodeSymbol, WebConversationSummary, WebEvidenceItem, WebGuestSession, WebKnowledgeChunk, WebKnowledgeDocument, WebKnowledgeNode, WebKnowledgeTriplet, WebMemoryFact, WebMessageFeedback, WebRetrievalTrace, WebUsagePeriodLock, WebUsagePreferences, WebUsageStage

WEB_MODELS = [CliPendingAction, CliAgentStep, CliAgentRun, CliSession, CliDeviceGrant, WebKnowledgeNode, WebKnowledgeTriplet, WebKnowledgeChunk, WebKnowledgeDocument, WebCodeEdge, WebCodeSymbol, WebCodeFile, WebCodeRepository, WebEvidenceItem, WebAnswerCheck, WebUsageStage, WebRetrievalTrace, ProcessedWebhook, SubscriptionUsageLedger, SubscriptionUsageWindow, ReferralReward, ReferralAttribution, SubscriptionEntitlement, ReferralCode, WalletLedger, UsageCharge, WebMessageFeedback, WebMemoryFact, WebConversationSummary, WebChatMessage, WebChatThread, WebGuestSession, PaymentOrder, WalletAccount, ApiRateLimit, WebUsagePeriodLock, WebUsagePreferences, SubscriptionPreference]


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


@pytest.fixture(scope="session", autouse=True)
def fresh_sqlite_schema():
    """Keep the default disposable SQLite database aligned with current models.

    A fixed repository-local file let create_all preserve obsolete columns
    between test runs. Never reset an explicitly supplied TEST_DATABASE_URL;
    PostgreSQL integration runs own their disposable schema lifecycle.
    """
    if engine.dialect.name == "sqlite":
        SQLModel.metadata.drop_all(engine)
        SQLModel.metadata.create_all(engine)
    yield


@pytest.fixture(autouse=True)
def clean_db():
    from app.ai.model_health import clear_model_health
    from app.web_api.upload_store import reset_upload_store_for_tests
    from app.web_api.router import reset_voice_ticket_store_for_tests

    reset_upload_store_for_tests()
    reset_voice_ticket_store_for_tests()
    clear_model_health()
    SQLModel.metadata.create_all(engine)
    queue = _get_job_queue()
    queue.stop()
    with SessionLocal() as session:
        for model in [*WEB_MODELS, AgentStep, AgentRun, AIUsageEvent, OpenAIUsageLog, GlobalQAObservation, GlobalQATombstone, GlobalQACache, Job, RagEmbedding, Conversation, QACache, DocumentArtifact, Item, DailyRoutine, UserProfile, User, EmailOtpCode]:
            session.exec(delete(model))
        session.commit()
    yield
    reset_upload_store_for_tests()
    reset_voice_ticket_store_for_tests()
    clear_model_health()
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
