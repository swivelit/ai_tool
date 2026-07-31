from __future__ import annotations

from hashlib import sha256
import re
from typing import Callable

from sqlmodel import Session, select

from ...billing.pricing import estimate_tokens
from ...models import WebChatMessage, WebChatThread, WebMemoryFact
from ...web_api.upload_store import EphemeralUpload
from .models import RetrievalCandidate


_WORD = re.compile(r"[A-Za-z0-9_]{2,}")


def _score(query: str, value: str) -> float:
    terms = {item.group(0).lower() for item in _WORD.finditer(query)}
    body = {item.group(0).lower() for item in _WORD.finditer(value)}
    return len(terms & body) / max(1, len(terms))


class OwnerConversationRetriever:
    source_name = "history"
    status_code = "owner_conversation"

    def __init__(self, session_factory: Callable[[], Session]) -> None:
        self._session_factory = session_factory

    def retrieve(self, *, query: str, uploads: list[EphemeralUpload],
                 owner_user_id: int, limit: int,
                 cancellation_signal: object | None = None) -> tuple[RetrievalCandidate, ...]:
        del uploads
        with self._session_factory() as session:
            rows = session.exec(
                select(WebChatMessage).join(
                    WebChatThread, WebChatThread.id == WebChatMessage.thread_id
                ).where(
                    WebChatMessage.user_id == int(owner_user_id),
                    WebChatThread.user_id == int(owner_user_id),
                    WebChatMessage.superseded_at.is_(None),
                    WebChatMessage.status == "complete",
                ).order_by(WebChatMessage.created_at.desc()).limit(max(1, int(limit) * 8))
            ).all()
            ranked = sorted(
                ((_score(query, row.content), row) for row in rows),
                key=lambda item: (-item[0], item[1].created_at, item[1].id),
            )
            return tuple(
                _candidate("conversation", owner_user_id, row.id, row.content, score, index)
                for index, (score, row) in enumerate(ranked[: max(0, int(limit))])
                if score > 0 and not _cancelled(cancellation_signal)
            )


class OwnerMemoryRetriever:
    source_name = "memory"
    status_code = "owner_memory"

    def __init__(self, session_factory: Callable[[], Session]) -> None:
        self._session_factory = session_factory

    def retrieve(self, *, query: str, uploads: list[EphemeralUpload],
                 owner_user_id: int, limit: int,
                 cancellation_signal: object | None = None) -> tuple[RetrievalCandidate, ...]:
        del uploads
        with self._session_factory() as session:
            rows = session.exec(
                select(WebMemoryFact).where(
                    WebMemoryFact.user_id == int(owner_user_id),
                    WebMemoryFact.deleted_at.is_(None),
                ).order_by(WebMemoryFact.salience.desc(), WebMemoryFact.updated_at.desc())
                .limit(max(1, int(limit) * 8))
            ).all()
            ranked = sorted(
                ((_score(query, row.value_text), row) for row in rows),
                key=lambda item: (-item[0], -item[1].salience, item[1].id),
            )
            return tuple(
                _candidate("memory", owner_user_id, row.id, row.value_text, score, index)
                for index, (score, row) in enumerate(ranked[: max(0, int(limit))])
                if score > 0 and not _cancelled(cancellation_signal)
            )


def _candidate(kind: str, owner: int, row_id: str, value: str,
               score: float, rank: int) -> RetrievalCandidate:
    return RetrievalCandidate(
        candidate_id=f"{kind}:{row_id}",
        owner_user_id=int(owner),
        source_kind=kind,
        source_locator=f"{kind}:{row_id}",
        runtime_text=value,
        token_count=estimate_tokens(value),
        lexical_score=max(0.0, min(1.0, score)),
        fused_score=max(0.0, min(1.0, score)),
        content_hash=sha256(value.encode()).hexdigest(),
        bounded_metadata=(("cache_scope", "private"),),
        rank=rank,
        reason_codes=("owner_scoped",),
    )


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
