from __future__ import annotations

from dataclasses import replace
import json
import logging

import pytest
from sqlmodel import Session, select

from app.ai.providers.base import GenerationCancelled, GenerationIncomplete
from app.ai.types import AIProviderResponse
from app.billing.errors import PaymentValidationError
from app.database import SessionLocal
from app.models import (
    UsageCharge, WebAnswerCheck, WebChatMessage, WebChatThread, WebUsageStage,
)
from app.web_ai.evidence.models import EvidenceItem, EvidencePack
from app.web_ai.generation.answer_guard import (
    AnswerGuard, AnswerGuardContext, ProviderCompletion,
)
from app.web_ai.generation.generator import VerifiedGenerator
from app.web_ai.generation.models import AnswerQualityResult, QualityCheck
from app.web_ai.generation.output_format import fenced_code_quality_check
from app.web_ai.generation.repair import build_repair_request
from app.web_ai.generation.task_requirements import (
    TaskRequirementContract, evaluate_architecture_coverage,
    extract_task_requirements, splice_architecture_section_repair,
)
from app.web_ai.persistence import get_or_create_usage_stage, persist_answer_quality
from app.web_ai.request_audit import build_request_audit
from app.web_ai.settings import TriagSettings
from app.web_ai.streaming_policy import StreamingPolicy
from app.web_ai.triage import AttachmentMetadata, TriageInput, build_execution_plan
from app.web_api.chat_service import (
    _missing_requested_private_identifier, _parse_verifier_status,
    execute_web_turn,
    prepare_web_turn,
    record_web_turn_lifecycle,
)
from app.web_api.conversation_continuity import SameThreadContinuityDecision
from tests.conftest import create_test_user
from tests.test_web_chat_api import _fund


def _pack(
    *,
    status: str = "sufficient",
    contradictions: tuple[str, ...] = (),
) -> EvidencePack:
    item = EvidenceItem(
        evidence_id="evidence-1",
        owner_user_id=1,
        source_type="temporary_upload",
        source_id="upload-1:0",
        ordinal=0,
        estimated_tokens=20,
        relevance_score=0.9,
        citation_label="S1",
        source_label="planets.pdf",
        source_locator="page 1",
        runtime_text="Saturn has prominent rings made mostly of ice.",
        content_hash="safe-hash",
    )
    return EvidencePack(
        owner_user_id=1,
        request_id="phase3",
        items=(item,),
        total_token_count=20,
        retrieval_status=status,  # type: ignore[arg-type]
        contradictions=contradictions,
        source_map=(("S1", "page 1"),),
    )


def test_turn_lifecycle_is_content_free_and_visible_in_request_audit(
    monkeypatch, caplog,
):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: None,
    )
    user = create_test_user("lifecycle-audit", "lifecycle-audit@example.com")
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain database indexes.",
        request_id="lifecycle-audit-request",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
    )
    caplog.set_level(logging.INFO, logger="app.web_api.chat_service")

    record_web_turn_lifecycle(prepared, "reserved")
    record_web_turn_lifecycle(
        prepared, "provider_started", reasoning_effort="medium"
    )

    with SessionLocal() as session:
        audit = build_request_audit(
            session, request_ids=[prepared.request_id]
        )[0]
    assert audit["reasoning_effort"] == "medium"
    assert audit["turn_lifecycle_stage"] == "provider_started"
    assert audit["turn_lifecycle_events"] == ["reserved", "provider_started"]
    records = [
        record for record in caplog.records
        if getattr(record, "event", "") == "web_chat_turn_lifecycle"
    ]
    assert [record.lifecycle_stage for record in records] == [
        "reserved", "provider_started",
    ]
    assert "Explain database indexes" not in str(
        [record.__dict__ for record in records]
    )


def test_turn_lifecycle_audit_falls_back_to_registered_user_message(
    monkeypatch,
):
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: None,
    )
    user = create_test_user(
        "lifecycle-message-fallback", "lifecycle-message-fallback@example.com",
    )
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain database indexes with one short example.",
        request_id="lifecycle-message-fallback-request",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
    )
    prepared.route = replace(prepared.route, provider="backend_tool")

    record_web_turn_lifecycle(prepared, "reserved")
    record_web_turn_lifecycle(prepared, "stream_terminal")

    with SessionLocal() as session:
        audit = build_request_audit(
            session, request_ids=[prepared.request_id]
        )[0]
    assert audit["generation_stage_count"] == 0
    assert audit["turn_lifecycle_stage"] == "stream_terminal"
    assert audit["turn_lifecycle_events"] == ["reserved", "stream_terminal"]


def _response(text: str) -> AIProviderResponse:
    return AIProviderResponse(
        text=text,
        provider="openai",
        model="internal-test-model",
        route="provider",
        reason="test",
        language="en",
        intent="general",
        input_tokens=8,
        output_tokens=4,
        raw={
            "usage_actual": True,
            "finish_reason": "stop",
            "completion_status": "complete",
            "truncated": False,
        },
    )


@pytest.mark.parametrize("billing_exempt", [False, True])
def test_assistant_persistence_failure_terminalizes_usage(
    monkeypatch, billing_exempt,
):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: None,
    )
    user = create_test_user(
        f"persistence-terminal-usage-{billing_exempt}",
        f"persistence-terminal-usage-{billing_exempt}@example.com",
    )
    if not billing_exempt:
        _fund(int(user.id))
    request_id = f"persistence-terminal-usage-{billing_exempt}-request"
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain this repository architecture.",
        request_id=request_id,
        thread_id=None,
        reply_language="en",
        billing_exempt=billing_exempt,
    )
    original_flush = Session.flush

    def fail_assistant_flush(self, objects=None):
        if objects and any(
            isinstance(item, WebChatMessage) and item.role == "assistant"
            for item in objects
        ):
            raise RuntimeError("simulated assistant persistence failure")
        return original_flush(self, objects)

    monkeypatch.setattr(Session, "flush", fail_assistant_flush)
    with pytest.raises(RuntimeError, match="assistant persistence"):
        execute_web_turn(prepared, providers={
            prepared.route.provider: type("Provider", (), {
                "complete": staticmethod(lambda _request, _route: _response(
                    "A complete generated answer."
                )),
            })(),
        })

    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id,
        )).one()
        assert charge.status not in {
            "reserving", "reserved", "running", "exempt_pending",
        }
        if billing_exempt:
            assert charge.status in {"billing_exempt", "released"}
        stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == request_id,
        )).all()
        assert all(stage.status not in {
            "planned", "reserved", "running",
        } for stage in stages)
        assert session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "assistant",
        )).first() is None


def test_request_audit_uses_persisted_message_quality_as_source_of_truth():
    user = create_test_user("quality-source", "quality-source@example.com")
    request_id = "quality-source-request"
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Quality")
        session.add(thread)
        session.flush()
        assistant = WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="assistant",
            content="Grounded answer [S1]",
            request_id=request_id,
            swico_tier="standard",
            status="complete",
            metadata_json=json.dumps({
                "quality": {
                    "status": "grounded",
                    "retrieval_status": "sufficient",
                    "checks": [{"type": "citation_validity", "status": "passed"}],
                },
            }),
        )
        session.add(assistant)
        session.flush()
        session.add(WebAnswerCheck(
            user_id=int(user.id),
            thread_id=thread.id,
            request_id=request_id,
            assistant_message_id=assistant.id,
            idempotency_key=f"answer-check:{request_id}:legacy",
            status="failed",
            passed=False,
            safe_metadata_json=json.dumps({"quality_outcome": "unverified"}),
        ))
        session.commit()
        audit = build_request_audit(session, request_ids=[request_id])[0]
    assert audit["quality_status"] == "grounded"
    assert audit["persisted_quality_status"] == "grounded"


