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


def _ensure_dirs(paths: Iterable[Path]) -> None:
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


_ensure_dirs((DATA_DIR, PROFILES_DIR, LOGS_DIR, MODELS_DIR))


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

PIPELINE_VERSION = _env_str("PIPELINE_VERSION", "ai_tool_stage_merge_v1")
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