"""
Deprecated server-side semantic cache prototype.

Phone-local semantic cache plus the newer LocalRAGService/VectorStore path are now
the primary runtime cache. This module remains only for manual backend experiments,
so keep it safe and bounded rather than letting it scan the whole cache table on
every query.
"""

from __future__ import annotations

import os
import re
import sqlite3
import threading
import uuid
from typing import List, Sequence, Tuple

import numpy as np
from dotenv import load_dotenv
from openai import OpenAI

# ==============================
# CONFIG & INIT
# ==============================
DB_NAME = os.getenv("SEMANTIC_CACHE_DB", "semantic_cache.db")
THRESHOLD = float(os.getenv("SEMANTIC_CACHE_THRESHOLD", "0.95"))
CACHE_LOOKUP_LIMIT = int(os.getenv("SEMANTIC_CACHE_LOOKUP_LIMIT", "200"))
MIN_PREFILTER_TOKEN_LENGTH = int(os.getenv("SEMANTIC_CACHE_MIN_TOKEN_LENGTH", "3"))
MAX_PREFILTER_TOKENS = int(os.getenv("SEMANTIC_CACHE_MAX_PREFILTER_TOKENS", "5"))
DEPRECATED = True

load_dotenv()

# Lazy initialization for the embedding model and client
_model = None
_client = None
_conn = None
_conn_lock = threading.Lock()
_db_lock = threading.RLock()
_TOKEN_RE = re.compile(r"[\w\u0B80-\u0BFF]+", re.UNICODE)


def _load_sentence_transformer_class():
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError(
            "sentence-transformers is optional and required only for the deprecated "
            "semantic cache embedding path. Install sentence-transformers to use it."
        ) from exc
    return SentenceTransformer


def get_openai_client():
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


def get_embedding_model():
    global _model
    if _model is None:
        # Load E5-small for efficient embeddings
        _model = _load_sentence_transformer_class()("intfloat/e5-small")
    return _model


def get_db_connection():
    """Return the singleton SQLite connection in a thread-safe way."""
    global _conn
    with _conn_lock:
        if _conn is None:
            conn = sqlite3.connect(DB_NAME, check_same_thread=False)
            try:
                _ensure_schema(conn)
            except Exception:
                conn.close()
                raise
            _conn = conn
        return _conn


def _ensure_schema(conn):
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS cache (
            id TEXT PRIMARY KEY,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            embedding BLOB NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute("PRAGMA table_info(cache)")
    columns = {row[1] for row in cursor.fetchall()}
    if "created_at" not in columns:
        cursor.execute("ALTER TABLE cache ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cache_question ON cache(question)")
    conn.commit()


# ==============================
# UTILS
# ==============================
def normalize_question(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").lower()).strip()


def get_embedding(text):
    text = normalize_question(text)
    return get_embedding_model().encode(f"query: {text}")


def cosine_similarity(a, b):
    # Ensure vectors are normalized for safety, though SentenceTransformer often does this
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return np.dot(a, b) / (norm_a * norm_b)


def _prefilter_tokens(question: str) -> List[str]:
    tokens: List[str] = []
    seen = set()
    for token in _TOKEN_RE.findall(normalize_question(question)):
        if len(token) < MIN_PREFILTER_TOKEN_LENGTH or token in seen:
            continue
        seen.add(token)
        tokens.append(token)
        if len(tokens) >= MAX_PREFILTER_TOKENS:
            break
    return tokens


def _fetch_candidate_rows(conn: sqlite3.Connection, question: str) -> Sequence[Tuple[str, str, bytes]]:
    """Fetch a bounded set of likely candidates before doing vector math.

    The old implementation loaded every embedding blob and computed cosine
    similarity for every row. This keeps the legacy cache from becoming an OOM
    or timeout risk as the table grows.
    """
    limit = max(1, CACHE_LOOKUP_LIMIT)
    cursor = conn.cursor()
    tokens = _prefilter_tokens(question)

    if tokens:
        clauses = " OR ".join("LOWER(question) LIKE ?" for _ in tokens)
        params = [f"%{token}%" for token in tokens]
        cursor.execute(
            f"""
            SELECT question, answer, embedding
            FROM cache
            WHERE {clauses}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (*params, limit),
        )
        rows = cursor.fetchall()
        if rows:
            return rows

    cursor.execute(
        """
        SELECT question, answer, embedding
        FROM cache
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return cursor.fetchall()


# ==============================
# CACHE OPERATIONS
# ==============================
def search_cache(query_embedding, question: str = ""):
    conn = get_db_connection()
    with _db_lock:
        rows = _fetch_candidate_rows(conn, question)

    best_score = 0.0
    best_answer = None

    for _question, answer, emb_blob in rows:
        stored_embedding = np.frombuffer(emb_blob, dtype=np.float32)
        score = float(cosine_similarity(query_embedding, stored_embedding))

        if score > best_score:
            best_score = score
            best_answer = answer

    return best_score, best_answer


def store_cache(question, answer, embedding):
    conn = get_db_connection()
    with _db_lock:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO cache (id, question, answer, embedding) VALUES (?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                normalize_question(question),
                answer,
                embedding.astype(np.float32).tobytes(),
            ),
        )
        conn.commit()


# ==============================
# MAIN EXPORTED FUNCTION
# ==============================
def chat_with_cache(user_query):
    """
    Deprecated legacy entry point for semantic caching.
    Returns: (answer, is_cache_hit)
    """
    normalized_query = normalize_question(user_query)

    # Step 1: Get query embedding
    query_embedding = get_embedding(normalized_query)

    # Step 2: Search a bounded candidate set from the cache
    score, cached_answer = search_cache(query_embedding, normalized_query)

    # Step 3: Check for HIT
    if score >= THRESHOLD:
        return cached_answer, True

    # Step 4: Cache MISS → Call OpenAI
    client = get_openai_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a helpful AI assistant."},
            {"role": "user", "content": user_query},
        ],
    )
    answer = response.choices[0].message.content

    # Step 5: Store in DB
    store_cache(normalized_query, answer, query_embedding)

    return answer, False


# ==============================
# RUN LOOP (CLI Testing)
# ==============================
if __name__ == "__main__":
    print("--- Deprecated Semantic Cache CLI Test ---")
    while True:
        user_input = input("\nAsk (type 'exit' to quit): ")
        if user_input.lower() in ["exit", "quit"]:
            break

        answer, hit = chat_with_cache(user_input)
        status = "⚡ HIT" if hit else "❌ MISS"
        print(f"[{status}] [Answer]: {answer}")
