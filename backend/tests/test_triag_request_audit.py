from __future__ import annotations

import json
from uuid import UUID

from sqlmodel import select

from app.auth import AuthUser, get_current_user
from app.billing.service import release_usage_reservation
from app.database import SessionLocal
from app.main import app
from app.models import (
    UsageCharge,
    WebAnswerCheck,
    WebChatMessage,
    WebChatThread,
    WebEvidenceItem,
    WebRetrievalTrace,
    WebUsageStage,
)
from app.time_utils import utc_now
from tests.conftest import auth_headers, create_test_user


REQUEST_ID = "72000000-0000-4000-8000-000000000001"
UNKNOWN_ID = "72000000-0000-4000-8000-000000000099"
SECRET_CONTENT = "private-answer-and-prompt"
SECRET_FILENAME = "customer-financial-plan.pdf"
SECRET_PROVIDER = "private-provider-name"
SECRET_MODEL = "private-model-name"

EXPECTED_RESULT_KEYS = {
    "request_id",
    "usage_charge_row_count",
    "usage_stage_row_count",
    "provider_call_count",
    "reserved_micro_inr_total",
    "charged_micro_inr_total",
    "settled_micro_inr_total",
    "charge_status_counts",
    "usage_stage_status_counts",
    "active_usage_stage_names",
    "last_terminal_charge_status",
    "paid_usage_stage_count",
    "duplicate_settlement_indicator",
    "source_count",
    "source_kind_counts",
    "retrieval_status",
    "quality_status",
    "persisted_quality_status",
    "cache_hit",
    "cache_hit_kind",
    "finish_reason",
    "completion_status",
    "truncated",
    "fence_autoclosed",
    "output_contract_check_status_counts",
    "task_requirement_check_status_counts",
    "architecture_missing_area_identifiers",
    "pre_repair_failed_check_identifiers",
    "repair_trigger_area_identifiers",
    "post_repair_failed_check_identifiers",
    "architecture_repair_mode",
    "failed_check_identifiers",
    "deterministic_intent",
    "deterministic_route",
    "scope_gate_reason",
    "repair_attempted",
    "generation_stage_count",
    "repair_stage_count",
    "answer_check_status_counts",
    "selected_tier",
    "repository_validation_mode",
    "reasoning_effort",
    "effective_max_output_tokens",
    "visible_output_reserve_tokens",
    "reasoning_budget_cap_tokens",
    "reasoning_starved_retry",
    "turn_lifecycle_stage",
    "turn_lifecycle_events",
    "turn_lifecycle_reason",
    "generation_output_tokens",
    "generation_reasoning_tokens",
    "generation_visible_output_tokens",
    "phase2_fallback_reason_code",
    "cancellation_state",
    "cancellation_failure_origin",
    "cancellation_failure_count",
    "orphaned_active_reservation",
}


