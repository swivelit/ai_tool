from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, inspect, or_, text
from sqlmodel import Session, select

from .models import GlobalQACache, GlobalQAObservation, GlobalQATombstone
from .openai_model_router import stable_user_hash
from .time_utils import utc_now

logger = logging.getLogger(__name__)
_SCHEMA_COMPAT_LOCK = threading.Lock()
_SCHEMA_COMPAT_READY = False

_TOKEN_RE = re.compile(r"[\w\u0B80-\u0BFF]+", re.UNICODE)
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
    "weather",
    "forecast",
    "tomorrow",
    "yesterday",
    "result",
    "results",
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
}
_LIVE_PHRASES = {
    "exchange rate",
    "gold rate",
    "petrol price",
    "near me",
}
GLOBAL_QA_EMBEDDING_KIND = "token_hash_v1"
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
            if "embedding_kind" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN embedding_kind VARCHAR NOT NULL DEFAULT 'token_hash_v1'"))
            if "observed_safe_questions_json" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN observed_safe_questions_json VARCHAR NOT NULL DEFAULT '[]'"))
            if "aliases_json" not in cache_columns:
                session.exec(text("ALTER TABLE global_qa_cache ADD COLUMN aliases_json VARCHAR NOT NULL DEFAULT '[]'"))
        if not inspector.has_table("global_qa_tombstone"):
            GlobalQATombstone.__table__.create(bind, checkfirst=True)
        if inspector.has_table("global_qa_observation"):
            observation_columns = {column["name"] for column in inspector.get_columns("global_qa_observation")}
            if "answer_similarity_score" not in observation_columns:
                session.exec(text("ALTER TABLE global_qa_observation ADD COLUMN answer_similarity_score FLOAT NOT NULL DEFAULT 1.0"))
            if "conflicting_answer_hashes_json" not in observation_columns:
                session.exec(text("ALTER TABLE global_qa_observation ADD COLUMN conflicting_answer_hashes_json VARCHAR NOT NULL DEFAULT '[]'"))
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


def embed_question_for_global_cache(text: str) -> Tuple[List[float], float]:
    tokens = _semantic_tokens(text)
    vec = _hash_embedding(tokens)
    return vec, _vector_norm(vec)


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


def _load_embedding(row: GlobalQACache) -> Optional[Tuple[List[float], float]]:
    if str(getattr(row, "embedding_kind", "") or GLOBAL_QA_EMBEDDING_KIND) != GLOBAL_QA_EMBEDDING_KIND:
        return None
    try:
        vec = [float(x) for x in json.loads(row.embedding_json or "[]")]
    except Exception:
        vec = []
    if not vec:
        return None
    return vec, float(row.embedding_norm or _vector_norm(vec))


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


def lookup_approved_global_cache(session: Session, question: str, reply_language: Optional[str] = None) -> Optional[dict]:
    if not _enabled() or not str(question or "").strip():
        return None
    _ensure_schema_compat(session)
    if is_live_or_current_question(question) or is_private_or_personal_question(question):
        return None

    language = _answer_language(reply_language)
    now = utc_now()
    query_embedding = embed_question_for_global_cache(question)
    rows = list(
        session.exec(
            select(GlobalQACache)
            .where(GlobalQACache.status == "approved")
            .order_by(GlobalQACache.updated_at.desc())
        ).all()
    )
    best: Optional[GlobalQACache] = None
    best_score = 0.0
    for row in rows:
        if not _not_expired(row, now):
            continue
        if row.safety_label in {"private", "personal_high_risk", "unsafe"}:
            continue
        if language and row.answer_language not in {language, "en"}:
            continue
        row_embedding = _load_embedding(row)
        score = max(
            (
                _question_similarity(question, variant, query_embedding, row_embedding)
                for variant in _row_question_variants(row)
            ),
            default=0.0,
        )
        if score > best_score:
            best = row
            best_score = score
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
        },
    )
    return {
        "id": best.id,
        "answer": best.answer,
        "answer_language": best.answer_language,
        "canonical_question": best.canonical_question,
        "normalized_question": best.normalized_question,
        "similarity_score": best_score,
        "confidence": best.confidence,
        "answer_hash": best.answer_hash,
        "topic": best.topic,
    }


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


def _find_candidate(session: Session, normalized_question: str, embedding: Tuple[List[float], float]) -> Tuple[Optional[GlobalQACache], float]:
    rows = list(
        session.exec(
            select(GlobalQACache)
            .where(GlobalQACache.status.in_(["candidate", "approved"]))
            .order_by(GlobalQACache.updated_at.desc())
        ).all()
    )
    best: Optional[GlobalQACache] = None
    best_score = 0.0
    for row in rows:
        if not _not_expired(row):
            continue
        row_embedding = _load_embedding(row)
        score = max(
            (
                _question_similarity(normalized_question, variant, embedding, row_embedding)
                for variant in _row_question_variants(row)
            ),
            default=0.0,
        )
        if score > best_score:
            best = row
            best_score = score
    if best is not None and best_score >= _min_similarity():
        return best, best_score
    return None, 0.0


