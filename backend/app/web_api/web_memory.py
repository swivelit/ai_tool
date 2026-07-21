from __future__ import annotations

from dataclasses import dataclass
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


_MEMORY_REQUESTS = re.compile(
    r"\b(continue (?:the )?.*(?:we discussed|from (?:the )?other chat)|"
    r"what did i (?:decide|say|plan)|use my previous|remember my (?:preferred|preference|project)|"
    r"what was the .* from (?:the )?(?:other|previous) chat|previous (?:chat|thread|conversation)|"
    r"we discussed (?:yesterday|before|earlier))\b",
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
    r"bank account|aadhaar|social security|private key|api key|access token)\b",
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


def needs_cross_thread_memory(message: str) -> bool:
    return bool(_MEMORY_REQUESTS.search(str(message or "")))


def memory_enabled(session: Session, user_id: int) -> bool:
    if not _env_bool("WEB_CROSS_THREAD_MEMORY_ENABLED", False):
        return False
    row = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == user_id
    )).first()
    return bool(row and row.memory_enabled)


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


def retrieve_memory(
    session: Session, *, user_id: int, message: str, current_thread_id: str | None,
    allow_natural_followup: bool = False,
) -> MemorySelection:
    if (
        not (needs_cross_thread_memory(message) or allow_natural_followup)
        or not memory_enabled(session, user_id)
    ):
        return MemorySelection("", ())
    limit = _env_int("WEB_MEMORY_MAX_ITEMS", 4, 1, 4)
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
    for rank, fact in enumerate(facts):
        if fact.source_message_id:
            source = session.get(WebChatMessage, fact.source_message_id)
            if source is not None and source.superseded_at is not None:
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
    return MemorySelection("\n\n".join(blocks), tuple(accepted))


def _explicit_fact(message: str) -> tuple[str, str] | None:
    text = " ".join(str(message or "").split()).strip()
    if not text or _SENSITIVE.search(text):
        return None
    patterns: Iterable[tuple[str, str]] = (
        (r"^remember that\s+(.+)$", "explicit"),
        (r"^my preferred reply style is\s+(.+)$", "reply_style"),
        (r"^i prefer\s+(.+)$", "preference"),
        (r"^i(?:'m| am) (?:working|building) on\s+(.+)$", "ongoing_project"),
        (r"^my (?:current )?project (?:is|uses)\s+(.+)$", "ongoing_project"),
    )
    for pattern, category in patterns:
        match = re.match(pattern, text, re.IGNORECASE)
        if match:
            value = match.group(1).strip()[:600]
            if value:
                return category, value
    return None


def write_turn_memory(
    session: Session, *, user_id: int, thread_id: str, user_message: WebChatMessage,
    assistant_message: WebChatMessage, answer_class: str,
) -> None:
    if not memory_enabled(session, user_id):
        return
    if _SENSITIVE.search(user_message.content) or _SENSITIVE.search(assistant_message.content):
        return
    now = utc_now()
    explicit = _explicit_fact(user_message.content)
    if explicit:
        category, value = explicit
        normalized_terms = sorted(_terms(value))[:12]
        normalized_key = f"{category}:{'-'.join(normalized_terms)}"[:160]
        if normalized_key != f"{category}:":
            row = session.exec(select(WebMemoryFact).where(
                WebMemoryFact.user_id == user_id,
                WebMemoryFact.normalized_key == normalized_key,
            )).first()
            if row is None:
                row = WebMemoryFact(
                    user_id=user_id, normalized_key=normalized_key,
                    value_text=value, category=category, salience=0.8,
                    confidence=1.0, source_thread_id=thread_id,
                    source_message_id=user_message.id,
                )
            else:
                row.value_text = value
                row.deleted_at = None
                row.updated_at = now
                row.source_thread_id = thread_id
                row.source_message_id = user_message.id
            session.add(row)
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
