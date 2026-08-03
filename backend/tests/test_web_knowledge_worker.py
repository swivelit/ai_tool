from __future__ import annotations

from decimal import Decimal
import json
from pathlib import Path

import pytest
import yaml
from sqlmodel import select

from app.database import SessionLocal, engine
from app.job_queue import DBJobQueue
from app.knowledge_worker import build_knowledge_worker_queues
from app.models import (
    Job,
    UsageCharge,
    WalletAccount,
    WalletLedger,
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebUsageStage,
)
from app.web_ai.knowledge_jobs import (
    KNOWLEDGE_JOB_TYPES,
    PaidEmbeddingResult,
    cancel_knowledge_job,
    enqueue_knowledge_job,
    handle_embedding_backfill,
)
from app.web_ai.retrieval.persistent_knowledge import (
    ApprovedKnowledgeChunk,
    PersistentKnowledgeRetriever,
    approve_persistent_knowledge,
    finalize_knowledge_ingest,
)
from app.web_ai.settings import TriagConfigurationError, TriagSettings
from tests.conftest import create_test_user


def _knowledge_flags(monkeypatch) -> None:
    monkeypatch.setenv("WEB_KNOWLEDGE_WORKER_ENABLED", "true")
    monkeypatch.setenv("WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED", "true")
    monkeypatch.setenv("WEB_RAG_DENSE_ENABLED", "true")
    monkeypatch.setenv("WEB_RAG_HIERARCHY_ENABLED", "true")
    monkeypatch.setenv("WEB_RAG_TRIPLET_ENABLED", "true")


def _document(owner_user_id: int, *, ready: bool = True) -> WebKnowledgeDocument:
    with SessionLocal() as session:
        document = approve_persistent_knowledge(
            session,
            owner_user_id=owner_user_id,
            source_id=f"worker-source-{owner_user_id}",
            source_version="v1",
            title="Worker source",
            chunks=(
                ApprovedKnowledgeChunk(
                    text=(
                        "When the alarm is red, stop the machine. "
                        "The log proves overheating, therefore inspect coolant."
                    ),
                    locator="manual.md#safety",
                ),
            ),
            user_approved=True,
            idempotency_key=f"worker-approval-{owner_user_id}",
        )
        if ready:
            finalize_knowledge_ingest(
                session,
                owner_user_id=owner_user_id,
                document_id=document.id,
                source_version="v1",
            )
        session.commit()
        session.refresh(document)
        return document


def _fund(owner_user_id: int, micros: int = 100_000) -> None:
    with SessionLocal() as session:
        session.add(WalletAccount(
            user_id=owner_user_id,
            credit_bucket="chat",
            balance_micros=micros,
            reserved_micros=0,
        ))
        session.commit()


def _paid_result(texts) -> PaidEmbeddingResult:
    return PaidEmbeddingResult(
        vectors=tuple((1.0,) + (0.0,) * 1535 for _ in texts),
        provider="embedding_provider",
        model="embedding_model",
        input_tokens=19,
        native_cost_amount=Decimal("0.000003"),
        native_cost_currency="USD",
        micro_inr_cost=300,
    )


def test_job_type_claim_isolation_and_disabled_compatibility():
    user = create_test_user("worker-claims", "worker-claims@example.com")
    document = _document(int(user.id))
    with SessionLocal() as session:
        knowledge = enqueue_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_type="web_hierarchy_build",
            document_id=document.id,
            source_version="v1",
            idempotency_key="claim-knowledge",
            swico_tier="pro",
        )
        unrelated = Job(
            user_id=int(user.id),
            job_type="chat",
            payload_json="{}",
        )
        session.add(unrelated)
        session.commit()
        session.refresh(unrelated)
        knowledge_id = int(knowledge.id)
        unrelated_id = int(unrelated.id)

    dedicated = DBJobQueue(engine, allowed_job_types=KNOWLEDGE_JOB_TYPES)
    with SessionLocal() as session:
        claimed = dedicated._claim_next_job(session)
        assert claimed is not None and claimed.id == knowledge_id
    shared_separated = DBJobQueue(
        engine, excluded_job_types=KNOWLEDGE_JOB_TYPES
    )
    with SessionLocal() as session:
        claimed = shared_separated._claim_next_job(session)
        assert claimed is not None and claimed.id == unrelated_id

    with SessionLocal() as session:
        rows = session.exec(select(Job)).all()
        for row in rows:
            row.status = "queued"
            session.add(row)
        session.commit()
    shared_legacy = DBJobQueue(engine)
    with SessionLocal() as session:
        claimed = shared_legacy._claim_next_job(session)
        assert claimed is not None and claimed.id == knowledge_id


