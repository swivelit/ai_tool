from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
from typing import Iterable

from sqlalchemy import or_
from sqlmodel import Session, select

from ..models import (
    WebChatMessage, WebChatThread, WebConversationSummary, WebMemoryFact,
    WebUsagePreferences,
)
from ..time_utils import utc_now
from ..billing.pricing import estimate_tokens
from ..openai_tracked import cached_text_embedding


_MEMORY_REQUESTS = re.compile(
    r"\b(continue (?:the )?.*(?:we discussed|from (?:the )?other chat)|"
    r"what did i (?:decide|say|plan|tell you(?: about my project)?)|"
    r"what (?:reply style do i prefer|are my saved preferences)|"
    r"how do i prefer you to answer|do you remember my preferred reply style|"
    r"what do you remember about me|use my previous|"
    r"remember my (?:preferred|preference|project)|"
    r"what was the .* from (?:the )?(?:other|previous) chat|previous (?:chat|thread|conversation)|"
    r"we discussed (?:yesterday|before|earlier)|my (?:current )?project)\b",
    re.IGNORECASE,
)
_EXPLICIT_MEMORY_WRITE = re.compile(
    r"^\s*(?:remember(?:\s+that)?\s+|save\s+this\s+preference\s*:|"
    r"my\s+preferred\s+reply\s+style\s+is\s+|i\s+prefer\s+|"
    r"my\s+current\s+project\s+is\s+|i\s+am\s+working\s+on\s+)",
    re.IGNORECASE,
)
_TOKENS = re.compile(r"[\w\u0B80-\u0BFF]+", re.UNICODE)
_STOP = {
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "from",
    "my", "i", "we", "did", "was", "what", "use", "previous", "other", "chat",
    "thread", "conversation", "yesterday", "earlier", "before", "remember",
}
_SENSITIVE = re.compile(
    r"\b(password|passcode|otp|one[- ]time password|credit card|debit card|cvv|"
    r"bank account|account number|ifsc|upi|aadhaar|pan number|social security|"
    r"private key|api key|access token|refresh token|secret)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class MemoryRecord:
    kind: str
    record_id: str
    source_thread_id: str | None
    source_message_id: str | None
    text: str
    score: float


@dataclass(frozen=True)
class MemorySelection:
    prompt_context: str
    records: tuple[MemoryRecord, ...]
    estimated_tokens: int = 0


@dataclass(frozen=True)
class DurableMemoryFact:
    category: str
    value: str
    normalized_key: str


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def needs_cross_thread_memory(message: str) -> bool:
    return bool(_MEMORY_REQUESTS.search(str(message or "")))


def memory_enabled(session: Session, user_id: int) -> bool:
    if not _env_bool("WEB_CROSS_THREAD_MEMORY_ENABLED", False):
        return False
    row = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == user_id
    )).first()
    return bool(row and row.memory_enabled)


def memory_deployment_available() -> bool:
    return _env_bool("WEB_CROSS_THREAD_MEMORY_ENABLED", False)


def _terms(value: str) -> set[str]:
    return {
        token for token in _TOKENS.findall(str(value or "").lower())
        if len(token) > 1 and token not in _STOP
    }


def _score(query: set[str], value: str, recency_rank: int) -> float:
    terms = _terms(value)
    overlap = len(query & terms)
    coverage = overlap / max(1, len(query))
    return overlap * 4.0 + coverage * 3.0 + max(0.0, 1.0 - recency_rank * 0.01)


def _embedding(raw: str | None) -> list[float]:
    try:
        parsed = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    try:
        return [float(value) for value in parsed]
    except (TypeError, ValueError):
        return []


def _cosine(left: list[float], right: list[float], right_norm: float = 0.0) -> float:
    if not left or not right:
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = right_norm or math.sqrt(sum(value * value for value in right))
    if left_norm <= 0.0 or right_norm <= 0.0:
        return 0.0
    dot = sum(left[index] * right[index] for index in range(min(len(left), len(right))))
    return max(0.0, min(1.0, dot / (left_norm * right_norm)))


