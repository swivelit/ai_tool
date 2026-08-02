from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, inspect, or_, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlmodel import Session, select

from .models import GlobalQACache, GlobalQAObservation, GlobalQATombstone, QACache
from .openai_model_router import stable_user_hash
from .openai_tracked import cached_text_embedding
from .time_utils import utc_now
from .vector_store import get_vector_store

logger = logging.getLogger(__name__)
_SCHEMA_COMPAT_LOCK = threading.Lock()
_SCHEMA_COMPAT_READY = False
REQUIRED_GLOBAL_QA_TABLES = (
    "global_qa_cache",
    "global_qa_observation",
    "global_qa_tombstone",
    "openai_usage_log",
)

_TOKEN_RE = re.compile(r"[\w\u0B80-\u0BFF]+", re.UNICODE)
BAD_CACHED_ANSWER_RE = re.compile(
    r"("
    r"I could not fetch a reliable web result|"
    r"I could not complete the web lookup|"
    r"I could not fetch the weather right now|"
    r"Internal Server Error|"
    r"OpenAI provider/configuration error|"
    r"requires OPENAI_API_KEY|"
    r"local_timeout|"
    r"You do not have any tomorrow reminders|"
    r"You do not have any reminders scheduled for tomorrow"
    r")",
    re.IGNORECASE,
)
_LIVE_TERMS = {
    "latest",
    "today",
    "current",
    "live",
    "score",
    "scores",
    "news",
    "breaking",
    "now",
    "new",
    "recent",
    "update",
    "updates",
    "election",
    "elections",
    "vote",
    "voting",
    "poll",
    "polls",
    "weather",
    "forecast",
    "tomorrow",
    "yesterday",
    "tonight",
    "result",
    "results",
    "playing",
    "match",
    "fixture",
    "fixtures",
    "schedule",
    "price",
    "prices",
    "rate",
    "rates",
    "stock",
    "stocks",
    "crypto",
    "nearby",
    "best",
    "cheapest",
    "deal",
    "deals",
    "offer",
    "offers",
    "discount",
    "discounts",
    "winner",
    "candidate",
    "candidates",
    "government",
    "president",
    "prime",
    "minister",
    "pm",
    "cm",
    "mla",
    "mp",
}
_LIVE_PHRASES = {
    "exchange rate",
    "gold rate",
    "petrol price",
    "near me",
    "prime minister",
}
GLOBAL_QA_EMBEDDING_KIND = "token_hash_v1"
GLOBAL_QA_QWEN_EMBEDDING_KIND = "qwen3_embedding_0_6b"
_GLOBAL_SCOPE = "global"
_USER_SCOPE = "user"
_ALIAS_MAP = {
    "ipl": "indian premier league",
    "ai": "artificial intelligence",
    "bp": "blood pressure",
}
_STOPWORDS = {
    "a",
    "an",
    "and",
    "about",
    "are",
    "can",
    "could",
    "do",
    "does",
    "explain",
    "for",
    "give",
    "how",
    "i",
    "is",
    "know",
    "me",
    "of",
    "please",
    "tell",
    "the",
    "to",
    "what",
    "whats",
    "why",
    "you",
}
_PRIVATE_PATTERNS = [
    re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
    re.compile(r"(?i)(?<!\d)(?:\+?91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}(?!\d)"),
    re.compile(r"(?i)\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"),  # Aadhaar-like 12 digit ID
    re.compile(r"(?i)\b(?:\d[ -]*?){13,19}\b"),  # bank/card-like long number
    re.compile(r"(?i)\b[a-z0-9._-]{2,}@[a-z]{2,}\b"),  # UPI-like IDs such as name@okicici
    re.compile(r"(?i)\b(?:otp|one[-\s]?time\s+password|password|passcode|pin)\b"),
    re.compile(r"(?i)\b(?:account\s+number|ifsc|credit\s+card|debit\s+card|upi\s+id|aadhaar|ssn)\b"),
    re.compile(r"(?i)\b(?:my|our)\s+(?:email|phone|mobile|address|password|otp|account|bank|card|upi|aadhaar|ssn|salary|income|ctc|pay)\b"),
    re.compile(r"(?i)\b(?:my\s+name\s+is|i\s+am\s+from|i\s+live\s+at|my\s+address\s+is|remember\s+that)\b"),
    re.compile(r"(?i)\b\d{1,5}\s+[A-Za-z0-9 .'-]{2,}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|nagar|colony|layout)\b"),
]
_PERSONAL_PRONOUN_RE = re.compile(r"(?i)\b(i|me|my|mine|we|our|ours)\b")
_OWNER_CONTEXT_PATTERN = re.compile(
    r"(?i)\b(?:saved\s+memory|saved\s+preferences?|reply\s+style|"
    r"user\s+preferences?|my\s+preferences?|my\s+profile|saved\s+profile|"
    r"(?:user|account)\s+profile|(?:my|user)\s+settings?|"
    r"what\s+do\s+you\s+know\s+about\s+me|what\s+did\s+i\s+tell\s+you|"
    r"what\s+do\s+you\s+remember\s+about\s+me|"
    r"what\s+reply\s+style\s+do\s+i\s+prefer|"
    r"how\s+do\s+i\s+prefer\s+you\s+to\s+answer|"
    r"do\s+you\s+remember\s+my|my\s+(?:current\s+)?project)\b"
)
_MEDICAL_TERMS = {
    "medical",
    "medicine",
    "medication",
    "tablet",
    "dose",
    "dosage",
    "doctor",
    "surgery",
    "symptom",
    "symptoms",
    "diagnosis",
    "treatment",
    "pregnant",
    "pregnancy",
    "pain",
    "fistula",
    "diabetes",
    "bp",
    "blood",
    "heart",
}
_LEGAL_TERMS = {"legal", "law", "lawyer", "court", "case", "contract", "sue", "lawsuit"}
_FINANCIAL_TERMS = {"finance", "financial", "invest", "investment", "stock", "loan", "tax", "insurance", "money"}
_SALARY_TERMS = {"salary", "income", "ctc", "pay", "bonus", "compensation", "earn", "earning"}
_ADVICE_TERMS = {"should", "can", "take", "choose", "recommend", "advice", "best", "plan", "treat", "diagnose"}


class _InProcessHotCache:
    def __init__(self, max_size: int = 2048) -> None:
        self.max_size = max(32, int(max_size or 2048))
        self._lock = threading.Lock()
        self._rows: "OrderedDict[str, Tuple[float, Dict[str, Any]]]" = OrderedDict()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with self._lock:
            item = self._rows.get(key)
            if item is None:
                return None
            expires_at, payload = item
            if expires_at <= now:
                self._rows.pop(key, None)
                return None
            self._rows.move_to_end(key)
            return dict(payload)

    def set(self, key: str, payload: Dict[str, Any], ttl_seconds: int) -> None:
        ttl = max(1, int(ttl_seconds or 1))
        with self._lock:
            self._rows[key] = (time.time() + ttl, dict(payload))
            self._rows.move_to_end(key)
            while len(self._rows) > self.max_size:
                self._rows.popitem(last=False)

    def delete(self, key: str) -> None:
        with self._lock:
            self._rows.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._rows.clear()


class _RedisHotCache:
    def __init__(self, url: str) -> None:
        import redis  # type: ignore

        self._client = redis.Redis.from_url(url, decode_responses=True)

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        raw = self._client.get(key)
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None

    def set(self, key: str, payload: Dict[str, Any], ttl_seconds: int) -> None:
        self._client.setex(key, max(1, int(ttl_seconds or 1)), json.dumps(payload, ensure_ascii=False))

    def delete(self, key: str) -> None:
        self._client.delete(key)

    def clear(self) -> None:
        # Used only by tests/debug. Avoid KEYS in production Redis.
        return None


_HOT_CACHE: Any = None
_HOT_CACHE_LOCK = threading.Lock()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        parsed = int(str(os.getenv(name, default)).strip())
    except Exception:
        parsed = int(default)
    return max(minimum, parsed)


def _env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    try:
        parsed = float(str(os.getenv(name, default)).strip())
    except Exception:
        parsed = float(default)
    return max(minimum, parsed)


def _enabled() -> bool:
    return _env_bool("GLOBAL_QA_CACHE_ENABLED", False)


def _semantic_enabled() -> bool:
    return _env_bool("GLOBAL_QA_SEMANTIC_ENABLED", False)


def _row_scope(row: GlobalQACache) -> str:
    scope = str(getattr(row, "scope", "") or "").strip().lower()
    return _USER_SCOPE if scope == _USER_SCOPE else _GLOBAL_SCOPE


def _hot_cache_ttl_seconds() -> int:
    return _env_int("GLOBAL_QA_HOT_CACHE_TTL_SECONDS", 3600, minimum=1)


def _hot_cache() -> Any:
    global _HOT_CACHE
    if _HOT_CACHE is not None:
        return _HOT_CACHE
    with _HOT_CACHE_LOCK:
        if _HOT_CACHE is not None:
            return _HOT_CACHE
        redis_url = str(os.getenv("REDIS_URL") or "").strip()
        if redis_url:
            try:
                _HOT_CACHE = _RedisHotCache(redis_url)
                return _HOT_CACHE
            except Exception as exc:
                logger.warning(
                    "global_qa_redis_hot_cache_unavailable",
                    extra={
                        "event": "global_qa_redis_hot_cache_unavailable",
                        "error_type": exc.__class__.__name__,
                    },
                )
        _HOT_CACHE = _InProcessHotCache(_env_int("GLOBAL_QA_HOT_CACHE_MAX_SIZE", 2048, minimum=32))
        return _HOT_CACHE


def reset_global_qa_hot_cache_for_tests() -> None:
    global _HOT_CACHE
    with _HOT_CACHE_LOCK:
        if _HOT_CACHE is not None:
            try:
                _HOT_CACHE.clear()
            except Exception:
                pass
        _HOT_CACHE = None


def _hot_question_hash(normalized_question: str) -> str:
    return hashlib.sha256(str(normalized_question or "").encode("utf-8")).hexdigest()


def _hot_key(*, scope: str, normalized_question: str, language: str = "*", user_id_hash: Optional[str] = None) -> str:
    scope = _USER_SCOPE if str(scope or "").lower() == _USER_SCOPE else _GLOBAL_SCOPE
    user_part = user_id_hash or "-"
    lang = str(language or "*").strip().lower() or "*"
    return f"gqa:v1:{scope}:{lang}:{user_part}:{_hot_question_hash(normalized_question)}"


def _hot_lookup_languages(language: Optional[str]) -> List[str]:
    languages = []
    if language:
        languages.append(language)
    languages.extend(["en", "*"])
    deduped_languages: List[str] = []
    seen_langs = set()
    for lang in languages:
        key = str(lang or "*").strip().lower() or "*"
        if key not in seen_langs:
            seen_langs.add(key)
            deduped_languages.append(key)
    return deduped_languages


def _hot_lookup_keys_for_scope(
    question: str,
    language: Optional[str],
    *,
    scope: str,
    user_id_hash: Optional[str] = None,
) -> List[str]:
    normalized = normalize_question(question)
    if not normalized:
        return []
    scope = _USER_SCOPE if str(scope or "").strip().lower() == _USER_SCOPE else _GLOBAL_SCOPE
    languages = _hot_lookup_languages(language)
    if scope == _USER_SCOPE:
        if not user_id_hash:
            return []
        return [
            _hot_key(scope=_USER_SCOPE, normalized_question=normalized, language=lang, user_id_hash=user_id_hash)
            for lang in languages
        ]
    return [
        _hot_key(scope=_GLOBAL_SCOPE, normalized_question=normalized, language=lang)
        for lang in languages
    ]


def _hot_lookup_keys(question: str, language: Optional[str], user_id_hash: Optional[str]) -> List[str]:
    keys: List[str] = []
    keys.extend(_hot_lookup_keys_for_scope(question, language, scope=_USER_SCOPE, user_id_hash=user_id_hash))
    keys.extend(_hot_lookup_keys_for_scope(question, language, scope=_GLOBAL_SCOPE))
    return keys