def _seed_request() -> None:
    owner = create_test_user("request-owner", "owner@example.com")
    now = utc_now()
    with SessionLocal() as session:
        thread = WebChatThread(
            user_id=int(owner.id), title=SECRET_CONTENT
        )
        session.add(thread)
        session.flush()
        trace = WebRetrievalTrace(
            user_id=int(owner.id),
            thread_id=thread.id,
            request_id=REQUEST_ID,
            idempotency_key=f"trace:{REQUEST_ID}",
            policy_version="v1",
            tier_id="pro",
            status="complete",
            safe_metadata_json=json.dumps({
                "retrieval_status": "sufficient",
            }),
            updated_at=now,
        )
        session.add(trace)
        session.flush()
        session.add(WebEvidenceItem(
            trace_id=trace.id,
            user_id=int(owner.id),
            request_id=REQUEST_ID,
            idempotency_key=f"evidence:{REQUEST_ID}",
            source_type="temporary_upload",
            source_id=SECRET_FILENAME,
            ordinal=0,
            status="selected",
            safe_metadata_json=json.dumps({
                "source_locator": SECRET_FILENAME,
                "source_text": SECRET_CONTENT,
            }),
        ))
        session.add(WebAnswerCheck(
            user_id=int(owner.id),
            thread_id=thread.id,
            request_id=REQUEST_ID,
            idempotency_key=f"check:{REQUEST_ID}",
            status="passed",
            passed=True,
            safe_metadata_json=json.dumps({
                "quality_outcome": "grounded",
                "generated_code": SECRET_CONTENT,
            }),
            updated_at=now,
        ))
        session.add(WebUsageStage(
            user_id=int(owner.id),
            thread_id=thread.id,
            request_id=REQUEST_ID,
            idempotency_key=f"stage:{REQUEST_ID}",
            stage_name="generation",
            status="settled",
            reserved_micros=500,
            debited_micros=321,
            input_tokens=10,
            output_tokens=20,
            settled_at=now,
            safe_metadata_json=json.dumps({
                "provider": SECRET_PROVIDER,
                "model": SECRET_MODEL,
                "reasoning_effort": "medium",
                "reasoning_token_count": 5,
                "effective_max_output_tokens": 3000,
                "visible_output_reserve_tokens": 0,
                "reasoning_budget_cap_tokens": 3000,
                "reasoning_starved_retry": False,
                "turn_lifecycle_stage": "message_persisted",
                "turn_lifecycle_events": [
                    "reserved", "provider_started", "provider_completed",
                    "answer_finalized", "message_persisted",
                ],
            }),
        ))
        session.add(UsageCharge(
            request_id=REQUEST_ID,
            user_id=int(owner.id),
            thread_id=thread.id,
            provider=SECRET_PROVIDER,
            model=SECRET_MODEL,
            reserved_micros=500,
            debited_micros=321,
            provider_cost_micros=321,
            status="settled",
            settled_at=now,
            pricing_snapshot_json=json.dumps({"prompt": SECRET_CONTENT}),
        ))
        session.add(WebChatMessage(
            thread_id=thread.id,
            user_id=int(owner.id),
            role="user",
            content=SECRET_CONTENT,
            request_id=REQUEST_ID,
            status="complete",
            metadata_json=json.dumps({"filename": SECRET_FILENAME}),
        ))
        session.add(WebChatMessage(
            thread_id=thread.id,
            user_id=int(owner.id),
            role="assistant",
            content=SECRET_CONTENT,
            request_id=REQUEST_ID,
            provider=SECRET_PROVIDER,
            model=SECRET_MODEL,
            status="complete",
            metadata_json=json.dumps({
                "provider_calls_with_usage": 1,
                "quality": {"status": "grounded"},
                "answer": SECRET_CONTENT,
            }),
        ))
        session.commit()


def _configure_admin(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    create_test_user("audit-admin", "admin@example.com")
    return auth_headers("audit-admin", "admin@example.com")


def test_request_audit_requires_verified_admin_and_is_non_disclosing(
    client, monkeypatch
):
    _seed_request()
    admin_headers = _configure_admin(monkeypatch)
    create_test_user("ordinary", "ordinary@example.com")

    assert client.post(
        "/api/web/admin/triag-request-audit",
        json={"request_ids": [REQUEST_ID]},
    ).status_code == 401
    denied = client.post(
        "/api/web/admin/triag-request-audit",
        headers=auth_headers("ordinary", "ordinary@example.com"),
        json={"request_ids": [REQUEST_ID]},
    )
    unknown = client.post(
        "/api/web/admin/triag-request-audit",
        headers=admin_headers,
        json={"request_ids": [UNKNOWN_ID]},
    )
    assert denied.status_code == unknown.status_code == 404
    assert denied.json() == unknown.json() == {"detail": "Not found"}

    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        firebase_uid="audit-admin",
        email="admin@example.com",
        email_verified=False,
    )
    try:
        unverified = client.post(
            "/api/web/admin/triag-request-audit",
            headers={"Authorization": "Bearer ignored"},
            json={"request_ids": [REQUEST_ID]},
        )
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert unverified.status_code == 404
    assert unverified.json() == {"detail": "Not found"}


