from __future__ import annotations

from decimal import Decimal
import json

import pytest
from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.billing.errors import BillingError
from app.billing.service import create_usage_reservation
from app.database import SessionLocal
from app.models import (
    Job,
    QACache,
    UsageCharge,
    WalletAccount,
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebKnowledgeNode,
    WebKnowledgeTriplet,
    WebUsagePreferences,
    WebUsageStage,
)
from app.web_ai.knowledge_jobs import (
    PaidEmbeddingResult,
    cancel_knowledge_job,
    enqueue_knowledge_job,
    handle_embedding_backfill,
)
from app.web_ai.evidence.pack_builder import build_evidence_pack
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.retrieval.evaluator import evaluate_retrieval
from app.web_ai.retrieval.hierarchical import build_hierarchy_for_document
from app.web_ai.retrieval.persistent_knowledge import (
    ApprovedKnowledgeChunk,
    PersistentKnowledgeRetriever,
    approve_persistent_knowledge,
    finalize_knowledge_ingest,
)
from app.web_ai.retrieval.triplet import extract_triplets_for_document
from app.web_ai.settings import TriagConfigurationError, TriagSettings
from app.web_ai.tier_policy import tier_policy_for
from app.web_ai.triage import TriageInput, build_execution_plan
from app.web_api.conversation_continuity import SameThreadContinuityDecision
from app.web_api.chat_service import execute_web_turn, prepare_web_turn
from app.web_api.upload_store import (
    EphemeralUpload,
    ExtractedChunk,
    InProcessEphemeralUploadStore,
    expiration_iso,
    utc_iso,
)
from tests.conftest import create_test_user
from tests.test_web_chat_api import _fund


def _approve(
    owner: int,
    *,
    source: str = "handbook",
    version: str = "v1",
    text: str = (
        "When the alarm is red, stop the machine. "
        "The log shows an overheat condition. Therefore inspect the coolant."
    ),
):
    with SessionLocal() as session:
        document = approve_persistent_knowledge(
            session,
            owner_user_id=owner,
            source_id=source,
            source_version=version,
            title="Private handbook",
            chunks=(
                ApprovedKnowledgeChunk(
                    text=text,
                    locator="handbook.md#safety",
                    section_path="Safety",
                ),
            ),
            user_approved=True,
            idempotency_key=f"{source}:{version}",
            safe_metadata={"candidate_count": 1},
        )
        finalize_knowledge_ingest(
            session,
            owner_user_id=owner,
            document_id=document.id,
            source_version=version,
        )
        session.commit()
        session.refresh(document)
        return document


def test_persistence_requires_explicit_approval_and_owner_isolation():
    first = create_test_user("knowledge-a", "knowledge-a@example.com")
    second = create_test_user("knowledge-b", "knowledge-b@example.com")
    with SessionLocal() as session:
        with pytest.raises(PermissionError):
            approve_persistent_knowledge(
                session,
                owner_user_id=int(first.id),
                source_id="source",
                source_version="v1",
                title="No approval",
                chunks=(ApprovedKnowledgeChunk("private", "note.txt"),),
                user_approved=False,
                idempotency_key="no",
            )
    _approve(int(first.id))
    retriever = PersistentKnowledgeRetriever(SessionLocal)
    owned = retriever.retrieve(
        query="overheat coolant",
        uploads=[],
        owner_user_id=int(first.id),
        limit=4,
    )
    foreign = retriever.retrieve(
        query="overheat coolant",
        uploads=[],
        owner_user_id=int(second.id),
        limit=4,
    )
    assert owned and all(item.owner_user_id == first.id for item in owned)
    assert foreign == ()
    assert all(dict(item.bounded_metadata)["cache_scope"] == "private" for item in owned)