def _hot_payload_for_row(row: GlobalQACache, source: str) -> Dict[str, Any]:
    return {
        "id": int(row.id) if row.id is not None else None,
        "scope": _row_scope(row),
        "user_id_hash": getattr(row, "user_id_hash", None),
        "answer_hash": row.answer_hash,
        "cache_hit_source": source,
    }


def _cache_hit_source_for_row(row: GlobalQACache) -> str:
    return "L2_user_global_qa" if _row_scope(row) == _USER_SCOPE else "L3_global_qa"


def _populate_hot_cache_for_row(row: GlobalQACache) -> None:
    if row.id is None or row.status != "approved" or not _not_expired(row):
        return
    if row.safety_label in {"private", "personal_high_risk", "unsafe"}:
        return
    scope = _row_scope(row)
    user_hash = str(getattr(row, "user_id_hash", "") or "").strip() or None
    if scope == _USER_SCOPE and not user_hash:
        return
    payload = _hot_payload_for_row(row, _cache_hit_source_for_row(row))
    languages = {str(row.answer_language or "en").strip().lower() or "en", "*"}
    cache = _hot_cache()
    for variant in _row_question_variants(row):
        for language in languages:
            try:
                cache.set(
                    _hot_key(scope=scope, normalized_question=variant, language=language, user_id_hash=user_hash),
                    payload,
                    _hot_cache_ttl_seconds(),
                )
            except Exception:
                return


def _invalidate_hot_cache_for_row(row: GlobalQACache) -> None:
    scope = _row_scope(row)
    user_hash = str(getattr(row, "user_id_hash", "") or "").strip() or None
    languages = {str(row.answer_language or "en").strip().lower() or "en", "*"}
    cache = _hot_cache()
    for variant in _row_question_variants(row):
        for language in languages:
            try:
                cache.delete(_hot_key(scope=scope, normalized_question=variant, language=language, user_id_hash=user_hash))
            except Exception:
                return


def global_qa_schema_ready(session: Session) -> dict:
    try:
        inspector = inspect(session.get_bind())
        missing_tables = [
            table_name
            for table_name in REQUIRED_GLOBAL_QA_TABLES
            if not inspector.has_table(table_name)
        ]
        return {"ok": not missing_tables, "missing_tables": missing_tables}
    except Exception as exc:
        logger.warning(
            "global_qa_schema_readiness_failed",
            extra={
                "event": "global_qa_schema_readiness_failed",
                "error_type": exc.__class__.__name__,
                "error_message": str(exc)[:240],
            },
        )
        return {"ok": False, "missing_tables": list(REQUIRED_GLOBAL_QA_TABLES)}


def _schema_not_ready_payload(missing_tables: Optional[List[str]] = None) -> dict:
    return {
        "ok": False,
        "schemaReady": False,
        "entries": [],
        "userEntries": [],
        "revokedIds": [],
        "revocations": [],
        "hasMore": False,
        "count": 0,
        "error": "global_qa_schema_not_ready",
        "missingTables": list(missing_tables or []),
    }


def _ensure_schema_compat(session: Session) -> None:
    global _SCHEMA_COMPAT_READY
    if _SCHEMA_COMPAT_READY:
        return
    with _SCHEMA_COMPAT_LOCK:
        if _SCHEMA_COMPAT_READY:
            return
        bind = session.get_bind()
        inspector = inspect(bind)
        if inspector.has_table("global_qa_cache"):
            cache_columns = {column["name"] for column in inspector.get_columns("global_qa_cache")}
            if "scope" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN scope VARCHAR NOT NULL DEFAULT 'global'"))
            if "user_id_hash" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN user_id_hash VARCHAR"))
            if "embedding_kind" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN embedding_kind VARCHAR NOT NULL DEFAULT 'token_hash_v1'"))
            if "token_hash_embedding_json" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN token_hash_embedding_json VARCHAR"))
            if "token_hash_embedding_norm" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN token_hash_embedding_norm FLOAT NOT NULL DEFAULT 0.0"))
            if "real_embedding_json" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN real_embedding_json VARCHAR"))
            if "real_embedding_norm" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN real_embedding_norm FLOAT NOT NULL DEFAULT 0.0"))
            if "real_embedding_kind" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN real_embedding_kind VARCHAR"))
            if "confidence" not in cache_columns:
                session.exec(
                    text(
                        "ALTER TABLE global_qa_cache ADD COLUMN confidence FLOAT "
                        "NOT NULL DEFAULT 0.0"
                    )
                )
            if "observed_safe_questions_json" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN observed_safe_questions_json VARCHAR NOT NULL DEFAULT '[]'"))
            if "aliases_json" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN aliases_json VARCHAR NOT NULL DEFAULT '[]'"))
            for index_name, columns in {
                "ix_global_qa_cache_scope": "scope",
                "ix_global_qa_cache_user_id_hash": "user_id_hash",
                "ix_global_qa_cache_real_embedding_kind": "real_embedding_kind",
            }.items():
                try:
                    session.exec(text(f"CREATE INDEX IF NOT EXISTS {index_name} ON global_qa_cache ({columns})"))
                except Exception:
                    pass
        if not inspector.has_table("global_qa_tombstone"):
            GlobalQATombstone.__table__.create(bind, checkfirst=True)
        if inspector.has_table("global_qa_observation"):
            observation_columns = {column["name"] for column in inspector.get_columns("global_qa_observation")}
            if "answer_similarity_score" not in observation_columns:
                session.exec(text("ALTER TABLE global_qa_observation ADD COLUMN answer_similarity_score FLOAT NOT NULL DEFAULT 1.0"))
            if "conflicting_answer_hashes_json" not in observation_columns:
                session.exec(text("ALTER TABLE global_qa_observation ADD COLUMN conflicting_answer_hashes_json VARCHAR NOT NULL DEFAULT '[]'"))
        if inspector.has_table("ai_usage_events"):
            usage_columns = {column["name"] for column in inspector.get_columns("ai_usage_events")}
            if "cache_hit_source" not in usage_columns:
                session.exec(text("ALTER TABLE ai_usage_events ADD COLUMN cache_hit_source VARCHAR"))
            try:
                session.exec(text("CREATE INDEX IF NOT EXISTS ix_ai_usage_events_cache_hit_source ON ai_usage_events (cache_hit_source)"))
            except Exception:
                pass
        session.commit()
        _SCHEMA_COMPAT_READY = True


def _min_similarity() -> float:
    return min(1.0, _env_float("GLOBAL_QA_MIN_SIMILARITY", 0.90, minimum=0.0))


def _promote_hits() -> int:
    return _env_int("GLOBAL_QA_PROMOTE_HITS", 2, minimum=1)


def _require_distinct_users() -> bool:
    return _env_bool("GLOBAL_QA_REQUIRE_DISTINCT_USERS", True)


def _ttl_days() -> int:
    return _env_int("GLOBAL_QA_TTL_DAYS", 180, minimum=1)


def normalize_question(text: str) -> str:
    lowered = str(text or "").lower()
    lowered = re.sub(r"[^\w\s\u0B80-\u0BFF]", " ", lowered, flags=re.UNICODE)
    return re.sub(r"\s+", " ", lowered).strip()


def _load_json_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    out: List[str] = []
    seen = set()
    for item in parsed:
        value = str(item or "").strip()
        if not value:
            continue
        key = normalize_question(value)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _dump_json_list(values: List[str], *, max_items: int = 50) -> str:
    out: List[str] = []
    seen = set()
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        key = normalize_question(text)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return json.dumps(out[-max_items:], ensure_ascii=False)


def _semantic_tokens(text: str) -> List[str]:
    tokens: List[str] = []
    seen = set()
    for raw in _TOKEN_RE.findall(normalize_question(text)):
        token = raw.strip().lower()
        if not token or token in _STOPWORDS:
            continue
        if len(token) > 4 and token.endswith("s"):
            token = token[:-1]
        if token and token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens


def question_hash(text: str) -> str:
    return hashlib.sha256(normalize_question(text).encode("utf-8")).hexdigest()


def answer_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _alias_variants(text: str) -> List[str]:
    normalized = normalize_question(text)
    if not normalized:
        return []
    variants: List[str] = []
    for short, expanded in _ALIAS_MAP.items():
        if re.search(rf"\b{re.escape(short)}\b", normalized):
            variants.append(re.sub(rf"\b{re.escape(short)}\b", expanded, normalized))
        if re.search(rf"\b{re.escape(expanded)}\b", normalized):
            variants.append(re.sub(rf"\b{re.escape(expanded)}\b", short, normalized))
    return [variant for variant in variants if variant and variant != normalized]


def _safe_question_variant(text: str) -> Optional[str]:
    raw = str(text or "").strip()
    if not raw:
        return None
    redacted = redact_sensitive_text(raw)
    if _redaction_changed_meaning(raw, redacted):
        return None
    normalized = normalize_question(redacted)
    if not normalized:
        return None
    if is_live_or_current_question(normalized) or is_private_or_personal_question(normalized):
        return None
    return normalized


def _safe_aliases_for_question(text: str) -> List[str]:
    aliases: List[str] = []
    for variant in _alias_variants(text):
        safe = _safe_question_variant(variant)
        if safe:
            aliases.append(safe)
    return aliases


def _row_question_variants(row: GlobalQACache) -> List[str]:
    values = [
        str(row.canonical_question or ""),
        str(row.normalized_question or ""),
        *_load_json_list(getattr(row, "observed_safe_questions_json", "[]")),
        *_load_json_list(getattr(row, "aliases_json", "[]")),
    ]
    values.extend(_alias_variants(row.canonical_question))
    values.extend(_alias_variants(row.normalized_question))
    safe_values: List[str] = []
    seen = set()
    for value in values:
        safe = _safe_question_variant(value)
        if not safe or safe in seen:
            continue
        seen.add(safe)
        safe_values.append(safe)
    return safe_values