def test_private_source_question_is_insufficient_when_identifier_is_absent():
    assert _missing_requested_private_identifier(
        "Using only the PDF, what is the CEO's passport number?", _pack(),
    ) is True
    supported = replace(
        _pack(),
        items=(replace(
            _pack().items[0],
            runtime_text="Passport number: SYNTHETIC-123",
        ),),
    )
    assert _missing_requested_private_identifier(
        "What is the passport number?", supported,
    ) is False


def test_live_plan_lists_only_enabled_phase3_provider_stages():
    plan = build_execution_plan(
        TriageInput(
            message="Explain the attached report in detail.",
            selected_tier="standard",
            reply_language="en",
            continuity=SameThreadContinuityDecision(
                mode="adaptive",
                use_context=False,
                reason="standalone",
                confidence=1.0,
                preferred_turn_count=0,
            ),
            attachment_metadata=AttachmentMetadata(
                count=1,
                total_bytes=100,
                media_categories=("application",),
                has_extracted_chunks=True,
            ),
            document_available_tokens=100,
        ),
        settings=TriagSettings(
            enabled=True,
            shadow_mode=False,
            rag_hybrid_enabled=True,
            rag_dense_enabled=True,
            answer_guard_enabled=True,
            verified_streaming_enabled=True,
            model_claim_verifier_enabled=True,
            answer_repair_enabled=True,
        ),
    )
    assert plan.streaming_mode == "verified_buffered"
    assert plan.expected_provider_calls == 4
    assert plan.planned_usage_stages == (
        "embedding", "reservation", "generation", "verifier", "repair",
        "settlement",
    )


def test_direct_mode_continues_streaming_before_checks_finish():
    visible: list[str] = []

    def generate(delta):
        assert delta is not None
        delta("draft ")
        assert visible == ["draft "]
        delta("answer")
        return _response("draft answer")

    result = VerifiedGenerator(StreamingPolicy("direct")).generate(
        generate_draft=generate,
        verify=lambda _answer: AnswerQualityResult(
            "best_effort", (QualityCheck("structural", "passed"),)
        ),
        repair=None,
        verify_repaired=None,
        on_delta=visible.append,
        on_status=None,
        cancellation_signal=None,
    )
    assert visible == ["draft ", "answer"]
    assert result.quality and result.quality.status == "best_effort"


def test_verified_mode_emits_no_delta_before_checks_finish():
    visible: list[str] = []
    statuses: list[str] = []

    def generate(delta):
        assert delta is not None
        delta("private draft")
        assert visible == []
        return _response("accepted answer")

    def verify(answer):
        assert answer == "accepted answer"
        assert visible == []
        return AnswerQualityResult(
            "verified", (QualityCheck("structural", "passed"),)
        )

    result = VerifiedGenerator(
        StreamingPolicy("verified_buffered")
    ).generate(
        generate_draft=generate,
        verify=verify,
        repair=None,
        verify_repaired=None,
        on_delta=visible.append,
        on_status=statuses.append,
        cancellation_signal=None,
    )
    assert visible == ["accepted answer"]
    assert statuses == [
        "generating", "verifying_sources", "responding",
    ]
    assert result.quality and result.quality.status == "verified"


def test_structural_repetition_and_duplicate_section_checks():
    result = AnswerGuard().check(
        "## Same\nRepeated sentence has enough words here. "
        "Repeated sentence has enough words here. "
        "Repeated sentence has enough words here.\n\n## Same\nText.",
        AnswerGuardContext(
            answer_class="normal", task_contract="Explain the topic."
        ),
    )
    statuses = {check.check_type: check.status for check in result.checks}
    assert statuses["repetition"] == "failed"
    assert statuses["duplicate_sections"] == "failed"
    assert result.status == "unverified"


@pytest.mark.parametrize(
    "completion",
    (
        ProviderCompletion(finish_reason="length"),
        ProviderCompletion(truncated=True),
        ProviderCompletion(completion_status="incomplete"),
        ProviderCompletion(incomplete_reason="max_output_tokens"),
    ),
)
def test_provider_incompleteness_can_never_be_verified(completion):
    result = AnswerGuard().check(
        "A complete-looking answer.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Answer the question.",
            verified_buffered=True,
            provider_completion=completion,
        ),
    )

    assert result.status == "unverified"
    assert any(
        check.check_type == "provider_completion"
        and check.status == "failed"
        for check in result.checks
    )


def test_invented_citation_and_missing_coverage_are_rejected():
    invented = AnswerGuard().check(
        "Saturn has prominent rings made mostly of ice [S2].",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Explain Saturn.",
            evidence_pack=_pack(),
            verified_buffered=True,
        ),
    )
    assert {
        check.check_type: check.status for check in invented.checks
    }["citation_validity"] == "failed"
    missing = AnswerGuard().check(
        "Saturn has prominent rings made mostly of ice and is a gas giant.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Explain Saturn.",
            evidence_pack=_pack(),
            verified_buffered=True,
        ),
    )
    assert {
        check.check_type: check.status for check in missing.checks
    }["citation_coverage"] == "failed"


def test_grounded_and_contradiction_warning_outcomes():
    grounded = AnswerGuard().check(
        "Saturn has prominent rings made mostly of ice [S1].",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Explain Saturn.",
            evidence_pack=_pack(),
            verified_buffered=True,
        ),
    )
    assert grounded.status == "grounded"
    contradictory = AnswerGuard().check(
        "Saturn has prominent rings made mostly of ice [S1].",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Explain Saturn.",
            evidence_pack=_pack(
                status="contradictory", contradictions=("S1:S2",)
            ),
            verified_buffered=True,
        ),
    )
    assert any(
        check.check_type == "contradiction_warning"
        and check.status == "warning"
        for check in contradictory.checks
    )


def test_short_uncited_evidence_answer_skips_support_and_is_grounded():
    result = AnswerGuard().check(
        "Saturn has icy rings.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Name Saturn's notable feature.",
            evidence_pack=_pack(),
            verified_buffered=True,
        ),
    )
    checks = {item.check_type: item for item in result.checks}
    assert checks["citation_coverage"].status == "passed"
    assert checks["evidence_support"].status == "skipped"
    assert checks["evidence_support"].reason_code == "no_cited_sections"
    assert result.status == "grounded"


def test_long_uncited_factual_answer_remains_unverified():
    result = AnswerGuard().check(
        "Saturn has prominent rings composed of many pieces of frozen ice.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Explain Saturn's notable feature.",
            evidence_pack=_pack(),
            verified_buffered=True,
        ),
    )
    checks = {item.check_type: item for item in result.checks}
    assert checks["citation_coverage"].status == "failed"
    assert checks["evidence_support"].status == "failed"
    assert result.status == "unverified"


