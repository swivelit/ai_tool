from __future__ import annotations

from collections import defaultdict
from hashlib import sha256
import re
from typing import Callable

from sqlmodel import Session, select

from ...billing.pricing import estimate_tokens
from ...models import (
    WebKnowledgeChunk,
    WebKnowledgeDocument,
    WebKnowledgeNode,
)
from ...time_utils import utc_now
from ...web_api.upload_store import EphemeralUpload
from .models import RetrievalCandidate


HIERARCHY_VERSION = "hierarchy-v1"
_WORD = re.compile(r"[A-Za-z0-9_]{2,}")


def _terms(value: str) -> set[str]:
    return {match.group(0).lower() for match in _WORD.finditer(value)}


def _summary(text: str, token_cap: int) -> str:
    words = text.split()
    summary = " ".join(words[: max(0, int(token_cap))])
    while summary and estimate_tokens(summary) > max(0, int(token_cap)):
        words = summary.split()
        summary = " ".join(words[:-1])
    return summary


def build_hierarchy_for_document(
    session: Session,
    *,
    owner_user_id: int,
    document_id: str,
    source_version: str,
    token_cap: int,
    cancellation_signal: object | None = None,
) -> dict[str, object]:
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
    for row in session.exec(
        select(WebKnowledgeNode).where(
            WebKnowledgeNode.document_id == document.id,
            WebKnowledgeNode.owner_user_id == int(owner_user_id),
            WebKnowledgeNode.source_version == source_version,
        )
    ).all():
        session.delete(row)
    session.flush()
    if _cancelled(cancellation_signal):
        return {"status": "cancelled", "node_count": 0}
    cap = max(32, min(4096, int(token_cap)))
    now = utc_now()
    document_text = "\n".join(chunk.content_text for chunk in chunks)
    document_summary = _summary(document_text, max(16, cap // 4))
    summary_tokens = estimate_tokens(document_summary)
    root = WebKnowledgeNode(
        document_id=document.id,
        owner_user_id=int(owner_user_id),
        source_version=source_version,
        node_kind="document_summary",
        title=document.title,
        summary_text=document_summary,
        token_count=estimate_tokens(document_summary),
        depth=0,
        ordinal=0,
        content_hash=sha256(
            f"{HIERARCHY_VERSION}\0{document.content_hash}".encode()
        ).hexdigest(),
        source_locator=document.title[:512],
        status="ready",
        created_at=now,
        updated_at=now,
    )
    session.add(root)
    session.flush([root])
    grouped: dict[str, list[WebKnowledgeChunk]] = defaultdict(list)
    for chunk in chunks:
        grouped[chunk.section_path or chunk.source_locator].append(chunk)
    node_count = 1
    for section_ordinal, (section, section_chunks) in enumerate(
        sorted(grouped.items()), start=0
    ):
        if _cancelled(cancellation_signal):
            return {"status": "cancelled", "node_count": node_count}
        section_text = "\n".join(chunk.content_text for chunk in section_chunks)
        remaining_summary_tokens = max(0, cap - summary_tokens)
        section_summary = _summary(
            section_text,
            min(
                remaining_summary_tokens,
                max(8, cap // max(4, len(grouped) + 2)),
            ),
        )
        section_tokens = estimate_tokens(section_summary)
        summary_tokens += section_tokens
        section_node = WebKnowledgeNode(
            document_id=document.id,
            parent_node_id=root.id,
            owner_user_id=int(owner_user_id),
            source_version=source_version,
            node_kind="section_summary",
            title=section[:256],
            summary_text=section_summary,
            token_count=section_tokens,
            depth=1,
            ordinal=section_ordinal,
            content_hash=sha256(
                f"{HIERARCHY_VERSION}\0{section}\0{section_summary}".encode()
            ).hexdigest(),
            source_locator=section[:512],
            status="ready",
            created_at=now,
            updated_at=now,
        )
        session.add(section_node)
        session.flush([section_node])
        node_count += 1
        for chunk in section_chunks:
            session.add(
                WebKnowledgeNode(
                    document_id=document.id,
                    parent_node_id=section_node.id,
                    raw_chunk_id=chunk.id,
                    owner_user_id=int(owner_user_id),
                    source_version=source_version,
                    node_kind="raw_chunk",
                    title="",
                    summary_text="",
                    token_count=chunk.token_count,
                    depth=2,
                    ordinal=chunk.chunk_index,
                    content_hash=chunk.content_hash,
                    source_locator=chunk.source_locator,
                    status="ready",
                    created_at=now,
                    updated_at=now,
                )
            )
            node_count += 1
    return {
        "status": "complete",
        "node_count": node_count,
        "summary_token_count": summary_tokens,
    }


class HierarchicalRetriever:
    source_name = "hierarchy"
    status_code = "hierarchy_raw_anchored"

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
        query_terms = _terms(query)
        if not query_terms or _cancelled(cancellation_signal):
            return ()
        with self._session_factory() as session:
            summaries = session.exec(
                select(WebKnowledgeNode).join(
                    WebKnowledgeDocument,
                    WebKnowledgeDocument.id == WebKnowledgeNode.document_id,
                ).where(
                    WebKnowledgeNode.owner_user_id == int(owner_user_id),
                    WebKnowledgeDocument.owner_user_id == int(owner_user_id),
                    WebKnowledgeNode.status == "ready",
                    WebKnowledgeDocument.status == "ready",
                    WebKnowledgeNode.node_kind.in_(
                        ("document_summary", "section_summary")
                    ),
                ).limit(max(1, min(400, int(limit) * 8)))
            ).all()
            matched = [
                (
                    len(query_terms & _terms(f"{node.title} {node.summary_text}"))
                    / max(1, len(query_terms)),
                    node,
                )
                for node in summaries
            ]
            matched = [item for item in matched if item[0] > 0]
            matched.sort(key=lambda item: (-item[0], item[1].document_id, item[1].id))
            chunk_scores: dict[str, float] = {}
            for score, node in matched:
                if node.node_kind == "section_summary":
                    raw_nodes = session.exec(
                        select(WebKnowledgeNode).where(
                            WebKnowledgeNode.owner_user_id == int(owner_user_id),
                            WebKnowledgeNode.parent_node_id == node.id,
                            WebKnowledgeNode.node_kind == "raw_chunk",
                            WebKnowledgeNode.status == "ready",
                            WebKnowledgeNode.raw_chunk_id.is_not(None),
                        )
                    ).all()
                else:
                    section_ids = session.exec(
                        select(WebKnowledgeNode.id).where(
                            WebKnowledgeNode.owner_user_id == int(owner_user_id),
                            WebKnowledgeNode.parent_node_id == node.id,
                            WebKnowledgeNode.node_kind == "section_summary",
                            WebKnowledgeNode.status == "ready",
                        )
                    ).all()
                    raw_nodes = session.exec(
                        select(WebKnowledgeNode).where(
                            WebKnowledgeNode.owner_user_id == int(owner_user_id),
                            WebKnowledgeNode.parent_node_id.in_(section_ids),
                            WebKnowledgeNode.node_kind == "raw_chunk",
                            WebKnowledgeNode.status == "ready",
                            WebKnowledgeNode.raw_chunk_id.is_not(None),
                        )
                    ).all() if section_ids else []
                for raw in raw_nodes:
                    if raw.raw_chunk_id:
                        chunk_scores[raw.raw_chunk_id] = max(
                            score, chunk_scores.get(raw.raw_chunk_id, 0.0)
                        )
            ids = list(chunk_scores)[: max(0, int(limit))]
            chunks = session.exec(
                select(WebKnowledgeChunk).where(
                    WebKnowledgeChunk.owner_user_id == int(owner_user_id),
                    WebKnowledgeChunk.id.in_(ids),
                    WebKnowledgeChunk.status == "ready",
                )
            ).all() if ids else []
            chunks.sort(key=lambda row: (-chunk_scores[row.id], row.document_id, row.chunk_index))
            # Only raw chunks are returned. Generated summaries route retrieval
            # but can never become the answer's sole evidence.
            return tuple(
                RetrievalCandidate(
                    candidate_id=f"hierarchy:{chunk.id}",
                    owner_user_id=int(owner_user_id),
                    source_kind="persistent_knowledge",
                    source_locator=chunk.source_locator,
                    runtime_text=chunk.content_text,
                    token_count=chunk.token_count,
                    lexical_score=score,
                    metadata_score=0.25,
                    fused_score=score,
                    content_hash=chunk.content_hash,
                    bounded_metadata=(
                        ("document_id", chunk.document_id),
                        ("raw_chunk_id", chunk.id),
                        ("source_label", "Saved knowledge"),
                        ("cache_scope", "private"),
                    ),
                    rank=index,
                    reason_codes=("owner_scoped", "hierarchy_routed", "raw_chunk"),
                )
                for index, (chunk, score) in enumerate(
                    (item, chunk_scores[item.id]) for item in chunks[: int(limit)]
                )
            )


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