def redact_sensitive_text(text: str) -> str:
    redacted = str(text or "")
    redacted = re.sub(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[REDACTED_EMAIL]", redacted)
    redacted = re.sub(r"(?i)(?<!\d)(?:\+?91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}(?!\d)", "[REDACTED_PHONE]", redacted)
    redacted = re.sub(r"(?i)\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b", "[REDACTED_ID]", redacted)
    redacted = re.sub(r"(?i)\b(?:\d[ -]*?){13,19}\b", "[REDACTED_CARD]", redacted)
    redacted = re.sub(r"(?i)\b[a-z0-9._-]{2,}@[a-z]{2,}\b", "[REDACTED_UPI]", redacted)
    redacted = re.sub(r"(?i)\b(?:bearer|token|password|otp|passcode|pin)\s*[:=]?\s+[A-Za-z0-9._~+/=-]+", "[REDACTED_SECRET]", redacted)
    redacted = re.sub(r"(?i)\b\d{1,5}\s+[A-Za-z0-9 .'-]{2,}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|nagar|colony|layout)\b", "[REDACTED_ADDRESS]", redacted)
    return redacted.strip()


def _redaction_changed_meaning(original: str, redacted: str) -> bool:
    if str(original or "").strip() == str(redacted or "").strip():
        return False
    original_tokens = {token for token in _semantic_tokens(original) if not token.startswith("redacted")}
    redacted_tokens = {token for token in _semantic_tokens(redacted) if not token.startswith("redacted")}
    if not original_tokens:
        return True
    retained = len(original_tokens & redacted_tokens) / max(1, len(original_tokens))
    return retained < 0.75


def is_live_or_current_question(text: str) -> bool:
    normalized = normalize_question(text)
    if not normalized:
        return False
    if any(re.search(rf"\b{re.escape(phrase)}\b", normalized) for phrase in _LIVE_PHRASES):
        return True
    tokens = set(_TOKEN_RE.findall(normalized))
    return bool(tokens & _LIVE_TERMS)


def is_private_or_personal_question(text: str) -> bool:
    raw = str(text or "")
    if any(pattern.search(raw) for pattern in _PRIVATE_PATTERNS):
        return True
    if _OWNER_CONTEXT_PATTERN.search(raw):
        return True
    normalized = normalize_question(raw)
    tokens = set(_semantic_tokens(normalized))
    personal = bool(_PERSONAL_PRONOUN_RE.search(normalized))
    if re.search(r"\b(my|our)\s+(?:health|body|symptoms|medical|legal|money|bank|tax|salary|income|ctc|pay|case|loan|investment)\b", normalized):
        return True
    if personal and tokens & _SALARY_TERMS:
        return True
    if personal and tokens & _MEDICAL_TERMS and (
        tokens & _ADVICE_TERMS
        or re.search(r"\b(?:i\s+(?:have|feel|am|was|got|suffer|suffering)|my\s+(?:pain|symptoms?|body|health))\b", normalized)
    ):
        return True
    if personal and tokens & (_LEGAL_TERMS | _FINANCIAL_TERMS) and (
        tokens & _ADVICE_TERMS
        or re.search(r"\b(?:my\s+(?:case|contract|loan|tax|investment)|should\s+i|can\s+i)\b", normalized)
    ):
        return True
    return False


def is_high_risk_personal_advice(text: str, answer: str) -> bool:
    normalized = normalize_question(text)
    tokens = set(_semantic_tokens(normalized))
    personal = bool(_PERSONAL_PRONOUN_RE.search(normalized))
    high_risk_domain = bool(tokens & (_MEDICAL_TERMS | _LEGAL_TERMS | _FINANCIAL_TERMS))
    advice_requested = bool(tokens & _ADVICE_TERMS) or bool(re.search(r"\bwhat\s+should\s+i\b|\bcan\s+i\b", normalized))
    if personal and high_risk_domain and advice_requested:
        return True
    answer_text = normalize_question(answer)
    if personal and high_risk_domain and re.search(r"\bdiagnos|prescri|dosage|legal advice|financial advice\b", answer_text):
        return True
    return False


def is_cacheable_global_question(question: str, answer: str) -> bool:
    q = str(question or "").strip()
    a = str(answer or "").strip()
    if not q or not a or len(a) < 8:
        return False
    if is_live_or_current_question(q):
        return False
    if is_private_or_personal_question(q):
        return False
    if is_high_risk_personal_advice(q, a):
        return False
    return True


def _hash_embedding(tokens: List[str], dims: int = 96) -> List[float]:
    vec = [0.0] * dims
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:2], "big") % dims
        sign = 1.0 if digest[2] % 2 == 0 else -1.0
        vec[index] += sign
    return vec


def _vector_norm(vec: List[float]) -> float:
    return math.sqrt(sum(float(x) * float(x) for x in vec)) if vec else 0.0


def _coerce_embedding_vector(value: Any) -> List[float]:
    if not isinstance(value, list):
        return []
    vec: List[float] = []
    for item in value:
        try:
            number = float(item)
        except Exception:
            return []
        if not math.isfinite(number):
            return []
        vec.append(number)
    return vec


def token_hash_embedding_for_global_cache(text: str) -> Tuple[List[float], float, str]:
    tokens = _semantic_tokens(text)
    vec = _hash_embedding(tokens)
    return vec, _vector_norm(vec), GLOBAL_QA_EMBEDDING_KIND


def _real_embedding_kind_for_provider(provider: str, model: str) -> str:
    provider = str(provider or "").strip().lower()
    model = str(model or "").strip()
    if provider == "qwen_http" or "qwen3-embedding-0.6b" in model.lower():
        return GLOBAL_QA_QWEN_EMBEDDING_KIND
    if provider == "openai":
        return f"openai:{model or 'text-embedding-3-small'}"
    return f"{provider}:{model}" if model else provider


def _parse_embedding_response(payload: Any) -> List[float]:
    if isinstance(payload, dict):
        if isinstance(payload.get("embedding"), list):
            return _coerce_embedding_vector(payload.get("embedding"))
        data = payload.get("data")
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                return _coerce_embedding_vector(first.get("embedding"))
            emb = getattr(first, "embedding", None)
            return _coerce_embedding_vector(emb)
        if isinstance(payload.get("embeddings"), list) and payload["embeddings"]:
            first = payload["embeddings"][0]
            return _coerce_embedding_vector(first)
    embedding = getattr(payload, "embedding", None)
    if embedding is not None:
        return _coerce_embedding_vector(embedding)
    data = getattr(payload, "data", None)
    if data:
        first = data[0]
        return _coerce_embedding_vector(getattr(first, "embedding", None))
    return []


def _qwen_http_embedding(text: str, url: str, model: str) -> List[float]:
    body = json.dumps({"model": model, "input": text, "texts": [text]}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    timeout = _env_float("GLOBAL_QA_QWEN_EMBEDDING_TIMEOUT_SECONDS", 3.0, minimum=0.1)
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - configured internal URL only.
        payload = json.loads(response.read().decode("utf-8"))
    return _parse_embedding_response(payload)


def _openai_embedding(text: str, model: str) -> List[float]:
    api_key = str(os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return []
    try:
        from openai import OpenAI  # type: ignore
    except Exception:
        return []
    client = OpenAI(api_key=api_key)
    response = client.embeddings.create(model=model or "text-embedding-3-small", input=[text])
    return _parse_embedding_response(response)


def real_embedding_for_global_cache(text: str) -> Optional[Tuple[List[float], float, str]]:
    if _semantic_enabled():
        vec = cached_text_embedding(text, route="global_qa_semantic")
        if vec:
            return vec, _vector_norm(vec), "openai:text-embedding-3-small"
    if not _env_bool("GLOBAL_QA_REAL_EMBEDDINGS_ENABLED", False):
        return None
    provider = str(os.getenv("GLOBAL_QA_EMBEDDING_PROVIDER") or "token_hash").strip().lower()
    model = str(os.getenv("GLOBAL_QA_EMBEDDING_MODEL") or "").strip()
    if provider in {"", "token_hash", "token_hash_v1"}:
        return None
    try:
        if provider == "qwen_http":
            url = str(os.getenv("GLOBAL_QA_QWEN_EMBEDDING_URL") or "").strip()
            if not url:
                return None
            vec = _qwen_http_embedding(text, url, model or "Qwen/Qwen3-Embedding-0.6B")
        elif provider == "openai":
            vec = _openai_embedding(text, model or "text-embedding-3-small")
        else:
            return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, TypeError, RuntimeError):
        return None
    if not vec:
        return None
    return vec, _vector_norm(vec), _real_embedding_kind_for_provider(provider, model)


def embedding_bundle_for_global_cache(text: str) -> Dict[str, Any]:
    token_vec, token_norm, token_kind = token_hash_embedding_for_global_cache(text)
    real = real_embedding_for_global_cache(text)
    active_vec, active_norm, active_kind = real if real is not None else (token_vec, token_norm, token_kind)
    return {
        "embedding": active_vec,
        "embedding_norm": active_norm,
        "embedding_kind": active_kind,
        "token_hash_embedding": token_vec,
        "token_hash_embedding_norm": token_norm,
        "token_hash_embedding_kind": token_kind,
        "real_embedding": real[0] if real is not None else [],
        "real_embedding_norm": real[1] if real is not None else 0.0,
        "real_embedding_kind": real[2] if real is not None else None,
    }


def embed_question_for_global_cache(text: str) -> Tuple[List[float], float]:
    bundle = embedding_bundle_for_global_cache(text)
    return list(bundle["embedding"]), float(bundle["embedding_norm"] or 0.0)


def _cosine(left: List[float], left_norm: float, right: List[float], right_norm: float) -> float:
    if not left or not right:
        return 0.0
    left_norm = left_norm or _vector_norm(left)
    right_norm = right_norm or _vector_norm(right)
    if left_norm <= 0.0 or right_norm <= 0.0:
        return 0.0
    dot = sum(float(left[i]) * float(right[i]) for i in range(min(len(left), len(right))))
    return max(0.0, min(1.0, dot / (left_norm * right_norm)))


def _token_similarity(left: str, right: str) -> float:
    left_tokens = set(_semantic_tokens(left))
    right_tokens = set(_semantic_tokens(right))
    if not left_tokens and not right_tokens:
        return 1.0
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))


def _answer_similarity(left: str, right: str) -> float:
    left_norm = normalize_question(left)
    right_norm = normalize_question(right)
    if left_norm == right_norm and left_norm:
        return 1.0
    token_score = _token_similarity(left_norm, right_norm)
    seq_score = SequenceMatcher(None, left_norm, right_norm).ratio() if left_norm and right_norm else 0.0
    return max(token_score, (token_score * 0.55) + (seq_score * 0.45), seq_score * 0.85)


def _min_answer_similarity() -> float:
    return min(1.0, _env_float("GLOBAL_QA_MIN_ANSWER_SIMILARITY", 0.62, minimum=0.0))


def _question_similarity(
    left: str,
    right: str,
    left_embedding: Optional[Tuple[List[float], float]] = None,
    right_embedding: Optional[Tuple[List[float], float]] = None,
) -> float:
    left_norm = normalize_question(left)
    right_norm = normalize_question(right)
    if left_norm == right_norm and left_norm:
        return 1.0
    token_score = _token_similarity(left_norm, right_norm)
    seq_score = SequenceMatcher(None, left_norm, right_norm).ratio() if left_norm and right_norm else 0.0
    semantic = 0.0
    if left_embedding and right_embedding:
        semantic = _cosine(left_embedding[0], left_embedding[1], right_embedding[0], right_embedding[1])
    return max(token_score, (token_score * 0.75) + (seq_score * 0.25), semantic)


def _load_embedding_json(raw: Optional[str], norm_value: Any = 0.0) -> Optional[Tuple[List[float], float]]:
    try:
        parsed = json.loads(raw or "[]")
    except Exception:
        return None
    vec = _coerce_embedding_vector(parsed)
    if not vec:
        return None
    try:
        norm = float(norm_value or 0.0)
    except Exception:
        norm = 0.0
    return vec, norm or _vector_norm(vec)


def _embedding_json_is_corrupt(raw: Optional[str]) -> bool:
    if not raw:
        return False
    try:
        parsed = json.loads(raw)
    except Exception:
        return True
    return not isinstance(parsed, list)


def _load_row_token_embedding(row: GlobalQACache) -> Optional[Tuple[List[float], float]]:
    explicit = _load_embedding_json(
        getattr(row, "token_hash_embedding_json", None),
        getattr(row, "token_hash_embedding_norm", 0.0),
    )
    if explicit is not None:
        return explicit
    if str(getattr(row, "embedding_kind", "") or GLOBAL_QA_EMBEDDING_KIND) != GLOBAL_QA_EMBEDDING_KIND:
        return None
    return _load_embedding_json(row.embedding_json, row.embedding_norm)


def _load_row_real_embedding(row: GlobalQACache) -> Optional[Tuple[List[float], float, str]]:
    kind = str(getattr(row, "real_embedding_kind", "") or "").strip()
    loaded = _load_embedding_json(getattr(row, "real_embedding_json", None), getattr(row, "real_embedding_norm", 0.0))
    if loaded is not None and kind:
        return loaded[0], loaded[1], kind
    legacy_kind = str(getattr(row, "embedding_kind", "") or "").strip()
    if legacy_kind and legacy_kind != GLOBAL_QA_EMBEDDING_KIND:
        legacy = _load_embedding_json(row.embedding_json, row.embedding_norm)
        if legacy is not None:
            return legacy[0], legacy[1], legacy_kind
    return None


def _row_embedding_for_kind(row: GlobalQACache, kind: str) -> Optional[Tuple[List[float], float]]:
    if kind == GLOBAL_QA_EMBEDDING_KIND:
        return _load_row_token_embedding(row)
    real = _load_row_real_embedding(row)
    if real is not None and real[2] == kind:
        return real[0], real[1]
    return None