def test_cited_but_unsupported_answer_remains_unverified():
    result = AnswerGuard().check(
        "Mercury orbits quickly near a blazing stellar surface [S1].",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Explain Mercury.",
            evidence_pack=_pack(),
            verified_buffered=True,
        ),
    )
    checks = {item.check_type: item for item in result.checks}
    assert checks["citation_coverage"].status == "passed"
    assert checks["evidence_support"].status == "failed"
    assert checks["evidence_support"].reason_code == (
        "unsupported_cited_section"
    )
    assert result.status == "unverified"


def test_repository_change_is_never_repository_verified_in_phase3():
    result = AnswerGuard().check(
        "I changed the requested file.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Modify the repository files.",
            verified_buffered=True,
        ),
    )
    assert result.status == "unverified"
    assert any(
        check.check_type == "repository_validation"
        and check.status == "skipped"
        for check in result.checks
    )


def test_repair_is_called_at_most_once():
    repairs = 0

    def repair(_answer, _quality):
        nonlocal repairs
        repairs += 1
        return _response("still not accepted")

    failed = AnswerQualityResult(
        "unverified", (QualityCheck("structural", "failed"),)
    )
    result = VerifiedGenerator(
        StreamingPolicy("verified_buffered")
    ).generate(
        generate_draft=lambda _delta: _response("bad"),
        verify=lambda _answer: failed,
        repair=repair,
        verify_repaired=lambda _answer, _prior: failed,
        on_delta=lambda _value: None,
        on_status=None,
        cancellation_signal=None,
    )
    assert repairs == 1
    assert result.repair_attempts == 1


def _execute_contract_turn(
    monkeypatch, *, slug, prompt, answers, captured_requests=None,
    task_repair_second_attempt_enabled=False,
):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: None,
    )
    user = create_test_user(slug, f"{slug}@example.com")
    _fund(int(user.id))
    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            if captured_requests is not None:
                captured_requests.append(request)
            answer = answers[min(calls, len(answers) - 1)]
            calls += 1
            return _response(answer)

    prepared = prepare_web_turn(
        user_id=int(user.id), message=prompt,
        request_id=f"{slug}-request", thread_id=None, reply_language="en",
    )
    prepared.triag_settings = TriagSettings(
        enabled=True,
        shadow_mode=False,
        answer_guard_enabled=True,
        verified_streaming_enabled=True,
        answer_repair_enabled=True,
        task_repair_second_attempt_enabled=(
            task_repair_second_attempt_enabled
        ),
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()}
    )
    return completed, calls


def test_malformed_bullets_are_repaired_and_final_text_is_verified(monkeypatch):
    prompt = (
        "Explain retries. Use exactly four bullet points and use no more "
        "than 140 words."
    )
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-bullets",
        prompt=prompt,
        answers=[
            "Retries should be handled carefully.",
            "- Define one operation.\n- Reuse one key.\n- Store the result.\n- Return it on retry.",
        ],
    )
    assert calls == 2
    assert completed.message.content.count("\n-") == 3
    assert completed.message.quality["status"] == "verified"


def test_b01_semantic_definition_and_retry_example_are_repaired(monkeypatch):
    prompt = (
        "Explain idempotency in payment APIs to a junior developer. Use exactly "
        "four bullet points, include one concrete retry example, and use no more "
        "than 140 words."
    )
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-semantic-b01",
        prompt=prompt,
        answers=[
            "- Use a key.\n- Store a result.\n- Return it.\n- Avoid duplicates.",
            "- Idempotency in payment APIs means one logical payment has one result.\n"
            "- Store a unique key with the result.\n"
            "- For example, retry POST /payments with key RETRY-1 and return the first result.\n"
            "- This prevents a duplicate charge.",
        ],
    )
    assert calls == 2
    assert completed.message.quality["status"] == "verified"
    check_types = {
        check["type"] for check in completed.message.quality["checks"]
    }
    assert "task_requirement_definition" in check_types
    assert "task_requirement_example" in check_types
    with SessionLocal() as session:
        audit = build_request_audit(
            session, request_ids=["contract-semantic-b01-request"]
        )[0]
    assert audit["task_requirement_check_status_counts"] == {"passed": 3}


def test_adaptive_context_reask_gets_one_bounded_repair(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("WEB_SAME_THREAD_CONTEXT_MODE", "adaptive")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: None,
    )
    user = create_test_user(
        "context-reask-repair", "context-reask-repair@example.com",
    )
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Inventory")
        session.add(thread)
        session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="user",
            content=(
                "I am building an inventory API with FastAPI, PostgreSQL, and "
                "Redis. The stock-reservation endpoint occasionally applies "
                "the same reservation twice after a client retry."
            ),
            request_id="context-reask-prior-turn",
            swico_tier="standard",
            status="complete",
        ))
        session.add(WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="assistant",
            content="I will keep those details in this thread.",
            request_id="context-reask-prior-turn",
            swico_tier="standard",
            status="complete",
        ))
        session.commit()
        thread_id = thread.id

    answers = [
        "Please share the system, symptoms, recent changes, error messages/logs, "
        "and what you already tried.",
        "In the FastAPI, PostgreSQL, and Redis inventory flow, the failure is a "
        "duplicate retry without idempotency. First add a UNIQUE idempotency key "
        "and commit its deduplication row and stock reservation atomically in one "
        "transaction.",
    ]
    captured_requests = []

    class Provider:
        def complete(self, request, _route):
            captured_requests.append(request)
            return _response(answers[len(captured_requests) - 1])

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="What is the most likely failure mode, and what should I change first?",
        request_id="context-reask-current-request",
        thread_id=thread_id,
        reply_language="en",
        billing_exempt=True,
    )
    requirements = TaskRequirementContract.from_metadata(
        prepared.ai_request.metadata["task_requirements"]
    )
    assert prepared.continuity_decision is not None
    assert prepared.continuity_decision.use_context is True
    assert requirements.prior_context_reask_forbidden is True
    assert requirements.duplicate_retry_fix_required is True
    prepared.triag_settings = TriagSettings(
        enabled=True,
        shadow_mode=False,
        answer_guard_enabled=True,
        verified_streaming_enabled=True,
        answer_repair_enabled=True,
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()},
    )
    assert len(captured_requests) == 2
    assert completed.message.quality["status"] == "verified"
    repair_prompt = "\n".join(
        str(item["content"])
        for item in captured_requests[1].metadata["provider_messages"]
    )
    assert "Do not ask the user to repeat" in repair_prompt


