from __future__ import annotations

import logging
import json
import math
import os
import queue
import re
import threading
import time
from dataclasses import dataclass
from typing import List, Optional, TYPE_CHECKING

import numpy as np
import openai
from dotenv import load_dotenv
from sqlalchemy import text
from sqlmodel import Session, select

from .database import SessionLocal, engine
from .models import WebChatMessage, WebMemoryFact
from .model_runtime import patch_openai_client
from .observability import bootstrap_observability
from .openai_tracked import tracked_chat_completion
from .openai_tracked import cached_text_embedding
from .time_utils import utc_now
from .web_api.web_memory import (
    normalized_memory_key,
    parse_durable_memory_fact,
)

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

# Load .env before module-level configuration is read so imported defaults
# reflect local deployment settings on first import.
load_dotenv()

_runtime_initialized = False
_runtime_init_lock = threading.Lock()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)) or default)
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)) or default)
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _load_config_from_env() -> None:
    global MEMORY_TABLE_NAME, OPENAI_CHAT_MODEL, EMBED_MODEL_NAME
    global MEMORY_MATCH_THRESHOLD, IDLE_THRESHOLD_SECONDS
    global BACKGROUND_POLL_SECONDS, MAX_MEMORY_ROWS_TO_SCAN

    MEMORY_TABLE_NAME = (
        os.getenv("CONTINUOUS_LEARNING_TABLE", "continuous_learning_memory").strip()
        or "continuous_learning_memory"
    )
    OPENAI_CHAT_MODEL = os.getenv(
        "CONTINUOUS_LEARNING_CHAT_MODEL",
        os.getenv("OPENAI_JSON_MODEL", "gpt-4o-mini"),
    )
    EMBED_MODEL_NAME = os.getenv("CONTINUOUS_LEARNING_EMBED_MODEL", "intfloat/e5-small")
    MEMORY_MATCH_THRESHOLD = _env_float("CONTINUOUS_LEARNING_MATCH_THRESHOLD", 0.80)
    IDLE_THRESHOLD_SECONDS = _env_int("CONTINUOUS_LEARNING_IDLE_SECONDS", 30)
    BACKGROUND_POLL_SECONDS = _env_float("CONTINUOUS_LEARNING_POLL_SECONDS", 5.0)
    MAX_MEMORY_ROWS_TO_SCAN = _env_int("CONTINUOUS_LEARNING_MAX_ROWS", 500)


def initialize_continuous_learning() -> None:
    """Initialize optional runtime hooks explicitly instead of at import time."""
    global _runtime_initialized
    if _runtime_initialized:
        return

    with _runtime_init_lock:
        if _runtime_initialized:
            return

        load_dotenv()
        bootstrap_observability()
        patch_openai_client()
        _load_config_from_env()
        _runtime_initialized = True


_load_config_from_env()

_client: Optional[openai.OpenAI] = None
_embed_model: Optional["SentenceTransformer"] = None
_client_lock = threading.Lock()
_embed_model_lock = threading.Lock()
_schema_lock = threading.Lock()
_worker_lock = threading.Lock()
_activity_lock = threading.Lock()
_worker_thread: Optional[threading.Thread] = None
_schema_ready = False
last_activity_time = time.time()


@dataclass(frozen=True)
class LearningEvent:
    text: str
    user_id: Optional[int] = None


memory_queue: "queue.Queue[LearningEvent]" = queue.Queue()