def _not_expired(row: GlobalQACache, now: Optional[datetime] = None) -> bool:
    if row.expires_at is None:
        return True
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > (now or utc_now())


def _answer_language(reply_language: Optional[str]) -> Optional[str]:
    normalized = str(reply_language or "").strip().lower()
    if normalized in {"en", "english"}:
        return "en"
    if normalized in {"ta", "tamil", "mixed", "tanglish"}:
        return "ta"
    return None


def _query_embedding_bundle(question: str, query_embedding: Any = None) -> Dict[str, Any]:
    if callable(query_embedding):
        try:
            resolved = query_embedding()
        except Exception:
            resolved = None
        if resolved is not None and resolved is not query_embedding:
            return _query_embedding_bundle(question, resolved)
    if isinstance(query_embedding, dict):
        bundle = dict(query_embedding)
        if "token_hash_embedding" not in bundle:
            token_vec, token_norm, token_kind = token_hash_embedding_for_global_cache(question)
            bundle.setdefault("token_hash_embedding", token_vec)
            bundle.setdefault("token_hash_embedding_norm", token_norm)
            bundle.setdefault("token_hash_embedding_kind", token_kind)
        return bundle
    if isinstance(query_embedding, tuple) and len(query_embedding) >= 2:
        vec = _coerce_embedding_vector(list(query_embedding[0] or []))
        try:
            norm = float(query_embedding[1] or 0.0)
        except Exception:
            norm = 0.0
        tuple_kind = str(query_embedding[2] if len(query_embedding) >= 3 else GLOBAL_QA_EMBEDDING_KIND).strip() or GLOBAL_QA_EMBEDDING_KIND
        token_vec, token_norm, token_kind = token_hash_embedding_for_global_cache(question)
        bundle = {
            "embedding": vec,
            "embedding_norm": norm or _vector_norm(vec),
            "embedding_kind": tuple_kind,
            "token_hash_embedding": token_vec,
            "token_hash_embedding_norm": token_norm,
            "token_hash_embedding_kind": token_kind,
        }
        if tuple_kind != GLOBAL_QA_EMBEDDING_KIND:
            bundle["real_embedding"] = vec
            bundle["real_embedding_norm"] = norm or _vector_norm(vec)
            bundle["real_embedding_kind"] = tuple_kind
        return bundle
    return embedding_bundle_for_global_cache(question)


def _score_row_against_query(row: GlobalQACache, question: str, query_bundle: Dict[str, Any]) -> float:
    variants = _row_question_variants(row)
    if not variants:
        return 0.0
    scores: List[float] = []
    real_query = _coerce_embedding_vector(query_bundle.get("real_embedding"))
    real_kind = str(query_bundle.get("real_embedding_kind") or "").strip()
    real_query_norm = float(query_bundle.get("real_embedding_norm") or _vector_norm(real_query) or 0.0)
    token_query = _coerce_embedding_vector(query_bundle.get("token_hash_embedding"))
    token_query_norm = float(query_bundle.get("token_hash_embedding_norm") or _vector_norm(token_query) or 0.0)
    row_real = _load_row_real_embedding(row)
    row_token = _load_row_token_embedding(row)
    for variant in variants:
        lexical = _question_similarity(question, variant)
        semantic = 0.0
        if real_query and real_kind and row_real is not None and row_real[2] == real_kind:
            semantic = max(semantic, _cosine(real_query, real_query_norm, row_real[0], row_real[1]))
        if token_query and row_token is not None:
            semantic = max(semantic, _cosine(token_query, token_query_norm, row_token[0], row_token[1]))
        scores.append(max(lexical, semantic))
    return max(scores, default=0.0)


def _row_to_hit(row: GlobalQACache, score: float) -> dict:
    source = _cache_hit_source_for_row(row)
    return {
        "id": row.id,
        "answer": row.answer,
        "answer_language": row.answer_language,
        "canonical_question": row.canonical_question,
        "normalized_question": row.normalized_question,
        "similarity_score": score,
        "confidence": row.confidence,
        "answer_hash": row.answer_hash,
        "topic": row.topic,
        "scope": _row_scope(row),
        "cache_hit_source": source,
        "direct_answer_source": "global_qa_cache",
        "cache_hit_kind": "exact",
    }


def _row_lookup_safe(
    row: GlobalQACache,
    question: str,
    language: Optional[str],
    now: datetime,
    *,
    user_hash: Optional[str],
    cache_compatibility_hash: Optional[str] = None,
) -> bool:
    if row.status != "approved":
        return False
    if float(row.confidence or 0.0) <= 0.0:
        return False
    if not _not_expired(row, now):
        return False
    if BAD_CACHED_ANSWER_RE.search(str(row.answer or "")):
        return False
    if row.safety_label in {"private", "personal_high_risk", "unsafe"}:
        return False
    if language and row.answer_language not in {language, "en"}:
        return False
    if (
        cache_compatibility_hash
        and cache_compatibility_hash not in _source_hashes(row)
    ):
        return False
    scope = _row_scope(row)
    if scope == _USER_SCOPE:
        return bool(user_hash and str(getattr(row, "user_id_hash", "") or "") == user_hash)
    return scope == _GLOBAL_SCOPE


def _touch_cache_hit(session: Session, row: GlobalQACache, now: datetime) -> None:
    row.hit_count = int(row.hit_count or 0) + 1
    row.last_seen_at = now
    session.add(row)
    session.commit()
    _populate_hot_cache_for_row(row)


def _semantic_vector_lookup(
    session: Session,
    question: str,
    language: Optional[str],
    user_hash: Optional[str],
    now: datetime,
    *,
    scope: str,
    cache_compatibility_hash: Optional[str] = None,
) -> Optional[dict]:
    query_vector = cached_text_embedding(question, route="global_qa_semantic_query")
    if not query_vector:
        return None
    results = get_vector_store().search(
        session,
        user_id=None,
        query_embedding=query_vector,
        limit=50,
        source_types=["global_qa"],
    )
    candidates: list[tuple[GlobalQACache, float]] = []
    query_embedding = (query_vector, _vector_norm(query_vector))
    for result in results:
        if len(candidates) >= 5:
            break
        try:
            row = session.get(GlobalQACache, int(result.get("source_id") or 0))
        except (TypeError, ValueError):
            row = None
        if row is None or _row_scope(row) != scope:
            continue
        if not _row_lookup_safe(
            row, question, language, now, user_hash=user_hash,
            cache_compatibility_hash=cache_compatibility_hash,
        ):
            continue
        row_real = _load_row_real_embedding(row)
        if row_real is None:
            continue
        similarity = _question_similarity(
            question,
            row.canonical_question,
            query_embedding,
            (row_real[0], row_real[1]),
        )
        if similarity >= _min_similarity():
            candidates.append((row, similarity))
    if not candidates:
        return None
    row, score = max(candidates, key=lambda item: item[1])
    _touch_cache_hit(session, row, now)
    hit = _row_to_hit(row, score)
    hit["cache_hit_kind"] = "semantic"
    return hit


def _semantic_lookup_after_exact_miss(
    session: Session,
    question: str,
    language: Optional[str],
    user_hash: Optional[str],
    now: datetime,
    *,
    cache_compatibility_hash: Optional[str] = None,
) -> Optional[dict]:
    normalized = normalize_question(question)
    scopes = [(_USER_SCOPE, user_hash)] if user_hash else []
    scopes.append((_GLOBAL_SCOPE, None))
    # Exhaust owner-scoped and global database exact matches before paying for
    # a semantic query embedding or touching the vector store.
    for scope, required_hash in scopes:
        statement = (
            select(GlobalQACache)
            .where(GlobalQACache.status == "approved")
            .where(GlobalQACache.normalized_question == normalized)
        )
        if scope == _USER_SCOPE:
            statement = statement.where(
                GlobalQACache.scope == _USER_SCOPE,
                GlobalQACache.user_id_hash == required_hash,
            )
        else:
            statement = statement.where(
                or_(GlobalQACache.scope == _GLOBAL_SCOPE, GlobalQACache.scope == None)  # noqa: E711
            )
        exact = session.exec(statement.order_by(GlobalQACache.updated_at.desc())).first()
        if exact is not None and _row_lookup_safe(
            exact, question, language, now, user_hash=user_hash,
            cache_compatibility_hash=cache_compatibility_hash,
        ):
            _touch_cache_hit(session, exact, now)
            return _row_to_hit(exact, 1.0)
    for scope, _required_hash in scopes:
        semantic = _semantic_vector_lookup(
            session,
            question,
            language,
            user_hash,
            now,
            scope=scope,
            cache_compatibility_hash=cache_compatibility_hash,
        )
        if semantic is not None:
            return semantic
    return None


def _upsert_vector_for_row(session: Session, row: GlobalQACache) -> None:
    if row.id is None:
        return
    real = _load_row_real_embedding(row)
    if real is None:
        return
    get_vector_store().upsert(
        session,
        user_id=None,
        source_type="global_qa",
        source_id=str(row.id),
        content_hash=hashlib.sha256(
            f"global_qa:{row.id}".encode("utf-8")
        ).hexdigest(),
        content_text=row.canonical_question,
        embedding=real[0],
        updated_at=row.updated_at,
    )


def _lookup_hot_cache(
    session: Session,
    question: str,
    language: Optional[str],
    user_hash: Optional[str],
    now: datetime,
    *,
    scope: str,
    cache_compatibility_hash: Optional[str] = None,
) -> Optional[dict]:
    cache = _hot_cache()
    for key in _hot_lookup_keys_for_scope(question, language, scope=scope, user_id_hash=user_hash):
        try:
            payload = cache.get(key)
        except Exception:
            return None
        if not payload:
            continue
        row_id = payload.get("id")
        if row_id is None:
            continue
        row = session.get(GlobalQACache, int(row_id))
        if row is None:
            try:
                cache.delete(key)
            except Exception:
                pass
            continue
        if _row_scope(row) != (_USER_SCOPE if str(scope or "").lower() == _USER_SCOPE else _GLOBAL_SCOPE):
            try:
                cache.delete(key)
            except Exception:
                pass
            continue
        if not _row_lookup_safe(
            row, question, language, now, user_hash=user_hash,
            cache_compatibility_hash=cache_compatibility_hash,
        ):
            try:
                cache.delete(key)
            except Exception:
                pass
            continue
        score = 1.0
        row.hit_count = int(row.hit_count or 0) + 1
        row.last_seen_at = now
        session.add(row)
        session.commit()
        return _row_to_hit(row, score)
    return None