def record_backend_openai_answer(
    session: Session,
    user_id: Any,
    question: str,
    answer: str,
    model_used: Optional[str],
    request_id: Optional[str] = None,
) -> dict:
    if not _enabled():
        return {"ok": False, "skipped": True, "reason": "disabled"}
    _ensure_schema_compat(session)

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
    embedding = embed_question_for_global_cache(normalized)
    embedding_json = json.dumps(embedding[0], ensure_ascii=False)
    expires_at = now + timedelta(days=_ttl_days())

    candidate, similarity = _find_candidate(session, normalized, embedding)
    if candidate is None:
        candidate = GlobalQACache(
            canonical_question=canonical_question,
            normalized_question=normalized,
            answer=redact_sensitive_text(answer),
            answer_language=_infer_answer_language(answer),
            topic=_topic_from_question(question),
            status="candidate",
            hit_count=1,
            distinct_user_count=1,
            observed_question_count=1,
            source_question_hashes_json=json.dumps([q_hash], ensure_ascii=False),
            observed_safe_questions_json=_dump_json_list([safe_variant] if safe_variant else []),
            aliases_json=_dump_json_list(safe_aliases),
            answer_hash=a_hash,
            embedding_json=embedding_json,
            embedding_kind=GLOBAL_QA_EMBEDDING_KIND,
            embedding_norm=embedding[1],
            confidence=0.0,
            safety_label="general",
            model_used=model_used,
            first_seen_at=now,
            last_seen_at=now,
            expires_at=expires_at,
            created_at=now,
            updated_at=now,
        )
        session.add(candidate)
        session.commit()
        session.refresh(candidate)
        similarity = 1.0
    else:
        answer_similarity = _answer_similarity(candidate.answer, answer)
        answer_conflict = bool(candidate.answer_hash and a_hash != candidate.answer_hash and answer_similarity < _min_answer_similarity())
        hashes = _source_hashes(candidate)
        if q_hash not in hashes:
            hashes.append(q_hash)
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
        "observation_id": observation.id,
        "status": candidate.status,
        "promoted": promoted,
    }


def promote_candidate_if_threshold_met(session: Session, candidate_id: int) -> bool:
    _ensure_schema_compat(session)
    candidate = session.get(GlobalQACache, candidate_id)
    if not candidate or candidate.status != "candidate":
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
    logger.info(
        "global_cache_promoted",
        extra={
            "event": "global_cache_promoted",
            "answer_hash": candidate.answer_hash,
            "cache_hit": False,
        },
    )
    return True


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


def record_global_qa_tombstone(session: Session, global_cache_id: int, reason: str = "deleted") -> GlobalQATombstone:
    _ensure_schema_compat(session)
    row = GlobalQATombstone(
        global_cache_id=int(global_cache_id),
        deleted_at=utc_now(),
        reason=str(reason or "deleted"),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def build_global_knowledge_sync_payload(
    session: Session,
    since: Any = None,
    limit: int = 250,
    after_id: Any = None,
) -> dict:
    _ensure_schema_compat(session)
    since_dt = _parse_since(since)
    after_id_int = _parse_after_id(after_id)
    now = utc_now()
    safe_limit = max(1, min(int(limit or 250), 500))
    query = (
        select(GlobalQACache)
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
        embedding_kind = str(getattr(row, "embedding_kind", "") or GLOBAL_QA_EMBEDDING_KIND)
        if embedding_kind != GLOBAL_QA_EMBEDDING_KIND:
            embedding = []
            embedding_norm = 0.0
        else:
            try:
                parsed_embedding = json.loads(row.embedding_json or "[]") if row.embedding_json else []
                embedding = [float(value) for value in parsed_embedding] if isinstance(parsed_embedding, list) else []
                embedding_norm = float(row.embedding_norm or _vector_norm(embedding))
            except Exception:
                if row.id is not None:
                    revoked_ids.append(int(row.id))
                logger.warning(
                    "global_knowledge_sync_skipped_corrupt_entry",
                    extra={"event": "global_knowledge_sync_skipped_corrupt_entry", "global_cache_id": row.id},
                )
                continue
        aliases = _sync_safe_variants(
            _load_json_list(getattr(row, "aliases_json", "[]")) + _alias_variants(row.canonical_question)
        )
        observed_safe_questions = _sync_safe_variants(
            _load_json_list(getattr(row, "observed_safe_questions_json", "[]"))
        )
        entries.append(
            {
                "id": row.id,
                "canonicalQuestion": row.canonical_question,
                "normalizedQuestion": row.normalized_question,
                "aliases": aliases,
                "observedSafeQuestions": observed_safe_questions,
                "answer": row.answer,
                "answerLanguage": row.answer_language,
                "topic": row.topic,
                "answerHash": row.answer_hash,
                "embedding": embedding,
                "embeddingNorm": embedding_norm,
                "embeddingKind": embedding_kind,
                "confidence": row.confidence,
                "safetyLabel": row.safety_label,
                "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
                "expiresAt": row.expires_at.isoformat() if row.expires_at else None,
            }
        )
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
        "entries": entries,
        "count": len(entries),
        "nextSince": next_since,
        "nextAfterId": next_after_id,
        "hasMore": has_more,
        "serverTime": now.isoformat(),
        "revokedIds": sorted(set(revoked_ids)),
        "since": since_dt.isoformat() if since_dt else None,
    }
