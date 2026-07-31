from __future__ import annotations

import json
from typing import Mapping

from sqlmodel import Session, select

from ..models import WebRetrievalTrace, WebUsageStage
from .execution_plan import ExecutionPlan
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