def test_complete_markdown_architecture_deliverables_need_no_repair(monkeypatch):
    prompt = """Design an idempotent webhook architecture.
Constraints:
- PostgreSQL is the source of truth
- Redis or Valkey must not be the source of truth
Include:
1. database tables and unique constraints
2. transaction boundaries
3. event and payment state transitions
4. pseudocode
5. duplicate-event handling
6. out-of-order handling
7. failure recovery
8. reconciliation
9. security checks
10. a focused test plan"""
    answer = """PostgreSQL is the source of truth. Redis and Valkey are non-authoritative caches.
### 1. Database tables and unique constraints
Use event and payment tables with unique event identifiers.
### 2. Transaction boundaries
One atomic transaction commits wallet and event changes.
### 3. Event and payment state transitions
Use monotonic event and payment status transitions.
### 4. Pseudocode
The worker flow begins, processes the event, then commits.
### 5. Duplicate-event handling
Deduplicate every duplicate event with the unique identifier.
### 6. Out-of-order handling
Store late out-of-order events until state permits transition.
### 7. Failure recovery
Retry crash recovery safely from the event inbox.
### 8. Reconciliation
Run a reconciliation consistency check against PostgreSQL.
### 9. Security checks
Perform HMAC signature and replay security checks.
### 10. A focused test plan
Test concurrency, duplicates, ordering, refunds, and failure injection."""
    captured_requests = []
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-complete-architecture",
        prompt=prompt,
        answers=[answer],
        captured_requests=captured_requests,
    )
    assert calls == 1
    assert len(captured_requests) == 1
    assert completed.message.quality["status"] == "verified"
    task_checks = [
        check for check in completed.message.quality["checks"]
        if (
            check["type"].startswith("task_requirement_")
            or check["type"].startswith("task_deliverable_")
            or (
                check["type"].startswith("task_architecture_")
                and check["type"] != "task_architecture_repair_trace"
            )
        )
    ]
    assert len(task_checks) == 12
    assert all(check["status"] == "passed" for check in task_checks)
    with SessionLocal() as session:
        audit = build_request_audit(
            session, request_ids=["contract-complete-architecture-request"]
        )[0]
    assert audit["pre_repair_failed_check_identifiers"] == []
    assert audit["repair_trigger_area_identifiers"] == []
    assert audit["post_repair_failed_check_identifiers"] == []


def test_authority_only_architecture_repair_splices_database_section(monkeypatch):
    prompt = """Design an idempotent webhook architecture.
Constraints:
- PostgreSQL is the source of truth
- Redis or Valkey must not be the source of truth
Include:
1. database tables and unique constraints
2. transaction boundaries
3. event and payment state transitions
4. pseudocode
5. duplicate-event handling
6. out-of-order handling
7. failure recovery
8. reconciliation
9. security checks
10. a focused test plan"""
    answer = """PostgreSQL is the system of record. Redis is non-authoritative.
### 1. Database tables and unique constraints
Use event and payment tables with a unique provider event ID.
### 2. Transaction boundaries
One atomic transaction commits wallet and event changes.
### 3. Event and payment state transitions
Use monotonic event and payment status transitions.
### 4. Pseudocode
The worker function begins a transaction, inserts the event, and commits.
### 5. Duplicate-event handling
INSERT ON CONFLICT DO NOTHING prevents a second wallet credit.
### 6. Out-of-order handling
Defer out-of-sequence events and discard outdated updates.
### 7. Failure recovery
Requeue pending events after a crash and resume expired leases.
### 8. Reconciliation
Run a reconciliation consistency check against PostgreSQL.
### 9. Security checks
Verify the webhook HMAC signature and reject replayed timestamps.
### 10. A focused test plan
Test duplicates, concurrency, crashes, refunds, replay, and out-of-order events."""
    repaired_section = """### 1. Database tables and unique constraints
Use event and payment tables with a unique provider event ID. PostgreSQL is the system of record. Redis and Valkey are explicitly non-authoritative stores."""
    captured_requests = []

    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-authority-only-architecture-repair",
        prompt=prompt,
        answers=[answer, repaired_section],
        captured_requests=captured_requests,
    )

    assert calls == 2
    assert len(captured_requests) == 2
    repair_messages = captured_requests[1].metadata["provider_messages"]
    assert "Return ONLY the targeted architecture sections" in (
        repair_messages[0]["content"]
    )
    assert "### 1. database tables and unique constraints" in (
        repair_messages[0]["content"]
    )
    assert completed.message.content[completed.message.content.index("### 2."):] == (
        answer[answer.index("### 2."):]
    )
    assert completed.message.quality["status"] == "verified"
    with SessionLocal() as session:
        audit = build_request_audit(
            session,
            request_ids=[
                "contract-authority-only-architecture-repair-request"
            ],
        )[0]
    assert audit["architecture_missing_area_identifiers"] == []
    assert audit["pre_repair_failed_check_identifiers"] == [
        "task_requirement_forbidden_authority"
    ]
    assert audit["repair_trigger_area_identifiers"] == ["database_schema"]
    assert audit["post_repair_failed_check_identifiers"] == []
    assert audit["architecture_repair_mode"] == "section_splice"


def test_non_architecture_format_repair_preserves_all_architecture_areas():
    prompt = """Design an idempotent webhook architecture.
Constraints:
- PostgreSQL is the source of truth
- Redis or Valkey must not be the source of truth
Include:
1. database tables and unique constraints
2. transaction boundaries
3. event and payment state transitions
4. pseudocode
5. duplicate-event handling
6. out-of-order handling
7. failure recovery
8. reconciliation
9. security checks
10. a focused test plan"""
    answer = """PostgreSQL is the system of record. Redis and Valkey are non-authoritative.
### 1. Database tables and unique constraints
Use event and payment tables with a unique provider event ID.
### 2. Transaction boundaries
One atomic transaction commits wallet and event changes.
### 3. Event and payment state transitions
Use monotonic event and payment status transitions.
### 4. Pseudocode
def handle_event(event):
    insert(event)
    commit()
### 5. Duplicate-event handling
INSERT ON CONFLICT DO NOTHING prevents a second wallet credit.
### 6. Out-of-order handling
Defer out-of-sequence events and discard outdated updates.
### 7. Failure recovery
Requeue pending events after a crash and resume expired leases.
### 8. Reconciliation
Run a reconciliation consistency check against PostgreSQL.
### 9. Security checks
Verify the webhook HMAC signature and reject replayed timestamps.
### 10. A focused test plan
Test duplicates, concurrency, crashes, refunds, replay, and out-of-order events."""
    repaired_section = """### 4. Pseudocode
```python
def handle_event(event):
    insert(event)
    commit()
```"""
    failed_check = fenced_code_quality_check(answer)
    assert failed_check.status == "failed"
    contract = build_repair_request(
        user_id=1,
        request_id="contract-format-only-architecture-repair-request",
        reply_language="en",
        current_answer=answer,
        failed_checks=(failed_check,),
        evidence_pack=None,
        task_contract=prompt,
        task_requirements=extract_task_requirements(prompt),
        answer_class="long_form",
        max_output_tokens=6000,
    )
    assert contract.architecture_splice_areas == ("pseudocode",)
    repaired = splice_architecture_section_repair(
        answer, repaired_section, contract.architecture_splice_areas,
    )
    assert repaired is not None
    assert repaired[:repaired.index("### 4.")] == (
        answer[:answer.index("### 4.")]
    )
    assert repaired[repaired.index("### 5."):] == (
        answer[answer.index("### 5."):]
    )
    assert evaluate_architecture_coverage(repaired).missing_area_identifiers == ()
    assert fenced_code_quality_check(repaired).status == "passed"

    completion_contract = build_repair_request(
        user_id=1,
        request_id="contract-completion-architecture-repair-request",
        reply_language="en",
        current_answer=answer,
        failed_checks=(QualityCheck(
            "provider_completion", "failed", "provider_output_incomplete",
        ),),
        evidence_pack=None,
        task_contract=prompt,
        task_requirements=extract_task_requirements(prompt),
        answer_class="long_form",
        max_output_tokens=6000,
    )
    assert completion_contract.architecture_splice_areas == ("test_plan",)
    completion_repaired = splice_architecture_section_repair(
        answer,
        "### 10. A focused test plan\nTest duplicate, concurrent, crash, refund, "
        "replay, and out-of-order scenarios.",
        completion_contract.architecture_splice_areas,
    )
    assert completion_repaired is not None
    assert completion_repaired[:completion_repaired.index("### 10.")] == (
        answer[:answer.index("### 10.")]
    )
    assert evaluate_architecture_coverage(
        completion_repaired
    ).missing_area_identifiers == ()