def lookup_approved_global_cache(
    session: Session,
    question: str,
    reply_language: Optional[str] = None,
    user_id: Any = None,
    query_embedding: Any = None,
    *,
    cache_compatibility_hash: Optional[str] = None,
    exact_only: bool = False,
) -> Optional[dict]:
    if not _enabled() or not str(question or "").strip():
        return None
    readiness = global_qa_schema_ready(session)
    if not readiness.get("ok"):
        logger.warning(
            "global_cache_schema_not_ready",
            extra={
                "event": "global_cache_schema_not_ready",
                "missing_tables": readiness.get("missing_tables") or [],
                "db_schema_ready": False,
            },
        )
        return None
    try:
        _ensure_schema_compat(session)
    except (ProgrammingError, OperationalError) as exc:
        session.rollback()
        logger.warning(
            "global_cache_schema_not_ready",
            extra={
                "event": "global_cache_schema_not_ready",
                "error_type": exc.__class__.__name__,
                "error_message": str(exc)[:240],
                "db_schema_ready": False,
            },
        )
        return None
    if is_live_or_current_question(question) or is_private_or_personal_question(question):
        return None

    language = _answer_language(reply_language)
    now = utc_now()
    user_hash = stable_user_hash(user_id) if user_id is not None else None
    if exact_only:
        normalized = normalize_question(question)
        scopes = [(_USER_SCOPE, user_hash)] if user_hash else []
        scopes.append((_GLOBAL_SCOPE, None))
        for scope, required_hash in scopes:
            statement = (
                select(GlobalQACache)
                .where(GlobalQACache.status == "approved")
                .where(GlobalQACache.normalized_question == normalized)
            )
            if scope == _USER_SCOPE:
                statement = statement.where(
                    GlobalQACache.scope == _USER_SCOPE,
                    GlobalQACache.user_id_hash == required_hash,
                )
            else:
                statement = statement.where(or_(
                    GlobalQACache.scope == _GLOBAL_SCOPE,
                    GlobalQACache.scope == None,  # noqa: E711
                ))
            for row in session.exec(
                statement.order_by(GlobalQACache.updated_at.desc())
            ).all():
                if _row_lookup_safe(
                    row, question, language, now, user_hash=user_hash,
                    cache_compatibility_hash=cache_compatibility_hash,
                ):
                    _touch_cache_hit(session, row, now)
                    return _row_to_hit(row, 1.0)
        return None
    if user_hash:
        hot_user_hit = _lookup_hot_cache(
            session, question, language, user_hash, now, scope=_USER_SCOPE,
            cache_compatibility_hash=cache_compatibility_hash,
        )
        if hot_user_hit is not None:
            return hot_user_hit
    if _semantic_enabled():
        hot_global_hit = _lookup_hot_cache(
            session, question, language, user_hash, now, scope=_GLOBAL_SCOPE,
            cache_compatibility_hash=cache_compatibility_hash,
        )
        if hot_global_hit is not None:
            return hot_global_hit
        return _semantic_lookup_after_exact_miss(
            session, question, language, user_hash, now,
            cache_compatibility_hash=cache_compatibility_hash,
        )
    query_bundle: Optional[Dict[str, Any]] = None
    try:
        user_rows: List[GlobalQACache] = []
        if user_hash:
            user_rows = list(
                session.exec(
                    select(GlobalQACache)
                    .where(GlobalQACache.status == "approved")
                    .where(GlobalQACache.scope == _USER_SCOPE)
                    .where(GlobalQACache.user_id_hash == user_hash)
                    .order_by(GlobalQACache.updated_at.desc())
                ).all()
            )
    except (ProgrammingError, OperationalError) as exc:
        session.rollback()
        logger.warning(
            "global_cache_schema_not_ready",
            extra={
                "event": "global_cache_schema_not_ready",
                "error_type": exc.__class__.__name__,
                "error_message": str(exc)[:240],
                "db_schema_ready": False,
            },
        )
        return None

    def _best_hit_from_rows(rows: List[GlobalQACache]) -> Tuple[Optional[GlobalQACache], float]:
        nonlocal query_bundle
        if not rows:
            return None, 0.0
        if query_bundle is None:
            query_bundle = _query_embedding_bundle(question, query_embedding)
        scored: List[Tuple[GlobalQACache, float]] = []
        for row in rows:
            if not _row_lookup_safe(
                row, question, language, now, user_hash=user_hash,
                cache_compatibility_hash=cache_compatibility_hash,
            ):
                continue
            score = _score_row_against_query(row, question, query_bundle)
            if score > 0:
                scored.append((row, score))
        if not scored:
            return None, 0.0
        try:
            from .ai.agents.reranker_agent import RerankerAgent

            reranked = RerankerAgent().rerank(scored)
            return reranked[0] if reranked else (None, 0.0)
        except Exception:
            best_row: Optional[GlobalQACache] = None
            best_score_value = 0.0
            for row, score in scored:
                if best_row is None or score > best_score_value:
                    best_row = row
                    best_score_value = score
            return best_row, best_score_value

    best, best_score = _best_hit_from_rows(user_rows)
    if best is not None and best_score >= _min_similarity():
        best.hit_count = int(best.hit_count or 0) + 1
        best.last_seen_at = now
        session.add(best)
        session.commit()
        logger.info(
            "global_cache_hit",
            extra={
                "event": "global_cache_hit",
                "cache_hit": True,
                "direct_answer_source": "global_qa_cache",
                "route_taken": "global_knowledge_cache",
                "answer_hash": best.answer_hash,
                "cache_hit_source": "L2_user_global_qa",
            },
        )
        _populate_hot_cache_for_row(best)
        return _row_to_hit(best, best_score)

    hot_global_hit = _lookup_hot_cache(
        session, question, language, user_hash, now, scope=_GLOBAL_SCOPE,
        cache_compatibility_hash=cache_compatibility_hash,
    )
    if hot_global_hit is not None:
        return hot_global_hit

    try:
        global_rows = list(
            session.exec(
                select(GlobalQACache)
                .where(GlobalQACache.status == "approved")
                .where(or_(GlobalQACache.scope == _GLOBAL_SCOPE, GlobalQACache.scope == None))  # noqa: E711
                .order_by(GlobalQACache.updated_at.desc())
            ).all()
        )
    except (ProgrammingError, OperationalError) as exc:
        session.rollback()
        logger.warning(
            "global_cache_schema_not_ready",
            extra={
                "event": "global_cache_schema_not_ready",
                "error_type": exc.__class__.__name__,
                "error_message": str(exc)[:240],
                "db_schema_ready": False,
            },
        )
        return None

    best, best_score = _best_hit_from_rows(global_rows)
    if best is None or best_score < _min_similarity():
        return None

    best.hit_count = int(best.hit_count or 0) + 1
    best.last_seen_at = now
    session.add(best)
    session.commit()
    logger.info(
        "global_cache_hit",
        extra={
            "event": "global_cache_hit",
            "cache_hit": True,
            "direct_answer_source": "global_qa_cache",
            "route_taken": "global_knowledge_cache",
            "answer_hash": best.answer_hash,
            "cache_hit_source": "L3_global_qa",
        },
    )
    _populate_hot_cache_for_row(best)
    return _row_to_hit(best, best_score)


def _source_hashes(row: GlobalQACache) -> List[str]:
    try:
        parsed = json.loads(row.source_question_hashes_json or "[]")
    except Exception:
        parsed = []
    return [str(item) for item in parsed if str(item).strip()]


def _infer_answer_language(answer: str) -> str:
    if re.search(r"[\u0B80-\u0BFF]", str(answer or "")):
        return "ta"
    return "en"


def _topic_from_question(question: str) -> Optional[str]:
    tokens = _semantic_tokens(question)
    return tokens[0] if tokens else None


def _find_candidate(session: Session, normalized_question: str, query_bundle: Dict[str, Any]) -> Tuple[Optional[GlobalQACache], float]:
    rows = list(
        session.exec(
            select(GlobalQACache)
            .where(GlobalQACache.status.in_(["candidate", "approved"]))
            .where(or_(GlobalQACache.scope == _GLOBAL_SCOPE, GlobalQACache.scope == None))  # noqa: E711
            .order_by(GlobalQACache.updated_at.desc())
        ).all()
    )
    best: Optional[GlobalQACache] = None
    best_score = 0.0
    for row in rows:
        if not _not_expired(row):
            continue
        score = _score_row_against_query(row, normalized_question, query_bundle)
        if score > best_score:
            best = row
            best_score = score
    if best is not None and best_score >= _min_similarity():
        return best, best_score
    return None, 0.0


def _apply_embedding_bundle(row: GlobalQACache, bundle: Dict[str, Any]) -> None:
    active = _coerce_embedding_vector(bundle.get("embedding"))
    token = _coerce_embedding_vector(bundle.get("token_hash_embedding"))
    real = _coerce_embedding_vector(bundle.get("real_embedding"))
    row.embedding_json = json.dumps(active, ensure_ascii=False) if active else "[]"
    row.embedding_kind = str(bundle.get("embedding_kind") or GLOBAL_QA_EMBEDDING_KIND)
    row.embedding_norm = float(bundle.get("embedding_norm") or _vector_norm(active) or 0.0)
    row.token_hash_embedding_json = json.dumps(token, ensure_ascii=False) if token else "[]"
    row.token_hash_embedding_norm = float(bundle.get("token_hash_embedding_norm") or _vector_norm(token) or 0.0)
    row.real_embedding_json = json.dumps(real, ensure_ascii=False) if real else None
    row.real_embedding_norm = float(bundle.get("real_embedding_norm") or _vector_norm(real) or 0.0)
    row.real_embedding_kind = str(bundle.get("real_embedding_kind") or "").strip() or None


def _find_user_scoped_row(
    session: Session,
    *,
    user_hash: str,
    answer_hash_value: str,
    normalized_question: str,
    query_bundle: Dict[str, Any],
) -> Optional[GlobalQACache]:
    rows = list(
        session.exec(
            select(GlobalQACache)
            .where(GlobalQACache.scope == _USER_SCOPE)
            .where(GlobalQACache.user_id_hash == user_hash)
            .where(GlobalQACache.status == "approved")
            .order_by(GlobalQACache.updated_at.desc())
        ).all()
    )
    best: Optional[GlobalQACache] = None
    best_score = 0.0
    for row in rows:
        if str(row.answer_hash or "") and str(row.answer_hash or "") != answer_hash_value:
            continue
        score = _score_row_against_query(row, normalized_question, query_bundle)
        if score > best_score:
            best = row
            best_score = score
    return best if best is not None and best_score >= _min_similarity() else None


def _upsert_user_scoped_cache_row(
    session: Session,
    *,
    user_hash: str,
    canonical_question: str,
    normalized: str,
    answer: str,
    model_used: Optional[str],
    q_hash: str,
    cache_compatibility_hash: Optional[str],
    a_hash: str,
    safe_variant: Optional[str],
    safe_aliases: List[str],
    embedding_bundle: Dict[str, Any],
    now: datetime,
    expires_at: datetime,
) -> Optional[GlobalQACache]:
    row = _find_user_scoped_row(
        session,
        user_hash=user_hash,
        answer_hash_value=a_hash,
        normalized_question=normalized,
        query_bundle=embedding_bundle,
    )
    redacted_answer = redact_sensitive_text(answer)
    if row is None:
        row = GlobalQACache(
            scope=_USER_SCOPE,
            user_id_hash=user_hash,
            canonical_question=canonical_question,
            normalized_question=normalized,
            answer=redacted_answer,
            answer_language=_infer_answer_language(answer),
            topic=_topic_from_question(canonical_question),
            status="approved",
            hit_count=1,
            distinct_user_count=1,
            observed_question_count=1,
            source_question_hashes_json=json.dumps(
                [value for value in (q_hash, cache_compatibility_hash) if value],
                ensure_ascii=False,
            ),
            observed_safe_questions_json=_dump_json_list([safe_variant] if safe_variant else []),
            aliases_json=_dump_json_list(safe_aliases),
            answer_hash=a_hash,
            confidence=0.90,
            safety_label="general",
            model_used=model_used,
            first_seen_at=now,
            last_seen_at=now,
            expires_at=expires_at,
            created_at=now,
            updated_at=now,
        )
        _apply_embedding_bundle(row, embedding_bundle)
        session.add(row)
        session.commit()
        session.refresh(row)
        _upsert_vector_for_row(session, row)
    else:
        hashes = _source_hashes(row)
        if q_hash not in hashes:
            hashes.append(q_hash)
        if (
            cache_compatibility_hash
            and cache_compatibility_hash not in hashes
        ):
            hashes.append(cache_compatibility_hash)
        observed_safe_questions = _load_json_list(getattr(row, "observed_safe_questions_json", "[]"))
        if safe_variant:
            observed_safe_questions.append(safe_variant)
        aliases = _load_json_list(getattr(row, "aliases_json", "[]"))
        aliases.extend(safe_aliases)
        row.canonical_question = row.canonical_question or canonical_question
        row.normalized_question = row.normalized_question or normalized
        row.answer = redacted_answer
        row.answer_hash = a_hash
        row.answer_language = _infer_answer_language(answer)
        row.status = "approved"
        row.hit_count = int(row.hit_count or 0) + 1
        row.distinct_user_count = 1
        row.observed_question_count = int(row.observed_question_count or 0) + 1
        row.source_question_hashes_json = json.dumps(hashes[-100:], ensure_ascii=False)
        row.observed_safe_questions_json = _dump_json_list(observed_safe_questions)
        row.aliases_json = _dump_json_list(aliases)
        row.confidence = max(float(row.confidence or 0.0), 0.90)
        row.safety_label = "general"
        row.model_used = model_used or row.model_used
        row.last_seen_at = now
        row.updated_at = now
        row.expires_at = expires_at
        _apply_embedding_bundle(row, embedding_bundle)
        session.add(row)
        session.commit()
        session.refresh(row)
        _upsert_vector_for_row(session, row)
    _populate_hot_cache_for_row(row)
    return row


