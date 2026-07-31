from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

import pytest

from app.auth import AuthUser, get_current_user
from app.database import SessionLocal
from app.main import app
from app.models import (
    UsageCharge,
    WebChatMessage,
    WebChatThread,
    WebMessageFeedback,
    WebUsageStage,
)
from app.web_ai.rollout_metrics import (
    RolloutReportSettings,
    build_rollout_report,
    evaluate_acceptance_gates,
)
from scripts.triag_rollout_report import render_report_json

from conftest import auth_headers, create_test_user


NOW = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)


def _rollout_metadata(
    *,
    version: str = "v1",
    cohort: str = "percentage",
    enabled: bool = True,
    execution: str = "live",
    unsafe: bool = False,
) -> str:
    records = [
        {
            "rollout_feature_key": feature,
            "rollout_cohort": cohort,
            "rollout_policy_version": version,
            "rollout_enabled": enabled,
            **({"private_message": "do not expose SECRET"} if unsafe else {}),
        }
        for feature in (
            "triag_hybrid",
            "knowledge_library",
            "repository_chat",
            "answer_guard",
        )
    ]
    return json.dumps({
        "rollout_execution": execution,
        "rollout_decisions": records,
        "attachments": [{"name": "private-customer-plan.pdf"}],
    })


def _insert_request(
    *,
    uid: str,
    email: str,
    request_id: str,
    created_at: datetime,
    version: str = "v1",
    cohort: str = "percentage",
    enabled: bool = True,
    execution: str = "live",
    tier: str = "standard",
    user_status: str = "complete",
    assistant_status: str = "complete",
    provider_calls: int = 3,
    cache_suppressed: bool = True,
    unsafe_rollout: bool = False,
    with_charge: bool = True,
    mismatch: bool = False,
    feedback: bool = False,
) -> None:
    user = create_test_user(uid, email)
    with SessionLocal() as session:
        thread = WebChatThread(
            user_id=int(user.id),
            title="Private thread title",
            created_at=created_at,
            updated_at=created_at,
        )
        session.add(thread)
        session.flush([thread])
        user_message = WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="user",
            content="raw private message SECRET",
            request_id=request_id,
            status=user_status,
            metadata_json=_rollout_metadata(
                version=version,
                cohort=cohort,
                enabled=enabled,
                execution=execution,
                unsafe=unsafe_rollout,
            ),
            created_at=created_at,
        )
        assistant = WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="assistant",
            content="raw generated answer SECRET",
            request_id=request_id,
            provider="private-provider",
            model="private-model",
            swico_tier=tier,
            input_tokens=30,
            output_tokens=15,
            status=assistant_status,
            metadata_json=json.dumps({
                "provider_calls_with_usage": provider_calls,
                "cache_scope": "disabled" if cache_suppressed else "global",
                "cache_scope_reason": (
                    "rollout_controlled_path"
                    if cache_suppressed else "public_standalone"
                ),
                "retrieval_status": "sufficient",
                "quality": {"status": "grounded"},
                "source_excerpt": "private source SECRET",
            }),
            created_at=created_at + timedelta(seconds=2),
        )
        session.add(user_message)
        session.add(assistant)
        session.flush([assistant])
        if with_charge:
            provider_cost = 100
            session.add(UsageCharge(
                request_id=request_id,
                user_id=int(user.id),
                thread_id=thread.id,
                assistant_message_id=assistant.id,
                provider="private-provider",
                model="private-model",
                swico_tier=tier,
                status="settled",
                reserved_micros=90 if mismatch else 100,
                debited_micros=80 if mismatch else 100,
                provider_cost_micros=provider_cost,
                input_tokens=30,
                output_tokens=15,
                settled_at=created_at + timedelta(seconds=2),
                created_at=created_at,
            ))
            for order, name, cost, input_count, output_count in (
                (10, "generation", 60, 21, 9),
                (20, "verifier", 20, 5, 2),
                (30, "repair", 20, 4, 1),
            ):
                session.add(WebUsageStage(
                    user_id=int(user.id),
                    thread_id=thread.id,
                    request_id=request_id,
                    idempotency_key=f"{request_id}:{name}",
                    stage_name=name,
                    stage_order=order,
                    status="settled",
                    debited_micros=cost,
                    input_tokens=input_count,
                    output_tokens=output_count,
                    settled_at=created_at + timedelta(seconds=2),
                    created_at=created_at,
                    updated_at=created_at + timedelta(seconds=2),
                ))
        if feedback:
            session.add(WebMessageFeedback(
                user_id=int(user.id),
                message_id=assistant.id,
                rating="up",
                created_at=created_at + timedelta(minutes=1),
                updated_at=created_at + timedelta(minutes=1),
            ))
        session.commit()


