from __future__ import annotations

import json

import pytest
from sqlmodel import select

from app.ai.providers.base import GenerationCancelled
from app.ai.types import AIProviderResponse
from app.billing.errors import PaymentValidationError
from app.database import SessionLocal
from app.models import UsageCharge, WebAnswerCheck, WebUsageStage
from app.web_ai.evidence.models import EvidenceItem, EvidencePack
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.generator import VerifiedGenerator
from app.web_ai.generation.models import AnswerQualityResult, QualityCheck
from app.web_ai.persistence import get_or_create_usage_stage, persist_answer_quality
from app.web_ai.settings import TriagSettings
from app.web_ai.streaming_policy import StreamingPolicy
from app.web_ai.triage import AttachmentMetadata, TriageInput, build_execution_plan
from app.web_api.chat_service import execute_web_turn, prepare_web_turn
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
        raw={"usage_actual": True},
    )


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
        "app.web_api.chat_service._cache_response", lambda *args: None
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


def test_generation_and_repair_settle_parent_exactly_once(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "false")
    monkeypatch.setenv("WEB_ANSWER_GUARD_ENABLED", "true")
    monkeypatch.setenv("WEB_VERIFIED_STREAMING_ENABLED", "true")
    monkeypatch.setenv("WEB_ANSWER_GUARD_REPAIR_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args: None
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