def _record_backend_openai_answer_impl(
    session: Session,
    user_id: Any,
    question: str,
    answer: str,
    model_used: Optional[str],
    request_id: Optional[str] = None,
    cache_compatibility_hash: Optional[str] = None,
) -> dict:
    if not _enabled():
        return {"ok": False, "skipped": True, "reason": "disabled"}
    readiness = global_qa_schema_ready(session)
    if not readiness.get("ok"):
        logger.warning(
            "global_cache_record_skipped_schema_not_ready",
            extra={
                "event": "global_cache_record_skipped_schema_not_ready",
                "missing_tables": readiness.get("missing_tables") or [],
                "db_schema_ready": False,
            },
        )
        return {
            "ok": False,
            "skipped": True,
            "reason": "global_qa_schema_not_ready",
            "missingTables": readiness.get("missing_tables") or [],
        }
    try:
        _ensure_schema_compat(session)
    except (ProgrammingError, OperationalError) as exc:
        session.rollback()
        logger.warning(
            "global_cache_record_skipped_schema_not_ready",
            extra={
                "event": "global_cache_record_skipped_schema_not_ready",
                "error_type": exc.__class__.__name__,
                "error_message": str(exc)[:240],
                "db_schema_ready": False,
            },
        )
        return {"ok": False, "skipped": True, "reason": "global_qa_schema_not_ready"}

    if not is_cacheable_global_question(question, answer):
        logger.info(
            "global_cache_rejected",
            extra={"event": "global_cache_rejected", "reason": "not_cacheable"},
        )
        return {"ok": False, "skipped": True, "reason": "not_cacheable"}

    now = utc_now()
    canonical_question = redact_sensitive_text(question)
    if _redaction_changed_meaning(question, canonical_question):
        logger.info(
            "global_cache_rejected",
            extra={"event": "global_cache_rejected", "reason": "redaction_changed_meaning"},
        )
        return {"ok": False, "skipped": True, "reason": "redaction_changed_meaning"}

    normalized = normalize_question(canonical_question)
    if not normalized or is_private_or_personal_question(normalized):
        logger.info(
            "global_cache_rejected",
            extra={"event": "global_cache_rejected", "reason": "unsafe_normalized_question"},
        )
        return {"ok": False, "skipped": True, "reason": "unsafe_normalized_question"}
    safe_variant = _safe_question_variant(canonical_question)
    safe_aliases = _safe_aliases_for_question(canonical_question)

    q_hash = question_hash(question)
    a_hash = answer_hash(answer)
    user_hash = stable_user_hash(user_id)
    embedding_bundle = embedding_bundle_for_global_cache(normalized)
    expires_at = now + timedelta(days=_ttl_days())

    user_row = None
    if user_id is not None and user_hash:
        user_row = _upsert_user_scoped_cache_row(
            session,
            user_hash=user_hash,
            canonical_question=canonical_question,
            normalized=normalized,
            answer=answer,
            model_used=model_used,
            q_hash=q_hash,
            cache_compatibility_hash=cache_compatibility_hash,
            a_hash=a_hash,
            safe_variant=safe_variant,
            safe_aliases=safe_aliases,
            embedding_bundle=embedding_bundle,
            now=now,
            expires_at=expires_at,
        )

    candidate, similarity = _find_candidate(session, normalized, embedding_bundle)
    if candidate is None:
        candidate = GlobalQACache(
            scope=_GLOBAL_SCOPE,
            user_id_hash=None,
            canonical_question=canonical_question,
            normalized_question=normalized,
            answer=redact_sensitive_text(answer),
            answer_language=_infer_answer_language(answer),
            topic=_topic_from_question(question),
            status="candidate",
            hit_count=1,
            distinct_user_count=1,
            observed_question_count=1,
            source_question_hashes_json=json.dumps(
                [value for value in (q_hash, cache_compatibility_hash) if value],
                ensure_ascii=False,
            ),
            observed_safe_questions_json=_dump_json_list([safe_variant] if safe_variant else []),
            aliases_json=_dump_json_list(safe_aliases),
            answer_hash=a_hash,
            confidence=0.0,
            safety_label="general",
            model_used=model_used,
            first_seen_at=now,
            last_seen_at=now,
            expires_at=expires_at,
            created_at=now,
            updated_at=now,
        )
        _apply_embedding_bundle(candidate, embedding_bundle)
        session.add(candidate)
        session.commit()
        session.refresh(candidate)
        _upsert_vector_for_row(session, candidate)
        similarity = 1.0
    else:
        answer_similarity = _answer_similarity(candidate.answer, answer)
        answer_conflict = bool(candidate.answer_hash and a_hash != candidate.answer_hash and answer_similarity < _min_answer_similarity())
        hashes = _source_hashes(candidate)
        if q_hash not in hashes:
            hashes.append(q_hash)
        if (
            cache_compatibility_hash
            and cache_compatibility_hash not in hashes
        ):
            hashes.append(cache_compatibility_hash)
        observed_safe_questions = _load_json_list(getattr(candidate, "observed_safe_questions_json", "[]"))
        if safe_variant:
            observed_safe_questions.append(safe_variant)
        aliases = _load_json_list(getattr(candidate, "aliases_json", "[]"))
        aliases.extend(safe_aliases)
        candidate.hit_count = int(candidate.hit_count or 0) + 1
        candidate.observed_question_count = int(candidate.observed_question_count or 0) + 1
        candidate.source_question_hashes_json = json.dumps(hashes[-100:], ensure_ascii=False)
        candidate.observed_safe_questions_json = _dump_json_list(observed_safe_questions)
        candidate.aliases_json = _dump_json_list(aliases)
        candidate.last_seen_at = now
        candidate.updated_at = now
        candidate.expires_at = expires_at
        if not candidate.embedding_kind:
            candidate.embedding_kind = GLOBAL_QA_EMBEDDING_KIND
        if not getattr(candidate, "token_hash_embedding_json", None) or (
            embedding_bundle.get("real_embedding") and not getattr(candidate, "real_embedding_json", None)
        ):
            _apply_embedding_bundle(candidate, embedding_bundle)
        if not answer_conflict and (not candidate.answer or candidate.status == "candidate"):
            candidate.answer = redact_sensitive_text(answer)
            candidate.answer_hash = a_hash
            candidate.answer_language = _infer_answer_language(answer)
            candidate.model_used = model_used or candidate.model_used
        if answer_conflict:
            existing_notes = str(candidate.review_notes or "").strip()
            conflict_hashes = sorted({str(candidate.answer_hash or ""), a_hash})
            candidate.review_notes = (
                f"{existing_notes}\n" if existing_notes else ""
            ) + f"conflicting_answer_hashes={json.dumps(conflict_hashes, ensure_ascii=False)}"
        session.add(candidate)
        session.commit()
        session.refresh(candidate)
        _upsert_vector_for_row(session, candidate)
        if answer_conflict:
            logger.info(
                "global_cache_needs_review",
                extra={
                    "event": "global_cache_needs_review",
                    "answer_hash": candidate.answer_hash,
                    "conflicting_answer_hashes": conflict_hashes,
                    "answer_similarity_score": round(answer_similarity, 4),
                },
            )
    if candidate is not None and candidate.answer_hash == a_hash:
        observation_answer_similarity = 1.0
        conflicting_answer_hashes: List[str] = []
    else:
        observation_answer_similarity = _answer_similarity(candidate.answer if candidate is not None else "", answer)
        conflicting_answer_hashes = (
            sorted({str(candidate.answer_hash or ""), a_hash})
            if candidate is not None
            and candidate.answer_hash
            and a_hash != candidate.answer_hash
            and observation_answer_similarity < _min_answer_similarity()
            else []
        )

    observation = GlobalQAObservation(
        global_cache_id=int(candidate.id),
        user_id_hash=user_hash,
        question_hash=q_hash,
        normalized_question=normalized,
        similarity_score=float(similarity),
        answer_similarity_score=float(observation_answer_similarity),
        backend_answer_hash=a_hash,
        conflicting_answer_hashes_json=json.dumps(conflicting_answer_hashes, ensure_ascii=False),
        model_used=model_used,
        created_at=now,
    )
    session.add(observation)
    session.commit()
    session.refresh(observation)

    observations = list(
        session.exec(
            select(GlobalQAObservation).where(GlobalQAObservation.global_cache_id == int(candidate.id))
        ).all()
    )
    distinct_users = {row.user_id_hash for row in observations if row.user_id_hash}
    candidate.distinct_user_count = len(distinct_users)
    candidate.observed_question_count = len(observations)
    session.add(candidate)
    session.commit()
    session.refresh(candidate)

    logger.info(
        "global_cache_candidate_observed",
        extra={
            "event": "global_cache_candidate_observed",
            "cache_hit": False,
            "answer_hash": candidate.answer_hash,
            "model_used": model_used,
        },
    )
    promoted = False if conflicting_answer_hashes else promote_candidate_if_threshold_met(session, int(candidate.id))
    return {
        "ok": True,
        "candidate_id": candidate.id,
        "user_candidate_id": user_row.id if user_row is not None else None,
        "observation_id": observation.id,
        "status": candidate.status,
        "promoted": promoted,
    }


def record_backend_openai_answer(
    session: Session,
    user_id: Any,
    question: str,
    answer: str,
    model_used: Optional[str],
    request_id: Optional[str] = None,
    cache_compatibility_hash: Optional[str] = None,
) -> dict:
    try:
        from .ai.agents.cache_writer_agent import CacheWriterAgent

        return CacheWriterAgent().record_provider_answer(
            session,
            user_id=user_id,
            question=question,
            answer=answer,
            model_used=model_used,
            request_id=request_id,
            cache_compatibility_hash=cache_compatibility_hash,
        )
    except ImportError:
        return _record_backend_openai_answer_impl(
            session,
            user_id,
            question,
            answer,
            model_used,
            request_id=request_id,
            cache_compatibility_hash=cache_compatibility_hash,
        )


def promote_candidate_if_threshold_met(session: Session, candidate_id: int) -> bool:
    _ensure_schema_compat(session)
    candidate = session.get(GlobalQACache, candidate_id)
    if not candidate or candidate.status != "candidate":
        return False
    if _row_scope(candidate) != _GLOBAL_SCOPE:
        return False
    if int(candidate.hit_count or 0) < _promote_hits():
        return False
    if _require_distinct_users() and int(candidate.distinct_user_count or 0) < _promote_hits():
        return False
    observations = list(
        session.exec(
            select(GlobalQAObservation).where(GlobalQAObservation.global_cache_id == int(candidate.id))
        ).all()
    )
    if len(observations) < _promote_hits():
        return False
    min_answer_similarity = _min_answer_similarity()
    conflicting = [
        row
        for row in observations
        if str(row.conflicting_answer_hashes_json or "[]").strip() not in {"", "[]"}
        or float(row.answer_similarity_score or 0.0) < min_answer_similarity
    ]
    if conflicting:
        logger.info(
            "global_cache_needs_review",
            extra={
                "event": "global_cache_needs_review",
                "answer_hash": candidate.answer_hash,
                "conflicting_observation_count": len(conflicting),
            },
        )
        return False
    candidate.status = "approved"
    candidate.confidence = max(float(candidate.confidence or 0.0), 0.90)
    candidate.updated_at = utc_now()
    session.add(candidate)
    session.commit()
    _upsert_vector_for_row(session, candidate)
    _populate_hot_cache_for_row(candidate)
    logger.info(
        "global_cache_promoted",
        extra={
            "event": "global_cache_promoted",
            "answer_hash": candidate.answer_hash,
            "cache_hit": False,
        },
    )
    return True


