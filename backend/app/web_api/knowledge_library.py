from __future__ import annotations

import json
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlmodel import Session, select

from ..models import (
    Job,
    QACache,
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebKnowledgeNode,
    WebKnowledgeTriplet,
)
from ..time_utils import utc_now
from ..web_ai.knowledge_jobs import (
    KNOWLEDGE_JOB_TYPES,
    cancel_knowledge_job,
    enqueue_knowledge_job,
)


_VISIBLE_DOCUMENT_STATUSES = {
    "pending", "indexing", "ready", "failed", "invalidated"
}
_ACTIVE_JOB_STATUSES = {"queued", "retrying", "running"}


def safe_document_summary(
    session: Session, document: WebKnowledgeDocument
) -> dict[str, Any]:
    chunk_count = len(session.exec(
        select(WebKnowledgeChunk.id).where(
            WebKnowledgeChunk.owner_user_id == document.owner_user_id,
            WebKnowledgeChunk.document_id == document.id,
        )
    ).all())
    return {
        "id": document.id,
        "title": document.title,
        "status": (
            document.status
            if document.status in _VISIBLE_DOCUMENT_STATUSES
            else "failed"
        ),
        "source_kind": document.source_kind,
        "chunk_count": chunk_count,
        "approved_at": document.approved_at,
        "created_at": document.created_at,
        "updated_at": document.updated_at,
    }


def list_owned_knowledge_documents(
    session: Session, *, owner_user_id: int
) -> list[WebKnowledgeDocument]:
    return list(session.exec(
        select(WebKnowledgeDocument).where(
            WebKnowledgeDocument.owner_user_id == int(owner_user_id),
            WebKnowledgeDocument.deleted_at.is_(None),
            WebKnowledgeDocument.status != "deleted",
        ).order_by(WebKnowledgeDocument.updated_at.desc()).limit(100)
    ).all())


def owned_knowledge_document(
    session: Session, *, owner_user_id: int, document_id: str
) -> WebKnowledgeDocument:
    document = session.exec(
        select(WebKnowledgeDocument).where(
            WebKnowledgeDocument.id == str(document_id),
            WebKnowledgeDocument.owner_user_id == int(owner_user_id),
            WebKnowledgeDocument.deleted_at.is_(None),
            WebKnowledgeDocument.status != "deleted",
        )
    ).first()
    if document is None:
        raise PermissionError("knowledge document unavailable")
    return document


def latest_owned_knowledge_job(
    session: Session, *, owner_user_id: int, document_id: str
) -> Job | None:
    jobs = session.exec(
        select(Job).where(
            Job.user_id == int(owner_user_id),
            Job.job_type.in_(KNOWLEDGE_JOB_TYPES),
        ).order_by(Job.created_at.desc()).limit(500)
    ).all()
    for job in jobs:
        try:
            payload = json.loads(job.payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if (
            isinstance(payload, dict)
            and payload.get("document_id") == str(document_id)
            and payload.get("owner_user_id") == int(owner_user_id)
        ):
            return job
    return None


def safe_job_summary(job: Job | None) -> dict[str, Any]:
    if job is None:
        return {"status": "not_scheduled", "updated_at": None}
    status = str(job.status or "")
    if status not in {
        "queued", "retrying", "running", "complete", "completed",
        "failed", "cancelled",
    }:
        status = "failed"
    if status == "completed":
        status = "complete"
    return {"status": status, "updated_at": job.updated_at}


def cancel_active_document_jobs(
    session: Session, *, owner_user_id: int, document_id: str
) -> int:
    cancelled = 0
    jobs = session.exec(
        select(Job).where(
            Job.user_id == int(owner_user_id),
            Job.job_type.in_(KNOWLEDGE_JOB_TYPES),
            Job.status.in_(_ACTIVE_JOB_STATUSES),
        )
    ).all()
    for job in jobs:
        try:
            payload = json.loads(job.payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if (
            isinstance(payload, dict)
            and payload.get("document_id") == str(document_id)
            and payload.get("owner_user_id") == int(owner_user_id)
        ):
            cancel_knowledge_job(
                session,
                owner_user_id=int(owner_user_id),
                job_id=int(job.id or 0),
            )
            cancelled += 1
    return cancelled


def delete_owned_knowledge_document(
    session: Session, *, owner_user_id: int, document_id: str
) -> None:
    document = owned_knowledge_document(
        session, owner_user_id=owner_user_id, document_id=document_id
    )
    cancel_active_document_jobs(
        session, owner_user_id=owner_user_id, document_id=document.id
    )
    session.exec(sa_delete(QACache).where(
        QACache.user_id == int(owner_user_id)
    ))
    session.delete(document)
    session.commit()


def reindex_owned_knowledge_document(
    session: Session,
    *,
    owner_user_id: int,
    document_id: str,
    operation_id: str,
) -> Job:
    document = owned_knowledge_document(
        session, owner_user_id=owner_user_id, document_id=document_id
    )
    if document.status == "invalidated":
        raise ValueError("invalidated knowledge cannot be re-indexed")
    idempotency_key = f"knowledge-reindex:{operation_id}"
    existing_jobs = session.exec(
        select(Job).where(
            Job.user_id == int(owner_user_id),
            Job.job_type == "web_knowledge_ingest",
        ).order_by(Job.created_at.desc()).limit(500)
    ).all()
    for existing in existing_jobs:
        try:
            payload = json.loads(existing.payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if (
            isinstance(payload, dict)
            and payload.get("idempotency_key") == idempotency_key
            and payload.get("document_id") == document.id
        ):
            return existing
    cancel_active_document_jobs(
        session, owner_user_id=owner_user_id, document_id=document.id
    )
    session.exec(sa_delete(WebKnowledgeTriplet).where(
        WebKnowledgeTriplet.owner_user_id == int(owner_user_id),
        WebKnowledgeTriplet.document_id == document.id,
    ))
    session.exec(sa_delete(WebKnowledgeNode).where(
        WebKnowledgeNode.owner_user_id == int(owner_user_id),
        WebKnowledgeNode.document_id == document.id,
    ))
    now = utc_now()
    chunks = session.exec(
        select(WebKnowledgeChunk).where(
            WebKnowledgeChunk.owner_user_id == int(owner_user_id),
            WebKnowledgeChunk.document_id == document.id,
        )
    ).all()
    if not chunks:
        raise ValueError("knowledge document has no source chunks")
    for chunk in chunks:
        chunk.status = "pending"
        chunk.embedding_json = None
        chunk.embedding_model = None
        chunk.embedding_version = None
        chunk.embedding_dimensions = 0
        chunk.embedding_status = "missing"
        chunk.updated_at = now
        session.add(chunk)
    document.status = "indexing"
    document.updated_at = now
    session.add(document)
    session.exec(sa_delete(QACache).where(
        QACache.user_id == int(owner_user_id)
    ))
    session.flush()
    return enqueue_knowledge_job(
        session,
        owner_user_id=int(owner_user_id),
        job_type="web_knowledge_ingest",
        document_id=document.id,
        source_version=document.source_version,
        idempotency_key=idempotency_key,
    )
