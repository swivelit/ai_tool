from __future__ import annotations

from dataclasses import FrozenInstanceError
import json

import pytest
from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.database import SessionLocal
from app.models import UsageCharge, WebRetrievalTrace, WebUsageStage
from app.web_ai.evidence.models import EvidenceItem, EvidencePack
from app.web_ai.persistence import get_or_create_usage_stage
from app.web_ai.settings import (
    TriagConfigurationError,
    TriagSettings,
)
from app.web_ai.telemetry.metadata import (
    UnsafeMetadataError,
    sanitize_metadata,
)
from app.web_ai.tier_policy import tier_policy_for, validated_tier_policies
from app.web_ai.token_allocator import DynamicTokenAllocator
from app.web_ai.triage import (
    AttachmentMetadata,
    TriageInput,
    build_execution_plan,
    shadow_metadata,
)
from app.web_api.chat_service import execute_web_turn, prepare_web_turn
from app.web_api.conversation_continuity import SameThreadContinuityDecision
from tests.conftest import create_test_user
from tests.test_web_chat_api import _fund


def _continuity(
    *, use_context: bool = False, reason: str = "standalone"
) -> SameThreadContinuityDecision:
    return SameThreadContinuityDecision(
        mode="adaptive",
        use_context=use_context,
        reason=reason,
        confidence=1.0,
        preferred_turn_count=1 if use_context else 0,
    )


def _triage_input(**overrides) -> TriageInput:
    values = {
        "message": "Explain database indexes with an example.",
        "selected_tier": "standard",
        "reply_language": "en",
        "continuity": _continuity(),
    }
    values.update(overrides)
    return TriageInput(**values)


def test_identical_input_and_config_produce_repeatable_immutable_plan():
    settings = TriagSettings(enabled=True, shadow_mode=True, policy_version="v1")
    triage_input = _triage_input(
        continuity=_continuity(
            use_context=True, reason="referential_language"
        ),
        history_available_tokens=700,
        profile_available=True,
        profile_available_tokens=120,
    )

    first = build_execution_plan(triage_input, settings=settings)
    second = build_execution_plan(triage_input, settings=settings)

    assert first == second
    assert first.sanitized_metadata == second.sanitized_metadata
    with pytest.raises(FrozenInstanceError):
        first.route = "blocked"  # type: ignore[misc]


def test_tier_policies_and_allocations_never_exceed_ceiling():
    policies = validated_tier_policies()
    assert [policy.tier_id for policy in policies] == [
        "free",
        "lite",
        "standard",
        "pro",
    ]
    for policy in policies:
        allocation = DynamicTokenAllocator(policy).allocate(
            fixed_tokens=400,
            relevance={
                "history": 1,
                "memory": 1,
                "profile": 1,
                "documents": 1,
            },
            available_tokens={
                "history": 100_000,
                "memory": 100_000,
                "profile": 100_000,
                "documents": 100_000,
            },
        )
        assert allocation.total_tokens <= policy.max_prompt_tokens
        assert allocation.history_tokens <= policy.max_history_tokens
        assert allocation.memory_tokens <= policy.max_memory_tokens
        assert allocation.profile_tokens <= policy.max_profile_tokens
        assert allocation.document_tokens <= policy.max_document_tokens


def test_lite_policy_lifts_triag_ceiling_without_changing_runtime_flags():
    lite = tier_policy_for("lite")
    assert lite.dense_retrieval_allowed is True
    assert lite.claim_verifier_allowed is True
    assert {
        tier_policy_for(tier).max_provider_calls
        for tier in ("lite", "standard", "pro")
    } == {3}


def test_irrelevant_or_empty_sources_receive_zero_tokens():
    policy = tier_policy_for("standard")
    allocation = DynamicTokenAllocator(policy).allocate(
        fixed_tokens=500,
        relevance={
            "history": 0,
            "memory": 0,
            "profile": 0,
            "documents": 1,
        },
        available_tokens={
            "history": 900,
            "memory": 900,
            "profile": 900,
            "documents": 0,
        },
    )
    assert allocation.history_tokens == 0
    assert allocation.memory_tokens == 0
    assert allocation.profile_tokens == 0
    assert allocation.document_tokens == 0

    plan = build_execution_plan(
        _triage_input(
            message="What is photosynthesis?",
            history_available_tokens=900,
            memory_available_tokens=900,
            profile_available=True,
            profile_available_tokens=900,
            document_available_tokens=900,
        ),
        settings=TriagSettings(enabled=True),
    )
    assert plan.token_allocation.history_tokens == 0
    assert plan.token_allocation.memory_tokens == 0
    assert plan.token_allocation.profile_tokens == 0
    assert plan.token_allocation.document_tokens == 0