def test_incomplete_architecture_gets_one_targeted_duplicate_repair(monkeypatch):
    prompt = """Design an idempotent webhook architecture.
Constraints:
- PostgreSQL is the source of truth
- Redis or Valkey must not be the source of truth
Include:
1. database tables and unique constraints
2. transaction boundaries
3. event and payment state transitions
4. pseudocode
5. duplicate-event handling
6. out-of-order handling
7. failure recovery
8. reconciliation
9. security checks
10. a focused test plan"""
    incomplete = """PostgreSQL is the source of truth. Redis and Valkey are non-authoritative caches.
### 1. Database tables and unique constraints
Use event tables with a UNIQUE provider event ID.
### 2. Transaction boundaries
Use one atomic transaction and commit or rollback together.
### 3. Event and payment state transitions
Use monotonic payment state transitions.
### 4. Pseudocode
Worker pseudocode begins a transaction and processes the event.
### 5. Duplicate-event handling
### 6. Out-of-order handling
Store late out-of-order events until their monotonic state permits them.
### 7. Failure recovery
Use a retryable inbox for crash recovery.
### 8. Reconciliation
Run a reconciliation audit job.
### 9. Security checks
Perform HMAC signature verification and replay-window checks.
### 10. A focused test plan
Run concurrency and failure-injection integration tests."""
    repaired = (
        "### 5. Duplicate-event handling\n"
        "INSERT ON CONFLICT DO NOTHING for the unique provider event ID, then "
        "return 200 without a second wallet credit."
    )
    captured_requests = []
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-targeted-architecture-repair",
        prompt=prompt,
        answers=[incomplete, repaired],
        captured_requests=captured_requests,
    )
    assert calls == 2
    assert len(captured_requests) == 2
    repair_messages = captured_requests[1].metadata["provider_messages"]
    assert "duplicate_handling" in repair_messages[0]["content"]
    assert "heading alone is insufficient" in repair_messages[0]["content"]
    assert "Return ONLY the targeted architecture sections" in (
        repair_messages[0]["content"]
    )
    assert "Cover all 10" not in repair_messages[1]["content"]
    assert completed.message.quality["status"] == "verified"
    with SessionLocal() as session:
        audit = build_request_audit(
            session,
            request_ids=["contract-targeted-architecture-repair-request"],
        )[0]
    assert audit["architecture_missing_area_identifiers"] == []
    assert audit["pre_repair_failed_check_identifiers"] == [
        "task_architecture_duplicate_handling"
    ]
    assert audit["repair_trigger_area_identifiers"] == ["duplicate_handling"]
    assert audit["post_repair_failed_check_identifiers"] == []
    assert audit["architecture_repair_mode"] == "section_splice"


def test_second_architecture_splice_repair_is_bounded_and_flagged(monkeypatch):
    prompt = """Design an idempotent webhook architecture.
Constraints:
- PostgreSQL is the source of truth
- Redis or Valkey must not be the source of truth
Include:
1. database tables and unique constraints
2. transaction boundaries
3. event and payment state transitions
4. pseudocode
5. duplicate-event handling
6. out-of-order handling
7. failure recovery
8. reconciliation
9. security checks
10. a focused test plan"""
    draft = """PostgreSQL is the source of truth. Redis and Valkey are non-authoritative caches.
### 1. Database tables and unique constraints
Use event tables with a UNIQUE provider event ID.
### 2. Transaction boundaries
Use one atomic transaction and commit or rollback.
### 3. Event and payment state transitions
Use monotonic state transitions and a status rank.
### 4. Pseudocode
The worker function inserts an event and commits.
### 5. Duplicate-event handling
Use INSERT ON CONFLICT DO NOTHING for an already processed event.
### 6. Out-of-order handling
Consider event timing carefully.
### 7. Failure recovery
Requeue pending events after a crash and resume expired leases.
### 8. Reconciliation
Run a reconciliation audit job against PostgreSQL.
### 9. Security checks
Protect the webhook.
### 10. A focused test plan
Cover duplicates, concurrency, and crash recovery scenarios."""
    first_repair = """### 6. Out-of-order handling
Events arriving out of sequence are deferred; outdated updates are discarded.
### 9. Security checks
Protect the webhook."""
    second_repair = """### 9. Security checks
Verify the X-Razorpay-Signature header against the webhook secret using a constant-time comparison."""
    captured_requests = []
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-second-architecture-splice",
        prompt=prompt,
        answers=[draft, first_repair, second_repair],
        captured_requests=captured_requests,
        task_repair_second_attempt_enabled=True,
    )
    assert calls == 3
    assert [request.request_id for request in captured_requests] == [
        "contract-second-architecture-splice-request",
        "contract-second-architecture-splice-request:repair:1",
        "contract-second-architecture-splice-request:repair:2",
    ]
    assert completed.message.quality["status"] == "verified"
    assert completed.message.content.count("### 6. Out-of-order handling") == 1
    assert completed.message.content.count("### 9. Security checks") == 1
    with SessionLocal() as session:
        audit = build_request_audit(
            session,
            request_ids=["contract-second-architecture-splice-request"],
        )[0]
    assert audit["pre_repair_failed_check_identifiers"] == [
        "task_architecture_out_of_order_handling",
        "task_architecture_security_checks",
    ]
    assert audit["post_repair_failed_check_identifiers"] == []


def test_extra_python_fence_is_canonicalized_before_persistence(monkeypatch):
    prompt = (
        "Return exactly two fenced Python code blocks.\n\n"
        "The first block must begin with:\n\n# pricing.py\n\n"
        "The second block must begin with:\n\n# test_pricing.py\n"
    )
    draft = (
        "Here is the result.\n```python\n# pricing.py\npass\n```\n"
        "```python\n# test_pricing.py\npass\n```\n"
        "```python\n# extra.py\npass\n```"
    )
    completed, calls = _execute_contract_turn(
        monkeypatch, slug="contract-fences", prompt=prompt, answers=[draft]
    )
    assert calls == 1
    assert completed.message.content.count("```python") == 2
    assert "extra.py" not in completed.message.content
    assert completed.message.quality["status"] == "verified"


def test_prose_wrapped_json_is_canonicalized_before_persistence(monkeypatch):
    prompt = (
        "Return only valid JSON with exactly these keys:\n\n"
        "- answer\n- reason\n- confidence\n\nDo not use Markdown fences."
    )
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-json",
        prompt=prompt,
        answers=[
            'Result: ```json\n{"answer":true,"reason":"prime","confidence":1}\n```'
        ],
    )
    assert calls == 1
    assert json.loads(completed.message.content)["answer"] is True
    assert completed.message.quality["status"] == "verified"


def test_invalid_contract_repair_remains_unverified_and_runs_once(monkeypatch):
    prompt = "Explain retries using exactly four bullet points."
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-invalid-repair",
        prompt=prompt,
        answers=["Draft paragraph.", "Still a paragraph."],
    )
    assert calls == 2
    assert completed.message.content == "Still a paragraph."
    assert completed.message.quality["status"] == "unverified"


