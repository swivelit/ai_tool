from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
import json
from typing import Callable, Sequence

from sqlmodel import Session, select

from ..billing.service import release_usage_reservation, settle_usage_reservation
from ..models import (
    Job,
    UsageCharge,
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebUsageStage,
)
from ..time_utils import utc_now
from .persistence import get_or_create_usage_stage
from .retrieval.hierarchical import build_hierarchy_for_document
from .retrieval.persistent_knowledge import finalize_knowledge_ingest
from .retrieval.triplet import extract_triplets_for_document
from .settings import TriagSettings
from .tier_policy import tier_policy_for
from .telemetry.metadata import sanitize_metadata


KNOWLEDGE_JOB_TYPES = (
    "web_knowledge_ingest",
    "web_embedding_backfill",
    "web_triplet_extract",
    "web_hierarchy_build",
)
KNOWLEDGE_JOB_VERSION = "v1"


@dataclass(frozen=True)
class PaidEmbeddingResult:
    vectors: tuple[tuple[float, ...], ...]
    provider: str
    model: str
    input_tokens: int
    native_cost_amount: Decimal
    native_cost_currency: str
    micro_inr_cost: int
    usd_to_inr_rate: Decimal | None = None


PaidEmbeddingProvider = Callable[[Sequence[str]], PaidEmbeddingResult]


