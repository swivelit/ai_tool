from __future__ import annotations

from dataclasses import replace
import json

import pytest
from sqlmodel import select

from app.ai.providers.base import GenerationCancelled, GenerationIncomplete
from app.ai.types import AIProviderResponse
from app.billing.errors import PaymentValidationError
from app.database import SessionLocal
from app.models import UsageCharge, WebAnswerCheck, WebUsageStage
from app.web_ai.evidence.models import EvidenceItem, EvidencePack
from app.web_ai.generation.answer_guard import (
    AnswerGuard, AnswerGuardContext, ProviderCompletion,
)
from app.web_ai.generation.generator import VerifiedGenerator
from app.web_ai.generation.models import AnswerQualityResult, QualityCheck
from app.web_ai.persistence import get_or_create_usage_stage, persist_answer_quality
from app.web_ai.settings import TriagSettings
from app.web_ai.streaming_policy import StreamingPolicy
from app.web_ai.triage import AttachmentMetadata, TriageInput, build_execution_plan
from app.web_api.chat_service import (
    _parse_verifier_status,
    execute_web_turn,
    prepare_web_turn,
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


def _execute_contract_turn(monkeypatch, *, slug, prompt, answers):
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
