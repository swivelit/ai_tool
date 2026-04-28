from __future__ import annotations

import logging
import os
import queue
import threading
import time
from dataclasses import dataclass
from typing import List, Optional, TYPE_CHECKING

import numpy as np
import openai
from dotenv import load_dotenv
from sqlalchemy import text

from .database import SessionLocal, engine
from .model_runtime import patch_openai_client
from .observability import bootstrap_observability

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
    response = client.chat.completions.create(
        model=OPENAI_CHAT_MODEL,
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
    response = client.chat.completions.create(
        model=OPENAI_CHAT_MODEL,
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
            {
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
            {
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
    response = client.chat.completions.create(
        model=OPENAI_CHAT_MODEL,
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
