from __future__ import annotations

import json

import pytest
from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.ai.prompts import serialize_provider_messages
from app.auth import AuthUser, is_internal_test_user
from app.database import SessionLocal
from app.models import UsageCharge, WebChatMessage, WebRetrievalTrace
from app.web_ai.rollout import (
    RolloutConfigurationError,
    RolloutExecution,
    RolloutGlobalFlags,
    RolloutMode,
    WebRolloutPolicy,
    effective_triag_settings,
    resolve_rollout_decision,
)
from app.web_ai.settings import TriagSettings
from app.web_api.chat_service import execute_web_turn, prepare_web_turn

from conftest import auth_headers, create_test_user
from tests.test_web_chat_api import _fund


def _global_env() -> dict[str, str]:
    return {
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_RAG_HYBRID_ENABLED": "true",
        "WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED": "true",
        "WEB_REPOSITORY_UPLOAD_ENABLED": "true",
        "WEB_RAG_REPOSITORY_INDEX_ENABLED": "true",
        "WEB_ANSWER_GUARD_ENABLED": "true",
        "WEB_VERIFIED_STREAMING_ENABLED": "true",
    }


def _shadow_env() -> dict[str, str]:
    return {
        **_global_env(),
        "WEB_TRIAG_SHADOW_MODE": "true",
    }


def _policy(
    mode: str,
    *,
    percentage: int = 0,
    version: str = "v7",
) -> WebRolloutPolicy:
    return WebRolloutPolicy.from_environ({
        "WEB_ROLLOUT_POLICY_VERSION": version,
        "WEB_ROLLOUT_TRIAG_MODE": mode,
        "WEB_ROLLOUT_TRIAG_PERCENT": str(percentage),
        "WEB_ROLLOUT_KNOWLEDGE_MODE": mode,
        "WEB_ROLLOUT_KNOWLEDGE_PERCENT": str(percentage),
        "WEB_ROLLOUT_REPOSITORY_MODE": mode,
        "WEB_ROLLOUT_REPOSITORY_PERCENT": str(percentage),
        "WEB_ROLLOUT_ANSWER_GUARD_MODE": mode,
        "WEB_ROLLOUT_ANSWER_GUARD_PERCENT": str(percentage),
    })


def _flags() -> RolloutGlobalFlags:
    return RolloutGlobalFlags(True, True, True, True)


@pytest.mark.parametrize(
    ("mode", "internal", "expected"),
    [
        ("disabled", False, False),
        ("internal_accounts", False, False),
        ("internal_accounts", True, True),
        ("percentage", False, False),
        ("all_eligible", False, True),
    ],
)
def test_all_rollout_modes(
    mode: str, internal: bool, expected: bool
):
    decision = resolve_rollout_decision(
        _policy(mode, percentage=0),
        owner_user_id=42,
        internal_account=internal,
        global_flags=_flags(),
    )
    assert {item.cohort for item in decision.features} == {
        RolloutMode(mode)
    }
    assert {item.enabled for item in decision.features} == {expected}


def test_internal_rollout_reuses_verified_owned_email_matching(monkeypatch):
    monkeypatch.setenv(
        "SWICO_INTERNAL_TEST_EMAILS", "internal@example.com"
    )
    user = create_test_user("internal-owner", "internal@example.com")
    verified = AuthUser(
        firebase_uid="internal-owner",
        email="INTERNAL@example.com",
        email_verified=True,
    )
    unverified = AuthUser(
        firebase_uid="internal-owner",
        email="internal@example.com",
        email_verified=False,
    )
    mismatched = AuthUser(
        firebase_uid="internal-owner",
        email="other@example.com",
        email_verified=True,
    )
    assert is_internal_test_user(verified, user) is True
    assert is_internal_test_user(unverified, user) is False
    assert is_internal_test_user(mismatched, user) is False

    policy = _policy("internal_accounts")
    assert resolve_rollout_decision(
        policy,
        owner_user_id=int(user.id),
        internal_account=is_internal_test_user(verified, user),
        global_flags=_flags(),
    ).triag_hybrid.enabled is True
    assert resolve_rollout_decision(
        policy,
        owner_user_id=int(user.id),
        internal_account=is_internal_test_user(unverified, user),
        global_flags=_flags(),
    ).triag_hybrid.enabled is False