_DURABLE_FACT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bmy name is\s+([^.!?\n]{1,120})", "identity"),
    (r"\bi work at\s+([^.!?\n]{1,180})", "work"),
    (r"\bi prefer\s+([^.!?\n]{1,240})", "preference"),
    (r"\bmy timezone(?: is|:)?\s+([A-Za-z_+\-/ ]{2,80})", "timezone"),
    (
        r"\b(?:actually|correction|to correct that),?\s+(?:my|i)\s+([^.!?\n]{2,240})",
        "correction",
    ),
)
_DISTILL_SENSITIVE = re.compile(
    r"\b(password|passcode|otp|one[- ]time password|credit card|debit card|cvv|"
    r"bank account|account number|ifsc|upi|aadhaar|pan number|social security|"
    r"private key|api key|access token|refresh token|secret)\b",
    re.IGNORECASE,
)
_DISTILL_TRANSIENT = re.compile(
    r"\b(?:for (?:this|the current) (?:message|turn|reply)|right now|today only|"
    r"temporarily|do not remember|don'?t save|ignore previous|system prompt)\b",
    re.IGNORECASE,
)
_DISTILL_SPECULATIVE = re.compile(
    r"\b(?:might|may|could|perhaps|probably|possibly|I (?:suggest|recommend|guess|"
    r"think)|consider using|one option)\b",
    re.IGNORECASE,
)
_ASSISTANT_DURABLE_PATTERNS: tuple[tuple[str, str], ...] = (
    (
        r"\b(?:we|you) (?:decided|chose|agreed) (?:to use|to|on|that)\s+"
        r"([^.!?\n]{2,240})",
        "decision",
    ),
    (
        r"\bthe (?:selected|agreed) (?:stack|approach|plan) is\s+"
        r"([^.!?\n]{2,240})",
        "decision",
    ),
)


def _fact_candidates(
    user_text: str, assistant_text: str = ""
) -> list[tuple[str, str, str]]:
    compact = " ".join(str(user_text or "").split()).strip()
    assistant = " ".join(str(assistant_text or "").split()).strip()
    if (
        not compact
        or _DISTILL_SENSITIVE.search(compact)
        or _DISTILL_TRANSIENT.search(compact)
    ):
        return []
    results: list[tuple[str, str, str]] = []
    explicit = parse_durable_memory_fact(compact)
    if explicit is not None:
        results.append((explicit.category, explicit.value, "user"))
    for pattern, category in _DURABLE_FACT_PATTERNS:
        match = re.search(pattern, compact, re.IGNORECASE)
        if not match:
            continue
        value = match.group(1).strip(" ,;:-")[:600]
        candidate = (category, value, "user")
        if value and candidate not in results:
            results.append(candidate)
        if len(results) >= 2:
            break
    # Assistant text is only authoritative when it records an explicit joint
    # decision. Advice, predictions and inferred user attributes are rejected.
    decision_context = bool(
        re.search(
            r"\b(?:decide|decision|choose|chose|agree|agreed|finali[sz]e|"
            r"which (?:stack|approach|plan))\b",
            compact,
            re.IGNORECASE,
        )
    )
    if (
        len(results) < 2
        and decision_context
        and assistant
        and not _DISTILL_SENSITIVE.search(assistant)
        and not _DISTILL_SPECULATIVE.search(assistant)
    ):
        for pattern, category in _ASSISTANT_DURABLE_PATTERNS:
            match = re.search(pattern, assistant, re.IGNORECASE)
            if not match:
                continue
            value = match.group(1).strip(" ,;:-")[:600]
            candidate = (category, value, "assistant")
            if value and candidate not in results:
                results.append(candidate)
            if len(results) >= 2:
                break
    return results


def _stored_vector(raw: str | None) -> list[float]:
    try:
        value = json.loads(raw or "[]")
        return [float(item) for item in value] if isinstance(value, list) else []
    except (TypeError, ValueError):
        return []


def _vector_cosine(left: list[float], right: list[float], right_norm: float) -> float:
    if not left or not right:
        return 0.0
    left_norm = math.sqrt(sum(item * item for item in left))
    right_norm = right_norm or math.sqrt(sum(item * item for item in right))
    if left_norm <= 0.0 or right_norm <= 0.0:
        return 0.0
    return sum(
        left[index] * right[index] for index in range(min(len(left), len(right)))
    ) / (left_norm * right_norm)