def _settings(*, min_sample: int = 1) -> RolloutReportSettings:
    return RolloutReportSettings(
        enabled=True,
        default_window_hours=24,
        max_window_hours=168,
        acceptance_min_sample=min_sample,
    )


def _group(
    report: dict[str, object], feature: str = "triag_hybrid"
) -> dict[str, object]:
    groups = report["groups"]
    assert isinstance(groups, list)
    return next(
        value for value in groups
        if value["feature_key"] == feature
    )


def test_report_window_is_bounded_and_excludes_old_requests():
    _insert_request(
        uid="recent",
        email="recent@example.com",
        request_id="report-recent",
        created_at=NOW - timedelta(hours=2),
    )
    _insert_request(
        uid="old",
        email="old@example.com",
        request_id="report-old",
        created_at=NOW - timedelta(hours=30),
    )
    with SessionLocal() as session:
        report = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
        assert _group(report)["metrics"]["total_eligible_requests"] == 1
        with pytest.raises(ValueError, match="configured bounds"):
            build_rollout_report(
                session, window_hours=169, settings=_settings(), now=NOW
            )


def test_policy_cohort_tier_groups_are_separate_and_sorted():
    _insert_request(
        uid="one",
        email="one@example.com",
        request_id="report-one",
        created_at=NOW - timedelta(hours=2),
        version="v1",
        cohort="internal_accounts",
        tier="pro",
    )
    _insert_request(
        uid="two",
        email="two@example.com",
        request_id="report-two",
        created_at=NOW - timedelta(hours=1),
        version="v2",
        cohort="percentage",
        tier="lite",
    )
    with SessionLocal() as session:
        report = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
    keys = [
        (
            item["policy_version"],
            item["feature_key"],
            item["rollout_cohort"],
            item["rollout_execution"],
            item["swico_tier"],
        )
        for item in report["groups"]
    ]
    assert keys == sorted(keys)
    assert {item[0] for item in keys} == {"v1", "v2"}
    assert {item[2] for item in keys} == {
        "internal_accounts", "percentage"
    }
    assert {item[3] for item in keys} == {"live"}
    assert {item[4] for item in keys} == {"lite", "pro"}


def test_shadow_and_live_execution_are_content_free_separate_groups():
    _insert_request(
        uid="shadow-report",
        email="shadow-report@example.com",
        request_id="report-shadow-execution",
        created_at=NOW - timedelta(hours=2),
        execution="shadow",
        cache_suppressed=False,
    )
    _insert_request(
        uid="live-report",
        email="live-report@example.com",
        request_id="report-live-execution",
        created_at=NOW - timedelta(hours=1),
        execution="live",
        cache_suppressed=True,
    )
    with SessionLocal() as session:
        report = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
    triag_groups = [
        group for group in report["groups"]
        if group["feature_key"] == "triag_hybrid"
    ]
    assert {group["rollout_execution"] for group in triag_groups} == {
        "shadow", "live"
    }
    shadow = next(
        group for group in triag_groups
        if group["rollout_execution"] == "shadow"
    )
    live = next(
        group for group in triag_groups
        if group["rollout_execution"] == "live"
    )
    assert shadow["metrics"]["cache_suppression_count"] == 0
    assert live["metrics"]["cache_suppression_count"] == 1
    rendered = json.dumps(report, sort_keys=True)
    for forbidden in (
        "shadow-report@example.com",
        "live-report@example.com",
        "report-shadow-execution",
        "report-live-execution",
        "private-provider",
        "private-model",
    ):
        assert forbidden not in rendered