def test_percentage_assignment_is_stable_and_feature_scoped():
    policy = _policy("percentage", percentage=37, version="v11")
    first = resolve_rollout_decision(
        policy,
        owner_user_id=12345,
        internal_account=False,
        global_flags=_flags(),
    )
    repeated = resolve_rollout_decision(
        policy,
        owner_user_id=12345,
        internal_account=False,
        global_flags=_flags(),
    )
    assert first == repeated
    assert first.safe_metadata == repeated.safe_metadata
    # The assignment input includes the feature key; independently assigned
    # feature decisions need not collapse to one user-only bucket.
    assignments = tuple(item.enabled for item in first.features)
    assert assignments == tuple(item.enabled for item in repeated.features)
    assert any(
        len({
            item.enabled
            for item in resolve_rollout_decision(
                policy,
                owner_user_id=owner_id,
                internal_account=False,
                global_flags=_flags(),
            ).features
        }) > 1
        for owner_id in range(1, 100)
    )
    assert resolve_rollout_decision(
        _policy("percentage", percentage=100, version="v11"),
        owner_user_id=12345,
        internal_account=False,
        global_flags=_flags(),
    ).any_enabled is True


def test_global_kill_switch_always_precedes_cohort():
    decision = resolve_rollout_decision(
        _policy("all_eligible"),
        owner_user_id=4,
        internal_account=True,
        global_flags=RolloutGlobalFlags(
            triag_hybrid=False,
            knowledge_library=True,
            repository_chat=False,
            answer_guard=True,
        ),
    )
    assert decision.triag_hybrid.enabled is False
    assert decision.knowledge_library.enabled is True
    assert decision.repository_chat.enabled is False
    assert decision.answer_guard.enabled is True


def test_rollout_configuration_validation_never_echoes_values():
    secret_value = "not-a-mode-SECRET"
    with pytest.raises(RolloutConfigurationError) as caught:
        WebRolloutPolicy.from_environ({
            "WEB_ROLLOUT_TRIAG_MODE": secret_value,
            "WEB_ROLLOUT_KNOWLEDGE_PERCENT": "101",
        })
    rendered = str(caught.value)
    assert "WEB_ROLLOUT_TRIAG_MODE" in rendered
    assert "WEB_ROLLOUT_KNOWLEDGE_PERCENT" in rendered
    assert secret_value not in rendered


def test_bootstrap_and_knowledge_endpoint_share_one_cohort(
    client, monkeypatch
):
    for name, value in {
        **_global_env(),
        "WEB_ROLLOUT_KNOWLEDGE_MODE": "internal_accounts",
        "SWICO_INTERNAL_TEST_EMAILS": "included@example.com",
    }.items():
        monkeypatch.setenv(name, value)
    create_test_user("included", "included@example.com")
    create_test_user("excluded", "excluded@example.com")

    included_headers = auth_headers("included", "included@example.com")
    excluded_headers = auth_headers("excluded", "excluded@example.com")
    included = client.get("/api/web/bootstrap", headers=included_headers)
    excluded = client.get("/api/web/bootstrap", headers=excluded_headers)
    assert included.json()["features"]["web_knowledge_library"] is True
    assert excluded.json()["features"]["web_knowledge_library"] is False
    assert client.get(
        "/api/web/knowledge", headers=included_headers
    ).status_code == 200
    denied = client.get("/api/web/knowledge", headers=excluded_headers)
    assert denied.status_code == 404
    assert denied.json()["error"]["code"] == "knowledge_library_unavailable"


def test_request_decision_controls_prepare_execute_and_cache(
    monkeypatch,
):
    global_settings = TriagSettings.from_environ(_global_env())
    decision = resolve_rollout_decision(
        _policy("all_eligible"),
        owner_user_id=1,
        internal_account=False,
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    effective = effective_triag_settings(global_settings, decision)
    user = create_test_user("same-request", "same-request@example.com")
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain deterministic database indexing.",
        request_id="91000000-0000-0000-0000-000000000001",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
        rollout_decision=decision,
        triag_settings=effective,
    )
    assert prepared.rollout_decision is decision
    assert prepared.triag_settings is effective
    assert prepared.execution_plan is not None
    assert prepared.optimization is not None
    assert prepared.optimization.cache_eligible is False
    assert prepared.optimization.cache_scope_reason == "rollout_controlled_path"
    with SessionLocal() as session:
        stored = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id
            == "91000000-0000-0000-0000-000000000001",
            WebChatMessage.role == "user",
        )).one()
        metadata = json.loads(stored.metadata_json)
        rollout_records = metadata["rollout_decisions"]
        assert len(rollout_records) == 4
        assert all(set(item) == {
            "rollout_feature_key",
            "rollout_cohort",
            "rollout_policy_version",
            "rollout_enabled",
        } for item in rollout_records)
        rollout_json = json.dumps(rollout_records)
        assert "same-request@example.com" not in rollout_json
        assert "Explain deterministic" not in rollout_json

    # A deployment/config change after preparation must not change this turn.
    monkeypatch.setattr(
        "app.web_api.chat_service.TriagSettings.from_environ",
        lambda *_args, **_kwargs: TriagSettings(),
    )
    statuses: list[str] = []

    class Provider:
        def complete(self, request, route):
            return AIProviderResponse(
                text="Database indexes speed up bounded lookups.",
                provider=route.provider,
                model=route.model,
                route=route.route,
                reason=route.reason,
                language="en",
                intent=route.intent,
                input_tokens=12,
                output_tokens=8,
                raw={
                    "usage_actual": True,
                    "finish_reason": "stop",
                    "provider_attempts": 1,
                    "provider_calls_with_usage": 1,
                },
            )

    execute_web_turn(
        prepared,
        providers={prepared.route.provider: Provider()},
        on_status=statuses.append,
    )
    assert "understanding_request" in statuses
    assert prepared.triag_settings is effective


