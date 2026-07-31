from __future__ import annotations

from hashlib import sha256
import re
from typing import Callable

from sqlmodel import Session, select

from ...billing.pricing import estimate_tokens
from ...models import (
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebKnowledgeTriplet,
)
from ...time_utils import utc_now
from ...web_api.upload_store import EphemeralUpload
from .models import RetrievalCandidate


EXTRACTION_VERSION = "triplet-v1"
_WORD = re.compile(r"[A-Za-z0-9_]{2,}")


def _terms(value: str) -> set[str]:
    return {match.group(0).lower() for match in _WORD.finditer(value)}


def extract_triplets_for_document(
    session: Session,
    *,
    owner_user_id: int,
    document_id: str,
    source_version: str,
    cancellation_signal: object | None = None,
) -> dict[str, object]:
    """Deterministic extraction; a failed extraction leaves raw chunks intact."""

    document = session.exec(
        select(WebKnowledgeDocument).where(
            WebKnowledgeDocument.id == document_id,
            WebKnowledgeDocument.owner_user_id == int(owner_user_id),
            WebKnowledgeDocument.source_version == source_version,
            WebKnowledgeDocument.status == "ready",
        )
    ).first()
    if document is None:
        raise PermissionError("knowledge document unavailable")
    chunks = session.exec(
        select(WebKnowledgeChunk).where(
            WebKnowledgeChunk.document_id == document.id,
            WebKnowledgeChunk.owner_user_id == int(owner_user_id),
            WebKnowledgeChunk.source_version == source_version,
            WebKnowledgeChunk.status == "ready",
        ).order_by(WebKnowledgeChunk.chunk_index)
    ).all()
    created = 0
    for chunk in chunks:
        if _cancelled(cancellation_signal):
            return {"status": "cancelled", "created": created}
        extracted = _extract(chunk.content_text)
        if extracted is None:
            continue
        condition, proof, conclusion = extracted
        digest = sha256(
            f"{condition}\0{proof}\0{conclusion}\0{chunk.content_hash}".encode()
        ).hexdigest()
        existing = session.exec(
            select(WebKnowledgeTriplet.id).where(
                WebKnowledgeTriplet.chunk_id == chunk.id,
                WebKnowledgeTriplet.extraction_version == EXTRACTION_VERSION,
                WebKnowledgeTriplet.content_hash == digest,
            )
        ).first()
        if existing is not None:
            continue
        session.add(
            WebKnowledgeTriplet(
                document_id=document.id,
                chunk_id=chunk.id,
                owner_user_id=int(owner_user_id),
                source_version=source_version,
                condition_text=condition,
                proof_text=proof,
                conclusion_text=conclusion,
                extraction_version=EXTRACTION_VERSION,
                confidence=0.7,
                content_hash=digest,
                source_locator=chunk.source_locator,
                status="ready",
                created_at=utc_now(),
                updated_at=utc_now(),
            )
        )
        created += 1
    return {"status": "complete", "created": created, "raw_chunk_count": len(chunks)}


def _extract(value: str) -> tuple[str, str, str] | None:
    sentences = [
        part.strip() for part in re.split(r"(?<=[.!?])\s+", value.strip())
        if part.strip()
    ]
    if len(sentences) < 2:
        return None
    condition = next(
        (item for item in sentences if re.search(r"\b(if|when|unless|given)\b", item, re.I)),
        None,
    )
    proof = next(
        (item for item in sentences if re.search(r"\b(because|evidence|shows|proof)\b", item, re.I)),
        None,
    )
    conclusion = next(
        (item for item in sentences if re.search(r"\b(therefore|thus|so|consequently)\b", item, re.I)),
        None,
    )
    if not condition or not conclusion:
        return None
    return condition[:4000], (proof or sentences[0])[:4000], conclusion[:4000]


class TripletRetriever:
    source_name = "triplets"
    status_code = "triplet"

    def __init__(self, session_factory: Callable[[], Session]) -> None:
        self._session_factory = session_factory

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
        terms = _terms(query)
        if not terms or _cancelled(cancellation_signal):
            return ()
        with self._session_factory() as session:
            rows = session.exec(
                select(WebKnowledgeTriplet).join(
                    WebKnowledgeChunk,
                    WebKnowledgeChunk.id == WebKnowledgeTriplet.chunk_id,
                ).join(
                    WebKnowledgeDocument,
                    WebKnowledgeDocument.id == WebKnowledgeTriplet.document_id,
                ).where(
                    WebKnowledgeTriplet.owner_user_id == int(owner_user_id),
                    WebKnowledgeChunk.owner_user_id == int(owner_user_id),
                    WebKnowledgeDocument.owner_user_id == int(owner_user_id),
                    WebKnowledgeTriplet.status == "ready",
                    WebKnowledgeChunk.status == "ready",
                    WebKnowledgeDocument.status == "ready",
                ).limit(max(1, min(400, int(limit) * 8)))
            ).all()
            ranked: list[tuple[float, WebKnowledgeTriplet]] = []
            for row in rows:
                body = f"{row.condition_text} {row.proof_text} {row.conclusion_text}"
                overlap = len(terms & _terms(body)) / max(1, len(terms))
                if overlap:
                    ranked.append((min(1.0, overlap), row))
            ranked.sort(key=lambda item: (-item[0], item[1].chunk_id, item[1].id))
            return tuple(
                RetrievalCandidate(
                    candidate_id=f"triplet:{row.id}",
                    owner_user_id=int(owner_user_id),
                    source_kind="knowledge_triplet",
                    source_locator=row.source_locator,
                    runtime_text=(
                        f"Condition: {row.condition_text}\n"
                        f"Proof: {row.proof_text}\n"
                        f"Conclusion: {row.conclusion_text}"
                    ),
                    token_count=estimate_tokens(
                        f"{row.condition_text} {row.proof_text} {row.conclusion_text}"
                    ),
                    lexical_score=score,
                    metadata_score=0.2,
                    fused_score=score,
                    content_hash=row.content_hash,
                    bounded_metadata=(
                        ("document_id", row.document_id),
                        ("raw_chunk_id", row.chunk_id),
                        ("source_label", "Saved knowledge"),
                        ("extraction_version", row.extraction_version),
                        ("cache_scope", "private"),
                    ),
                    rank=index,
                    reason_codes=("owner_scoped", "raw_chunk_anchored", "supplemental"),
                )
                for index, (score, row) in enumerate(ranked[: max(0, int(limit))])
            )


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)

