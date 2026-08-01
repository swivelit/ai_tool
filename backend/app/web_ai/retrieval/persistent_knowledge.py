from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
import re
from typing import Callable, Iterable

from sqlalchemy import text
from sqlmodel import Session, select

from ...billing.pricing import estimate_tokens
from ...models import (
    QACache,
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebKnowledgeNode,
    WebKnowledgeTriplet,
)
from ...time_utils import utc_now
from ...web_api.attachment_context import calibrated_query_coverage
from ...web_api.upload_store import EphemeralUpload
from ..telemetry.metadata import sanitize_metadata
from .models import RetrievalCandidate


_WORD = re.compile(r"[A-Za-z0-9_]{2,}")
_SAFE_LOCATOR = re.compile(r"^[^\x00-\x1f\x7f]{1,512}$")
_SAFE_LABEL = re.compile(r"^[^\x00-\x1f\x7f]{1,256}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]+$")
_ACTIVE_DOCUMENT_STATUSES = ("indexing", "ready")


@dataclass(frozen=True)
class ApprovedKnowledgeChunk:
    text: str
    locator: str
    section_path: str = ""


def _hash(value: str) -> str:
    return sha256(value.encode("utf-8", errors="ignore")).hexdigest()


def _clean_locator(value: object) -> str:
    locator = str(value or "").strip()
    if not _SAFE_LOCATOR.fullmatch(locator):
        raise ValueError("knowledge source locator is unsafe or oversized")
    return locator


def owner_has_active_knowledge(session: Session, owner_user_id: int) -> bool:
    return session.exec(
        select(WebKnowledgeDocument.id).where(
            WebKnowledgeDocument.owner_user_id == int(owner_user_id),
            WebKnowledgeDocument.status.in_(_ACTIVE_DOCUMENT_STATUSES),
            WebKnowledgeDocument.deleted_at.is_(None),
        ).limit(1)
    ).first() is not None


def owner_active_knowledge_tokens(
    session: Session, owner_user_id: int, *, ceiling: int = 12_000
) -> int:
    rows = session.exec(
        select(WebKnowledgeChunk.token_count).join(
            WebKnowledgeDocument,
            WebKnowledgeDocument.id == WebKnowledgeChunk.document_id,
        ).where(
            WebKnowledgeChunk.owner_user_id == int(owner_user_id),
            WebKnowledgeDocument.owner_user_id == int(owner_user_id),
            WebKnowledgeChunk.status == "ready",
            WebKnowledgeDocument.status.in_(_ACTIVE_DOCUMENT_STATUSES),
            WebKnowledgeDocument.deleted_at.is_(None),
        ).limit(1_000)
    ).all()
    return min(max(0, int(ceiling)), sum(max(0, int(value or 0)) for value in rows))


def owner_knowledge_lexical_relevance(
    session: Session,
    owner_user_id: int,
    query: str,
    *,
    chunk_limit: int = 64,
) -> float:
    """Return a bounded owner-scoped lexical preflight without provider work."""

    bounded_limit = min(128, max(1, int(chunk_limit)))
    rows = session.exec(
        select(WebKnowledgeChunk.content_text).join(
            WebKnowledgeDocument,
            WebKnowledgeDocument.id == WebKnowledgeChunk.document_id,
        ).where(
            WebKnowledgeChunk.owner_user_id == int(owner_user_id),
            WebKnowledgeDocument.owner_user_id == int(owner_user_id),
            WebKnowledgeChunk.status == "ready",
            WebKnowledgeDocument.status == "ready",
            WebKnowledgeDocument.deleted_at.is_(None),
        ).order_by(
            WebKnowledgeDocument.id,
            WebKnowledgeChunk.chunk_index,
        ).limit(bounded_limit)
    ).all()
    return max(
        (_lexical_score(str(query or "")[:4096], str(body or "")) for body in rows),
        default=0.0,
    )