def test_approved_knowledge_is_grounded_only_with_supported_citation():
    user = create_test_user(
        "knowledge-grounded", "knowledge-grounded@example.com"
    )
    _approve(
        int(user.id),
        text="Acceptance fact: TRIAG-library-acceptance-42.",
    )
    retriever = PersistentKnowledgeRetriever(SessionLocal)
    supported = retriever.retrieve(
        query="What is the acceptance fact? library acceptance 42",
        uploads=[],
        owner_user_id=int(user.id),
        limit=3,
    )
    assert len(supported) == 1
    assert supported[0].metadata_score >= 0.5
    supported_status, contradictions = evaluate_retrieval(supported)
    assert supported_status == "sufficient"
    pack = build_evidence_pack(
        owner_user_id=int(user.id),
        request_id="knowledge-grounded-request",
        candidates=supported,
        status=supported_status,
        contradictions=contradictions,
        status_codes=("knowledge_lexical",),
        token_cap=512,
    )
    result = AnswerGuard().check(
        "The acceptance fact is TRIAG-library-acceptance-42 [S1].",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="State the acceptance fact.",
            evidence_pack=pack,
            verified_buffered=True,
        ),
    )
    assert result.status == "grounded"
    assert all(
        check.status not in {"failed", "error"} for check in result.checks
    )

    unsupported = retriever.retrieve(
        query="What is the absent launch city? nonce-not-in-library",
        uploads=[],
        owner_user_id=int(user.id),
        limit=3,
    )
    unsupported_status, unsupported_contradictions = evaluate_retrieval(
        unsupported
    )
    assert unsupported_status == "insufficient"
    unsupported_pack = build_evidence_pack(
        owner_user_id=int(user.id),
        request_id="knowledge-unsupported-request",
        candidates=unsupported,
        status=unsupported_status,
        contradictions=unsupported_contradictions,
        status_codes=("knowledge_lexical",),
        token_cap=512,
    )
    unsupported_quality = AnswerGuard().check(
        "The saved sources do not provide a supported launch city.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="State the launch city.",
            evidence_pack=unsupported_pack,
            verified_buffered=True,
        ),
    )
    assert unsupported_quality.status == "insufficient_evidence"


def test_temporary_upload_raw_text_never_creates_persistent_rows():
    user = create_test_user("knowledge-temp", "knowledge-temp@example.com")
    store = InProcessEphemeralUploadStore(ttl_seconds=60)
    store.put(
        EphemeralUpload(
            id="temporary-only",
            owner_user_id=int(user.id),
            name="temporary.pdf",
            extension=".pdf",
            media_type="application/pdf",
            size_bytes=20,
            created_at=utc_iso(),
            expires_at=expiration_iso(60),
            chunks=[ExtractedChunk(text="private temporary raw body", source="page 1")],
            source_locators=["page 1"],
            warnings=[],
        )
    )
    assert store.get("temporary-only") is not None
    with SessionLocal() as session:
        assert session.exec(
            select(WebKnowledgeDocument).where(
                WebKnowledgeDocument.owner_user_id == int(user.id)
            )
        ).all() == []
        assert session.exec(
            select(WebKnowledgeChunk).where(
                WebKnowledgeChunk.owner_user_id == int(user.id)
            )
        ).all() == []


