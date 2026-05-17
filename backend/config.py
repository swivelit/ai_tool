from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Optional

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent

# Checked-in source of truth for phone-local agent config/training/RAG seeds.
SHARED_SEED_DATA_DIR = REPO_ROOT / "mobile" / "data"
SHARED_CONFIG_DIR = SHARED_SEED_DATA_DIR / "config"
RAG_DATA_DIR = SHARED_SEED_DATA_DIR / "rag" / "seed"
TRAINING_DATA_DIR = SHARED_SEED_DATA_DIR / "training" / "seed"

# Backend runtime workspace remains local to the backend and is not intended as
# the primary product runtime architecture.
DATA_DIR = BASE_DIR / "data"
DATABASE_DIR = DATA_DIR / "db"
PROFILES_DIR = DATA_DIR / "profiles"
LOGS_DIR = DATA_DIR / "logs"
GENERATED_DOCS_DIR = DATA_DIR / "generated_docs"

# Model artifacts can still live outside data/ because these are code/runtime assets,
# not user/runtime data.
MODELS_DIR = BASE_DIR / "models"

# Database + datasets
DATABASE_PATH = DATABASE_DIR / "ai_tool.sqlite3"
CLASSIFIER_DATASET_PATH = TRAINING_DATA_DIR / "classifier_dataset.csv"
FAST_RAG_DATASET_PATH = RAG_DATA_DIR / "fast_rag_replies.csv"
PIPELINE_QUESTIONS_CSV_PATH = TRAINING_DATA_DIR / "pipeline_questions.csv"
LOCAL_RAG_KEYWORDS_PATH = RAG_DATA_DIR / "local_rag_keywords.csv"
LOCAL_RAG_SYNONYMS_PATH = RAG_DATA_DIR / "local_rag_synonyms.csv"

# Agent config comes from shared checked-in seed data. Runtime state stays under
# backend/data so the backend remains a support/fallback mirror.
AGENTS_DIR = DATA_DIR / "agents"
AGENT_CONFIG_DIR = SHARED_CONFIG_DIR
AGENT_STATE_DIR = AGENTS_DIR / "state"
AGENT_MEMORY_DIR = AGENTS_DIR / "memory"
AGENT_LOGS_DIR = AGENTS_DIR / "logs"
AGENT_TRAINING_DIR = AGENTS_DIR / "training"
AGENT_PROFILE_SNAPSHOT_DIR = AGENTS_DIR / "snapshots"
AGENT_RAG_EXPORT_DIR = AGENTS_DIR / "rag_exports"
AGENT_WORKSPACE_MANIFEST_PATH = AGENT_CONFIG_DIR / "workspace_manifest.json"

AGENT_PROFILER_SCHEMA_PATH = AGENT_CONFIG_DIR / "profiler_slots.json"
AGENT_ORCHESTRATOR_CONFIG_PATH = AGENT_CONFIG_DIR / "orchestrator_routes.json"
AGENT_ALIGNMENT_CONFIG_PATH = AGENT_CONFIG_DIR / "alignment_rules.json"
AGENT_MEMORY_CONFIG_PATH = AGENT_CONFIG_DIR / "memory_rules.json"


def _ensure_dirs(paths: Iterable[Path]) -> None:
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


_ensure_dirs(
    (
        SHARED_SEED_DATA_DIR,
        SHARED_CONFIG_DIR,
        RAG_DATA_DIR,
        TRAINING_DATA_DIR,
        DATA_DIR,
        DATABASE_DIR,
        PROFILES_DIR,
        LOGS_DIR,
        MODELS_DIR,
        GENERATED_DOCS_DIR,
        AGENTS_DIR,
        AGENT_CONFIG_DIR,
        AGENT_STATE_DIR,
        AGENT_MEMORY_DIR,
        AGENT_LOGS_DIR,
        AGENT_TRAINING_DIR,
        AGENT_PROFILE_SNAPSHOT_DIR,
        AGENT_RAG_EXPORT_DIR,
    )
)