def test_exact_120_word_contract_repair_persists_visible_verified_text(
    monkeypatch,
):
    prompt = (
        "Write a micro-story of exactly 120 words. Include the phrase "
        "\u201cblue umbrella\u201d exactly once. End with the word \u201chome\u201d. "
        "Do not include a title."
    )
    prefix = [
        "At", "the", "railway", "station", "a", "blue", "umbrella", "rested",
    ]
    malformed = " ".join(prefix + ["quietly"] * 115 + ["home"])
    repaired = " ".join(prefix + ["quietly"] * 111 + ["home"])
    assert len(malformed.split()) == 124
    assert len(repaired.split()) == 120

    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-exact-120-visible",
        prompt=prompt,
        answers=[malformed, repaired],
    )

    assert calls == 2
    assert completed.message.content == repaired
    assert completed.message.content.strip()
    assert len(completed.message.content.split()) == 120
    assert completed.message.quality["status"] == "verified"


def test_exact_120_word_contract_allows_one_final_strict_format_correction(
    monkeypatch,
):
    prompt = (
        "Write a micro-story of exactly 120 words. Requirements: include the "
        "phrase \u201cblue umbrella\u201d exactly once; the setting is a railway station; "
        "no dialogue; end with the word \u201chome\u201d; do not include a title."
    )
    prefix = [
        "At", "the", "railway", "station", "a", "blue", "umbrella", "rested",
    ]
    draft_124 = " ".join(prefix + ["quietly"] * 115 + ["home"])
    repair_111 = " ".join(prefix + ["quietly"] * 102 + ["home"])
    repair_120 = " ".join(prefix + ["quietly"] * 111 + ["home"])
    captured_requests = []

    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-exact-120-second-correction",
        prompt=prompt,
        answers=[draft_124, repair_111, repair_120],
        captured_requests=captured_requests,
    )

    assert calls == 3
    assert [request.request_id for request in captured_requests] == [
        "contract-exact-120-second-correction-request",
        "contract-exact-120-second-correction-request:repair:1",
        "contract-exact-120-second-correction-request:repair:2",
    ]
    second_repair = captured_requests[2]
    assert second_repair.metadata["strict_output_contract"] is True
    assert second_repair.metadata["minimum_visible_output_tokens"] >= 200
    assert second_repair.metadata["max_provider_attempts"] == 1
    assert completed.message.content == repair_120
    assert len(completed.message.content.split()) == 120
    assert completed.message.content.casefold().count("blue umbrella") == 1
    assert "railway station" in completed.message.content.casefold()
    assert not any(character in completed.message.content for character in '\u201c\u201d"')
    assert "\n" not in completed.message.content
    assert completed.message.content.endswith("home")
    assert completed.message.quality["status"] == "verified"

    request_id = "contract-exact-120-second-correction-request"
    with SessionLocal() as session:
        stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == request_id
        )).all()
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id
        )).one()
        audit = build_request_audit(session, request_ids=[request_id])[0]
    repair_stage = next(
        stage for stage in stages if stage.stage_name == "repair"
    )
    assert repair_stage.status == "settled"
    assert repair_stage.input_tokens == 16
    assert repair_stage.output_tokens == 8
    assert charge.debited_micros == sum(stage.debited_micros for stage in stages)
    assert audit["provider_call_count"] == 3
    assert audit["repair_stage_count"] == 1
    assert audit["output_contract_check_status_counts"].get("failed", 0) == 0


def test_tamil_sentence_and_script_contract_repair_agrees_with_request_audit(
    monkeypatch,
):
    prompt = (
        "ஒளிச்சேர்க்கை எப்படி வேலை செய்கிறது? "
        "ஐந்து எளிய தமிழ் வாக்கியங்களில் விளக்கவும்."
    )
    repaired = "ஒன்று. இரண்டு. மூன்று. நான்கு. ஐந்து."
    completed, calls = _execute_contract_turn(
        monkeypatch,
        slug="contract-tamil-script",
        prompt=prompt,
        answers=["One. Two. Three. Four. Five.", repaired],
    )

    assert calls == 2
    assert completed.message.content == repaired
    assert completed.message.quality["status"] == "verified"
    checks = {
        check["type"]: check
        for check in completed.message.quality["checks"]
    }
    assert checks["output_contract_sentence_count"]["status"] == "passed"
    assert checks["output_contract_required_script"]["status"] == "passed"
    with SessionLocal() as session:
        persisted = session.exec(select(WebAnswerCheck).where(
            WebAnswerCheck.request_id == "contract-tamil-script-request"
        )).one()
        safe_metadata = json.loads(persisted.safe_metadata_json)
        audit = build_request_audit(
            session, request_ids=["contract-tamil-script-request"]
        )
    persisted_checks = {
        check["check_type"]: check
        for check in safe_metadata["quality_checks"]
    }
    assert persisted_checks["output_contract_sentence_count"] == {
        "check_type": "output_contract_sentence_count",
        "check_status": "passed",
        "expected_sentence_count": 5,
        "observed_sentence_count": 5,
        "validator_version": "2026-08-03.1",
    }
    assert persisted_checks["output_contract_required_script"] == {
        "check_type": "output_contract_required_script",
        "check_status": "passed",
        "contains_tamil_script": 1,
        "validator_version": "2026-08-03.1",
    }
    assert audit is not None
    assert audit[0]["quality_status"] == "verified"
    assert audit[0]["persisted_quality_status"] == "verified"
    assert audit[0]["output_contract_check_status_counts"] == {
        "passed": 2,
    }


def test_incomplete_provider_metadata_is_persisted_as_unverified(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: None,
    )
    user = create_test_user(
        "phase3-incomplete-output", "phase3-incomplete-output@example.com"
    )
    _fund(int(user.id))

    class Provider:
        def complete(self, request, route):
            response = _response("A complete-looking but truncated answer.")
            response.raw.update({
                "finish_reason": "length",
                "completion_status": "incomplete",
                "incomplete_reason": "max_output_tokens",
                "truncated": True,
            })
            return response

    request_id = "phase3-incomplete-output-request"
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Explain a complex topic in detail.",
        request_id=request_id, thread_id=None, reply_language="en",
    )
    prepared.triag_settings = TriagSettings(
        enabled=True,
        shadow_mode=False,
        answer_guard_enabled=True,
        verified_streaming_enabled=True,
        answer_repair_enabled=False,
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()}
    )

    assert completed.message.quality["status"] == "unverified"
    assert any(
        check["type"] == "provider_completion" and check["status"] == "failed"
        for check in completed.message.quality["checks"]
    )
    with SessionLocal() as session:
        assistant = session.exec(select(WebAnswerCheck).where(
            WebAnswerCheck.request_id == request_id,
        )).one()
        assert json.loads(assistant.safe_metadata_json)[
            "quality_outcome"
        ] == "unverified"


class _Signal:
    cancelled = False

    def cancel(self):
        self.cancelled = True