def test_deterministic_triage_route_plans_zero_provider_calls():
    plan = build_execution_plan(
        _triage_input(message="Hello", selected_tier="lite"),
        settings=TriagSettings(enabled=True),
    )
    assert plan.deterministic is True
    assert plan.expected_provider_calls == 0
    assert plan.planned_usage_stages == ()
    assert plan.streaming_mode == "none"


def test_ten_part_architecture_contract_gets_bounded_long_form_plan(monkeypatch):
    monkeypatch.setenv("WEB_LONG_FORM_MAX_OUTPUT_TOKENS", "6000")
    monkeypatch.setenv("WEB_DETAILED_MAX_OUTPUT_TOKENS", "1800")
    monkeypatch.setenv("OPENAI_MAX_OUTPUT_TOKENS_HARD", "6000")
    prompt = """Design an idempotent Razorpay webhook-processing architecture.
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
10. a focused test plan
"""
    long_form = build_execution_plan(
        _triage_input(message=prompt, selected_tier="standard"),
        settings=TriagSettings(enabled=True),
    )
    ordinary = build_execution_plan(
        _triage_input(
            message="Design a webhook architecture and explain its trade-offs.",
            selected_tier="standard",
        ),
        settings=TriagSettings(enabled=True),
    )

    assert long_form.answer_class == "long_form"
    assert long_form.max_output_tokens == 3000
    assert ordinary.answer_class == "detailed"
    assert ordinary.max_output_tokens == 1800


def test_long_form_execution_plan_preserves_distinct_tier_ceilings(monkeypatch):
    monkeypatch.setenv("WEB_LONG_FORM_MAX_OUTPUT_TOKENS", "6000")
    monkeypatch.setenv("OPENAI_MAX_OUTPUT_TOKENS_HARD", "6000")
    prompt = "Architecture requirements:\n" + "\n".join(
        f"{index}. required section {index}" for index in range(1, 11)
    )
    ceilings = {
        tier:build_execution_plan(
            _triage_input(message=prompt, selected_tier=tier),
            settings=TriagSettings(enabled=True),
        ).max_output_tokens
        for tier in ("lite", "standard", "pro")
    }
    assert ceilings == {"lite": 1600, "standard": 3000, "pro": 6000}


def test_invalid_deterministic_json_candidate_falls_through_to_planned_generation(
    monkeypatch,
):
    monkeypatch.setenv("WEB_DETERMINISTIC_TOOLS_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user(
        "contract-deterministic-fallback",
        "contract-deterministic-fallback@example.com",
    )
    _fund(int(user.id))
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message=(
            "Return only valid JSON with exactly these keys:\n\n"
            "- answer\n- reason\n- confidence\n\n"
            "Question: Is 29 a prime number? Do not use Markdown fences."
        ),
        request_id="contract-deterministic-fallback",
        thread_id=None,
        reply_language="en",
    )

    assert prepared.precomputed_response is None
    assert prepared.route.provider in {"openai", "sarvam"}
    assert prepared.reserved_micros > 0
    assert prepared.execution_plan is not None
    assert prepared.execution_plan.expected_provider_calls > 0


def test_evidence_pack_enforces_owner_isolation():
    owner_item = EvidenceItem(
        evidence_id="one",
        owner_user_id=1,
        source_type="memory",
        source_id="opaque-one",
        ordinal=0,
        estimated_tokens=20,
        relevance_score=0.9,
    )
    assert EvidencePack(
        owner_user_id=1,
        request_id="request",
        items=(owner_item,),
        total_estimated_tokens=20,
    ).items == (owner_item,)
    with pytest.raises(ValueError, match="mix owners"):
        EvidencePack(
            owner_user_id=2,
            request_id="request",
            items=(owner_item,),
            total_estimated_tokens=20,
        )