def _env_str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int, *, minimum: Optional[int] = None) -> int:
    value = os.getenv(name)
    try:
        parsed = int(str(value).strip()) if value is not None else int(default)
    except Exception:
        parsed = int(default)
    if minimum is not None:
        parsed = max(parsed, minimum)
    return parsed


def _env_float(name: str, default: float, *, minimum: Optional[float] = None) -> float:
    value = os.getenv(name)
    try:
        parsed = float(str(value).strip()) if value is not None else float(default)
    except Exception:
        parsed = float(default)
    if minimum is not None:
        parsed = max(parsed, minimum)
    return parsed


OPENAI_API_KEY = _env_str("OPENAI_API_KEY", "")
OPENAI_MODEL = _env_str("OPENAI_MODEL", "gpt-5-nano")
OPENAI_JSON_MODEL = _env_str("OPENAI_JSON_MODEL", "gpt-5-nano")
OPENAI_MODEL_CHEAP = _env_str("OPENAI_MODEL_CHEAP", _env_str("OPENAI_JSON_MODEL", OPENAI_MODEL))
OPENAI_MODEL_STANDARD = _env_str("OPENAI_MODEL_STANDARD", OPENAI_MODEL)
OPENAI_MODEL_REASONING = _env_str("OPENAI_MODEL_REASONING", "gpt-5-mini")
OPENAI_MODEL_HIGH = _env_str("OPENAI_MODEL_HIGH", "")
OPENAI_DISABLE_HIGHEST_MODEL = _env_bool("OPENAI_DISABLE_HIGHEST_MODEL", True)
OPENAI_DAILY_BUDGET_USD = _env_float("OPENAI_DAILY_BUDGET_USD", 5.0, minimum=0.0)
OPENAI_BUDGET_SAFETY_MARGIN_RATIO = _env_float("OPENAI_BUDGET_SAFETY_MARGIN_RATIO", 0.05, minimum=0.0)
OPENAI_MAX_OUTPUT_TOKENS_DEFAULT = _env_int("OPENAI_MAX_OUTPUT_TOKENS_DEFAULT", 450, minimum=1)
OPENAI_MAX_OUTPUT_TOKENS_HARD = _env_int("OPENAI_MAX_OUTPUT_TOKENS_HARD", 900, minimum=1)
OPENAI_EMBEDDING_MODEL = _env_str("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
OPENAI_MODERATION_MODEL = _env_str("OPENAI_MODERATION_MODEL", "omni-moderation-latest")
OPENAI_TIMEOUT = _env_int("OPENAI_TIMEOUT", 60, minimum=5)
OPENAI_MAX_RETRIES = _env_int("OPENAI_MAX_RETRIES", 3, minimum=1)
OPENAI_BACKOFF_BASE_SECONDS = _env_float("OPENAI_BACKOFF_BASE_SECONDS", 0.8, minimum=0.1)
OPENAI_CACHE_SIZE = _env_int("OPENAI_CACHE_SIZE", 128, minimum=8)
OPENAI_JSON_REPAIR_ATTEMPTS = _env_int("OPENAI_JSON_REPAIR_ATTEMPTS", 1, minimum=0)

SARVAM_CHAT_MODEL = _env_str("SARVAM_CHAT_MODEL", "sarvam-30b")
SARVAM_CHAT_MODEL_REASONING = _env_str("SARVAM_CHAT_MODEL_REASONING", "sarvam-105b")
SARVAM_STT_MODEL = _env_str("SARVAM_STT_MODEL", "saaras:v3")
SARVAM_STT_MODE = _env_str("SARVAM_STT_MODE", "transcribe")
SARVAM_TTS_MODEL = _env_str("SARVAM_TTS_MODEL", "bulbul:v2")
SARVAM_TTS_MODEL_PREMIUM = _env_str("SARVAM_TTS_MODEL_PREMIUM", "bulbul:v3")
SARVAM_TTS_SPEAKER = _env_str("SARVAM_TTS_SPEAKER", "shubh")

AI_ROUTER_ENABLED = _env_bool("AI_ROUTER_ENABLED", True)
AI_LEGACY_PIPELINE_ENABLED = _env_bool("AI_LEGACY_PIPELINE_ENABLED", False)
AI_PROVIDER_ROUTING_MODE = _env_str("AI_PROVIDER_ROUTING_MODE", "cost_optimized")
AI_MAX_PROVIDER_CALLS_PER_TURN = _env_int("AI_MAX_PROVIDER_CALLS_PER_TURN", 1, minimum=1)
AI_MAX_PROVIDER_CALLS_PER_TURN_HARD = _env_int("AI_MAX_PROVIDER_CALLS_PER_TURN_HARD", 2, minimum=1)
AI_ALLOW_OPENAI_TO_SARVAM_FALLBACK = _env_bool("AI_ALLOW_OPENAI_TO_SARVAM_FALLBACK", False)
AI_ALLOW_SARVAM_COMPLEX_FALLBACK = _env_bool("AI_ALLOW_SARVAM_COMPLEX_FALLBACK", False)
FREE_DAILY_TEXT_LIMIT = _env_int("FREE_DAILY_TEXT_LIMIT", 40, minimum=0)
FREE_DAILY_VOICE_SECONDS = _env_int("FREE_DAILY_VOICE_SECONDS", 180, minimum=0)
AI_DAILY_BUDGET_INR = _env_float("AI_DAILY_BUDGET_INR", 0.0, minimum=0.0)
SARVAM_DAILY_BUDGET_INR = _env_float("SARVAM_DAILY_BUDGET_INR", 0.0, minimum=0.0)
ENABLE_WEB_SEARCH_FOR_FREE = _env_bool("ENABLE_WEB_SEARCH_FOR_FREE", False)
ENABLE_OPENAI_FILE_SEARCH = _env_bool("ENABLE_OPENAI_FILE_SEARCH", False)
ENABLE_OPENAI_MODERATION = _env_bool("ENABLE_OPENAI_MODERATION", False)

PIPELINE_VERSION = _env_str("PIPELINE_VERSION", "ai_tool_stage_merge_v3_advanced_rag")
PROFILE_VERSION = _env_str("PROFILE_VERSION", "v4")
QUESTION_COUNT = _env_int("QUESTION_COUNT", 15, minimum=1)
MAX_HISTORY_DOCS = _env_int("MAX_HISTORY_DOCS", 8, minimum=1)
MAX_PROFILE_MEMORY_ROWS = _env_int("MAX_PROFILE_MEMORY_ROWS", 40, minimum=5)

RAW_TEMPERATURE = _env_float("RAW_TEMPERATURE", 0.3, minimum=0.0)
REMODEL_TEMPERATURE = _env_float("REMODEL_TEMPERATURE", 0.35, minimum=0.0)
TRANSLATION_TEMPERATURE = _env_float("TRANSLATION_TEMPERATURE", 0.1, minimum=0.0)
REVIEW_TEMPERATURE = _env_float("REVIEW_TEMPERATURE", 0.12, minimum=0.0)

DIRECT_MATCH_STRONG_THRESHOLD = _env_float("DIRECT_MATCH_STRONG_THRESHOLD", 0.9, minimum=0.0)
DIRECT_MATCH_SEMANTIC_THRESHOLD = _env_float("DIRECT_MATCH_SEMANTIC_THRESHOLD", 0.84, minimum=0.0)
DIRECT_MATCH_WEAK_THRESHOLD = _env_float("DIRECT_MATCH_WEAK_THRESHOLD", 0.76, minimum=0.0)
DIRECT_MATCH_FORCE_THRESHOLD = _env_float("DIRECT_MATCH_FORCE_THRESHOLD", 0.92, minimum=0.0)
DIRECT_MATCH_ROUTE_THRESHOLD = _env_float("DIRECT_MATCH_ROUTE_THRESHOLD", 0.84, minimum=0.0)

ENABLE_TRANSLATION_REFINEMENT = _env_bool("ENABLE_TRANSLATION_REFINEMENT", True)
ENABLE_TAMIL_VALIDATION = _env_bool("ENABLE_TAMIL_VALIDATION", True)
ENABLE_ANSWER_REVIEW = _env_bool("ENABLE_ANSWER_REVIEW", True)
ENABLE_LOCAL_DIALECT_MODEL = _env_bool("ENABLE_LOCAL_DIALECT_MODEL", False)
ENABLE_HEALTH_SAFETY_GUARD = _env_bool("ENABLE_HEALTH_SAFETY_GUARD", True)
ENABLE_THENI_TAMIL_CONVERSION = _env_bool("ENABLE_THENI_TAMIL_CONVERSION", True)
ENABLE_SPACE_WARMUP_ON_BOOT = _env_bool("ENABLE_SPACE_WARMUP_ON_BOOT", True)
ENABLE_SPACE_HEALTHCHECK = _env_bool("ENABLE_SPACE_HEALTHCHECK", True)

REMODEL_MIN_OUTPUT_CHARS = _env_int("REMODEL_MIN_OUTPUT_CHARS", 20, minimum=1)
REMODEL_MIN_SIMILARITY_TO_RAW = _env_float("REMODEL_MIN_SIMILARITY_TO_RAW", 0.42, minimum=0.0)
MIN_TAMIL_CHAR_RATIO = _env_float("MIN_TAMIL_CHAR_RATIO", 0.18, minimum=0.0)
TRANSLATION_RETRY_ON_NON_TAMIL = _env_bool("TRANSLATION_RETRY_ON_NON_TAMIL", True)
TRANSLATION_MAX_CHUNK_CHARS = _env_int("TRANSLATION_MAX_CHUNK_CHARS", 700, minimum=120)
TRANSLATION_REFINEMENT_MAX_CHARS = _env_int("TRANSLATION_REFINEMENT_MAX_CHARS", 2200, minimum=300)
TRANSLATION_MAX_RETRIES = _env_int("TRANSLATION_MAX_RETRIES", 2, minimum=0)

TAMIL_TO_THENI_MODEL_ROOT = Path(
    _env_str("TAMIL_TO_THENI_MODEL_ROOT", str(MODELS_DIR / "stage_tamil_thenitamil_model"))
)
DIALECT_MODEL_MAX_LENGTH = _env_int("DIALECT_MODEL_MAX_LENGTH", 160, minimum=16)
DIALECT_MODEL_NUM_BEAMS = _env_int("DIALECT_MODEL_NUM_BEAMS", 5, minimum=1)

TAMIL_TO_THENI_API_URL = _env_str("TAMIL_TO_THENI_API_URL", "")
THENI_TO_TAMIL_API_URL = _env_str("THENI_TO_TAMIL_API_URL", "")
THENI_TAMIL_API_URL = _env_str("THENI_TAMIL_API_URL", TAMIL_TO_THENI_API_URL)

SPACE_REQUEST_CONNECT_TIMEOUT = _env_int("SPACE_REQUEST_CONNECT_TIMEOUT", 10, minimum=2)
SPACE_REQUEST_READ_TIMEOUT = _env_int("SPACE_REQUEST_READ_TIMEOUT", 180, minimum=10)
SPACE_HEALTHCHECK_TIMEOUT = _env_int("SPACE_HEALTHCHECK_TIMEOUT", 12, minimum=2)
SPACE_WARMUP_TIMEOUT = _env_int("SPACE_WARMUP_TIMEOUT", 240, minimum=20)
SPACE_MAX_RETRIES = _env_int("SPACE_MAX_RETRIES", 2, minimum=0)
SPACE_RETRY_BACKOFF_SECONDS = _env_float("SPACE_RETRY_BACKOFF_SECONDS", 2.5, minimum=0.1)
SPACE_WARM_STATE_TTL_SECONDS = _env_int("SPACE_WARM_STATE_TTL_SECONDS", 1800, minimum=30)

PREGNANCY_CUSTOM_AVOID_LIST = [
    "pineapple",
    "alcohol",
    "smoking",
    "tobacco",
    "unprescribed medicine",
    "crash dieting",
]

MEDICAL_SAFETY_NOTE = (
    "For pregnancy, diabetes, blood pressure, allergies, kidney issues, or other health conditions, "
    "avoid definitive medical instructions. Give cautious lifestyle guidance and suggest a clinician "
    "for diagnosis, medication, or emergency concerns."
)

HEALTH_RISK_KEYWORDS = {
    "pregnant",
    "pregnancy",
    "postpartum",
    "breastfeeding",
    "conceive",
    "fertility",
    "diabetes",
    "sugar",
    "bp",
    "blood pressure",
    "heart",
    "allergy",
    "kidney",
    "medicine",
    "tablet",
    "dose",
    "dosage",
    "emergency",
    "chest pain",
    "fainting",
}

# --------------------
# Advanced RAG configuration
# --------------------
RAG_ENABLED = _env_bool("RAG_ENABLED", True)
RAG_EMBEDDING_MODEL = _env_str("RAG_EMBEDDING_MODEL", OPENAI_EMBEDDING_MODEL)
RAG_ENABLE_FAST_RAG_SEMANTIC = _env_bool("RAG_ENABLE_FAST_RAG_SEMANTIC", True)
RAG_ENABLE_FOLLOWUP_REWRITE = _env_bool("RAG_ENABLE_FOLLOWUP_REWRITE", True)

RAG_FAST_RAG_MIN_SCORE = _env_float("RAG_FAST_RAG_MIN_SCORE", 0.86, minimum=0.0)
RAG_MIN_SCORE = _env_float("RAG_MIN_SCORE", 0.56, minimum=0.0)
RAG_TOP_K = _env_int("RAG_TOP_K", 6, minimum=1)
RAG_MAX_ITEM_CANDIDATES = _env_int("RAG_MAX_ITEM_CANDIDATES", 250, minimum=20)
RAG_MAX_CONVERSATION_CANDIDATES = _env_int("RAG_MAX_CONVERSATION_CANDIDATES", 80, minimum=10)
RAG_MAX_CACHE_CANDIDATES = _env_int("RAG_MAX_CACHE_CANDIDATES", 60, minimum=10)
RAG_MAX_CONTEXT_CHARS = _env_int("RAG_MAX_CONTEXT_CHARS", 3200, minimum=800)
RAG_RECENCY_HALF_LIFE_DAYS = _env_float("RAG_RECENCY_HALF_LIFE_DAYS", 14.0, minimum=0.1)
RAG_EMBED_CACHE_SIZE = _env_int("RAG_EMBED_CACHE_SIZE", 4096, minimum=256)

# Stage-pipeline RAG injection controls
RAG_CONTEXT_INCLUDE_IN_STAGE_CONTEXT = _env_bool("RAG_CONTEXT_INCLUDE_IN_STAGE_CONTEXT", True)
RAG_CONTEXT_HEADER = _env_str("RAG_CONTEXT_HEADER", "Relevant user memory and knowledge:")
RAG_CONTEXT_MAX_SNIPPETS = _env_int("RAG_CONTEXT_MAX_SNIPPETS", 6, minimum=1)

# --------------------
# Agentic architecture feature flags
# --------------------
AGENTIC_MODE_ENABLED = _env_bool("AGENTIC_MODE_ENABLED", True)
PROFILER_AGENT_ENABLED = _env_bool("PROFILER_AGENT_ENABLED", True)
ORCHESTRATOR_AGENT_ENABLED = _env_bool("ORCHESTRATOR_AGENT_ENABLED", True)
ALIGNMENT_AGENT_ENABLED = _env_bool("ALIGNMENT_AGENT_ENABLED", True)
MEMORY_AGENT_ENABLED = _env_bool("MEMORY_AGENT_ENABLED", True)