def retrieve_memory(
    session: Session, *, user_id: int, message: str, current_thread_id: str | None,
    allow_natural_followup: bool = False,
) -> MemorySelection:
    ranking_enabled = _env_bool("WEB_MEMORY_FACT_RANKING_ENABLED", False)
    if not memory_enabled(session, user_id):
        return MemorySelection("", ())
    if not ranking_enabled and not (
        needs_cross_thread_memory(message) or allow_natural_followup
    ):
        return MemorySelection("", ())
    # Ranked website memory is intentionally limited to one or two facts for
    # this rollout.  Larger legacy values are clamped instead of expanding the
    # provider prompt.
    limit = _env_int("WEB_MEMORY_MAX_ITEMS", 2, 1, 2)
    char_limit = _env_int("WEB_MEMORY_MAX_CHARS", 1200, 100, 1200)
    query = _terms(message)
    candidates: list[MemoryRecord] = []
    facts = session.exec(select(WebMemoryFact).where(
        WebMemoryFact.user_id == user_id,
        WebMemoryFact.deleted_at.is_(None),
        *([or_(
            WebMemoryFact.source_thread_id.is_(None),
            WebMemoryFact.source_thread_id != current_thread_id,
        )] if current_thread_id else []),
    ).order_by(WebMemoryFact.updated_at.desc()).limit(100)).all()
    if ranking_enabled:
        query_embedding = cached_text_embedding(
            message,
            session=session,
            user_id=user_id,
            route="web_memory_query",
        )
        threshold = max(0.0, min(1.0, _env_float("WEB_MEMORY_FACT_MIN_SIMILARITY", 0.35)))
        ranked: list[MemoryRecord] = []
        fact_by_id: dict[str, WebMemoryFact] = {}
        for fact in facts:
            if fact.source_message_id:
                source = session.exec(select(WebChatMessage).where(
                    WebChatMessage.id == fact.source_message_id,
                    WebChatMessage.user_id == user_id,
                    WebChatMessage.status == "complete",
                    WebChatMessage.superseded_at.is_(None),
                )).first()
                if source is None:
                    continue
            score = _cosine(
                query_embedding,
                _embedding(fact.embedding_json),
                float(fact.embedding_norm or 0.0),
            )
            if score < threshold:
                continue
            text = f"{fact.category}: {fact.value_text}"
            ranked.append(
                MemoryRecord(
                    "fact", fact.id, fact.source_thread_id, fact.source_message_id,
                    text, score,
                )
            )
            fact_by_id[fact.id] = fact
        selected = sorted(
            ranked, key=lambda item: (-item.score, item.record_id)
        )[:limit]
        blocks: list[str] = []
        accepted: list[MemoryRecord] = []
        used = 0
        for item in selected:
            block = item.text.strip()
            remaining = char_limit - used - (2 if blocks else 0)
            if remaining <= 20:
                break
            block = block[:remaining].rstrip()
            blocks.append(block)
            accepted.append(item)
            used += len(block) + (2 if len(blocks) > 1 else 0)
            fact = fact_by_id.get(item.record_id)
            if fact is not None:
                fact.accessed_at = utc_now()
                session.add(fact)
        context = "\n\n".join(blocks)
        return MemorySelection(
            context, tuple(accepted), estimate_tokens(context) if context else 0
        )
    for rank, fact in enumerate(facts):
        if fact.source_message_id:
            source = session.exec(select(WebChatMessage).where(
                WebChatMessage.id == fact.source_message_id,
                WebChatMessage.user_id == user_id,
                WebChatMessage.status == "complete",
                WebChatMessage.superseded_at.is_(None),
            )).first()
            if source is None:
                continue
        text = f"{fact.category}: {fact.value_text}"
        candidates.append(MemoryRecord(
            "fact", fact.id, fact.source_thread_id, fact.source_message_id,
            text, _score(query, text, rank) + float(fact.salience),
        ))
    summaries = session.exec(select(WebConversationSummary).where(
        WebConversationSummary.user_id == user_id,
        *([WebConversationSummary.thread_id != current_thread_id] if current_thread_id else []),
    ).order_by(WebConversationSummary.updated_at.desc()).limit(100)).all()
    for rank, summary in enumerate(summaries):
        thread = session.get(WebChatThread, summary.thread_id)
        if thread is None or thread.user_id != user_id or thread.archived_at is not None:
            continue
        text = f"Previous chat — {thread.title}: {summary.summary_text}"
        candidates.append(MemoryRecord(
            "summary", summary.id, summary.thread_id, None, text,
            _score(query, f"{text} {summary.keywords_text}", rank),
        ))
    ordered = sorted(candidates, key=lambda item: (-item.score, item.kind, item.record_id))
    # For a memory-specific query with no lexical topic (for example "what did
    # I decide yesterday?"), recency is the deterministic relevance signal.
    selected = [item for item in ordered if item.score > 1.05][:limit]
    if not selected:
        selected = ordered[:limit]
    blocks: list[str] = []
    accepted: list[MemoryRecord] = []
    used = 0
    for item in selected:
        block = item.text.strip()
        separator = 2 if blocks else 0
        remaining = char_limit - used - separator
        if remaining <= 20:
            break
        if len(block) > remaining:
            block = block[:remaining].rstrip()
        blocks.append(block)
        accepted.append(item)
        used += len(block) + separator
    context = "\n\n".join(blocks)
    return MemorySelection(
        context, tuple(accepted), estimate_tokens(context) if context else 0
    )