def distill_web_turn_facts(
    session: Session, *, user_id: int, user_message_id: str,
    assistant_message_id: str, thread_id: str,
) -> dict[str, int]:
    """Heuristic-only post-turn fact distillation. This function never calls an LLM."""
    if not _env_bool("WEB_POST_TURN_DISTILLATION_ENABLED", False):
        return {"extracted": 0, "inserted": 0, "deduped": 0, "evicted": 0}
    message = session.get(WebChatMessage, user_message_id)
    assistant = session.get(WebChatMessage, assistant_message_id)
    if (
        message is None
        or assistant is None
        or message.user_id != user_id
        or assistant.user_id != user_id
        or message.role != "user"
        or assistant.role != "assistant"
        or message.thread_id != thread_id
        or assistant.thread_id != thread_id
        or not message.request_id
        or message.request_id != assistant.request_id
        or message.status != "complete"
        or assistant.status != "complete"
        or message.superseded_at is not None
        or assistant.superseded_at is not None
    ):
        return {"extracted": 0, "inserted": 0, "deduped": 0, "evicted": 0}
    candidates = _fact_candidates(message.content, assistant.content)[:2]
    existing = list(
        session.exec(
            select(WebMemoryFact).where(
                WebMemoryFact.user_id == user_id,
            )
        ).all()
    )
    inserted = deduped = 0
    for category, value, source_role in candidates:
        normalized_key = normalized_memory_key(category, value)
        duplicate = next(
            (fact for fact in existing if fact.normalized_key == normalized_key),
            None,
        )
        if duplicate is not None:
            duplicate.accessed_at = utc_now()
            duplicate.updated_at = utc_now()
            duplicate.deleted_at = None
            duplicate.value_text = value
            duplicate.category = category
            duplicate.source_thread_id = thread_id
            duplicate.source_message_id = (
                assistant.id if source_role == "assistant" else message.id
            )
            session.add(duplicate)
            deduped += 1
            continue
        vector = cached_text_embedding(
            value,
            session=session,
            user_id=user_id,
            request_id=f"distill:{assistant.id}:{inserted + deduped}",
            route="web_memory_distillation",
        )
        duplicate = next(
            (
                fact
                for fact in existing
                if (
                    vector
                    and _vector_cosine(
                        vector,
                        _stored_vector(fact.embedding_json),
                        float(fact.embedding_norm or 0.0),
                    )
                    > 0.9
                )
            ),
            None,
        )
        if duplicate is not None:
            duplicate.accessed_at = utc_now()
            duplicate.updated_at = utc_now()
            session.add(duplicate)
            deduped += 1
            continue
        norm = math.sqrt(sum(item * item for item in vector)) if vector else 0.0
        fact = WebMemoryFact(
            user_id=user_id,
            normalized_key=normalized_key,
            value_text=value,
            category=category,
            salience=0.8,
            confidence=1.0,
            source_thread_id=thread_id,
            source_message_id=(
                assistant.id if source_role == "assistant" else message.id
            ),
            embedding_json=json.dumps(vector, separators=(",", ":")) if vector else None,
            embedding_norm=norm,
            accessed_at=utc_now(),
        )
        session.add(fact)
        session.flush()
        existing.append(fact)
        inserted += 1
    session.commit()

    active = list(
        session.exec(
            select(WebMemoryFact)
            .where(
                WebMemoryFact.user_id == user_id,
                WebMemoryFact.deleted_at.is_(None),
            )
            .order_by(WebMemoryFact.accessed_at.asc(), WebMemoryFact.updated_at.asc())
        ).all()
    )
    evicted = max(0, len(active) - 50)
    now = utc_now()
    for fact in active[:evicted]:
        fact.deleted_at = now
        fact.updated_at = now
        session.add(fact)
    if evicted:
        session.commit()
    return {
        "extracted": len(candidates),
        "inserted": inserted,
        "deduped": deduped,
        "evicted": evicted,
    }


def _touch_activity() -> None:
    global last_activity_time
    with _activity_lock:
        last_activity_time = time.time()


def _seconds_since_last_activity() -> float:
    with _activity_lock:
        return time.time() - last_activity_time