def backfill_global_qa_embeddings(
    session: Session, *, batch_size: int = 100, after_id: int = 0
) -> dict[str, int]:
    """Repair one bounded page of approved, cross-user-safe global QA vectors."""
    if not _semantic_enabled():
        return {
            "scanned": 0, "embedded": 0, "vector_upserts": 0,
            "next_after_id": max(0, int(after_id)), "has_more": False,
        }
    safe_batch = min(100, max(1, int(batch_size or 100)))
    rows = list(
        session.exec(
            select(GlobalQACache)
            .where(GlobalQACache.id > max(0, int(after_id)))
            .where(GlobalQACache.status == "approved")
            .where(or_(
                GlobalQACache.scope == _GLOBAL_SCOPE,
                GlobalQACache.scope == None,  # noqa: E711
            ))
            .order_by(GlobalQACache.id.asc())
            .limit(safe_batch)
        ).all()
    )
    embedded = vector_upserts = 0
    for row in rows:
        if not _row_lookup_safe(
            row, row.canonical_question, None, utc_now(), user_hash=None
        ):
            continue
        if _load_row_real_embedding(row) is None:
            bundle = embedding_bundle_for_global_cache(
                row.normalized_question or row.canonical_question
            )
            if not bundle.get("real_embedding"):
                # Leave the cursor on this page so the queue retry policy can
                # retry a transient embedding outage instead of silently
                # declaring the backfill complete.
                raise RuntimeError(
                    f"Embedding unavailable for approved global QA row {row.id}"
                )
            _apply_embedding_bundle(row, bundle)
            row.updated_at = utc_now()
            session.add(row)
            session.commit()
            session.refresh(row)
            embedded += 1
        _upsert_vector_for_row(session, row)
        vector_upserts += 1
    next_after_id = int(rows[-1].id) if rows else max(0, int(after_id))
    return {
        "scanned": len(rows),
        "embedded": embedded,
        "vector_upserts": vector_upserts,
        "next_after_id": next_after_id,
        "has_more": len(rows) == safe_batch,
    }