def backfill_memory_fact_embeddings(
    session: Session, *, user_id: int, batch_size: int = 20
) -> dict[str, int]:
    """Populate a bounded batch of legacy fact vectors outside the request path."""
    if not _env_bool("WEB_MEMORY_FACT_RANKING_ENABLED", False):
        return {"scanned": 0, "embedded": 0}
    facts = session.exec(
        select(WebMemoryFact).where(
            WebMemoryFact.user_id == user_id,
            WebMemoryFact.deleted_at.is_(None),
            or_(
                WebMemoryFact.embedding_json.is_(None),
                WebMemoryFact.embedding_json == "",
            ),
        ).order_by(WebMemoryFact.updated_at.desc()).limit(
            max(1, min(100, int(batch_size)))
        )
    ).all()
    embedded = 0
    for fact in facts:
        vector = cached_text_embedding(
            fact.value_text,
            session=session,
            user_id=user_id,
            route="web_memory_fact_backfill",
        )
        if not vector:
            continue
        fact.embedding_json = json.dumps(vector, separators=(",", ":"))
        fact.embedding_norm = math.sqrt(sum(item * item for item in vector))
        session.add(fact)
        embedded += 1
    session.commit()
    return {"scanned": len(facts), "embedded": embedded}


def explicit_memory_write_requested(message: str) -> bool:
    return bool(_EXPLICIT_MEMORY_WRITE.search(str(message or "")))


def normalized_memory_key(category: str, value: str) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "")).strip().casefold()
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]
    return f"{str(category or 'preference').strip().casefold()}:{digest}"[:160]