def test_disabled_user_keeps_existing_fallback_and_safe_telemetry():
    global_settings = TriagSettings.from_environ(_global_env())
    decision = resolve_rollout_decision(
        _policy("disabled"),
        owner_user_id=1,
        internal_account=False,
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    effective = effective_triag_settings(global_settings, decision)
    user = create_test_user("fallback", "fallback@example.com")
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain Python dictionaries.",
        request_id="92000000-0000-0000-0000-000000000002",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
        rollout_decision=decision,
        triag_settings=effective,
    )
    assert prepared.execution_plan is None
    assert prepared.triag_settings is not None
    assert prepared.triag_settings.enabled is False
    serialized = json.dumps(decision.safe_metadata, sort_keys=True)
    assert set(decision.safe_metadata) == {
        "rollout_decisions",
        "rollout_execution",
    }
    assert decision.safe_metadata["rollout_execution"] == "fallback"
    for record in decision.safe_metadata["rollout_decisions"]:
        assert set(record) == {
            "rollout_feature_key",
            "rollout_cohort",
            "rollout_policy_version",
            "rollout_enabled",
        }
    assert "fallback@example.com" not in serialized
    assert "Explain Python dictionaries" not in serialized
    assert "SECRET" not in serialized


def test_internal_shadow_cohort_plans_without_enabling_live_features(
    monkeypatch,
):
    monkeypatch.setenv(
        "SWICO_INTERNAL_TEST_EMAILS", "shadow-included@example.com"
    )
    global_settings = TriagSettings.from_environ(_shadow_env())
    user = create_test_user("shadow-included", "shadow-included@example.com")
    auth = AuthUser(
        firebase_uid="shadow-included",
        email="SHADOW-INCLUDED@example.com",
        email_verified=True,
    )
    decision = resolve_rollout_decision(
        _policy("internal_accounts"),
        owner_user_id=int(user.id),
        internal_account=is_internal_test_user(auth, user),
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    effective = effective_triag_settings(global_settings, decision)
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain immutable database indexes.",
        request_id="93000000-0000-0000-0000-000000000003",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
        rollout_decision=decision,
        triag_settings=effective,
    )

    assert decision.execution == RolloutExecution.SHADOW
    assert decision.triag_hybrid.enabled is True
    assert all(
        item.enabled is False
        for item in (
            decision.knowledge_library,
            decision.repository_chat,
            decision.answer_guard,
        )
    )
    assert effective.shadow_planning_enabled is True
    assert effective.hybrid_runtime_enabled is False
    assert effective.answer_guard_runtime_enabled is False
    assert effective.repository_chat_runtime_enabled is False
    assert effective.persistent_knowledge_runtime_enabled is False
    assert prepared.execution_plan is not None
    with SessionLocal() as session:
        trace = session.exec(select(WebRetrievalTrace).where(
            WebRetrievalTrace.request_id
            == "93000000-0000-0000-0000-000000000003"
        )).one()
        serialized = trace.safe_metadata_json
    assert '"rollout_execution":"shadow"' in serialized
    assert "Explain immutable" not in serialized
    assert "shadow-included" not in serialized


