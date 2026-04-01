import sqlite3
import uuid
import numpy as np
from sentence_transformers import SentenceTransformer
from openai import OpenAI
from dotenv import load_dotenv
import os

# ==============================
# CONFIG
# ==============================
DB_NAME = "semantic_cache.db"
THRESHOLD = 0.95

# Load API key safely
load_dotenv() 
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


# ==============================
# LOAD EMBEDDING MODEL (E5)
# ==============================
model = SentenceTransformer("intfloat/e5-small")

def get_embedding(text):
    text = text.lower().strip()
    return model.encode(f"query: {text}")

# ==============================
# DATABASE SETUP (Room equivalent)
# ==============================
conn = sqlite3.connect(DB_NAME)
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
# COSINE SIMILARITY
# ==============================
def cosine_similarity(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

# ==============================
# SEARCH CACHE
# ==============================
def search_cache(query_embedding):
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

# ==============================
# STORE CACHE
# ==============================
def store_cache(question, answer, embedding):
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
# MAIN FUNCTION
# ==============================
def chat_with_cache(user_query):
    print(f"\n[User]: {user_query}")

    # Step 1: Embedding
    query_embedding = get_embedding(user_query)

    # Step 2: Search cache
    score, cached_answer = search_cache(query_embedding)

    print(f"[Similarity]: {score:.4f}")

    # Step 3: Cache Hit
    if score >= THRESHOLD:
        print("⚡ Cache HIT")
        print(f"[Answer]: {cached_answer}")
        return cached_answer

    # Step 4: Cache Miss → Call OpenAI
    print("❌ Cache MISS → Calling OpenAI...")

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

    print(f"[Answer]: {answer}")
    return answer

# ==============================
# RUN LOOP
# ==============================
if __name__ == "__main__":
    while True:
        user_input = input("\nAsk (type 'exit' to quit): ")

        if user_input.lower() in ["exit", "quit"]:
            break

        chat_with_cache(user_input)