@pytest.mark.parametrize("phase", ["generation", "verification", "repair"])
def test_cancellation_stops_generation_verification_and_repair(phase):
    signal = _Signal()
    failed = AnswerQualityResult(
        "unverified", (QualityCheck("structural", "failed"),)
    )

    def generate(_delta):
        if phase == "generation":
            signal.cancel()
        return _response("draft")

    def verify(_answer):
        if phase == "verification":
            signal.cancel()
        return failed

    def repair(_answer, _quality):
        if phase == "repair":
            signal.cancel()
        return _response("repair")

    with pytest.raises(GenerationCancelled):
        VerifiedGenerator(
            StreamingPolicy("verified_buffered")
        ).generate(
            generate_draft=generate,
            verify=verify,
            repair=repair,
            verify_repaired=lambda _answer, _prior: failed,
            on_delta=lambda _value: None,
            on_status=None,
            cancellation_signal=signal,
        )


def test_generation_verifier_repair_stages_are_owner_scoped_and_idempotent():
    first = create_test_user("phase3-stage-one", "p3-stage-one@example.com")
    second = create_test_user("phase3-stage-two", "p3-stage-two@example.com")
    with SessionLocal() as session:
        for stage_name in ("generation", "verifier", "repair"):
            row = get_or_create_usage_stage(
                session,
                user_id=int(first.id),
                request_id="phase3-stage-request",
                stage_name=stage_name,
            )
            session.flush()
            replay = get_or_create_usage_stage(
                session,
                user_id=int(first.id),
                request_id="phase3-stage-request",
                stage_name=stage_name,
            )
            assert replay.id == row.id
            get_or_create_usage_stage(
                session,
                user_id=int(second.id),
                request_id="phase3-stage-request",
                stage_name=stage_name,
            )
        session.commit()
        assert len(session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "phase3-stage-request"
        )).all()) == 6


def test_persisted_quality_contains_no_answer_evidence_or_secret():
    user = create_test_user("phase3-quality", "p3-quality@example.com")
    secret = "private evidence API_KEY=secret-value"
    result = AnswerQualityResult(
        "unverified",
        (
            QualityCheck("citation_validity", "failed", secret),
            QualityCheck("task_completeness", "passed"),
        ),
        retrieval_status="sufficient",
    )
    with SessionLocal() as session:
        row = persist_answer_quality(
            session,
            user_id=int(user.id),
            thread_id=None,
            request_id="phase3-quality-request",
            assistant_message_id=None,
            result=result,
        )
        session.commit()
        session.refresh(row)
        encoded = row.safe_metadata_json
    assert secret not in encoded
    assert "API_KEY" not in encoded
    assert json.loads(encoded)["quality_outcome"] == "unverified"


def test_disabled_answer_guard_and_triag_preserve_fallback():
    answer_guard_disabled = TriagSettings.from_environ({
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_ANSWER_GUARD_ENABLED": "false",
        "WEB_VERIFIED_STREAMING_ENABLED": "true",
    })
    triag_disabled = TriagSettings.from_environ({
        "WEB_TRIAG_ENABLED": "false",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_ANSWER_GUARD_ENABLED": "true",
        "WEB_VERIFIED_STREAMING_ENABLED": "true",
    })
    assert answer_guard_disabled.answer_guard_runtime_enabled is False
    assert answer_guard_disabled.verified_streaming_runtime_enabled is False
    assert triag_disabled.answer_guard_runtime_enabled is False
    assert triag_disabled.runtime_status["answer_guard"] == "disabled"


def test_no_repair_provider_call_when_reservation_expansion_fails(
    monkeypatch,
):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "false")
    monkeypatch.setenv("WEB_ANSWER_GUARD_ENABLED", "true")
    monkeypatch.setenv("WEB_VERIFIED_STREAMING_ENABLED", "true")
    monkeypatch.setenv("WEB_ANSWER_GUARD_REPAIR_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        "app.web_api.chat_service._expand_phase3_reservation",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            PaymentValidationError("no expansion")
        ),
    )
    user = create_test_user("phase3-no-repair", "p3-no-repair@example.com")
    _fund(int(user.id))
    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            calls += 1
            return AIProviderResponse(
                text="",
                provider=route.provider,
                model=route.model,
                route=route.route,
                reason=route.reason,
                language="en",
                intent=route.intent,
                input_tokens=12,
                output_tokens=0,
                raw={"usage_actual": True, "finish_reason": "stop"},
            )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain this topic in detail.",
        request_id="phase3-no-repair-request",
        thread_id=None,
        reply_language="en",
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()}
    )
    assert calls == 1
    assert completed.message.quality
    assert completed.message.quality["status"] == "unverified"
    with SessionLocal() as session:
        stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "phase3-no-repair-request"
        )).all()
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "phase3-no-repair-request"
        )).one()
        assert {
            stage.stage_name: stage.status for stage in stages
        } == {"generation": "settled", "repair": "skipped"}
        assert charge.status == "settled"
        assert charge.debited_micros == completed.message.charge_micros


def test_phase2_insufficient_evidence_quality_remains_deterministic():
    result = AnswerGuard().check(
        "Not enough supporting information.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Answer from the document.",
            evidence_pack=_pack(status="insufficient"),
            verified_buffered=True,
        ),
    )
    assert result.status == "insufficient_evidence"


def test_zero_visible_strict_output_uses_only_one_accounted_fallback(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user("strict-visible-fallback", "strict-visible-fallback@example.com")
    _fund(int(user.id))
    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise GenerationIncomplete(
                    completion_status="incomplete",
                    incomplete_reason="max_output_tokens",
                    finish_reason="length",
                    input_tokens=20,
                    output_tokens=40,
                    reasoning_tokens=40,
                    visible_characters=0,
                    max_output_tokens=route.max_output_tokens,
                    provider_usage_received=True,
                )
            return _response(
                "One two three four five six seven eight nine home"
            )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message='Write exactly 10 words and end with the word "home".',
        request_id="strict-visible-fallback-request",
        thread_id=None,
        reply_language="en",
    )
    prepared.triag_settings = TriagSettings(
        enabled=True, shadow_mode=False, answer_guard_enabled=True,
        verified_streaming_enabled=True, answer_repair_enabled=True,
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider:Provider()}
    )
    assert calls == 2
    assert completed.message.content.endswith("home")
    with SessionLocal() as session:
        repair_stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "strict-visible-fallback-request",
            WebUsageStage.stage_name == "repair",
        )).all()
        assert len(repair_stages) == 1


def test_failed_zero_visible_fallback_persists_stable_unverified_answer(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user("strict-visible-exhausted", "strict-visible-exhausted@example.com")
    _fund(int(user.id))
    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise GenerationIncomplete(
                    completion_status="incomplete",
                    incomplete_reason="max_output_tokens",
                    finish_reason="length",
                    input_tokens=20,
                    output_tokens=40,
                    reasoning_tokens=40,
                    visible_characters=0,
                    max_output_tokens=route.max_output_tokens,
                    provider_usage_received=True,
                )
            return _response("")

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message='Write exactly 10 words and end with the word "home".',
        request_id="strict-visible-exhausted-request",
        thread_id=None,
        reply_language="en",
    )
    prepared.triag_settings = TriagSettings(
        enabled=True, shadow_mode=False, answer_guard_enabled=True,
        verified_streaming_enabled=True, answer_repair_enabled=True,
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider:Provider()}
    )
    assert calls == 2
    assert completed.message.content.startswith("Swico could not produce")
    assert completed.message.quality["status"] == "unverified"