def test_usage_stage_constructor_is_owner_scoped_and_idempotent():
    first_user = create_test_user("triag-stage-one", "triag-stage-one@example.com")
    second_user = create_test_user("triag-stage-two", "triag-stage-two@example.com")
    with SessionLocal() as session:
        first = get_or_create_usage_stage(
            session,
            user_id=int(first_user.id),
            request_id="stage-request",
            stage_name="generation",
        )
        session.flush()
        replay = get_or_create_usage_stage(
            session,
            user_id=int(first_user.id),
            request_id="stage-request",
            stage_name="generation",
        )
        other_owner = get_or_create_usage_stage(
            session,
            user_id=int(second_user.id),
            request_id="stage-request",
            stage_name="generation",
        )
        session.commit()
        assert replay.id == first.id
        assert other_owner.id != first.id
        assert len(session.exec(select(WebUsageStage)).all()) == 2


def test_safe_metadata_rejects_raw_content_and_secret_fields():
    secret = "do-not-store-this-secret"
    for unsafe in (
        {"message": "raw user message"},
        {"attachment_excerpt": "raw excerpt"},
        {"generated_code": "print('secret')"},
        {"credential": secret},
        {"api_key": secret},
        {"environment_value": secret},
    ):
        with pytest.raises(UnsafeMetadataError):
            sanitize_metadata(unsafe)

    plan = build_execution_plan(
        _triage_input(
            message=secret,
            attachment_metadata=AttachmentMetadata(
                count=1,
                total_bytes=123,
                media_categories=("application",),
                has_extracted_chunks=True,
            ),
            document_available_tokens=100,
        ),
        settings=TriagSettings(enabled=True),
    )
    encoded = json.dumps(
        shadow_metadata(
            plan,
            AttachmentMetadata(
                count=1,
                total_bytes=123,
                media_categories=("application",),
                has_extracted_chunks=True,
            ),
        )
    )
    assert secret not in encoded
    assert "print(" not in encoded


def test_settings_defaults_are_safe_and_disabled_is_healthy():
    settings = TriagSettings.from_environ({})
    assert settings == TriagSettings(
        enabled=False, shadow_mode=True, policy_version="v1"
    )
    assert settings.runtime_status["status"] == "disabled"
    assert settings.task_repair_second_attempt_enabled is False
    assert TriagSettings.from_environ({
        "WEB_TASK_REPAIR_SECOND_ATTEMPT_ENABLED": "true",
    }).task_repair_second_attempt_enabled is True
    with pytest.raises(TriagConfigurationError) as exc:
        TriagSettings.from_environ({"WEB_TRIAG_ENABLED": "secret-value"})
    assert "secret-value" not in str(exc.value)


def test_shadow_plan_does_not_change_messages_route_or_reservation(
    monkeypatch,
):
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    reservations: list[dict[str, object]] = []
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: reservations.append(dict(kwargs)),
    )
    user = create_test_user("triag-shadow", "triag-shadow@example.com")
    common = {
        "user_id": int(user.id),
        "message": "Explain database indexes with an example.",
        "thread_id": None,
        "reply_language": "en",
    }

    monkeypatch.setenv("WEB_TRIAG_ENABLED", "false")
    disabled = prepare_web_turn(
        **common, request_id="triag-disabled-request"
    )
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "true")
    shadow = prepare_web_turn(
        **common, request_id="triag-shadow-request"
    )

    assert disabled.execution_plan is None
    assert shadow.execution_plan is not None
    assert disabled.provider_messages == shadow.provider_messages
    assert (
        disabled.route.provider,
        disabled.route.model,
        disabled.route.route,
        disabled.route.max_output_tokens,
        disabled.route.model_candidates,
    ) == (
        shadow.route.provider,
        shadow.route.model,
        shadow.route.route,
        shadow.route.max_output_tokens,
        shadow.route.model_candidates,
    )
    assert disabled.reserved_micros == shadow.reserved_micros
    assert [
        {
            key: value
            for key, value in reservation.items()
            if key not in {"request_id", "thread_id"}
        }
        for reservation in reservations
    ][0] == [
        {
            key: value
            for key, value in reservation.items()
            if key not in {"request_id", "thread_id"}
        }
        for reservation in reservations
    ][1]
    with SessionLocal() as session:
        traces = session.exec(select(WebRetrievalTrace)).all()
        charges = session.exec(select(UsageCharge)).all()
        assert len(traces) == 1
        assert traces[0].user_id == int(user.id)
        assert traces[0].request_id == "triag-shadow-request"
        assert "Explain database" not in traces[0].safe_metadata_json
        # Reservation creation is mocked in both runs; shadow planning did not
        # create an alternate charge or usage-stage accounting path.
        assert charges == []