def parse_durable_memory_fact(message: str) -> DurableMemoryFact | None:
    text = " ".join(str(message or "").split()).strip()
    if not text or _SENSITIVE.search(text):
        return None
    if re.search(
        r"\b(?:for (?:this|the current) (?:message|turn|reply)|right now|"
        r"today only|temporarily|do not remember|don'?t save)\b",
        text,
        re.IGNORECASE,
    ):
        return None
    remember = re.match(r"^remember(?:\s+that)?\s+(.+)$", text, re.IGNORECASE)
    if remember:
        nested = parse_durable_memory_fact(remember.group(1))
        if nested is not None:
            return nested
        value = remember.group(1).strip(" ,;:-")[:600]
        return (
            DurableMemoryFact(
                "explicit", value, normalized_memory_key("explicit", value)
            )
            if value else None
        )
    patterns: Iterable[tuple[str, str]] = (
        (r"^save this preference\s*:\s*(.+)$", "preference"),
        (r"^my preferred reply style is\s+(.+)$", "reply_style"),
        (r"^i prefer\s+(.+)$", "preference"),
        (r"^i(?:'m| am) (?:working|building) on\s+(.+)$", "ongoing_project"),
        (r"^my (?:current )?project (?:is|uses)\s+(.+)$", "ongoing_project"),
    )
    for pattern, category in patterns:
        match = re.match(pattern, text, re.IGNORECASE)
        if match:
            value = match.group(1).strip(" ,;:-")[:600]
            if value:
                return DurableMemoryFact(
                    category, value, normalized_memory_key(category, value)
                )
    return None


def store_explicit_memory_fact(
    session: Session,
    *,
    user_id: int,
    thread_id: str,
    source_message_id: str,
    fact: DurableMemoryFact,
) -> WebMemoryFact:
    """Upsert one owner-scoped fact without performing embedding work."""
    row = session.exec(
        select(WebMemoryFact).where(
            WebMemoryFact.user_id == user_id,
            WebMemoryFact.normalized_key == fact.normalized_key,
        )
    ).first()
    now = utc_now()
    if row is None:
        row = WebMemoryFact(
            user_id=user_id,
            normalized_key=fact.normalized_key,
            value_text=fact.value,
            category=fact.category,
            salience=0.8,
            confidence=1.0,
            source_thread_id=thread_id,
            source_message_id=source_message_id,
            accessed_at=now,
        )
    else:
        # The unique key includes the owner. A deleted row is restored only by
        # the same owner's exact normalized fact.
        row.value_text = fact.value
        row.category = fact.category
        row.deleted_at = None
        row.updated_at = now
        row.accessed_at = now
        row.source_thread_id = thread_id
        row.source_message_id = source_message_id
    session.add(row)
    session.flush()
    return row


def write_turn_memory(
    session: Session, *, user_id: int, thread_id: str, user_message: WebChatMessage,
    assistant_message: WebChatMessage, answer_class: str,
) -> None:
    if not memory_enabled(session, user_id):
        return
    if _SENSITIVE.search(user_message.content) or _SENSITIVE.search(assistant_message.content):
        return
    now = utc_now()
    # When post-turn distillation is enabled, fact extraction and embeddings
    # belong exclusively to its background job. Conversation summaries remain
    # here so the existing continuity/search behavior is preserved.
    explicit = (
        None
        if _env_bool("WEB_POST_TURN_DISTILLATION_ENABLED", False)
        else parse_durable_memory_fact(user_message.content)
    )
    if explicit:
        store_explicit_memory_fact(
            session,
            user_id=user_id,
            thread_id=thread_id,
            source_message_id=user_message.id,
            fact=explicit,
        )
    if answer_class not in {"detailed", "long_form"} and not re.search(
        r"\b(roadmap|plan|architecture|decision|project)\b", user_message.content, re.I
    ):
        return
    user_part = " ".join(user_message.content.split())[:320]
    assistant_part = " ".join(assistant_message.content.split())[:720]
    summary_text = f"Request: {user_part}\nResult: {assistant_part}"
    keywords = " ".join(sorted(_terms(f"{user_part} {assistant_part}"))[:40])
    summary = session.exec(select(WebConversationSummary).where(
        WebConversationSummary.user_id == user_id,
        WebConversationSummary.thread_id == thread_id,
    )).first()
    if summary is None:
        summary = WebConversationSummary(
            user_id=user_id, thread_id=thread_id,
            summary_text=summary_text, keywords_text=keywords,
        )
    else:
        summary.summary_text = summary_text
        summary.keywords_text = keywords
        summary.updated_at = now
    session.add(summary)