def test_verifier_contract_is_bounded_simple_and_strict(monkeypatch):
    assert _parse_verifier_status("SUPPORTED") is True
    assert _parse_verifier_status("UNSUPPORTED") is False
    for invalid in ("", "supported because...", "UNKNOWN", "{}"):
        with pytest.raises(ValueError, match="verifier_unavailable"):
            _parse_verifier_status(invalid)

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user("phase3-contract", "p3-contract@example.com")
    _fund(int(user.id))
    observed: dict[str, object] = {}

    class GenerationProvider:
        def complete(self, request, route):
            return _response("Saturn has prominent rings made mostly of ice [S1].")

    class VerifierProvider:
        def complete(self, request, route):
            observed["max_output_tokens"] = route.max_output_tokens
            observed["answer_class"] = request.metadata.get("answer_class")
            return _response("SUPPORTED")

    prepared = prepare_web_turn(
        user_id=int(user.id), message="Explain Saturn from the evidence.",
        request_id="phase3-contract-request", thread_id=None,
        reply_language="en",
    )
    prepared.retrieval_context = replace(
        _pack(), owner_user_id=int(user.id),
        request_id="phase3-contract-request",
    )
    prepared.swico_tier = "standard"
    prepared.triag_settings = TriagSettings(
        enabled=True, shadow_mode=False, answer_guard_enabled=True,
        verified_streaming_enabled=True, model_claim_verifier_enabled=True,
    )
    completed = execute_web_turn(prepared, providers={
        prepared.route.provider: GenerationProvider(),
        "verifier": VerifierProvider(),
    })

    assert observed == {"max_output_tokens": 96, "answer_class": "simple"}
    assert completed.message.quality
    assert completed.message.quality["status"] == "grounded"


@pytest.mark.parametrize("mode", ["empty", "incomplete"])
def test_verifier_unavailable_is_terminal_and_incomplete_usage_is_billed_once(
    monkeypatch, mode,
):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user(
        f"phase3-verifier-{mode}", f"p3-verifier-{mode}@example.com"
    )
    _fund(int(user.id))
    verifier_calls = 0

    class GenerationProvider:
        def complete(self, request, route):
            return _response("Saturn has prominent rings made mostly of ice [S1].")

    class VerifierProvider:
        def complete(self, request, route):
            nonlocal verifier_calls
            verifier_calls += 1
            if mode == "incomplete":
                raise GenerationIncomplete(
                    completion_status="incomplete",
                    incomplete_reason="max_output_tokens",
                    finish_reason="length",
                    input_tokens=41,
                    output_tokens=96,
                    reasoning_tokens=80,
                    visible_characters=0,
                    max_output_tokens=96,
                    provider_usage_received=True,
                )
            response = _response("")
            response.input_tokens = 41
            response.output_tokens = 3
            return response

    request_id = f"phase3-verifier-{mode}-request"
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Explain Saturn from the evidence.",
        request_id=request_id, thread_id=None, reply_language="en",
    )
    prepared.retrieval_context = replace(
        _pack(), owner_user_id=int(user.id), request_id=request_id,
    )
    prepared.swico_tier = "standard"
    prepared.triag_settings = TriagSettings(
        enabled=True, shadow_mode=False, answer_guard_enabled=True,
        verified_streaming_enabled=True, model_claim_verifier_enabled=True,
    )
    completed = execute_web_turn(prepared, providers={
        prepared.route.provider: GenerationProvider(),
        "verifier": VerifierProvider(),
    })

    assert verifier_calls == 1
    assert completed.message.quality
    checks = completed.message.quality["checks"]
    assert any(
        check["type"] == "model_claim_verifier"
        and check["status"] == "error"
        for check in checks
    )
    with SessionLocal() as session:
        stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == request_id
        )).all()
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id
        )).one()
        verifier = next(
            stage for stage in stages if stage.stage_name == "verifier"
        )
        assert verifier.status == "settled"
        assert verifier.input_tokens == 41
        assert verifier.output_tokens == (96 if mode == "incomplete" else 3)
        if mode == "incomplete":
            assert json.loads(verifier.safe_metadata_json)[
                "reasoning_token_count"
            ] == 80
        assert charge.status == "settled"
        assert charge.debited_micros == sum(
            stage.debited_micros for stage in stages
        )
        assert all(stage.status not in {"planned", "reserved", "running"}
                   for stage in stages)


def test_repair_runs_before_the_single_paid_verifier(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user("phase3-final-verify", "p3-final@example.com")
    _fund(int(user.id))
    generation_calls = 0
    verifier_answers: list[str] = []

    class GenerationProvider:
        def complete(self, request, route):
            nonlocal generation_calls
            generation_calls += 1
            return _response(
                "" if generation_calls == 1
                else "Saturn has prominent rings made mostly of ice [S1]."
            )

    class VerifierProvider:
        def complete(self, request, route):
            verifier_answers.append(str(request.metadata["provider_messages"][-1]))
            return _response("SUPPORTED")

    request_id = "phase3-final-verifier-request"
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Explain Saturn from the evidence.",
        request_id=request_id, thread_id=None, reply_language="en",
    )
    prepared.retrieval_context = replace(
        _pack(), owner_user_id=int(user.id), request_id=request_id,
    )
    prepared.swico_tier = "standard"
    prepared.triag_settings = TriagSettings(
        enabled=True, shadow_mode=False, answer_guard_enabled=True,
        verified_streaming_enabled=True, model_claim_verifier_enabled=True,
        answer_repair_enabled=True,
    )
    execute_web_turn(prepared, providers={
        prepared.route.provider: GenerationProvider(),
        "verifier": VerifierProvider(),
    })

    assert generation_calls == 2
    assert len(verifier_answers) == 1
    assert "Saturn has prominent rings" in verifier_answers[0]
    with SessionLocal() as session:
        verifier_stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == request_id,
            WebUsageStage.stage_name == "verifier",
        )).all()
        assert len(verifier_stages) == 1
        assert verifier_stages[0].status == "settled"


def test_generation_and_repair_settle_parent_exactly_once(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "false")
    monkeypatch.setenv("WEB_ANSWER_GUARD_ENABLED", "true")
    monkeypatch.setenv("WEB_VERIFIED_STREAMING_ENABLED", "true")
    monkeypatch.setenv("WEB_ANSWER_GUARD_REPAIR_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user(
        "phase3-exact-settlement", "p3-settlement@example.com"
    )
    _fund(int(user.id))
    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            calls += 1
            return AIProviderResponse(
                text="" if calls == 1 else "Complete repaired answer.",
                provider=route.provider,
                model=route.model,
                route=route.route,
                reason=route.reason,
                language="en",
                intent=route.intent,
                input_tokens=10 + calls,
                output_tokens=2 + calls,
                raw={"usage_actual": True, "finish_reason": "stop"},
            )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain this topic in detail.",
        request_id="phase3-exact-settlement-request",
        thread_id=None,
        reply_language="en",
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()}
    )
    assert calls == 2
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "phase3-exact-settlement-request"
        )).one()
        stages = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "phase3-exact-settlement-request",
            WebUsageStage.stage_name.in_(["generation", "repair"]),
        )).all()
        checks = session.exec(select(WebAnswerCheck).where(
            WebAnswerCheck.request_id == "phase3-exact-settlement-request"
        )).all()
        assert charge.status == "settled"
        assert len(checks) == 1
        assert charge.debited_micros == sum(
            stage.debited_micros for stage in stages
        )
        assert charge.debited_micros == completed.message.charge_micros
        assert completed.wallet["reserved_micros"] == 0
