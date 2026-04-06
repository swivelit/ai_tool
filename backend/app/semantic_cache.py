import sqlite3
import uuid
import numpy as np
import os
from sentence_transformers import SentenceTransformer
from openai import OpenAI
from dotenv import load_dotenv
from pathlib import Path

# ==============================
# CONFIG & INIT
# ==============================
DB_NAME = "semantic_cache.db"
THRESHOLD = 0.95

load_dotenv() 

# Lazy initialization for the embedding model and client
_model = None
_client = None
_conn = None

def get_openai_client():
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client

def get_embedding_model():
    global _model
    if _model is None:
        # Load E5-small for efficient embeddings
        _model = SentenceTransformer("intfloat/e5-small")
    return _model

def get_db_connection():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_NAME, check_same_thread=False)
        _ensure_schema(_conn)
    return _conn

def _ensure_schema(conn):
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS cache (
        id TEXT PRIMARY KEY,
        question TEXT,
        answer TEXT,
        embedding BLOB
    )
    """)
    conn.commit()

# ==============================
# UTILS
# ==============================
def get_embedding(text):
    text = text.lower().strip()
    return get_embedding_model().encode(f"query: {text}")

def cosine_similarity(a, b):
    # Ensure vectors are normalized for safety, though SentenceTransformer often does this
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return np.dot(a, b) / (norm_a * norm_b)

# ==============================
# CACHE OPERATIONS
# ==============================
def search_cache(query_embedding):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT question, answer, embedding FROM cache")
    rows = cursor.fetchall()

    best_score = 0
    best_answer = None

    for q, ans, emb_blob in rows:
        stored_embedding = np.frombuffer(emb_blob, dtype=np.float32)
        score = cosine_similarity(query_embedding, stored_embedding)

        if score > best_score:
            best_score = score
            best_answer = ans

    return best_score, best_answer

def store_cache(question, answer, embedding):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO cache VALUES (?, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            question,
            answer,
            embedding.astype(np.float32).tobytes()
        )
    )
    conn.commit()

# ==============================
# MAIN EXPORTED FUNCTION
# ==============================
def chat_with_cache(user_query):
    """
    Main entry point for semantic caching.
    Returns: (answer, is_cache_hit)
    """
    # Step 1: Get query embedding
    query_embedding = get_embedding(user_query)

    # Step 2: Search cache
    score, cached_answer = search_cache(query_embedding)

    # Step 3: Check for HIT
    if score >= THRESHOLD:
        return cached_answer, True

    # Step 4: Cache MISS → Call OpenAI
    client = get_openai_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a helpful AI assistant."},
            {"role": "user", "content": user_query}
        ]
    )
    answer = response.choices[0].message.content

    # Step 5: Store in DB
    store_cache(user_query, answer, query_embedding)
    
    return answer, False

# ==============================
# RUN LOOP (CLI Testing)
# ==============================
if __name__ == "__main__":
    print("--- Semantic Cache CLI Test ---")
    while True:
        user_input = input("\nAsk (type 'exit' to quit): ")
        if user_input.lower() in ["exit", "quit"]:
            break
        
        answer, hit = chat_with_cache(user_input)
        status = "⚡ HIT" if hit else "❌ MISS"
        print(f"[{status}] [Answer]: {answer}")