def test_provider_is_never_constructed_without_wallet_reservation(monkeypatch):
    _knowledge_flags(monkeypatch)
    user = create_test_user("worker-no-budget", "worker-no-budget@example.com")
    document = _document(int(user.id))
    job = _enqueue_embedding(int(user.id), document.id, "no-budget")
    factory_calls = 0

    def factory(_session, _payload):
        nonlocal factory_calls
        factory_calls += 1
        return _paid_result

    queue = _dedicated_queue(factory)
    assert queue._process_one() is True
    assert factory_calls == 0
    with SessionLocal() as session:
        completed = session.get(Job, job.id)
        assert completed is not None and completed.status == "completed"
        result = json.loads(completed.result_json or "{}")
        assert result["reason"] == "embedding_budget_unavailable"
        assert session.exec(select(UsageCharge)).all() == []


def test_exact_settlement_retry_restart_and_duplicate_job_protection(monkeypatch):
    _knowledge_flags(monkeypatch)
    monkeypatch.setenv("WEB_RAG_HIERARCHY_ENABLED", "false")
    monkeypatch.setenv("WEB_RAG_TRIPLET_ENABLED", "false")
    user = create_test_user("worker-paid", "worker-paid@example.com")
    document = _document(int(user.id))
    _fund(int(user.id))
    first = _enqueue_embedding(int(user.id), document.id, "paid-once")
    with SessionLocal() as session:
        duplicate = enqueue_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_type="web_embedding_backfill",
            document_id=document.id,
            source_version="v1",
            idempotency_key="paid-once",
            swico_tier="pro",
        )
        assert duplicate.id == first.id
    provider_calls = 0

    def factory(_session, _payload):
        def provider(texts):
            nonlocal provider_calls
            provider_calls += 1
            return _paid_result(texts)
        return provider

    assert _dedicated_queue(factory)._process_one() is True
    with SessionLocal() as session:
        original = session.get(Job, first.id)
        payload = json.loads(original.payload_json)
        session.add(Job(
            user_id=int(user.id),
            job_type="web_embedding_backfill",
            payload_json=json.dumps(payload, sort_keys=True),
        ))
        session.commit()
    # A new process/queue sees ready embeddings and cannot replay the provider.
    assert _dedicated_queue(factory)._process_one() is True
    assert provider_calls == 1
    with SessionLocal() as session:
        stage = session.exec(select(WebUsageStage)).one()
        charge = session.exec(select(UsageCharge)).one()
        debits = session.exec(
            select(WalletLedger).where(WalletLedger.entry_type == "usage_debit")
        ).all()
        assert stage.status == "settled"
        assert stage.debited_micros == 300
        assert charge.status == "settled"
        assert charge.provider_cost_micros == 300
        assert charge.debited_micros == 300
        assert len(debits) == 1


def test_billing_exempt_embedding_is_audited_without_wallet_debit(monkeypatch):
    _knowledge_flags(monkeypatch)
    email = "worker-exempt@example.com"
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", email)
    user = create_test_user("worker-exempt", email)
    document = _document(int(user.id))
    job = _enqueue_embedding(int(user.id), document.id, "exempt-once")

    assert _dedicated_queue(
        lambda _session, _payload: _paid_result,
    )._process_one() is True

    with SessionLocal() as session:
        completed = session.get(Job, job.id)
        charge = session.exec(select(UsageCharge)).one()
        debits = session.exec(
            select(WalletLedger).where(WalletLedger.entry_type == "usage_debit")
        ).all()
        assert completed is not None and completed.status == "completed"
        assert charge.status == "billing_exempt"
        assert charge.billing_exemption_reason == "internal_capability_test"
        assert charge.provider_cost_micros == 300
        assert charge.debited_micros == 0
        assert debits == []