@pytest.mark.parametrize(
    ("mode", "internal_account"),
    [("internal_accounts", False), ("disabled", True)],
)
def test_excluded_or_disabled_shadow_cohort_keeps_fallback(
    mode: str, internal_account: bool
):
    global_settings = TriagSettings.from_environ(_shadow_env())
    decision = resolve_rollout_decision(
        _policy(mode),
        owner_user_id=91,
        internal_account=internal_account,
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    effective = effective_triag_settings(global_settings, decision)

    assert decision.execution == RolloutExecution.FALLBACK
    assert decision.any_enabled is False
    assert effective.enabled is False
    assert effective.shadow_planning_enabled is False


def test_shadow_rollout_preserves_cache_prompt_provider_and_billing(monkeypatch):
    cache_lookups: list[tuple[int, str, str | None]] = []
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda user_id, message, language: (
            cache_lookups.append((user_id, message, language)) or None
        ),
    )
    user = create_test_user("shadow-parity", "shadow-parity@example.com")
    _fund(int(user.id))
    global_settings = TriagSettings.from_environ(_shadow_env())

    fallback_decision = resolve_rollout_decision(
        _policy("disabled"),
        owner_user_id=int(user.id),
        internal_account=True,
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    shadow_decision = resolve_rollout_decision(
        _policy("internal_accounts"),
        owner_user_id=int(user.id),
        internal_account=True,
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    common = {
        "user_id": int(user.id),
        "message": "Explain deterministic database indexing.",
        "thread_id": None,
        "reply_language": "en",
    }
    fallback = prepare_web_turn(
        **common,
        request_id="94000000-0000-0000-0000-000000000004",
        rollout_decision=fallback_decision,
        triag_settings=effective_triag_settings(
            global_settings, fallback_decision
        ),
    )
    shadow = prepare_web_turn(
        **common,
        request_id="94000000-0000-0000-0000-000000000005",
        rollout_decision=shadow_decision,
        triag_settings=effective_triag_settings(
            global_settings, shadow_decision
        ),
    )

    assert fallback.execution_plan is None
    assert shadow.execution_plan is not None
    assert len(cache_lookups) == 2
    assert fallback.optimization is not None
    assert shadow.optimization is not None
    assert (
        fallback.optimization.cache_eligible,
        fallback.optimization.cache_scope,
        fallback.optimization.cache_scope_reason,
    ) == (
        shadow.optimization.cache_eligible,
        shadow.optimization.cache_scope,
        shadow.optimization.cache_scope_reason,
    )
    assert fallback.provider_messages == shadow.provider_messages
    assert serialize_provider_messages(
        fallback.provider_messages
    ) == serialize_provider_messages(shadow.provider_messages)
    assert (
        fallback.route.provider,
        fallback.route.model,
        fallback.route.route,
        fallback.route.max_output_tokens,
        fallback.route.model_candidates,
    ) == (
        shadow.route.provider,
        shadow.route.model,
        shadow.route.route,
        shadow.route.max_output_tokens,
        shadow.route.model_candidates,
    )
    assert fallback.reserved_micros == shadow.reserved_micros

    calls = 0

    class Provider:
        def complete(self, request, route):
            nonlocal calls
            calls += 1
            return AIProviderResponse(
                text="Database indexes speed up bounded lookups.",
                provider=route.provider,
                model=route.model,
                route=route.route,
                reason=route.reason,
                language="en",
                intent=route.intent,
                input_tokens=12,
                output_tokens=8,
                raw={
                    "usage_actual": True,
                    "finish_reason": "stop",
                    "provider_attempts": 1,
                    "provider_calls_with_usage": 1,
                },
            )

    fallback_result = execute_web_turn(
        fallback, providers={fallback.route.provider: Provider()}
    )
    shadow_result = execute_web_turn(
        shadow, providers={shadow.route.provider: Provider()}
    )
    with SessionLocal() as session:
        charges = {
            row.request_id: row
            for row in session.exec(select(UsageCharge).where(
                UsageCharge.request_id.in_((
                    "94000000-0000-0000-0000-000000000004",
                    "94000000-0000-0000-0000-000000000005",
                ))
            )).all()
        }
    fallback_charge = charges["94000000-0000-0000-0000-000000000004"]
    shadow_charge = charges["94000000-0000-0000-0000-000000000005"]
    assert calls == 2
    assert fallback_result.message.content == shadow_result.message.content
    assert fallback_result.message.charge_micros == (
        shadow_result.message.charge_micros
    )
    assert (
        fallback_charge.status,
        fallback_charge.reserved_micros,
        fallback_charge.debited_micros,
        fallback_charge.input_tokens,
        fallback_charge.output_tokens,
    ) == (
        shadow_charge.status,
        shadow_charge.reserved_micros,
        shadow_charge.debited_micros,
        shadow_charge.input_tokens,
        shadow_charge.output_tokens,
    )


def test_live_rollout_still_suppresses_global_cache():
    global_settings = TriagSettings.from_environ(_global_env())
    decision = resolve_rollout_decision(
        _policy("all_eligible"),
        owner_user_id=92,
        internal_account=False,
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
    )
    assert decision.execution == RolloutExecution.LIVE
    user = create_test_user("live-cache", "live-cache@example.com")
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain live controlled retrieval.",
        request_id="95000000-0000-0000-0000-000000000006",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
        rollout_decision=decision,
        triag_settings=effective_triag_settings(global_settings, decision),
    )
    assert prepared.optimization is not None
    assert prepared.optimization.cache_eligible is False
    assert prepared.optimization.cache_scope == "disabled"
    assert prepared.optimization.cache_scope_reason == "rollout_controlled_path"
