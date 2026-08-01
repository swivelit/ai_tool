from __future__ import annotations

import json
from typing import Mapping

from sqlmodel import Session, select

from ..models import (
    WebAnswerCheck,
    WebEvidenceItem,
    WebRetrievalTrace,
    WebUsageStage,
)
from .evidence.models import EvidencePack
from .execution_plan import ExecutionPlan
from .generation.models import AnswerQualityResult
from .telemetry.metadata import sanitize_metadata


def persist_shadow_plan(
    session: Session,
    *,
    user_id: int,
    thread_id: str | None,
    request_id: str,
    plan: ExecutionPlan,
    metadata: Mapping[str, object],
) -> WebRetrievalTrace:
    """Idempotently persist content-free shadow planning metadata."""

    key = f"triag-plan:{request_id}:{plan.policy_version}"
    existing = session.exec(
        select(WebRetrievalTrace).where(
            WebRetrievalTrace.user_id == int(user_id),
            WebRetrievalTrace.idempotency_key == key,
        )
    ).first()
    if existing is not None:
        return existing
    safe = sanitize_metadata(metadata)
    row = WebRetrievalTrace(
        user_id=int(user_id),
        thread_id=thread_id,
        request_id=request_id,
        idempotency_key=key,
        policy_version=plan.policy_version,
        tier_id=plan.tier_id,
        status="planned",
        safe_metadata_json=json.dumps(
            safe, sort_keys=True, separators=(",", ":")
        ),
    )
    session.add(row)
    return row


def get_or_create_usage_stage(
    session: Session,
    *,
    user_id: int,
    request_id: str,
    stage_name: str,
    thread_id: str | None = None,
    usage_charge_id: str | None = None,
    stage_order: int = 0,
    status: str = "planned",
    safe_metadata: Mapping[str, object] | None = None,
) -> WebUsageStage:
    """Owner-scoped idempotent constructor reserved for future phases."""

    normalized_stage = str(stage_name or "").strip().lower()
    if not normalized_stage or len(normalized_stage) > 32:
        raise ValueError("stage_name is required and must be at most 32 characters")
    existing = session.exec(
        select(WebUsageStage).where(
            WebUsageStage.user_id == int(user_id),
            WebUsageStage.request_id == request_id,
            WebUsageStage.stage_name == normalized_stage,
        )
    ).first()
    if existing is not None:
        return existing
    safe = sanitize_metadata(safe_metadata or {})
    row = WebUsageStage(
        user_id=int(user_id),
        thread_id=thread_id,
        usage_charge_id=usage_charge_id,
        request_id=request_id,
        idempotency_key=f"usage-stage:{request_id}:{normalized_stage}",
        stage_name=normalized_stage,
        stage_order=max(0, int(stage_order)),
        status=status,
        safe_metadata_json=json.dumps(
            safe, sort_keys=True, separators=(",", ":")
        ),
    )
    session.add(row)
    return row