def test_tokens_cost_feedback_failures_cancellation_and_mismatch_aggregate():
    _insert_request(
        uid="aggregate",
        email="aggregate@example.com",
        request_id="report-aggregate",
        created_at=NOW - timedelta(hours=1),
        user_status="cancelled",
        assistant_status="cancelled",
        mismatch=True,
        feedback=True,
    )
    with SessionLocal() as session:
        metrics = _group(build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        ))["metrics"]
    assert metrics["input_tokens"] == 30
    assert metrics["output_tokens"] == 15
    assert metrics["verifier_tokens"] == 7
    assert metrics["repair_tokens"] == 5
    assert metrics["total_settled_micro_inr"] == 80
    assert metrics["provider_call_count"] == 3
    assert metrics["cancellation_count"] == 1
    assert metrics["cancellation_failure_count"] == 1
    assert metrics["reservation_settlement_mismatch_count"] == 1
    assert metrics["feedback_count"] == 1
    assert metrics["feedback_rate"] == 1.0
    assert metrics["latency_p50_ms"] == 2000
    assert metrics["latency_p95_ms"] == 2000


def test_report_never_returns_sensitive_content_or_identity():
    _insert_request(
        uid="private-firebase-uid",
        email="private-admin@example.com",
        request_id="report-private",
        created_at=NOW - timedelta(hours=1),
        unsafe_rollout=True,
    )
    with SessionLocal() as session:
        report = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
    rendered = json.dumps(report, sort_keys=True)
    for forbidden in (
        "raw private message",
        "raw generated answer",
        "private source",
        "private-customer-plan",
        "private-admin@example.com",
        "private-firebase-uid",
        "private-provider",
        "private-model",
        "SECRET",
    ):
        assert forbidden not in rendered
    for forbidden_key in (
        '"user_id"',
        '"firebase_uid"',
        '"email"',
        '"provider"',
        '"model"',
        '"request_id"',
    ):
        assert forbidden_key not in rendered
    assert _group(report)["metrics"]["privacy_violation_count"] > 0


def test_disabled_rollout_is_counted_as_existing_fallback():
    _insert_request(
        uid="fallback",
        email="fallback@example.com",
        request_id="report-fallback",
        created_at=NOW - timedelta(hours=1),
        cohort="disabled",
        enabled=False,
        execution="fallback",
        provider_calls=0,
        cache_suppressed=False,
        with_charge=False,
    )
    with SessionLocal() as session:
        metrics = _group(build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        ))["metrics"]
    assert metrics["total_eligible_requests"] == 1
    assert metrics["rollout_enabled_requests"] == 0
    assert metrics["fallback_requests"] == 1
    assert metrics["deterministic_provider_free_requests"] == 1
    assert metrics["cache_suppression_count"] == 0


def test_failure_status_is_aggregated_without_failure_details():
    _insert_request(
        uid="failed",
        email="failed@example.com",
        request_id="report-failed",
        created_at=NOW - timedelta(hours=1),
        user_status="retryable",
        assistant_status="failed",
        with_charge=False,
    )
    with SessionLocal() as session:
        report = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
    metrics = _group(report)["metrics"]
    assert metrics["failure_count"] == 1
    assert "failure_detail" not in json.dumps(report)