def _ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        with engine.begin() as conn:
            conn.execute(
                text(
                    f"""
                    CREATE TABLE IF NOT EXISTS {MEMORY_TABLE_NAME} (
                        id INTEGER PRIMARY KEY,
                        user_id INTEGER NULL,
                        summary TEXT NOT NULL,
                        facts TEXT,
                        embedding BLOB NOT NULL,
                        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            )

        _schema_ready = True


def get_openai_client() -> openai.OpenAI:
    initialize_continuous_learning()
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
                if not api_key:
                    raise RuntimeError(
                        "OPENAI_API_KEY is required for continuous learning"
                    )
                _client = openai.OpenAI(api_key=api_key)
    return _client


def _load_sentence_transformer_class():
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError(
            "sentence-transformers is optional and required only for continuous "
            "learning embeddings. Install sentence-transformers to enable this feature."
        ) from exc
    return SentenceTransformer


def get_embed_model() -> "SentenceTransformer":
    initialize_continuous_learning()
    global _embed_model
    if _embed_model is None:
        with _embed_model_lock:
            if _embed_model is None:
                _embed_model = _load_sentence_transformer_class()(EMBED_MODEL_NAME)
    return _embed_model


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def create_embedding(text_value: str, *, is_query: bool = False) -> np.ndarray:
    prefix = "query: " if is_query else "passage: "
    embedding = get_embed_model().encode(f"{prefix}{(text_value or '').strip()}")
    return np.asarray(embedding, dtype=np.float32)


def _serialize_embedding(embedding: np.ndarray) -> bytes:
    return np.asarray(embedding, dtype=np.float32).tobytes()


def _deserialize_embedding(raw: object) -> np.ndarray:
    if raw is None:
        return np.array([], dtype=np.float32)
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    elif isinstance(raw, bytearray):
        raw = bytes(raw)
    return np.frombuffer(raw, dtype=np.float32)


def _drain_queue() -> List[LearningEvent]:
    events: List[LearningEvent] = []
    while True:
        try:
            events.append(memory_queue.get_nowait())
        except queue.Empty:
            break
    return events


def record_learning_event(text_value: str, user_id: Optional[int] = None) -> None:
    normalized = str(text_value or "").strip()
    if not normalized:
        return
    _touch_activity()
    memory_queue.put(LearningEvent(text=normalized, user_id=user_id))


def summarize_chat(chat_list: List[str]) -> str:
    text_blob = "\n".join([entry for entry in chat_list if entry]).strip()
    if not text_blob:
        return ""

    client = get_openai_client()
    response = tracked_chat_completion(
        client,
        task="simple_transform",
        route="continuous_learning_summarize",
        messages=[
            {
                "role": "system",
                "content": "Summarize this conversation briefly in 1-2 lines.",
            },
            {"role": "user", "content": text_blob},
        ],
    )
    return (response.choices[0].message.content or "").strip()


def extract_facts(chat_list: List[str]) -> str:
    text_blob = "\n".join([entry for entry in chat_list if entry]).strip()
    if not text_blob:
        return "{}"

    prompt = f"""
Extract structured facts into JSON:
{{
  "skills": [],
  "goals": [],
  "preferences": [],
  "personal_info": []
}}
Conversation:
{text_blob}
""".strip()

    client = get_openai_client()
    response = tracked_chat_completion(
        client,
        task="json",
        route="continuous_learning_extract_facts",
        messages=[{"role": "user", "content": prompt}],
    )
    return (response.choices[0].message.content or "{}").strip()


def _store_memory(
    *, user_id: Optional[int], summary: str, facts: str, embedding: np.ndarray
) -> None:
    _ensure_schema()
    with SessionLocal() as session:
        session.exec(
            text(
                f"""
                INSERT INTO {MEMORY_TABLE_NAME} (user_id, summary, facts, embedding)
                VALUES (:user_id, :summary, :facts, :embedding)
                """
            ),
            params={
                "user_id": int(user_id) if user_id is not None else None,
                "summary": summary,
                "facts": facts,
                "embedding": _serialize_embedding(embedding),
            },
        )
        session.commit()


def retrieve_memory(user_query: str, user_id: Optional[int] = None) -> Optional[str]:
    normalized_query = str(user_query or "").strip()
    if not normalized_query:
        return None

    _ensure_schema()
    query_embedding = create_embedding(normalized_query, is_query=True)

    with SessionLocal() as session:
        rows = session.exec(
            text(
                f"""
                SELECT summary, facts, embedding
                FROM {MEMORY_TABLE_NAME}
                WHERE (:user_id IS NULL OR user_id = :user_id)
                ORDER BY id DESC
                LIMIT :row_limit
                """
            ),
            params={
                "user_id": int(user_id) if user_id is not None else None,
                "row_limit": max(1, MAX_MEMORY_ROWS_TO_SCAN),
            },
        ).all()

    best_score = 0.0
    best_memory: Optional[str] = None

    for summary, facts, emb_blob in rows:
        stored_embedding = _deserialize_embedding(emb_blob)
        if stored_embedding.size == 0:
            continue

        score = cosine_similarity(query_embedding, stored_embedding)
        if score > best_score:
            best_score = score
            facts_text = str(facts or "").strip()
            best_memory = str(summary or "").strip()
            if facts_text:
                best_memory = f"{best_memory}\n\nFacts:\n{facts_text}".strip()

    if best_score >= MEMORY_MATCH_THRESHOLD:
        return best_memory
    return None


def chat_with_ai(user_input: str, user_id: Optional[int] = None) -> str:
    memory = retrieve_memory(user_input, user_id=user_id)
    system_prompt = "You are a helpful AI assistant."
    if memory:
        system_prompt += (
            f"\n\nUser memory context:\n{memory}\nUse this only if it is relevant."
        )

    client = get_openai_client()
    response = tracked_chat_completion(
        client,
        task="normal_qa",
        route="continuous_learning_chat",
        user_id=user_id,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ],
    )
    answer = (response.choices[0].message.content or "").strip()

    record_learning_event(user_input, user_id=user_id)
    if answer:
        record_learning_event(f"Assistant: {answer}", user_id=user_id)

    return answer


def background_worker() -> None:
    while True:
        try:
            if (
                memory_queue.empty()
                or _seconds_since_last_activity() <= IDLE_THRESHOLD_SECONDS
            ):
                time.sleep(BACKGROUND_POLL_SECONDS)
                continue

            pending_events = _drain_queue()
            if not pending_events:
                time.sleep(BACKGROUND_POLL_SECONDS)
                continue

            grouped: dict[Optional[int], List[str]] = {}
            for event in pending_events:
                grouped.setdefault(event.user_id, []).append(event.text)

            for user_id, messages in grouped.items():
                if not messages:
                    continue

                summary = summarize_chat(messages)
                if len(summary) < 10:
                    continue

                facts = extract_facts(messages)
                embedding = create_embedding(summary)
                _store_memory(
                    user_id=user_id,
                    summary=summary,
                    facts=facts,
                    embedding=embedding,
                )
        except Exception:
            logger.exception("continuous learning background worker failed")

        time.sleep(BACKGROUND_POLL_SECONDS)


def start_background_learning() -> threading.Thread:
    global _worker_thread
    initialize_continuous_learning()
    _ensure_schema()

    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return _worker_thread

        _worker_thread = threading.Thread(
            target=background_worker,
            name="continuous-learning-worker",
            daemon=True,
        )
        _worker_thread.start()
        return _worker_thread


if __name__ == "__main__":
    start_background_learning()
    print("--- Continuous Learning CLI Test ---")
    while True:
        user_input = input("\nYou: ").strip()
        if user_input.lower() in {"exit", "quit"}:
            break

        record_learning_event(user_input)
        answer = chat_with_ai(user_input)
        print(f"AI: {answer}")