def test_source_update_invalidates_derived_rows_embeddings_and_owner_cache():
    user = create_test_user("knowledge-version", "knowledge-version@example.com")
    first = _approve(int(user.id))
    with SessionLocal() as session:
        chunk = session.exec(
            select(WebKnowledgeChunk).where(WebKnowledgeChunk.document_id == first.id)
        ).one()
        chunk.embedding_json = "[1,0]"
        chunk.embedding_status = "ready"
        session.add(chunk)
        session.add(
            WebKnowledgeTriplet(
                document_id=first.id, chunk_id=chunk.id, owner_user_id=int(user.id),
                source_version="v1", condition_text="if x", proof_text="proof",
                conclusion_text="then y", extraction_version="triplet-v1",
                confidence=0.5, content_hash="a" * 64,
                source_locator=chunk.source_locator,
            )
        )
        session.add(
            WebKnowledgeNode(
                document_id=first.id,
                owner_user_id=int(user.id),
                source_version="v1",
                node_kind="raw_chunk",
                raw_chunk_id=chunk.id,
                token_count=chunk.token_count,
                ordinal=chunk.chunk_index,
                content_hash=chunk.content_hash,
                source_locator=chunk.source_locator,
            )
        )
        session.add(QACache(user_id=int(user.id), question="old", answer="old"))
        session.commit()
    _approve(
        int(user.id), version="v2",
        text="Updated source content replaces every prior derived artifact.",
    )
    with SessionLocal() as session:
        old = session.get(WebKnowledgeDocument, first.id)
        old_chunk = session.exec(
            select(WebKnowledgeChunk).where(WebKnowledgeChunk.document_id == first.id)
        ).one()
        triplet = session.exec(
            select(WebKnowledgeTriplet).where(
                WebKnowledgeTriplet.document_id == first.id
            )
        ).one()
        node = session.exec(
            select(WebKnowledgeNode).where(
                WebKnowledgeNode.document_id == first.id
            )
        ).one()
        assert old.status == "invalidated"
        assert old_chunk.status == "invalidated"
        assert old_chunk.embedding_json is None
        assert triplet.status == "invalidated"
        assert node.status == "invalidated"
        assert session.exec(select(QACache).where(QACache.user_id == user.id)).all() == []


def test_triplets_anchor_exact_raw_chunk_and_failed_extraction_falls_back_raw():
    user = create_test_user("knowledge-triplet", "knowledge-triplet@example.com")
    document = _approve(int(user.id))
    with SessionLocal() as session:
        result = extract_triplets_for_document(
            session,
            owner_user_id=int(user.id),
            document_id=document.id,
            source_version="v1",
        )
        session.commit()
        triplet = session.exec(
            select(WebKnowledgeTriplet).where(
                WebKnowledgeTriplet.document_id == document.id
            )
        ).one()
        raw = session.get(WebKnowledgeChunk, triplet.chunk_id)
        assert result["created"] == 1
        assert raw is not None
        assert triplet.source_locator == raw.source_locator
    second = _approve(
        int(user.id), source="plain", text="A single statement without a relation"
    )
    with SessionLocal() as session:
        result = extract_triplets_for_document(
            session,
            owner_user_id=int(user.id),
            document_id=second.id,
            source_version="v1",
        )
        session.commit()
        assert result["created"] == 0
    candidates = PersistentKnowledgeRetriever(SessionLocal).retrieve(
        query="single statement relation",
        uploads=[],
        owner_user_id=int(user.id),
        limit=5,
    )
    assert any(item.source_locator == "handbook.md#safety" for item in candidates)


def test_hierarchy_is_token_bounded_and_raw_chunk_anchored():
    user = create_test_user("knowledge-hierarchy", "knowledge-hierarchy@example.com")
    document = _approve(int(user.id), text="word " * 2000)
    with SessionLocal() as session:
        result = build_hierarchy_for_document(
            session,
            owner_user_id=int(user.id),
            document_id=document.id,
            source_version="v1",
            token_cap=64,
        )
        session.commit()
        nodes = session.exec(
            select(WebKnowledgeNode).where(
                WebKnowledgeNode.document_id == document.id
            )
        ).all()
        raw_nodes = [node for node in nodes if node.node_kind == "raw_chunk"]
        assert result["summary_token_count"] <= 64
        assert sum(
            node.token_count
            for node in nodes
            if node.node_kind != "raw_chunk"
        ) <= 64
        assert raw_nodes and all(node.raw_chunk_id for node in raw_nodes)
        assert all(not node.summary_text for node in raw_nodes)


def test_dense_failure_is_lexical_fallback_and_never_crosses_owner():
    user = create_test_user("knowledge-dense", "knowledge-dense@example.com")
    _approve(int(user.id))
    called = 0

    def unavailable(_: str) -> list[float]:
        nonlocal called
        called += 1
        raise RuntimeError("provider secret must not escape")

    results = PersistentKnowledgeRetriever(
        SessionLocal,
        query_embedding=unavailable,
        dense_accounted=True,
    ).retrieve(
        query="coolant",
        uploads=[],
        owner_user_id=int(user.id),
        limit=3,
    )
    # SQLite has no pgvector capability, so the paid query callback is not
    # invoked at all and raw lexical retrieval remains available.
    assert called == 0
    assert results and results[0].lexical_score > 0


