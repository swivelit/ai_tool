from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Optional

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PROFILES_DIR = DATA_DIR / "profiles"
LOGS_DIR = DATA_DIR / "logs"
MODELS_DIR = BASE_DIR / "models"
CLASSIFIER_DATASET_PATH = DATA_DIR / "classifier_dataset.csv"
FAST_RAG_DATASET_PATH = DATA_DIR / "fast_rag_replies.csv"
PIPELINE_QUESTIONS_CSV_PATH = DATA_DIR / "pipeline_questions.csv"
GENERATED_DOCS_DIR = DATA_DIR / "generated_docs"


def _ensure_dirs(paths: Iterable[Path]) -> None:
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


_ensure_dirs((DATA_DIR, PROFILES_DIR, LOGS_DIR, MODELS_DIR, GENERATED_DOCS_DIR))


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
OPENAI_MODEL = _env_str("OPENAI_MODEL", "gpt-4.1-mini")
OPENAI_TIMEOUT = _env_int("OPENAI_TIMEOUT", 60, minimum=5)
OPENAI_MAX_RETRIES = _env_int("OPENAI_MAX_RETRIES", 3, minimum=1)
OPENAI_BACKOFF_BASE_SECONDS = _env_float("OPENAI_BACKOFF_BASE_SECONDS", 0.8, minimum=0.1)
OPENAI_CACHE_SIZE = _env_int("OPENAI_CACHE_SIZE", 128, minimum=8)
OPENAI_JSON_REPAIR_ATTEMPTS = _env_int("OPENAI_JSON_REPAIR_ATTEMPTS", 1, minimum=0)

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
RAG_EMBEDDING_MODEL = _env_str("RAG_EMBEDDING_MODEL", "text-embedding-3-small")
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