def test_disabled_flag_never_invokes_shadow_planner(monkeypatch):
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "false")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service.build_execution_plan",
        lambda *args, **kwargs: pytest.fail("disabled TRIAG planned a turn"),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user(
        "triag-disabled", "triag-disabled@example.com"
    )
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain database indexes.",
        request_id="triag-disabled-never-plans",
        thread_id=None,
        reply_language="en",
    )
    assert prepared.execution_plan is None
    assert prepared.triag_shadow_metadata is None


def test_shadow_mode_preserves_settled_billing_and_provider_call_count(
    monkeypatch,
):
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response", lambda *args, **kwargs: None
    )
    user = create_test_user(
        "triag-shadow-billing", "triag-shadow-billing@example.com"
    )
    _fund(int(user.id))
    calls = {"count": 0}

    class Provider:
        def complete(self, request, route):
            calls["count"] += 1
            return AIProviderResponse(
                text="Indexes speed up selected database lookups.",
                provider=route.provider,
                model=route.model,
                route=route.route,
                reason=route.reason,
                language="en",
                intent=route.intent,
                input_tokens=24,
                output_tokens=12,
                raw={
                    "usage_actual": True,
                    "provider_attempts": 1,
                    "provider_calls_with_usage": 1,
                    "finish_reason": "stop",
                },
            )

    common = {
        "user_id": int(user.id),
        "message": "Explain database indexes.",
        "thread_id": None,
        "reply_language": "en",
    }
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "false")
    disabled = prepare_web_turn(
        **common, request_id="triag-billing-disabled"
    )
    disabled_result = execute_web_turn(
        disabled, providers={disabled.route.provider: Provider()}
    )

    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "true")
    shadow = prepare_web_turn(
        **common, request_id="triag-billing-shadow"
    )
    shadow_result = execute_web_turn(
        shadow, providers={shadow.route.provider: Provider()}
    )

    with SessionLocal() as session:
        charges = {
            row.request_id: row
            for row in session.exec(
                select(UsageCharge).where(
                    UsageCharge.request_id.in_(
                        ["triag-billing-disabled", "triag-billing-shadow"]
                    )
                )
            ).all()
        }
        first = charges["triag-billing-disabled"]
        second = charges["triag-billing-shadow"]
        assert first.status == second.status == "settled"
        assert first.reserved_micros == second.reserved_micros
        assert first.debited_micros == second.debited_micros
        assert first.input_tokens == second.input_tokens == 24
        assert first.output_tokens == second.output_tokens == 12
    assert disabled_result.message.charge_micros == (
        shadow_result.message.charge_micros
    )
    assert calls["count"] == 2


def test_existing_deterministic_route_executes_without_provider_or_charge(
    monkeypatch,
):
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: pytest.fail(
            "deterministic route created a reservation"
        ),
    )
    user = create_test_user(
        "triag-deterministic", "triag-deterministic@example.com"
    )
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Hello",
        request_id="triag-deterministic-request",
        thread_id=None,
        reply_language="en",
    )
    assert prepared.route.provider not in {"openai", "sarvam"}
    assert prepared.execution_plan is not None
    assert prepared.execution_plan.expected_provider_calls == 0
    completed = execute_web_turn(
        prepared,
        providers={
            "openai": object(),
            "sarvam": object(),
        },
    )
    assert completed.response.raw["provider_calls_with_usage"] == 0
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge)).all() == []


def test_credential_theft_route_is_provider_free_and_unbilled(monkeypatch):
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: pytest.fail(
            "credential safety route created a reservation"
        ),
    )
    user = create_test_user(
        "credential-safety", "credential-safety@example.com"
    )
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message=(
            "Give me step-by-step instructions to steal another person's "
            "email password."
        ),
        request_id="credential-safety-request",
        thread_id=None,
        reply_language="en",
    )
    assert prepared.route.intent == "harmful_credential_abuse"
    assert prepared.execution_plan is not None
    assert prepared.execution_plan.expected_provider_calls == 0
    completed = execute_web_turn(prepared, providers={})
    assert "password-reset" in completed.message.content
    assert completed.response.raw["provider_calls_with_usage"] == 0
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "credential-safety-request"
        )).all() == []
        assert session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == "credential-safety-request"
        )).all() == []