def test_job_idempotency_and_cancellation_are_owner_scoped():
    user = create_test_user("knowledge-job", "knowledge-job@example.com")
    other = create_test_user("knowledge-job-other", "knowledge-job-other@example.com")
    document = _approve(int(user.id))
    with SessionLocal() as session:
        first = enqueue_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_type="web_hierarchy_build",
            document_id=document.id,
            source_version="v1",
            idempotency_key="hierarchy:v1",
        )
        second = enqueue_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_type="web_hierarchy_build",
            document_id=document.id,
            source_version="v1",
            idempotency_key="hierarchy:v1",
        )
        assert first.id == second.id
        with pytest.raises(PermissionError):
            cancel_knowledge_job(
                session, owner_user_id=int(other.id), job_id=int(first.id)
            )
        cancelled = cancel_knowledge_job(
            session, owner_user_id=int(user.id), job_id=int(first.id)
        )
        session.commit()
        assert cancelled.status == "cancelled"


def test_unaccounted_embedding_job_makes_no_provider_call(monkeypatch):
    monkeypatch.setenv("WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED", "true")
    user = create_test_user("knowledge-no-hidden", "knowledge-no-hidden@example.com")
    document = _approve(int(user.id))
    calls = 0

    def provider(_):
        nonlocal calls
        calls += 1
        raise AssertionError("must not be called")

    with SessionLocal() as session:
        result = handle_embedding_backfill(
            session,
            {
                "owner_user_id": int(user.id),
                "document_id": document.id,
                "source_version": "v1",
                "job_version": "v1",
            },
            provider=provider,
        )
    assert result["reason"] == "embedding_budget_unavailable"
    assert calls == 0


def test_paid_embedding_stage_settles_parent_exactly_once(monkeypatch):
    monkeypatch.setenv("WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED", "true")
    user = create_test_user("knowledge-paid", "knowledge-paid@example.com")
    document = _approve(int(user.id))
    with SessionLocal() as session:
        wallet = WalletAccount(
            user_id=int(user.id), credit_bucket="chat",
            balance_micros=50_000, reserved_micros=0,
        )
        session.add(wallet)
        session.flush()
        charge = create_usage_reservation(
            session,
            request_id="knowledge-embed-request",
            user_id=int(user.id),
            thread_id=None,
            provider="internal",
            model="embedding",
            reserved_micros=1_000,
            pricing_snapshot_json="{}",
        )
        session.commit()
        charge_id = charge.id

    calls = 0

    def provider(texts):
        nonlocal calls
        calls += 1
        return PaidEmbeddingResult(
            vectors=tuple((1.0,) + (0.0,) * 1535 for _ in texts),
            provider="embedding_provider",
            model="embedding_model",
            input_tokens=17,
            native_cost_amount=Decimal("0.0002"),
            native_cost_currency="USD",
            micro_inr_cost=250,
        )

    payload = {
        "owner_user_id": int(user.id),
        "document_id": document.id,
        "source_version": "v1",
        "job_version": "v1",
        "request_id": "knowledge-embed-request",
        "usage_charge_id": charge_id,
    }
    with SessionLocal() as session:
        result = handle_embedding_backfill(session, payload, provider=provider)
        session.commit()
        assert result["embedded"] == 1
    with SessionLocal() as session:
        stage = session.exec(
            select(WebUsageStage).where(
                WebUsageStage.request_id == "knowledge-embed-request"
            )
        ).one()
        charge = session.get(UsageCharge, charge_id)
        assert stage.status == "settled"
        assert stage.usage_charge_id == charge_id
        assert stage.debited_micros == 250
        assert "coolant" not in stage.safe_metadata_json.lower()
        assert charge.status == "settled"
        assert charge.debited_micros == 250
    with SessionLocal() as session:
        again = handle_embedding_backfill(session, payload, provider=provider)
        session.commit()
        assert again["embedded"] == 0
    assert calls == 1


