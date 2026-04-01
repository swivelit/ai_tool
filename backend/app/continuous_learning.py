import os
import time
import threading
import queue
import sqlite3
import numpy as np
import logging
from dotenv import load_dotenv
from openai import OpenAI
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(_name_)

# ==============================
# CONFIG & INIT
# ==============================
DB_NAME = "memory.db"
load_dotenv()

_client = None
_embed_model = None
_conn = None

memory_queue = queue.Queue()
last_activity_time = time.time()

def get_openai_client():
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client

def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = SentenceTransformer("intfloat/e5-small")
    return _embed_model

def get_db_connection():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_NAME, check_same_thread=False)
        _ensure_schema(_conn)
    return _conn

def _ensure_schema(conn):
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary TEXT,
        facts TEXT,
        embedding BLOB
    )
    """)
    conn.commit()

# ==============================
# UTILS
# ==============================
def cosine_similarity(a, b):
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return np.dot(a, b) / (norm_a * norm_b)

def create_embedding(text, is_query=False):
    prefix = "query: " if is_query else "passage: "
    return get_embed_model().encode(f"{prefix}{text}")

# ==============================
# RAG MEMORY RETRIEVAL
# ==============================
def retrieve_memory(user_query):
    query_embedding = create_embedding(user_query, is_query=True)
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT summary, embedding FROM memory")
    rows = cursor.fetchall()

    best_score = 0
    best_memory = None

    for summary, emb_blob in rows:
        stored_embedding = np.frombuffer(emb_blob, dtype=np.float32)
        score = cosine_similarity(query_embedding, stored_embedding)
        if score > best_score:
            best_score = score
            best_memory = summary

    if best_score > 0.80:
        return best_memory
    return None

def chat_with_ai(user_input):
    memory = retrieve_memory(user_input)
    system_prompt = "You are a helpful AI assistant."
    if memory:
        system_prompt += f"\n\nUser memory context:\n{memory}\nUse this if relevant."

    client = get_openai_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input}
        ]
    )
    return response.choices[0].message.content

# ==============================
# BACKGROUND AGENT TASKS
# ==============================
def summarize_chat(chat_list):
    text = "\n".join(chat_list)
    client = get_openai_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Summarize briefly in 1-2 lines."},
            {"role": "user", "content": text}
        ]
    )
    return response.choices[0].message.content

def extract_facts(chat_list):
    text = "\n".join(chat_list)
    prompt = f"""
    Extract structured facts into JSON:
    {{
      "skills": [],
      "goals": [],
      "preferences": [],
      "personal_info": []
    }}
    Conversation: {text}
    """
    client = get_openai_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content

# ==============================
# BACKGROUND WORKER
# ==============================
def background_worker():
    global last_activity_time
    IDLE_THRESHOLD = 30  # Increased for production stability

    while True:
        try:
            if not memory_queue.empty() and (time.time() - last_activity_time > IDLE_THRESHOLD):
                session_data = []
                while not memory_queue.empty():
                    session_data.append(memory_queue.get())

                summary = summarize_chat(session_data)
                facts = extract_facts(session_data)

                if len(summary) >= 10:
                    embedding = create_embedding(summary)
                    conn = get_db_connection()
                    cursor = conn.cursor()
                    cursor.execute(
                        "INSERT INTO memory (summary, facts, embedding) VALUES (?, ?, ?)",
                        (summary, facts, embedding.astype(np.float32).tobytes())
                    )
                    conn.commit()
        except Exception as e:
            logger.error(f"Error in Background Learning Worker: {e}")
        
        time.sleep(5)

def start_background_learning():
    """Starts the learning agent thread."""
    t = threading.Thread(target=background_worker, daemon=True)
    t.start()
    return t

# ==============================
# RUN LOOP (CLI Testing)
# ==============================
if _name_ == "_main_":
    start_background_learning()
    print("--- Continuous Learning CLI Test ---")
    while True:
        user_input = input("\nYou: ")
        if user_input.lower() in ["exit", "quit"]:
            break
        
        last_activity_time = time.time()
        memory_queue.put(user_input)
        
        answer = chat_with_ai(user_input)
        print(f"AI: {answer}")