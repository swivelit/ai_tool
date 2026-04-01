# ===============================
# ✅ LOAD ENV
# ===============================
from dotenv import load_dotenv
load_dotenv()

import os
import time
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer

print("DATABASE_URL:", os.getenv("DATABASE_URL"))


# ===============================
# ✅ IMPORT PIPELINE
# ===============================
from app.main import _run_stage_pipeline
from app.database import get_session
from stage_openai_core import OpenAICore


# ===============================
# ✅ INIT
# ===============================
similarity_model = SentenceTransformer("all-mpnet-base-v2")
openai_only = OpenAICore()


# ===============================
# ✅ SIMILARITY FUNCTION
# ===============================
def similarity_score(text1, text2):
    emb1 = similarity_model.encode([str(text1)])
    emb2 = similarity_model.encode([str(text2)])
    return cosine_similarity(emb1, emb2)[0][0]


# ===============================
# ✅ TEST INPUT
# ===============================
user_input = "எனக்கு வேலை கிடைக்கவில்லை என்ன செய்யலாம்?"
user_id = None
reply_language = "en"   # 🔥 FORCE ENGLISH


# ===============================
# ✅ SAME PROMPT (IMPORTANT)
# ===============================
prompt = f"""
Answer the question in 2-3 sentences.
Be clear, helpful, and practical.

Question: {user_input}
"""


# ===============================
# ✅ CREATE SESSION
# ===============================
session = next(get_session())


# ===============================
# ✅ 1. FULL PIPELINE (RAG)
# ===============================
print("\n🚀 Running FULL PIPELINE...\n")

start = time.time()

pipeline_result = _run_stage_pipeline(
    session,
    user_id,
    prompt,   # 🔥 SAME PROMPT
    reply_language
)

# 🔹 Extract outputs
raw_output = pipeline_result.get("raw_english", "")
final_output = pipeline_result.get("remodeled_english", "")

rag_time = time.time() - start


# ===============================
# ✅ 2. OPENAI ONLY
# ===============================
print("\n🚀 Running OPENAI ONLY...\n")

start = time.time()

direct_output = openai_only.answer_user_query(
    prompt,   # 🔥 SAME PROMPT
    "neutral"
)

direct_time = time.time() - start


# ===============================
# ✅ SIMILARITY CALCULATIONS
# ===============================
sim_raw_vs_direct = similarity_score(raw_output, direct_output)
sim_final_vs_direct = similarity_score(final_output, direct_output)


# ===============================
# ✅ PRINT RESULTS (CLEAR)
# ===============================
print("\n" + "="*70)
print("🧪 PIPELINE SIMILARITY ANALYSIS")
print("="*70)

# 🔹 INPUT
print("\n📥 INPUT QUESTION:")
print("-"*70)
print(user_input)

# 🔹 RAW OUTPUT (before remodel)
print("\n🧩 RAW PIPELINE OUTPUT (Before Remodel):")
print("-"*70)
print(raw_output)

# 🔹 FINAL OUTPUT (after remodel)
print("\n🤖 FINAL PIPELINE OUTPUT (After Remodel):")
print("-"*70)
print(final_output)

# 🔹 OPENAI OUTPUT
print("\n🧠 OPENAI ONLY OUTPUT:")
print("-"*70)
print(direct_output)

# 🔹 SIMILARITY
print("\n📊 SIMILARITY SCORES:")
print("-"*70)
print(f"RAW vs OpenAI   : {round(sim_raw_vs_direct, 4)}")
print(f"FINAL vs OpenAI : {round(sim_final_vs_direct, 4)}")

# 🔹 LATENCY
print("\n⏱️ LATENCY:")
print("-"*70)
print(f"Pipeline Time : {round(rag_time, 3)} sec")
print(f"OpenAI Time   : {round(direct_time, 3)} sec")

# 🔹 LENGTH CHECK
print("\n🔍 LENGTH COMPARISON:")
print("-"*70)
print("RAW Length     :", len(raw_output))
print("FINAL Length   :", len(final_output))
print("OpenAI Length  :", len(direct_output))

print("\n" + "="*70)