def enqueue_knowledge_job(
    session: Session,
    *,
    owner_user_id: int,
    job_type: str,
    document_id: str,
    source_version: str,
    idempotency_key: str,
    swico_tier: str = "pro",
    request_id: str | None = None,
    usage_charge_id: str | None = None,
) -> Job:
    if job_type not in KNOWLEDGE_JOB_TYPES:
        raise ValueError("unsupported knowledge job type")
    owner = int(owner_user_id)
    document = session.exec(
        select(WebKnowledgeDocument).where(
            WebKnowledgeDocument.id == str(document_id),
            WebKnowledgeDocument.owner_user_id == owner,
            WebKnowledgeDocument.source_version == str(source_version),
            WebKnowledgeDocument.deleted_at.is_(None),
        )
    ).first()
    if document is None:
        raise PermissionError("knowledge document unavailable")
    key = str(idempotency_key or "").strip()
    if not key or len(key) > 160:
        raise ValueError("knowledge job idempotency key is invalid")
    existing_rows = session.exec(
        select(Job).where(
            Job.user_id == owner,
            Job.job_type == job_type,
        ).order_by(Job.created_at.desc()).limit(500)
    ).all()
    for existing in existing_rows:
        try:
            payload = json.loads(existing.payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if (
            payload.get("idempotency_key") == key
            and payload.get("job_version") == KNOWLEDGE_JOB_VERSION
        ):
            return existing
    payload = {
        "owner_user_id": owner,
        "document_id": document.id,
        "source_version": document.source_version,
        "idempotency_key": key,
        "job_version": KNOWLEDGE_JOB_VERSION,
        "swico_tier": tier_policy_for(swico_tier).tier_id,
    }
    if request_id and usage_charge_id:
        payload["request_id"] = str(request_id)[:64]
        payload["usage_charge_id"] = str(usage_charge_id)[:36]
    job = Job(
        user_id=owner,
        job_type=job_type,
        status="queued",
        payload_json=json.dumps(payload, sort_keys=True, separators=(",", ":")),
        attempts=0,
        max_attempts=3,
        run_at=utc_now(),
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def cancel_knowledge_job(
    session: Session, *, owner_user_id: int, job_id: int
) -> Job:
    job = session.exec(
        select(Job).where(
            Job.id == int(job_id),
            Job.user_id == int(owner_user_id),
            Job.job_type.in_(KNOWLEDGE_JOB_TYPES),
        )
    ).first()
    if job is None:
        raise PermissionError("knowledge job unavailable")
    if job.status in {"queued", "retrying", "running"}:
        job.status = "cancelled"
        job.error_message = None
        job.finished_at = utc_now()
        job.updated_at = utc_now()
        session.add(job)
    return job


def knowledge_job_cancelled(
    session: Session, *, job_id: int | None, owner_user_id: int
) -> bool:
    if not job_id:
        return False
    session.expire_all()
    job = session.get(Job, int(job_id))
    return bool(
        job is None
        or job.user_id != int(owner_user_id)
        or job.status == "cancelled"
    )


def handle_knowledge_ingest(
    session: Session, payload: dict[str, object]
) -> dict[str, object]:
    _validate_payload(payload)
    if _cancelled(session, payload):
        return {"status": "cancelled"}
    return finalize_knowledge_ingest(
        session,
        owner_user_id=int(payload["owner_user_id"]),
        document_id=str(payload["document_id"]),
        source_version=str(payload["source_version"]),
    )


def handle_embedding_backfill(
    session: Session,
    payload: dict[str, object],
    *,
    provider: PaidEmbeddingProvider | None = None,
) -> dict[str, object]:
    _validate_payload(payload)
    owner = int(payload["owner_user_id"])
    if _cancelled(session, payload):
        return {"status": "cancelled"}
    settings = TriagSettings.from_environ()
    if not settings.persistent_knowledge_enabled:
        return {"status": "disabled"}
    rows = session.exec(
        select(WebKnowledgeChunk).where(
            WebKnowledgeChunk.owner_user_id == owner,
            WebKnowledgeChunk.document_id == str(payload["document_id"]),
            WebKnowledgeChunk.source_version == str(payload["source_version"]),
            WebKnowledgeChunk.status == "ready",
            WebKnowledgeChunk.embedding_status != "ready",
        ).order_by(WebKnowledgeChunk.chunk_index)
        .limit(settings.knowledge_job_batch_size)
    ).all()
    if not rows:
        return {"status": "complete", "embedded": 0}
    if provider is None:
        return {
            "status": "lexical_fallback",
            "reason": "embedding_provider_unavailable",
            "embedded": 0,
        }
    stage, parent = _accounted_stage(
        session,
        payload=payload,
        stage_name="knowledge_embedding",
    )
    if stage is None or parent is None:
        return {
            "status": "lexical_fallback",
            "reason": "embedding_budget_unavailable",
            "embedded": 0,
        }
    stage.status = "running"
    session.add(stage)
    session.flush()
    try:
        result = provider(tuple(row.content_text for row in rows))
    except Exception:
        stage.status = "failed"
        stage.updated_at = utc_now()
        session.add(stage)
        release_usage_reservation(
            session, parent.request_id, reason="knowledge_provider_unavailable"
        )
        return {
            "status": "lexical_fallback",
            "reason": "embedding_provider_unavailable",
            "embedded": 0,
        }
    if _cancelled(session, payload):
        stage.status = "released"
        stage.updated_at = utc_now()
        session.add(stage)
        release_usage_reservation(
            session, parent.request_id, reason="knowledge_job_cancelled"
        )
        return {"status": "cancelled", "embedded": 0}
    if len(result.vectors) != len(rows):
        stage.status = "failed"
        session.add(stage)
        release_usage_reservation(
            session, parent.request_id, reason="malformed_embedding_result"
        )
        return {"status": "lexical_fallback", "reason": "malformed_vector", "embedded": 0}
    expected_dimensions = settings.embedding_dimensions
    for row, vector in zip(rows, result.vectors):
        if (
            len(vector) != expected_dimensions
            or not all(isinstance(value, (float, int)) for value in vector)
        ):
            stage.status = "failed"
            session.add(stage)
            release_usage_reservation(
                session, parent.request_id, reason="malformed_embedding_result"
            )
            return {
                "status": "lexical_fallback",
                "reason": "malformed_vector",
                "embedded": 0,
            }
        row.embedding_json = json.dumps(
            [float(value) for value in vector], separators=(",", ":")
        )
        row.embedding_model = result.model[:128]
        row.embedding_version = KNOWLEDGE_JOB_VERSION
        row.embedding_dimensions = expected_dimensions
        row.embedding_status = "ready"
        row.updated_at = utc_now()
        session.add(row)
    _settle_paid_stage(session, stage=stage, parent=parent, result=result)
    return {"status": "complete", "embedded": len(rows)}


def handle_triplet_extract(
    session: Session, payload: dict[str, object]
) -> dict[str, object]:
    _validate_payload(payload)
    if not TriagSettings.from_environ().rag_triplet_enabled:
        return {"status": "disabled"}
    if _cancelled(session, payload):
        return {"status": "cancelled"}
    # v1 is deterministic and provider-free. A future model extractor must use
    # _accounted_stage before its first call.
    return extract_triplets_for_document(
        session,
        owner_user_id=int(payload["owner_user_id"]),
        document_id=str(payload["document_id"]),
        source_version=str(payload["source_version"]),
        cancellation_signal=_JobCancellation(session, payload),
    )


def handle_hierarchy_build(
    session: Session, payload: dict[str, object]
) -> dict[str, object]:
    _validate_payload(payload)
    if not TriagSettings.from_environ().rag_hierarchy_enabled:
        return {"status": "disabled"}
    if _cancelled(session, payload):
        return {"status": "cancelled"}
    policy = tier_policy_for(payload.get("swico_tier"))
    return build_hierarchy_for_document(
        session,
        owner_user_id=int(payload["owner_user_id"]),
        document_id=str(payload["document_id"]),
        source_version=str(payload["source_version"]),
        token_cap=policy.hierarchy_summary_token_cap,
        cancellation_signal=_JobCancellation(session, payload),
    )


def _accounted_stage(
    session: Session,
    *,
    payload: dict[str, object],
    stage_name: str,
) -> tuple[WebUsageStage | None, UsageCharge | None]:
    request_id = str(payload.get("request_id") or "")
    charge_id = str(payload.get("usage_charge_id") or "")
    if not request_id or not charge_id:
        return None, None
    owner = int(payload["owner_user_id"])
    parent = session.exec(
        select(UsageCharge).where(
            UsageCharge.id == charge_id,
            UsageCharge.request_id == request_id,
            UsageCharge.user_id == owner,
            UsageCharge.status == "reserved",
        )
    ).first()
    if parent is None:
        return None, None
    stage = get_or_create_usage_stage(
        session,
        user_id=owner,
        request_id=request_id,
        usage_charge_id=parent.id,
        stage_name=stage_name,
        stage_order=5,
        status="reserved",
        safe_metadata={
            "stage_key": stage_name,
            "attempt_number": 1,
            "status": "reserved",
        },
    )
    if stage.usage_charge_id not in {None, parent.id}:
        return None, None
    stage.usage_charge_id = parent.id
    stage.status = "reserved" if stage.status == "planned" else stage.status
    session.add(stage)
    return stage, parent


def _settle_paid_stage(
    session: Session,
    *,
    stage: WebUsageStage,
    parent: UsageCharge,
    result: PaidEmbeddingResult,
) -> None:
    if stage.status == "settled":
        return
    stage.status = "settled"
    stage.input_tokens = max(0, int(result.input_tokens))
    stage.output_tokens = 0
    stage.debited_micros = max(0, int(result.micro_inr_cost))
    stage.settled_at = utc_now()
    stage.updated_at = utc_now()
    stage.safe_metadata_json = json.dumps(
        sanitize_metadata({
            "stage_key": stage.stage_name,
            "attempt_number": 1,
            "provider": result.provider[:32],
            "model": result.model[:128],
            "status": "settled",
            "native_cost_amount": float(result.native_cost_amount),
            "native_cost_currency": result.native_cost_currency[:8],
            "micro_inr_cost": max(0, int(result.micro_inr_cost)),
            "input_token_count": max(0, int(result.input_tokens)),
            "output_token_count": 0,
        }),
        sort_keys=True,
        separators=(",", ":"),
    )
    session.add(stage)
    # Each background paid job owns one authoritative reservation. Settlement
    # is idempotent in billing.service and releases the unused reservation.
    settle_usage_reservation(
        session,
        request_id=parent.request_id,
        provider_cost_amount=result.native_cost_amount,
        provider_cost_currency=result.native_cost_currency,
        provider_cost_micros=max(0, int(result.micro_inr_cost)),
        input_tokens=max(0, int(result.input_tokens)),
        cached_input_tokens=0,
        output_tokens=0,
        usage_source="actual",
        pricing_snapshot_json=json.dumps(
            {"stages": [stage.stage_name], "stage_count": 1},
            sort_keys=True,
            separators=(",", ":"),
        ),
        usd_to_inr_rate=result.usd_to_inr_rate,
        provider=result.provider,
        model=result.model,
        usage_kind="chat",
    )


def _validate_payload(payload: dict[str, object]) -> None:
    required = ("owner_user_id", "document_id", "source_version", "job_version")
    if any(not payload.get(key) for key in required):
        raise ValueError("knowledge job payload is incomplete")
    if payload.get("job_version") != KNOWLEDGE_JOB_VERSION:
        raise ValueError("knowledge job version is unsupported")


def _cancelled(session: Session, payload: dict[str, object]) -> bool:
    return knowledge_job_cancelled(
        session,
        job_id=int(payload.get("_job_id") or 0) or None,
        owner_user_id=int(payload["owner_user_id"]),
    )


class _JobCancellation:
    def __init__(self, session: Session, payload: dict[str, object]) -> None:
        self._session = session
        self._payload = payload

    def cancelled(self) -> bool:
        return _cancelled(self._session, self._payload)