def approve_persistent_knowledge(
    session: Session,
    *,
    owner_user_id: int,
    source_id: str,
    source_version: str,
    title: str,
    chunks: Iterable[ApprovedKnowledgeChunk],
    user_approved: bool,
    idempotency_key: str,
    approval_version: str = "v1",
    source_kind: str = "approved_document",
    safe_metadata: dict[str, object] | None = None,
) -> WebKnowledgeDocument:
    """Persist content only after an explicit, auditable owner approval.

    This intentionally accepts no ``EphemeralUpload`` object and is never
    called by the temporary-upload path.
    """

    if not user_approved:
        raise PermissionError("persistent knowledge requires explicit approval")
    owner = int(owner_user_id)
    if owner <= 0:
        raise ValueError("owner_user_id must be positive")
    source = str(source_id or "").strip()
    version = str(source_version or "").strip()
    key = str(idempotency_key or "").strip()
    bounded_title = str(title or "").strip()
    if (
        not source
        or len(source) > 160
        or not _SAFE_ID.fullmatch(source)
        or not version
        or len(version) > 64
        or not _SAFE_ID.fullmatch(version)
    ):
        raise ValueError("knowledge source identifiers are invalid")
    if (
        not key
        or len(key) > 160
        or not _SAFE_LABEL.fullmatch(bounded_title)
    ):
        raise ValueError("knowledge approval metadata is invalid")
    normalized = tuple(
        ApprovedKnowledgeChunk(
            text=str(item.text or "").strip(),
            locator=_clean_locator(item.locator),
            section_path=str(item.section_path or "").strip()[:512],
        )
        for item in chunks
        if str(item.text or "").strip()
    )
    if (
        not normalized
        or len(normalized) > 10_000
        or any(len(item.text) > 200_000 for item in normalized)
        or sum(len(item.text) for item in normalized) > 20_000_000
    ):
        raise ValueError("approved knowledge must contain bounded non-empty chunks")
    existing = session.exec(
        select(WebKnowledgeDocument).where(
            WebKnowledgeDocument.owner_user_id == owner,
            WebKnowledgeDocument.idempotency_key == key,
        )
    ).first()
    if existing is not None:
        return existing

    combined_hash = _hash(
        "\n".join(
            f"{item.locator}\0{_hash(item.text)}" for item in normalized
        )
    )
    invalidate_knowledge_source(
        session,
        owner_user_id=owner,
        source_id=source,
        keep_source_version=version,
    )
    now = utc_now()
    document = WebKnowledgeDocument(
        owner_user_id=owner,
        source_id=source,
        source_version=version,
        idempotency_key=key,
        title=bounded_title,
        source_kind=str(source_kind or "approved_document")[:32],
        content_hash=combined_hash,
        approval_version=str(approval_version or "v1")[:24],
        status="indexing",
        safe_metadata_json=json.dumps(
            sanitize_metadata(safe_metadata or {}),
            sort_keys=True,
            separators=(",", ":"),
        ),
        approved_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(document)
    session.flush([document])
    for index, item in enumerate(normalized):
        session.add(
            WebKnowledgeChunk(
                document_id=document.id,
                owner_user_id=owner,
                source_version=version,
                chunk_index=index,
                content_text=item.text,
                content_hash=_hash(item.text),
                token_count=estimate_tokens(item.text),
                source_locator=item.locator,
                section_path=item.section_path,
                embedding_status="missing",
                status="pending",
                created_at=now,
                updated_at=now,
            )
        )
    session.flush()
    return document


def invalidate_knowledge_source(
    session: Session,
    *,
    owner_user_id: int,
    source_id: str,
    keep_source_version: str | None = None,
) -> int:
    """Invalidate stale derived data and owner cache rows on source changes."""

    owner = int(owner_user_id)
    documents = session.exec(
        select(WebKnowledgeDocument).where(
            WebKnowledgeDocument.owner_user_id == owner,
            WebKnowledgeDocument.source_id == str(source_id),
            WebKnowledgeDocument.deleted_at.is_(None),
        )
    ).all()
    stale = [
        row for row in documents
        if keep_source_version is None
        or row.source_version != str(keep_source_version)
    ]
    now = utc_now()
    for document in stale:
        document.status = "invalidated"
        document.updated_at = now
        session.add(document)
        chunks = session.exec(
            select(WebKnowledgeChunk).where(
                WebKnowledgeChunk.owner_user_id == owner,
                WebKnowledgeChunk.document_id == document.id,
            )
        ).all()
        for chunk in chunks:
            chunk.status = "invalidated"
            chunk.embedding_json = None
            chunk.embedding_model = None
            chunk.embedding_version = None
            chunk.embedding_dimensions = 0
            chunk.embedding_status = "missing"
            chunk.updated_at = now
            session.add(chunk)
        for model in (WebKnowledgeTriplet, WebKnowledgeNode):
            rows = session.exec(
                select(model).where(  # type: ignore[arg-type]
                    model.owner_user_id == owner,
                    model.document_id == document.id,
                )
            ).all()
            for row in rows:
                row.status = "invalidated"
                row.updated_at = now
                session.add(row)
    # The legacy owner cache is private but may contain answers based on a
    # previous source version. Global cache rows are deliberately untouched:
    # private knowledge is never eligible to create them.
    for row in session.exec(select(QACache).where(QACache.user_id == owner)).all():
        session.delete(row)
    return len(stale)


def finalize_knowledge_ingest(
    session: Session, *, owner_user_id: int, document_id: str, source_version: str
) -> dict[str, object]:
    document = _owned_document(
        session, owner_user_id, document_id, source_version=source_version
    )
    chunks = session.exec(
        select(WebKnowledgeChunk).where(
            WebKnowledgeChunk.owner_user_id == int(owner_user_id),
            WebKnowledgeChunk.document_id == document.id,
            WebKnowledgeChunk.source_version == source_version,
        ).order_by(WebKnowledgeChunk.chunk_index)
    ).all()
    if not chunks:
        document.status = "failed"
        session.add(document)
        return {"status": "failed", "reason": "no_chunks"}
    now = utc_now()
    for chunk in chunks:
        chunk.status = "ready"
        chunk.updated_at = now
        session.add(chunk)
    document.status = "ready"
    document.updated_at = now
    session.add(document)
    return {"status": "ready", "chunk_count": len(chunks)}


def _owned_document(
    session: Session,
    owner_user_id: int,
    document_id: str,
    *,
    source_version: str | None = None,
) -> WebKnowledgeDocument:
    statement = select(WebKnowledgeDocument).where(
        WebKnowledgeDocument.id == str(document_id),
        WebKnowledgeDocument.owner_user_id == int(owner_user_id),
        WebKnowledgeDocument.deleted_at.is_(None),
    )
    if source_version is not None:
        statement = statement.where(
            WebKnowledgeDocument.source_version == str(source_version)
        )
    row = session.exec(statement).first()
    if row is None:
        raise PermissionError("knowledge document unavailable")
    return row


def _tokens(value: str) -> list[str]:
    return [match.group(0).lower() for match in _WORD.finditer(value)]


def _lexical_score(query: str, body: str) -> float:
    return calibrated_query_coverage(query, body)


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    ln = math.sqrt(sum(value * value for value in left))
    rn = math.sqrt(sum(value * value for value in right))
    if ln <= 0 or rn <= 0:
        return 0.0
    return max(0.0, min(1.0, dot / (ln * rn)))


class PersistentKnowledgeRetriever:
    source_name = "knowledge"
    status_code = "knowledge_lexical"

    def __init__(
        self,
        session_factory: Callable[[], Session],
        *,
        query_embedding: Callable[[str], list[float]] | None = None,
        dense_accounted: bool = False,
    ) -> None:
        self._session_factory = session_factory
        self._query_embedding = query_embedding if dense_accounted else None
        self.status_code = (
            "knowledge_hybrid" if self._query_embedding is not None
            else "knowledge_lexical"
        )

    def retrieve(
        self,
        *,
        query: str,
        uploads: list[EphemeralUpload],
        owner_user_id: int,
        limit: int,
        cancellation_signal: object | None = None,
    ) -> tuple[RetrievalCandidate, ...]:
        del uploads
        if _cancelled(cancellation_signal):
            return ()
        with self._session_factory() as session:
            rows, fts_scores = _lexical_rows(
                session, owner_user_id=int(owner_user_id), query=query, limit=limit
            )
            semantic: dict[str, float] = {}
            vector_available = _pgvector_available(session)
            if (
                self._query_embedding is not None
                and vector_available
                and not _cancelled(cancellation_signal)
            ):
                try:
                    vector = [float(value) for value in self._query_embedding(query)]
                    semantic = _vector_scores(
                        session,
                        owner_user_id=int(owner_user_id),
                        query_vector=vector,
                        limit=limit,
                    )
                except Exception:
                    # Dense retrieval is optional. The read-only lexical result
                    # remains valid even when pgvector/provider/accounting fails.
                    semantic = {}
                    self.status_code = "knowledge_lexical"
            elif self._query_embedding is not None:
                self.status_code = "knowledge_lexical"
            ranked = sorted(
                rows,
                key=lambda row: (
                    -max(fts_scores.get(row.id, 0.0), semantic.get(row.id, 0.0)),
                    row.document_id,
                    row.chunk_index,
                ),
            )[: max(0, int(limit))]
            document_ids = {row.document_id for row in ranked}
            titles = {
                row.id: row.title
                for row in session.exec(
                    select(WebKnowledgeDocument).where(
                        WebKnowledgeDocument.owner_user_id == int(owner_user_id),
                        WebKnowledgeDocument.id.in_(document_ids),
                        WebKnowledgeDocument.status == "ready",
                    )
                ).all()
            } if document_ids else {}
            return tuple(
                RetrievalCandidate(
                    candidate_id=f"knowledge:{row.id}",
                    owner_user_id=int(owner_user_id),
                    source_kind="persistent_knowledge",
                    source_locator=row.source_locator,
                    runtime_text=row.content_text,
                    token_count=row.token_count,
                    lexical_score=fts_scores.get(row.id, 0.0),
                    query_coverage=_lexical_score(query, row.content_text),
                    semantic_score=semantic.get(row.id, 0.0),
                    metadata_score=0.1,
                    fused_score=max(
                        fts_scores.get(row.id, 0.0),
                        semantic.get(row.id, 0.0),
                    ),
                    content_hash=row.content_hash,
                    bounded_metadata=(
                        ("document_id", row.document_id),
                        ("source_label", titles.get(row.document_id, "Saved knowledge")[:256]),
                        ("chunk_id", row.id),
                        ("source_version", row.source_version),
                        ("cache_scope", "private"),
                    ),
                    rank=index,
                    reason_codes=(
                        "owner_scoped",
                        "raw_chunk",
                        "pgvector" if row.id in semantic else "lexical",
                    ),
                )
                for index, row in enumerate(ranked)
                if not _cancelled(cancellation_signal)
            )


def _lexical_rows(
    session: Session, *, owner_user_id: int, query: str, limit: int
) -> tuple[list[WebKnowledgeChunk], dict[str, float]]:
    bounded_limit = max(1, min(200, int(limit)))
    if session.bind is not None and session.bind.dialect.name == "postgresql":
        try:
            statement = text(
                "SELECT c.id, ts_rank_cd("
                "to_tsvector('simple', c.content_text), "
                "plainto_tsquery('simple', :query)) AS score "
                "FROM web_knowledge_chunk c "
                "JOIN web_knowledge_document d ON d.id = c.document_id "
                "WHERE c.owner_user_id = :owner AND d.owner_user_id = :owner "
                "AND c.status = 'ready' AND d.status = 'ready' "
                "AND to_tsvector('simple', c.content_text) "
                "@@ plainto_tsquery('simple', :query) "
                "ORDER BY score DESC, c.document_id, c.chunk_index LIMIT :limit"
            )
            mapped = session.connection().execute(
                statement,
                {"query": query[:4096], "owner": owner_user_id, "limit": bounded_limit},
            ).mappings().all()
            ids = [str(item["id"]) for item in mapped]
            scores = {
                str(item["id"]): max(0.0, min(1.0, float(item["score"] or 0.0)))
                for item in mapped
            }
            if ids:
                rows = session.exec(
                    select(WebKnowledgeChunk).where(
                        WebKnowledgeChunk.owner_user_id == owner_user_id,
                        WebKnowledgeChunk.id.in_(ids),
                        WebKnowledgeChunk.status == "ready",
                    )
                ).all()
                order = {item_id: index for index, item_id in enumerate(ids)}
                return sorted(rows, key=lambda row: order[row.id]), scores
        except Exception:
            # An unavailable FTS capability must not fail the request.
            pass
    rows = session.exec(
        select(WebKnowledgeChunk).join(
            WebKnowledgeDocument,
            WebKnowledgeDocument.id == WebKnowledgeChunk.document_id,
        ).where(
            WebKnowledgeChunk.owner_user_id == owner_user_id,
            WebKnowledgeDocument.owner_user_id == owner_user_id,
            WebKnowledgeChunk.status == "ready",
            WebKnowledgeDocument.status == "ready",
        ).order_by(
            WebKnowledgeChunk.document_id,
            WebKnowledgeChunk.chunk_index,
        ).limit(max(bounded_limit * 8, bounded_limit))
    ).all()
    scores = {row.id: _lexical_score(query, row.content_text) for row in rows}
    selected = sorted(
        rows, key=lambda row: (-scores[row.id], row.document_id, row.chunk_index)
    )[:bounded_limit]
    return selected, scores


def _vector_scores(
    session: Session,
    *,
    owner_user_id: int,
    query_vector: list[float],
    limit: int,
) -> dict[str, float]:
    if (
        not query_vector
        or session.bind is None
        or session.bind.dialect.name != "postgresql"
    ):
        return {}
    vector_json = json.dumps(query_vector, separators=(",", ":"))
    try:
        with session.begin_nested():
            rows = session.connection().execute(
                text(
                    "SELECT c.id, 1 - (CAST(c.embedding_json AS vector) "
                    "<=> CAST(:query_vector AS vector)) AS score "
                    "FROM web_knowledge_chunk c "
                    "JOIN web_knowledge_document d ON d.id = c.document_id "
                    "WHERE c.owner_user_id = :owner AND d.owner_user_id = :owner "
                    "AND c.status = 'ready' AND d.status = 'ready' "
                    "AND c.embedding_status = 'ready' AND c.embedding_json IS NOT NULL "
                    "ORDER BY CAST(c.embedding_json AS vector) "
                    "<=> CAST(:query_vector AS vector) LIMIT :limit"
                ),
                {
                    "query_vector": vector_json,
                    "owner": owner_user_id,
                    "limit": max(1, min(200, int(limit))),
                },
            ).mappings().all()
        return {
            str(row["id"]): max(0.0, min(1.0, float(row["score"] or 0.0)))
            for row in rows
        }
    except Exception:
        return {}


def _pgvector_available(session: Session) -> bool:
    if (
        session.bind is None
        or session.bind.dialect.name != "postgresql"
    ):
        return False
    try:
        return bool(
            session.connection().execute(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_extension "
                    "WHERE extname = 'vector')"
                )
            ).scalar()
        )
    except Exception:
        return False


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