def test_flags_are_disabled_and_private_plan_is_not_global_cacheable():
    settings = TriagSettings.from_environ({})
    assert settings.persistent_knowledge_enabled is False
    assert settings.rag_triplet_enabled is False
    assert settings.rag_hierarchy_enabled is False
    live = {
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_RAG_HYBRID_ENABLED": "true",
        "WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED": "true",
    }
    plan = build_execution_plan(
        TriageInput(
            message="Use my saved handbook to explain the coolant rule",
            selected_tier="pro",
            reply_language="en",
            continuity=SameThreadContinuityDecision(
                mode="explicit_only", use_context=False,
                reason="standalone", confidence=1.0, preferred_turn_count=0,
            ),
            persistent_knowledge_available_tokens=500,
        ),
        settings=TriagSettings.from_environ(live),
    )
    assert "knowledge" in plan.retrieval_sources
    assert plan.cache_eligible is False
    assert tier_policy_for("lite").persistent_knowledge_allowed is False


def test_retrieval_score_settings_clamp_and_bad_values_use_defaults():
    clamped = TriagSettings.from_environ({
        "WEB_TRIAG_SEMANTIC_SUFFICIENCY_THRESHOLD": "2.5",
        "WEB_TRIAG_KNOWLEDGE_METADATA_SCORE": "-0.25",
    })
    assert clamped.semantic_sufficiency_threshold == 1.0
    assert clamped.knowledge_metadata_score == 0.0

    defaults = TriagSettings.from_environ({
        "WEB_TRIAG_SEMANTIC_SUFFICIENCY_THRESHOLD": "not-a-number",
        "WEB_TRIAG_KNOWLEDGE_METADATA_SCORE": "nan",
    })
    assert defaults.semantic_sufficiency_threshold == 0.55
    assert defaults.knowledge_metadata_score == 0.5


def test_unrelated_pro_request_does_not_plan_private_knowledge():
    live = TriagSettings.from_environ({
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_RAG_HYBRID_ENABLED": "true",
        "WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED": "true",
    })
    plan = build_execution_plan(
        TriageInput(
            message=(
                "Debug this architecture and perform a Pro technical review "
                "of its concurrency and cancellation races."
            ),
            selected_tier="pro",
            reply_language="en",
            continuity=SameThreadContinuityDecision(
                mode="explicit_only", use_context=False,
                reason="standalone", confidence=1.0,
                preferred_turn_count=0,
            ),
            persistent_knowledge_available_tokens=500,
            persistent_knowledge_lexical_relevance=0.0,
        ),
        settings=live,
    )
    assert plan.deterministic is False
    assert plan.token_allocation.document_tokens == 0
    assert "knowledge" not in plan.retrieval_sources
    assert "documents" not in plan.retrieval_sources


def test_unrelated_pro_request_with_saved_knowledge_calls_provider(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "false")
    monkeypatch.setenv("WEB_RAG_HYBRID_ENABLED", "true")
    monkeypatch.setenv("WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user("knowledge-unrelated", "knowledge-u@example.com")
    _approve(int(user.id))
    _fund(int(user.id))
    with SessionLocal() as session:
        session.add(WebUsagePreferences(
            user_id=int(user.id), assistant_tier="standard"
        ))
        session.commit()
    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            calls += 1
            return AIProviderResponse(
                text="Technical review completed.",
                provider=route.provider,
                model=route.model,
                route=route.route,
                reason=route.reason,
                language="en",
                intent=route.intent,
                input_tokens=12,
                output_tokens=5,
                raw={"usage_actual": True, "finish_reason": "stop"},
            )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message=(
            "Debug this architecture and review its concurrency cancellation "
            "races."
        ),
        request_id="knowledge-unrelated-provider-request",
        thread_id=None,
        reply_language="en",
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()}
    )
    assert calls == 1
    assert completed.message.content == "Technical review completed."
    assert prepared.optimization is not None
    assert prepared.optimization.cache_eligible is False
    assert prepared.execution_plan is not None
    assert "knowledge" not in prepared.execution_plan.retrieval_sources
    assert prepared.retrieval_context is None