def test_cancellation_before_and_during_embedding(monkeypatch):
    _knowledge_flags(monkeypatch)
    user = create_test_user("worker-cancel", "worker-cancel@example.com")
    document = _document(int(user.id))
    _fund(int(user.id))
    before = _enqueue_embedding(int(user.id), document.id, "cancel-before")
    with SessionLocal() as session:
        cancel_knowledge_job(
            session, owner_user_id=int(user.id), job_id=int(before.id)
        )
        session.commit()
    called = 0

    def unused_factory(_session, _payload):
        nonlocal called
        called += 1
        return _paid_result

    assert _dedicated_queue(unused_factory)._process_one() is False
    assert called == 0

    during = _enqueue_embedding(int(user.id), document.id, "cancel-during")

    def cancelling_factory(_session, payload):
        def provider(texts):
            with SessionLocal() as cancellation_session:
                cancel_knowledge_job(
                    cancellation_session,
                    owner_user_id=int(user.id),
                    job_id=int(payload["_job_id"]),
                )
                cancellation_session.commit()
            return _paid_result(texts)
        return provider

    assert _dedicated_queue(cancelling_factory)._process_one() is True
    with SessionLocal() as session:
        job = session.get(Job, during.id)
        stage = session.exec(select(WebUsageStage)).one()
        charge = session.exec(select(UsageCharge)).one()
        chunk = session.exec(
            select(WebKnowledgeChunk).where(
                WebKnowledgeChunk.document_id == document.id
            )
        ).one()
        assert job.status == "cancelled"
        assert stage.status == "settled"
        assert charge.status == "settled"
        assert charge.debited_micros == 300
        assert chunk.embedding_status == "missing"


def test_source_version_and_cross_owner_fail_closed(monkeypatch):
    _knowledge_flags(monkeypatch)
    user = create_test_user("worker-version", "worker-version@example.com")
    other = create_test_user("worker-foreign", "worker-foreign@example.com")
    document = _document(int(user.id))
    _fund(int(user.id))
    job = _enqueue_embedding(int(user.id), document.id, "source-change")

    def invalidating_factory(_session, _payload):
        def provider(texts):
            with SessionLocal() as source_session:
                source = source_session.get(WebKnowledgeDocument, document.id)
                source.status = "invalidated"
                source_session.add(source)
                source_session.commit()
            return _paid_result(texts)
        return provider

    assert _dedicated_queue(invalidating_factory)._process_one() is True
    with SessionLocal() as session:
        completed = session.get(Job, job.id)
        result = json.loads(completed.result_json or "{}")
        charge = session.exec(select(UsageCharge)).one()
        assert result["reason"] == "source_version_changed"
        assert charge.status == "settled"
        assert charge.debited_micros == 300

        source = session.get(WebKnowledgeDocument, document.id)
        source.status = "ready"
        session.add(source)
        foreign = Job(
            user_id=int(other.id),
            job_type="web_embedding_backfill",
            payload_json=json.dumps({
                "owner_user_id": int(other.id),
                "document_id": document.id,
                "source_version": "v1",
                "idempotency_key": "cross-owner",
                "job_version": "v1",
                "swico_tier": "pro",
            }),
        )
        session.add(foreign)
        session.commit()
        session.refresh(foreign)
        foreign_id = foreign.id
    calls = 0

    def forbidden_factory(_session, _payload):
        nonlocal calls
        calls += 1
        return _paid_result

    assert _dedicated_queue(forbidden_factory)._process_one() is True
    assert calls == 0
    with SessionLocal() as session:
        rejected = session.get(Job, foreign_id)
        assert rejected.status == "retrying"
        assert rejected.error_message == "knowledge_job_failed"