def test_acceptance_evaluator_emits_every_status_deterministically():
    base = {
        "total_eligible_requests": 100,
        "failure_count": 0,
        "cancellation_count": 10,
        "cancellation_failure_count": 0,
        "privacy_violation_count": 0,
        "owner_isolation_mismatch_count": 0,
        "reservation_settlement_mismatch_count": 0,
        "latency_p95_ms": 1000,
        "retrieval_status_counts": {
            "sufficient": 100,
            "ambiguous": 0,
            "insufficient": 0,
            "contradictory": 0,
        },
        "answer_quality_status_counts": {
            "verified": 100,
            "grounded": 0,
            "best_effort": 0,
            "unverified": 0,
            "insufficient_evidence": 0,
        },
    }
    passing = evaluate_acceptance_gates(base, min_sample=20)
    assert {item.status for item in passing} == {"pass"}
    warning = evaluate_acceptance_gates(
        {**base, "failure_count": 3}, min_sample=20
    )
    assert next(
        item for item in warning if item.gate == "error_rate"
    ).status == "warning"
    failing = evaluate_acceptance_gates(
        {**base, "reservation_settlement_mismatch_count": 1},
        min_sample=20,
    )
    assert next(
        item for item in failing if item.gate == "billing_settlement"
    ).status == "fail"
    isolation_failure = evaluate_acceptance_gates(
        {**base, "owner_isolation_mismatch_count": 1},
        min_sample=20,
    )
    assert next(
        item
        for item in isolation_failure
        if item.gate == "owner_isolation"
    ).status == "fail"
    privacy_failure = evaluate_acceptance_gates(
        {**base, "privacy_violation_count": 1},
        min_sample=20,
    )
    assert next(
        item for item in privacy_failure if item.gate == "privacy"
    ).status == "fail"
    insufficient = evaluate_acceptance_gates(
        {
            **base,
            "total_eligible_requests": 1,
            "cancellation_count": 0,
            "retrieval_status_counts": {},
            "answer_quality_status_counts": {},
        },
        min_sample=20,
    )
    assert "insufficient_sample" in {
        item.status for item in insufficient
    }
    assert warning == evaluate_acceptance_gates(
        {**base, "failure_count": 3}, min_sample=20
    )


def test_report_and_cli_serialization_are_deterministic():
    _insert_request(
        uid="stable",
        email="stable@example.com",
        request_id="report-stable",
        created_at=NOW - timedelta(hours=1),
    )
    with SessionLocal() as session:
        first = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
        second = build_rollout_report(
            session, window_hours=24, settings=_settings(), now=NOW
        )
    assert first == second
    assert render_report_json(first, pretty=False) == render_report_json(
        second, pretty=False
    )


def test_verified_admin_authorization_and_non_disclosing_denials(
    client, monkeypatch
):
    for name, value in {
        "WEB_TRIAG_ROLLOUT_REPORT_ENABLED": "true",
        "ADMIN_EMAILS": "admin@example.com",
    }.items():
        monkeypatch.setenv(name, value)
    create_test_user("admin", "admin@example.com")
    create_test_user("ordinary", "ordinary@example.com")

    allowed = client.get(
        "/api/web/admin/triag-rollout-report",
        headers=auth_headers("admin", "admin@example.com"),
    )
    assert allowed.status_code == 200
    assert allowed.headers["cache-control"] == "no-store"

    ordinary = client.get(
        "/api/web/admin/triag-rollout-report",
        headers=auth_headers("ordinary", "ordinary@example.com"),
    )
    assert ordinary.status_code == 404
    assert ordinary.json()["detail"] == "Not found"

    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        firebase_uid="admin",
        email="admin@example.com",
        email_verified=False,
    )
    try:
        unverified = client.get(
            "/api/web/admin/triag-rollout-report",
            headers={"Authorization": "Bearer ignored"},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert unverified.status_code == 404
    assert unverified.json()["detail"] == "Not found"


def test_admin_report_window_bound_and_disabled_flag(
    client, monkeypatch
):
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    monkeypatch.setenv("WEB_TRIAG_ROLLOUT_REPORT_ENABLED", "true")
    monkeypatch.setenv(
        "WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS", "48"
    )
    create_test_user("admin", "admin@example.com")
    headers = auth_headers("admin", "admin@example.com")
    bounded = client.get(
        "/api/web/admin/triag-rollout-report?window_hours=49",
        headers=headers,
    )
    assert bounded.status_code == 422

    monkeypatch.setenv("WEB_TRIAG_ROLLOUT_REPORT_ENABLED", "false")
    disabled = client.get(
        "/api/web/admin/triag-rollout-report",
        headers=headers,
    )
    assert disabled.status_code == 404