def _parse_since(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_after_id(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        parsed = int(str(value).strip())
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _sync_safe_row(row: GlobalQACache, now: datetime) -> bool:
    if row.status != "approved":
        return False
    if not _not_expired(row, now):
        return False
    safety_label = str(row.safety_label or "").strip().lower()
    if safety_label in {"private", "personal_high_risk", "unsafe"}:
        return False
    if is_private_or_personal_question(row.canonical_question) or is_private_or_personal_question(row.normalized_question):
        return False
    if is_live_or_current_question(row.canonical_question) or is_live_or_current_question(row.normalized_question):
        return False
    return True


def _sync_embedding_payload(row: GlobalQACache) -> Optional[Dict[str, Any]]:
    token = _load_row_token_embedding(row)
    real = _load_row_real_embedding(row)
    active_vec: List[float] = []
    active_norm = 0.0
    active_kind = ""
    if real is not None:
        active_vec, active_norm, active_kind = real
    elif token is not None:
        active_vec, active_norm = token
        active_kind = GLOBAL_QA_EMBEDDING_KIND
    elif _embedding_json_is_corrupt(row.embedding_json) or _embedding_json_is_corrupt(getattr(row, "token_hash_embedding_json", None)) or _embedding_json_is_corrupt(getattr(row, "real_embedding_json", None)):
        return None
    payload: Dict[str, Any] = {
        "embedding": active_vec,
        "embeddingNorm": active_norm,
        "embeddingKind": active_kind,
    }
    if token is not None:
        payload.update(
            {
                "tokenHashEmbedding": token[0],
                "tokenHashEmbeddingNorm": token[1],
                "tokenHashEmbeddingKind": GLOBAL_QA_EMBEDDING_KIND,
            }
        )
    return payload


def _sync_safe_variants(values: List[str]) -> List[str]:
    safe_values: List[str] = []
    seen = set()
    for value in values:
        safe = _safe_question_variant(value)
        if not safe or safe in seen:
            continue
        seen.add(safe)
        safe_values.append(safe)
    return safe_values


def _row_cursor(row: GlobalQACache) -> Tuple[Optional[str], Optional[int]]:
    return (
        row.updated_at.isoformat() if row.updated_at else None,
        int(row.id) if row.id is not None else None,
    )


def _user_qa_sync_min_hits() -> int:
    return _env_int("USER_QA_SYNC_MIN_HITS", 2, minimum=1)


def _user_qa_sync_ttl_days() -> int:
    return _env_int("USER_QA_SYNC_TTL_DAYS", 30, minimum=1)


def _qa_cache_payload(row: QACache) -> Dict[str, Any]:
    try:
        parsed = json.loads(row.answer or "{}")
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _qa_cache_answer_text(payload: Dict[str, Any]) -> str:
    assistant = payload.get("assistant")
    if isinstance(assistant, dict):
        text = str(assistant.get("text") or "").strip()
        if text:
            return " ".join(text.split())
    meta = payload.get("meta")
    if isinstance(meta, dict):
        details = str(meta.get("details") or "").strip()
        if details:
            return " ".join(details.split())
    pipeline = payload.get("pipeline")
    if isinstance(pipeline, dict):
        for key in ("theni_tamil_text", "tamil_text", "remodeled_english", "raw_english"):
            text = str(pipeline.get(key) or "").strip()
            if text:
                return " ".join(text.split())
    return ""


def _qa_cache_pipeline(payload: Dict[str, Any]) -> Dict[str, Any]:
    pipeline = payload.get("pipeline")
    return pipeline if isinstance(pipeline, dict) else {}


def _qa_cache_route_is_user_sync_safe(pipeline: Dict[str, Any]) -> bool:
    route = str(pipeline.get("route_taken") or "").strip().lower()
    source = str(pipeline.get("direct_answer_source") or "").strip().lower()
    risk = str(pipeline.get("risk_level") or "").strip().lower()
    predicted = str(pipeline.get("predicted_label") or "").strip().lower()
    cache_hit = str(pipeline.get("cache_hit") or "").strip().lower() in {"1", "true", "yes"}
    if cache_hit or route == "global_knowledge_cache" or source == "global_qa_cache":
        return False
    if risk in {"high", "unsafe", "personal_high_risk"}:
        return False
    blocked_terms = (
        "reminder",
        "routine",
        "schedule",
        "calendar",
        "tool",
        "mutation",
        "error",
        "fallback",
    )
    combined = " ".join(part for part in (route, source, predicted) if part)
    return not any(term in combined for term in blocked_terms)


def _safe_user_qa_sync_entry(row: QACache, now: datetime) -> Optional[Dict[str, Any]]:
    if row.id is None or row.user_id is None:
        return None
    if int(row.hits or 0) < _user_qa_sync_min_hits():
        return None
    updated_at = row.updated_at or now
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    expires_at = updated_at + timedelta(days=_user_qa_sync_ttl_days())
    if expires_at <= now:
        return None
    question = str(row.question or "").strip()
    payload = _qa_cache_payload(row)
    answer = _qa_cache_answer_text(payload)
    pipeline = _qa_cache_pipeline(payload)
    if not question or not answer:
        return None
    if not _qa_cache_route_is_user_sync_safe(pipeline):
        return None
    if not is_cacheable_global_question(question, answer):
        return None
    canonical_question = redact_sensitive_text(question)
    if _redaction_changed_meaning(question, canonical_question):
        return None
    normalized = normalize_question(canonical_question)
    if not normalized:
        return None
    token_embedding, token_embedding_norm, token_embedding_kind = token_hash_embedding_for_global_cache(normalized)
    aliases = _sync_safe_variants(_alias_variants(canonical_question))
    answer_language = _infer_answer_language(answer)
    source = {
        "kind": "user_qa_cache",
        "qaCacheId": int(row.id),
        "hits": int(row.hits or 0),
        "route": str(pipeline.get("route_taken") or ""),
        "directAnswerSource": str(pipeline.get("direct_answer_source") or ""),
    }
    return {
        "id": f"user:{int(row.id)}",
        "scope": "user",
        "canonicalQuestion": canonical_question,
        "normalizedQuestion": normalized,
        "aliases": aliases,
        "observedSafeQuestions": _sync_safe_variants([canonical_question, normalized]),
        "answer": redact_sensitive_text(answer),
        "answerLanguage": answer_language,
        "topic": _topic_from_question(canonical_question),
        "answerHash": answer_hash(answer),
        "embedding": token_embedding,
        "embeddingNorm": token_embedding_norm,
        "embeddingKind": token_embedding_kind,
        "tokenHashEmbedding": token_embedding,
        "tokenHashEmbeddingNorm": token_embedding_norm,
        "tokenHashEmbeddingKind": token_embedding_kind,
        "confidence": 1.0,
        "safetyLabel": "general",
        "scopeSource": source,
        "source": source,
        "updatedAt": updated_at.isoformat(),
        "expiresAt": expires_at.isoformat(),
    }


def _user_qa_sync_entries(
    session: Session,
    *,
    user_id: Any,
    now: datetime,
    limit: int,
) -> List[Dict[str, Any]]:
    try:
        uid = int(user_id)
    except Exception:
        return []
    rows = list(
        session.exec(
            select(QACache)
            .where(QACache.user_id == uid)
            .order_by(QACache.updated_at.desc(), QACache.id.desc())
            .limit(max(1, min(int(limit or 250), 500)))
        ).all()
    )
    entries: List[Dict[str, Any]] = []
    for row in rows:
        entry = _safe_user_qa_sync_entry(row, now)
        if entry is not None:
            entries.append(entry)
    return entries


def _global_qa_row_sync_entry(row: GlobalQACache, *, entry_id: Any, scope: str, now: datetime) -> Optional[Dict[str, Any]]:
    if not _sync_safe_row(row, now):
        return None
    embedding_payload = _sync_embedding_payload(row)
    if embedding_payload is None:
        return None
    aliases = _sync_safe_variants(
        _load_json_list(getattr(row, "aliases_json", "[]")) + _alias_variants(row.canonical_question)
    )
    observed_safe_questions = _sync_safe_variants(
        _load_json_list(getattr(row, "observed_safe_questions_json", "[]"))
    )
    return {
        "id": entry_id,
        "scope": scope,
        "canonicalQuestion": row.canonical_question,
        "normalizedQuestion": row.normalized_question,
        "aliases": aliases,
        "observedSafeQuestions": observed_safe_questions,
        "answer": row.answer,
        "answerLanguage": row.answer_language,
        "topic": row.topic,
        "answerHash": row.answer_hash,
        **embedding_payload,
        "confidence": row.confidence,
        "safetyLabel": row.safety_label,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        "expiresAt": row.expires_at.isoformat() if row.expires_at else None,
    }


def _user_global_qa_sync_entries(
    session: Session,
    *,
    user_id: Any,
    now: datetime,
    limit: int,
) -> List[Dict[str, Any]]:
    if user_id is None:
        return []
    user_hash = stable_user_hash(user_id)
    rows = list(
        session.exec(
            select(GlobalQACache)
            .where(GlobalQACache.scope == _USER_SCOPE)
            .where(GlobalQACache.user_id_hash == user_hash)
            .where(GlobalQACache.status == "approved")
            .order_by(GlobalQACache.updated_at.desc(), GlobalQACache.id.desc())
            .limit(max(1, min(int(limit or 250), 500)))
        ).all()
    )
    entries: List[Dict[str, Any]] = []
    for row in rows:
        if row.id is None:
            continue
        entry = _global_qa_row_sync_entry(row, entry_id=f"user-global:{int(row.id)}", scope=_USER_SCOPE, now=now)
        if entry is not None:
            source = {"kind": "user_global_qa_cache", "globalCacheId": int(row.id)}
            entry["scopeSource"] = source
            entry["source"] = source
            entries.append(entry)
    return entries


def _dedupe_sync_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen_ids = set()
    seen_hashes = set()
    for entry in entries:
        entry_id = str(entry.get("id") or "").strip()
        answer_hash_value = str(entry.get("answerHash") or "").strip()
        if entry_id and entry_id in seen_ids:
            continue
        if answer_hash_value and answer_hash_value in seen_hashes:
            continue
        if entry_id:
            seen_ids.add(entry_id)
        if answer_hash_value:
            seen_hashes.add(answer_hash_value)
        out.append(entry)
    return out


def _normalize_topic_seed_list(values: Any) -> List[str]:
    if values in (None, ""):
        return []
    raw_values = values if isinstance(values, list) else [values]
    out: List[str] = []
    seen = set()
    for raw_value in raw_values:
        for part in re.split(r",", str(raw_value or "")):
            seed = _safe_question_variant(part)
            if not seed or seed in seen:
                continue
            seen.add(seed)
            out.append(seed)
            if len(out) >= 24:
                return out
    return out


def _topic_seed_prefetch_limit(safe_limit: int) -> int:
    configured = _env_int("GLOBAL_QA_TOPIC_SEED_PREFETCH_LIMIT", 25, minimum=0)
    if configured <= 0:
        return 0
    return min(configured, max(1, safe_limit))


def _topic_seed_query_bundle(seed: str) -> Dict[str, Any]:
    token_vec, token_norm, token_kind = token_hash_embedding_for_global_cache(seed)
    bundle: Dict[str, Any] = {
        "embedding": token_vec,
        "embedding_norm": token_norm,
        "embedding_kind": token_kind,
        "token_hash_embedding": token_vec,
        "token_hash_embedding_norm": token_norm,
        "token_hash_embedding_kind": token_kind,
        "real_embedding": [],
        "real_embedding_norm": 0.0,
        "real_embedding_kind": None,
    }
    provider = str(os.getenv("GLOBAL_QA_EMBEDDING_PROVIDER") or "token_hash").strip().lower()
    if _env_bool("GLOBAL_QA_REAL_EMBEDDINGS_ENABLED", False) and provider not in {"", "token_hash", "token_hash_v1", "openai"}:
        real = real_embedding_for_global_cache(seed)
        if real is not None:
            bundle.update(
                {
                    "embedding": real[0],
                    "embedding_norm": real[1],
                    "embedding_kind": real[2],
                    "real_embedding": real[0],
                    "real_embedding_norm": real[1],
                    "real_embedding_kind": real[2],
                }
            )
    return bundle


def _topic_seed_lexical_score(row: GlobalQACache, seed: str) -> float:
    values = [
        str(row.topic or ""),
        str(row.canonical_question or ""),
        str(row.normalized_question or ""),
        *_load_json_list(getattr(row, "aliases_json", "[]")),
        *_load_json_list(getattr(row, "observed_safe_questions_json", "[]")),
    ]
    return max((_token_similarity(seed, value) for value in values if value), default=0.0)


def _topic_seed_prefetch_entries(
    session: Session,
    *,
    topic_seeds: List[str],
    now: datetime,
    excluded_ids: set[int],
    excluded_answer_hashes: set[str],
    limit: int,
) -> List[Dict[str, Any]]:
    if not topic_seeds or limit <= 0:
        return []
    seed_bundles = [(seed, _topic_seed_query_bundle(seed)) for seed in topic_seeds]
    row_limit = max(50, min(500, int(limit or 25) * 8))
    try:
        rows = list(
            session.exec(
                select(GlobalQACache)
                .where(GlobalQACache.status == "approved")
                .where(or_(GlobalQACache.scope == _GLOBAL_SCOPE, GlobalQACache.scope == None))  # noqa: E711
                .order_by(GlobalQACache.updated_at.desc(), GlobalQACache.id.desc())
                .limit(row_limit)
            ).all()
        )
    except (ProgrammingError, OperationalError):
        session.rollback()
        return []

    threshold = min(1.0, _env_float("GLOBAL_QA_TOPIC_SEED_MIN_SIMILARITY", 0.35, minimum=0.0))
    scored: List[Tuple[GlobalQACache, float]] = []
    for row in rows:
        if row.id is None or int(row.id) in excluded_ids:
            continue
        if str(row.answer_hash or "") and str(row.answer_hash or "") in excluded_answer_hashes:
            continue
        if not _sync_safe_row(row, now):
            continue
        score = 0.0
        for seed, bundle in seed_bundles:
            score = max(score, _score_row_against_query(row, seed, bundle), _topic_seed_lexical_score(row, seed))
        if score >= threshold:
            scored.append((row, score))

    try:
        from .ai.agents.reranker_agent import RerankerAgent

        ranked = RerankerAgent().rerank(scored)
    except Exception:
        ranked = sorted(scored, key=lambda item: item[1], reverse=True)

    entries: List[Dict[str, Any]] = []
    for row, _score in ranked:
        if len(entries) >= limit:
            break
        entry = _global_qa_row_sync_entry(row, entry_id=row.id, scope=_GLOBAL_SCOPE, now=now)
        if entry is None:
            continue
        entry.pop("scope", None)
        entries.append(entry)
        if row.id is not None:
            excluded_ids.add(int(row.id))
        if str(row.answer_hash or ""):
            excluded_answer_hashes.add(str(row.answer_hash or ""))
    return entries


def record_global_qa_tombstone(
    session: Session, global_cache_id: int, reason: str = "deleted",
    *, commit: bool = True,
) -> GlobalQATombstone:
    _ensure_schema_compat(session)
    existing = session.get(GlobalQACache, int(global_cache_id))
    if existing is not None:
        _invalidate_hot_cache_for_row(existing)
    row = GlobalQATombstone(
        global_cache_id=int(global_cache_id),
        deleted_at=utc_now(),
        reason=str(reason or "deleted"),
    )
    session.add(row)
    if commit:
        session.commit()
        session.refresh(row)
    return row


def build_global_knowledge_sync_payload(
    session: Session,
    since: Any = None,
    limit: int = 250,
    after_id: Any = None,
    user_id: Any = None,
    topic_seeds: Optional[List[str]] = None,
) -> dict:
    readiness = global_qa_schema_ready(session)
    if not readiness.get("ok"):
        logger.warning(
            "global_knowledge_sync_schema_not_ready",
            extra={
                "event": "global_knowledge_sync_schema_not_ready",
                "missing_tables": readiness.get("missing_tables") or [],
                "db_schema_ready": False,
            },
        )
        return _schema_not_ready_payload(readiness.get("missing_tables") or [])

    try:
        _ensure_schema_compat(session)
        since_dt = _parse_since(since)
        after_id_int = _parse_after_id(after_id)
        now = utc_now()
        safe_limit = max(1, min(int(limit or 250), 500))
        normalized_topic_seeds = _normalize_topic_seed_list(topic_seeds)
        query = (
            select(GlobalQACache)
            .where(or_(GlobalQACache.scope == _GLOBAL_SCOPE, GlobalQACache.scope == None))  # noqa: E711
            .order_by(GlobalQACache.updated_at.asc(), GlobalQACache.id.asc())
            .limit(safe_limit + 1)
        )
        if since_dt is not None:
            if after_id_int is not None:
                query = query.where(
                    or_(
                        GlobalQACache.updated_at > since_dt,
                        and_(GlobalQACache.updated_at == since_dt, GlobalQACache.id > after_id_int),
                    )
                )
            else:
                query = query.where(GlobalQACache.updated_at > since_dt)
        rows = list(session.exec(query).all())
        page_rows = rows[:safe_limit]
        has_more = len(rows) > safe_limit
        entries: List[Dict[str, Any]] = []
        tombstone_query = select(GlobalQATombstone)
        if since_dt is not None:
            tombstone_query = tombstone_query.where(GlobalQATombstone.deleted_at > since_dt)
        revoked_ids: List[int] = [
            int(row.global_cache_id)
            for row in session.exec(tombstone_query).all()
            if int(row.global_cache_id or 0) > 0
        ]
        user_entries = _user_global_qa_sync_entries(session, user_id=user_id, now=now, limit=safe_limit)
        user_entries.extend(
            _user_qa_sync_entries(
                session,
                user_id=user_id,
                now=now,
                limit=safe_limit,
            )
        )
        user_entries = _dedupe_sync_entries(user_entries)
    except (ProgrammingError, OperationalError) as exc:
        session.rollback()
        readiness = global_qa_schema_ready(session)
        logger.warning(
            "global_knowledge_sync_schema_not_ready",
            extra={
                "event": "global_knowledge_sync_schema_not_ready",
                "missing_tables": readiness.get("missing_tables") or [],
                "error_type": exc.__class__.__name__,
                "error_message": str(exc)[:240],
                "db_schema_ready": False,
            },
        )
        return _schema_not_ready_payload(readiness.get("missing_tables") or [])
    last_processed: Optional[GlobalQACache] = None
    for row in page_rows:
        last_processed = row
        if not _sync_safe_row(row, now):
            if row.id is not None:
                revoked_ids.append(int(row.id))
            safety_label = str(row.safety_label or "").strip().lower()
            if (
                safety_label in {"private", "personal_high_risk", "unsafe"}
                or is_private_or_personal_question(row.canonical_question)
                or is_private_or_personal_question(row.normalized_question)
                or is_live_or_current_question(row.canonical_question)
                or is_live_or_current_question(row.normalized_question)
            ):
                logger.warning(
                    "global_knowledge_sync_skipped_private_entry",
                    extra={"event": "global_knowledge_sync_skipped_private_entry", "global_cache_id": row.id},
                )
            continue
        entry = _global_qa_row_sync_entry(row, entry_id=row.id, scope=_GLOBAL_SCOPE, now=now)
        if entry is None:
            if row.id is not None:
                revoked_ids.append(int(row.id))
            logger.warning(
                "global_knowledge_sync_skipped_corrupt_entry",
                extra={"event": "global_knowledge_sync_skipped_corrupt_entry", "global_cache_id": row.id},
            )
            continue
        entry.pop("scope", None)
        entries.append(entry)
    if normalized_topic_seeds:
        existing_ids = {
            int(entry["id"])
            for entry in entries
            if str(entry.get("id") or "").isdigit()
        }
        existing_answer_hashes = {
            str(entry.get("answerHash") or "")
            for entry in entries
            if str(entry.get("answerHash") or "").strip()
        }
        entries.extend(
            _topic_seed_prefetch_entries(
                session,
                topic_seeds=normalized_topic_seeds,
                now=now,
                excluded_ids=existing_ids,
                excluded_answer_hashes=existing_answer_hashes,
                limit=_topic_seed_prefetch_limit(safe_limit),
            )
        )
        entries = _dedupe_sync_entries(entries)
    next_since, next_after_id = _row_cursor(last_processed) if last_processed is not None else (
        since_dt.isoformat() if since_dt else None,
        after_id_int,
    )
    logger.info(
        "global_knowledge_sync_completed",
        extra={
            "event": "global_knowledge_sync_completed",
            "cache_hit": False,
            "question_length": len(entries),
            "revoked_count": len(set(revoked_ids)),
            "has_more": has_more,
        },
    )
    return {
        "ok": True,
        "schemaReady": True,
        "entries": entries,
        "userEntries": user_entries,
        "count": len(entries),
        "nextSince": next_since,
        "nextAfterId": next_after_id,
        "hasMore": has_more,
        "serverTime": now.isoformat(),
        "revokedIds": sorted(set(revoked_ids)),
        "revocations": sorted(set(revoked_ids)),
        "since": since_dt.isoformat() if since_dt else None,
    }