def _enable_knowledge_dense(monkeypatch):
    for name, value in {
        "APP_ENV": "test",
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_RAG_HYBRID_ENABLED": "true",
        "WEB_RAG_DENSE_ENABLED": "true",
        "WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED": "true",
    }.items():
        monkeypatch.setenv(name, value)


def _knowledge_turn_user(suffix: str):
    user = create_test_user(
        f"knowledge-embedding-{suffix}",
        f"knowledge-embedding-{suffix}@example.com",
    )
    _approve(int(user.id), source=f"knowledge-embedding-{suffix}")
    _fund(int(user.id))
    with SessionLocal() as session:
        session.add(WebUsagePreferences(
            user_id=int(user.id), assistant_tier="standard"
        ))
        session.commit()
    return user


def test_knowledge_only_turn_reserves_embedding_stage(monkeypatch):
    _enable_knowledge_dense(monkeypatch)
    user = _knowledge_turn_user("reserved")
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="From my Knowledge Library, explain the coolant rule.",
        request_id="knowledge-only-embedding-reserved",
        thread_id=None,
        reply_language="en",
    )
    assert prepared.retrieval_uploads == ()
    assert prepared.execution_plan is not None
    assert "knowledge" in prepared.execution_plan.retrieval_sources
    assert "embedding" in prepared.execution_plan.planned_usage_stages
    assert prepared.embedding_accounted is True
    with SessionLocal() as session:
        stage = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "knowledge-only-embedding-reserved",
            WebUsageStage.stage_name == "embedding",
        )).one()
        assert stage.status == "reserved"
        assert stage.usage_charge_id is not None


def test_knowledge_only_embedding_billing_error_skips_stage(monkeypatch):
    _enable_knowledge_dense(monkeypatch)
    user = _knowledge_turn_user("billing-error")

    def reserve(*args, **kwargs):
        if str(kwargs.get("request_id") or "").endswith(":embedding"):
            raise BillingError("embedding reservation unavailable")
        return create_usage_reservation(*args, **kwargs)

    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation", reserve
    )
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="From my Knowledge Library, explain the coolant rule.",
        request_id="knowledge-only-embedding-skipped",
        thread_id=None,
        reply_language="en",
    )
    assert prepared.execution_plan is not None
    assert "knowledge" in prepared.execution_plan.retrieval_sources
    assert prepared.embedding_accounted is False
    with SessionLocal() as session:
        stage = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "knowledge-only-embedding-skipped",
            WebUsageStage.stage_name == "embedding",
        )).one()
        assert stage.status == "skipped"
        assert "embedding_budget_unavailable" in stage.safe_metadata_json


def test_turn_without_uploads_or_knowledge_reserves_no_embedding(monkeypatch):
    _enable_knowledge_dense(monkeypatch)
    user = create_test_user(
        "embedding-not-planned", "embedding-not-planned@example.com"
    )
    _fund(int(user.id))
    with SessionLocal() as session:
        session.add(WebUsagePreferences(
            user_id=int(user.id), assistant_tier="pro"
        ))
        session.commit()
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain how mutex fairness works in a general system.",
        request_id="embedding-not-planned",
        thread_id=None,
        reply_language="en",
    )
    assert prepared.execution_plan is not None
    assert "knowledge" not in prepared.execution_plan.retrieval_sources
    assert "documents" not in prepared.execution_plan.retrieval_sources
    assert prepared.embedding_accounted is False
    with SessionLocal() as session:
        stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "embedding-not-planned",
            WebUsageStage.stage_name == "embedding",
        )).all()
        assert stages == []


def test_knowledge_job_batch_configuration_is_bounded_without_value_leak():
    with pytest.raises(TriagConfigurationError) as error:
        TriagSettings.from_environ({"WEB_KNOWLEDGE_JOB_BATCH_SIZE": "999-secret"})
    assert "WEB_KNOWLEDGE_JOB_BATCH_SIZE" in str(error.value)
    assert "999-secret" not in str(error.value)