def test_failed_embedding_keeps_lexical_retrieval_and_chains_in_order(monkeypatch):
    _knowledge_flags(monkeypatch)
    user = create_test_user("worker-chain", "worker-chain@example.com")
    document = _document(int(user.id), ready=False)
    with SessionLocal() as session:
        ingest = enqueue_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_type="web_knowledge_ingest",
            document_id=document.id,
            source_version="v1",
            idempotency_key="chain-ingest",
            swico_tier="pro",
        )
    factory_calls = 0

    def no_budget_factory(_session, _payload):
        nonlocal factory_calls
        factory_calls += 1
        return _paid_result

    queue = _dedicated_queue(no_budget_factory)
    assert queue._process_one() is True
    assert _job_types_by_creation() == [
        "web_knowledge_ingest", "web_embedding_backfill"
    ]
    assert queue._process_one() is True
    assert _job_types_by_creation() == [
        "web_knowledge_ingest", "web_embedding_backfill",
        "web_hierarchy_build",
    ]
    assert factory_calls == 0
    results = PersistentKnowledgeRetriever(SessionLocal).retrieve(
        query="alarm coolant",
        uploads=[],
        owner_user_id=int(user.id),
        limit=3,
    )
    assert results and results[0].lexical_score > 0
    assert queue._process_one() is True
    assert _job_types_by_creation() == [
        "web_knowledge_ingest", "web_embedding_backfill",
        "web_hierarchy_build", "web_triplet_extract",
    ]
    assert queue._process_one() is True
    with SessionLocal() as session:
        assert all(
            row.status == "completed"
            for row in session.exec(select(Job)).all()
        )
        assert session.get(Job, ingest.id) is not None


def test_worker_settings_disabled_and_bounded_without_value_leak():
    settings = TriagSettings.from_environ({})
    assert settings.knowledge_worker_enabled is False
    assert settings.knowledge_worker_poll_seconds == 2
    assert settings.knowledge_worker_max_concurrency == 1
    assert build_knowledge_worker_queues(engine, settings) == ()
    with pytest.raises(TriagConfigurationError) as error:
        TriagSettings.from_environ({
            "WEB_KNOWLEDGE_WORKER_ENABLED": "maybe-secret",
            "WEB_KNOWLEDGE_WORKER_POLL_SECONDS": "secret",
            "WEB_KNOWLEDGE_WORKER_MAX_CONCURRENCY": "99-secret",
        })
    rendered = str(error.value)
    assert "WEB_KNOWLEDGE_WORKER_ENABLED" in rendered
    assert "WEB_KNOWLEDGE_WORKER_POLL_SECONDS" in rendered
    assert "WEB_KNOWLEDGE_WORKER_MAX_CONCURRENCY" in rendered
    assert "secret" not in rendered


def test_render_worker_has_minimal_secret_contract():
    blueprint = yaml.safe_load(
        (Path(__file__).resolve().parents[2] / "render.staging.yaml").read_text()
    )
    environment = blueprint["projects"][0]["environments"][0]
    services = environment["services"]
    worker = next(
        item for item in services
        if item.get("name") == "swico-knowledge-worker-staging"
    )
    assert worker["type"] == "worker"
    keys = {item["key"] for item in worker["envVars"]}
    assert {"DATABASE_URL", "OPENAI_API_KEY", "WEB_KNOWLEDGE_WORKER_ENABLED"} <= keys
    forbidden = {
        "GOOGLE_APPLICATION_CREDENTIALS",
        "FIREBASE_CREDENTIALS_JSON",
        "RAZORPAY_KEY_ID",
        "RAZORPAY_KEY_SECRET",
        "RAZORPAY_WEBHOOK_SECRET",
        "SMTP_HOST",
        "SMTP_PASSWORD",
        "DOWNLOAD_TOKEN_SECRET",
        "WEB_CODE_VALIDATOR_AUTH_TOKEN",
    }
    assert not (keys & forbidden)
    # Five services plus PostgreSQL is the documented six-resource staging set.
    assert len(services) + len(environment["databases"]) == 6


def _enqueue_embedding(owner: int, document_id: str, key: str) -> Job:
    with SessionLocal() as session:
        return enqueue_knowledge_job(
            session,
            owner_user_id=owner,
            job_type="web_embedding_backfill",
            document_id=document_id,
            source_version="v1",
            idempotency_key=key,
            swico_tier="pro",
        )


def _dedicated_queue(factory) -> DBJobQueue:
    return DBJobQueue(
        engine,
        allowed_job_types=KNOWLEDGE_JOB_TYPES,
        knowledge_embedding_provider_factory=factory,
        chain_knowledge_jobs=True,
    )


def _job_types_by_creation() -> list[str]:
    with SessionLocal() as session:
        return [
            row.job_type
            for row in session.exec(
                select(Job).order_by(Job.created_at, Job.id)
            ).all()
        ]