def persist_retrieval_pack(
    session: Session,
    *,
    user_id: int,
    thread_id: str,
    request_id: str,
    policy_version: str,
    tier_id: str,
    pack: EvidencePack,
    candidate_count: int,
) -> WebRetrievalTrace:
    """Persist only content-free retrieval and evidence provenance."""

    if not pack.owner_user_id == int(user_id):
        raise ValueError("retrieval pack owner mismatch")
    key = f"triag-retrieval:{request_id}:{policy_version}"
    trace = session.exec(
        select(WebRetrievalTrace).where(
            WebRetrievalTrace.user_id == int(user_id),
            WebRetrievalTrace.idempotency_key == key,
        )
    ).first()
    fallback_reason_code = next((
        code for code in pack.status_codes
        if code in {
            "dense_unavailable",
            "embedding_budget_unavailable",
            "malformed_vector",
            "upload_expired",
            "retrieval_timeout",
            "retrieval_unavailable",
            "phase2_hybrid_retrieval_failed",
            "phase2_token_allocation_failed",
            "phase2_prompt_rebuild_failed",
            "phase2_persistence_failed",
            "phase2_unknown_failure",
        }
    ), None)
    safe_trace = sanitize_metadata(
        {
            "policy_version": policy_version,
            "tier_id": tier_id,
            "status": "complete",
            "retrieval_status": pack.retrieval_status,
            "candidate_count": max(0, int(candidate_count)),
            "evidence_item_count": len(pack.items),
            "total_token_count": pack.total_token_count,
            "status_codes": list(pack.status_codes),
            **(
                {"phase2_fallback_reason_code": fallback_reason_code}
                if fallback_reason_code else {}
            ),
        }
    )
    if trace is None:
        trace = WebRetrievalTrace(
            user_id=int(user_id),
            thread_id=thread_id,
            request_id=request_id,
            idempotency_key=key,
            policy_version=policy_version,
            tier_id=tier_id,
            status="complete",
            safe_metadata_json=json.dumps(
                safe_trace, sort_keys=True, separators=(",", ":")
            ),
        )
        session.add(trace)
        session.flush([trace])
    else:
        trace.status = "complete"
        trace.safe_metadata_json = json.dumps(
            safe_trace, sort_keys=True, separators=(",", ":")
        )
        session.add(trace)
    for item in pack.items:
        item_key = f"evidence:{request_id}:{item.citation_label}"
        existing = session.exec(
            select(WebEvidenceItem).where(
                WebEvidenceItem.user_id == int(user_id),
                WebEvidenceItem.idempotency_key == item_key,
            )
        ).first()
        if existing is not None:
            continue
        safe_item = sanitize_metadata(
            {
                "source_label": item.source_label,
                "source_locator": item.source_locator,
                "source_kind": item.source_type,
                "confidence": item.confidence,
                "content_hash": item.content_hash,
                "total_token_count": item.estimated_tokens,
                "status": "complete",
            }
        )
        session.add(
            WebEvidenceItem(
                trace_id=trace.id,
                user_id=int(user_id),
                request_id=request_id,
                idempotency_key=item_key,
                source_type=item.source_type[:32],
                source_id=item.source_id[:160],
                ordinal=item.ordinal,
                estimated_tokens=item.estimated_tokens,
                status="selected",
                safe_metadata_json=json.dumps(
                    safe_item, sort_keys=True, separators=(",", ":")
                ),
            )
        )
    return trace


def persist_answer_quality(
    session: Session,
    *,
    user_id: int,
    thread_id: str | None,
    request_id: str,
    assistant_message_id: str | None,
    result: AnswerQualityResult,
) -> WebAnswerCheck:
    """Idempotently persist content-free Answer Guard results."""

    key = f"answer-check:{request_id}:phase3"
    existing = session.exec(
        select(WebAnswerCheck).where(
            WebAnswerCheck.user_id == int(user_id),
            WebAnswerCheck.idempotency_key == key,
        )
    ).first()
    safe = sanitize_metadata(
        {
            "quality_outcome": result.status,
            **(
                {"retrieval_status": result.retrieval_status}
                if result.retrieval_status else {}
            ),
            "quality_checks": [
                {
                    "check_type": check.check_type,
                    "check_status": check.status,
                }
                for check in result.checks
            ],
            "repair_attempted": result.repair_attempted,
            "verifier_used": result.verifier_used,
            **(
                {
                    "repository_validation_mode": (
                        result.repository_validation_mode
                    )
                }
                if result.repository_validation_mode else {}
            ),
        }
    )
    row = existing or WebAnswerCheck(
        user_id=int(user_id),
        thread_id=thread_id,
        request_id=request_id,
        idempotency_key=key,
    )
    row.assistant_message_id = assistant_message_id
    row.status = (
        "passed"
        if result.status in {"verified", "grounded", "best_effort"}
        else "skipped"
        if result.status == "insufficient_evidence"
        else "failed"
    )
    row.passed = result.passed
    row.safe_metadata_json = json.dumps(
        safe, sort_keys=True, separators=(",", ":")
    )
    session.add(row)
    return row