def test_request_audit_is_bounded_and_rejects_duplicates(client, monkeypatch):
    headers = _configure_admin(monkeypatch)
    too_many = [
        str(UUID(int=index + 1)) for index in range(13)
    ]
    assert client.post(
        "/api/web/admin/triag-request-audit",
        headers=headers,
        json={"request_ids": too_many},
    ).status_code == 422
    assert client.post(
        "/api/web/admin/triag-request-audit",
        headers=headers,
        json={"request_ids": [UNKNOWN_ID, UNKNOWN_ID]},
    ).status_code == 422
    assert client.post(
        "/api/web/admin/triag-request-audit",
        headers=headers,
        json={"request_ids": []},
    ).status_code == 422


def test_request_audit_serialization_is_content_free(client, monkeypatch):
    _seed_request()
    headers = _configure_admin(monkeypatch)
    response = client.post(
        "/api/web/admin/triag-request-audit",
        headers=headers,
        json={"request_ids": [REQUEST_ID]},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    result = response.json()["results"][0]
    assert set(result) == EXPECTED_RESULT_KEYS
    assert result == {
        "request_id": REQUEST_ID,
        "usage_charge_row_count": 1,
        "usage_stage_row_count": 1,
        "provider_call_count": 1,
        "reserved_micro_inr_total": 500,
        "charged_micro_inr_total": 321,
        "settled_micro_inr_total": 321,
        "charge_status_counts": {"settled": 1},
        "usage_stage_status_counts": {"settled": 1},
        "active_usage_stage_names": [],
        "last_terminal_charge_status": "settled",
        "paid_usage_stage_count": 1,
        "duplicate_settlement_indicator": False,
        "source_count": 1,
        "source_kind_counts": {"temporary_upload": 1},
        "retrieval_status": "sufficient",
        "quality_status": "grounded",
        "persisted_quality_status": "grounded",
        "cache_hit": False,
        "cache_hit_kind": "none",
        "finish_reason": "unknown",
        "completion_status": "unknown",
        "truncated": False,
        "fence_autoclosed": False,
        "output_contract_check_status_counts": {},
        "task_requirement_check_status_counts": {},
        "architecture_missing_area_identifiers": [],
        "pre_repair_failed_check_identifiers": [],
        "repair_trigger_area_identifiers": [],
        "post_repair_failed_check_identifiers": [],
        "architecture_repair_mode": "not_attempted",
        "failed_check_identifiers": [],
        "deterministic_intent": None,
        "deterministic_route": None,
        "scope_gate_reason": None,
        "repair_attempted": False,
        "generation_stage_count": 1,
        "repair_stage_count": 0,
        "answer_check_status_counts": {"passed": 1},
        "selected_tier": "pro",
        "repository_validation_mode": None,
        "reasoning_effort": "medium",
        "effective_max_output_tokens": 3000,
        "visible_output_reserve_tokens": 0,
        "reasoning_budget_cap_tokens": 3000,
        "reasoning_starved_retry": False,
        "turn_lifecycle_stage": "message_persisted",
        "turn_lifecycle_events": [
            "reserved", "provider_started", "provider_completed",
            "answer_finalized", "message_persisted",
        ],
        "turn_lifecycle_reason": None,
        "generation_output_tokens": 20,
        "generation_reasoning_tokens": 5,
        "generation_visible_output_tokens": 15,
        "phase2_fallback_reason_code": None,
        "cancellation_state": "complete",
        "cancellation_failure_origin": "none",
        "cancellation_failure_count": 0,
        "orphaned_active_reservation": False,
    }

    rendered = response.text
    for forbidden in (
        SECRET_CONTENT,
        SECRET_FILENAME,
        SECRET_PROVIDER,
        SECRET_MODEL,
        "owner@example.com",
        '"user_id"',
        '"email"',
        '"provider"',
        '"model"',
        '"prompt"',
        '"message"',
        '"answer"',
        '"filename"',
        '"source_locator"',
        '"source_text"',
        '"generated_code"',
        '"metadata"',
        '"exception"',
    ):
        assert forbidden not in rendered


def test_request_audit_reports_clean_pre_provider_cancellation(
    client, monkeypatch
):
    _seed_request()
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == REQUEST_ID
        )).one()
        original_status = charge.status
        original_debit = charge.debited_micros
        original_settled_at = charge.settled_at
        release_usage_reservation(
            session,
            REQUEST_ID,
            reason="cancelled_before_provider_usage",
            annotate_terminal=True,
        )
        session.flush()
        assert charge.status == original_status
        assert charge.debited_micros == original_debit
        assert charge.settled_at == original_settled_at
        assert json.loads(charge.pricing_snapshot_json)[
            "release_reason"
        ] == "cancelled_before_provider_usage"
        stage = session.exec(select(WebUsageStage).where(
            WebUsageStage.request_id == REQUEST_ID
        )).one()
        stage.status = "released"
        stage.debited_micros = 0
        session.add(stage)
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == REQUEST_ID,
            WebChatMessage.role == "assistant",
        )).one()
        session.delete(assistant)
        user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == REQUEST_ID,
            WebChatMessage.role == "user",
        )).one()
        user_message.status = "retryable"
        session.add(user_message)
        session.commit()

    response = client.post(
        "/api/web/admin/triag-request-audit",
        headers=_configure_admin(monkeypatch),
        json={"request_ids": [REQUEST_ID]},
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["cancellation_state"] == "cancelled"
    assert result["cancellation_failure_origin"] == "none"
    assert result["cancellation_failure_count"] == 0
    assert result["orphaned_active_reservation"] is False
    assert result["duplicate_settlement_indicator"] is False
    assert SECRET_CONTENT not in response.text


def test_request_audit_includes_every_counted_failed_contract_identifier(
    client, monkeypatch,
):
    _seed_request()
    with SessionLocal() as session:
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == REQUEST_ID,
            WebChatMessage.role == "assistant",
        )).one()
        assistant.metadata_json = json.dumps({
            "deterministic_intent": "billing_tier_pricing",
            "deterministic_route": None,
            "scope_gate_reason": "message_too_long",
            "quality": {
                "status": "unverified",
                "checks": [
                    {
                        "type": "task_requirement_explicit_subquestions",
                        "status": "failed",
                    },
                    {
                        "type": "output_contract_question_count",
                        "status": "failed",
                    },
                ],
            },
        })
        session.add(assistant)
        session.commit()

    response = client.post(
        "/api/web/admin/triag-request-audit",
        headers=_configure_admin(monkeypatch),
        json={"request_ids": [REQUEST_ID]},
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["task_requirement_check_status_counts"] == {"failed": 1}
    assert result["output_contract_check_status_counts"] == {"failed": 1}
    assert result["failed_check_identifiers"] == [
        "task_requirement_explicit_subquestions",
        "output_contract_question_count",
    ]
    assert result["pre_repair_failed_check_identifiers"] == (
        result["failed_check_identifiers"]
    )
    assert result["post_repair_failed_check_identifiers"] == (
        result["failed_check_identifiers"]
    )
    assert result["deterministic_intent"] == "billing_tier_pricing"
    assert result["deterministic_route"] is None
    assert result["scope_gate_reason"] == "message_too_long"
    assert SECRET_CONTENT not in response.text


def test_request_audit_retryable_without_cancellation_reason_is_failed(
    client, monkeypatch
):
    _seed_request()
    with SessionLocal() as session:
        user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == REQUEST_ID,
            WebChatMessage.role == "user",
        )).one()
        user_message.status = "retryable"
        session.add(user_message)
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == REQUEST_ID,
            WebChatMessage.role == "assistant",
        )).one()
        session.delete(assistant)
        session.commit()
    response = client.post(
        "/api/web/admin/triag-request-audit",
        headers=_configure_admin(monkeypatch),
        json={"request_ids": [REQUEST_ID]},
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["cancellation_state"] == "failed"
    assert result["cancellation_failure_origin"] == "message_status"


def test_request_audit_cancelled_assistant_remains_cancelled(
    client, monkeypatch
):
    _seed_request()
    with SessionLocal() as session:
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == REQUEST_ID,
            WebChatMessage.role == "assistant",
        )).one()
        assistant.status = "cancelled"
        session.add(assistant)
        session.commit()
    response = client.post(
        "/api/web/admin/triag-request-audit",
        headers=_configure_admin(monkeypatch),
        json={"request_ids": [REQUEST_ID]},
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["cancellation_state"] == "cancelled"
    assert result["cancellation_failure_origin"] == "none"
