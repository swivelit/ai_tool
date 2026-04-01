import os
import time
import threading
import queue
import sqlite3
import numpy as np
from dotenv import load_dotenv
from openai import OpenAI
from sentence_transformers import SentenceTransformer

# ==============================
# INIT
# ==============================
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

embed_model = SentenceTransformer("intfloat/e5-small")

memory_queue = queue.Queue()
last_activity_time = time.time()

# ==============================
# DATABASE
# ==============================
conn = sqlite3.connect("memory.db", check_same_thread=False)
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
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))


def create_embedding(text):
    return embed_model.encode(f"passage: {text}")


# ==============================
# RAG MEMORY RETRIEVAL
# ==============================
def retrieve_memory(user_query):
    query_embedding = embed_model.encode(f"query: {user_query}")

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


# ==============================
# OPENAI CHAT (WITH MEMORY)
# ==============================
def chat_with_ai(user_input):
    memory = retrieve_memory(user_input)

    if memory:
        system_prompt = f"""
You are a helpful AI assistant.

User memory:
{memory}

Use this memory if relevant to personalize your response.
"""
    else:
        system_prompt = "You are a helpful AI assistant."

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input}
        ]
    )

    return response.choices[0].message.content


# ==============================
# BACKGROUND FUNCTIONS
# ==============================
def summarize_chat(chat_list):
    text = "\n".join(chat_list)

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
You are an AI that extracts structured user information.

Rules:
- Extract only long-term useful facts
- Ignore temporary or irrelevant info
- Be precise
- Return valid JSON ONLY

Format:
{{
  "skills": [],
  "goals": [],
  "preferences": [],
  "personal_info": []
}}

Conversation:
{text}
"""

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}]
    )

    return response.choices[0].message.content


# ==============================
# BACKGROUND WORKER (SILENT)
# ==============================
def background_worker():
    global last_activity_time
    IDLE_THRESHOLD = 10

    while True:
        if (not memory_queue.empty() and
            time.time() - last_activity_time > IDLE_THRESHOLD):

            session_data = []

            while not memory_queue.empty():
                session_data.append(memory_queue.get())

            try:
                summary = summarize_chat(session_data)
                facts = extract_facts(session_data)

                # Filter small/irrelevant memory
                if len(summary) < 10:
                    continue

                embedding = create_embedding(summary)

                # Store in DB
                cursor.execute(
                    "INSERT INTO memory (summary, facts, embedding) VALUES (?, ?, ?)",
                    (summary, facts, embedding.astype(np.float32).tobytes())
                )
                conn.commit()

            except:
                pass  # silent

        time.sleep(1)


# ==============================
# START BACKGROUND THREAD
# ==============================
threading.Thread(target=background_worker, daemon=True).start()

# ==============================
# MAIN CHAT LOOP
# ==============================
print("AI Assistant Started (type 'exit' to quit)")

while True:
    user_input = input("\nYou: ")

    if user_input.lower() in ["exit", "quit"]:
        break

    # Update activity
    last_activity_time = time.time()

    # Add to background queue
    memory_queue.put(user_input)

    # Immediate AI response (with memory)
    answer = chat_with_ai(user_input)
    print(f"AI: {answer}")