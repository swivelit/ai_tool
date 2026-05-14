from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

from sqlmodel import Session, select

from .models import GlobalQACache, GlobalQAObservation
from .openai_model_router import stable_user_hash
from .time_utils import utc_now

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[\w\u0B80-\u0BFF]+", re.UNICODE)
_LIVE_TERMS = {"latest", "today", "current", "live", "score", "scores", "news", "breaking", "now"}
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
    re.compile(r"(?i)\bmy\s+(?:email|phone|mobile|address|password|otp|account|bank|card|upi|aadhaar|ssn)\b"),
    re.compile(r"(?i)\b(?:\+?\d[\d\s().-]{7,}\d)\b"),
    re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
    re.compile(r"(?i)\b(?:my\s+name\s+is|i\s+am\s+from|i\s+live\s+at|remember\s+that)\b"),
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


def redact_sensitive_text(text: str) -> str:
    redacted = str(text or "")
    redacted = re.sub(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[REDACTED_EMAIL]", redacted)
    redacted = re.sub(r"\b(?:\+?\d[\d\s().-]{7,}\d)\b", "[REDACTED_PHONE]", redacted)
    redacted = re.sub(r"(?i)\b(?:bearer|token|password|otp)\s*[:=]?\s+[A-Za-z0-9._~+/=-]+", "[REDACTED_SECRET]", redacted)
    return redacted.strip()


def is_live_or_current_question(text: str) -> bool:
    tokens = set(_TOKEN_RE.findall(normalize_question(text)))
    return bool(tokens & _LIVE_TERMS)


def is_private_or_personal_question(text: str) -> bool:
    raw = str(text or "")
    if any(pattern.search(raw) for pattern in _PRIVATE_PATTERNS):
        return True
    normalized = normalize_question(raw)
    if re.search(r"\b(my|our)\s+(?:health|body|symptoms|medical|legal|money|bank|tax|salary|income)\b", normalized):
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
        score = _question_similarity(question, row.normalized_question, query_embedding, _load_embedding(row))
        if score > best_score:
            best = row
            best_score = score
    if best is None or best_score < _min_similarity():
        return None

    best.hit_count = int(best.hit_count or 0) + 1
    best.last_seen_at = now
    best.updated_at = now
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
        score = _question_similarity(normalized_question, row.normalized_question, embedding, _load_embedding(row))
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

    if not is_cacheable_global_question(question, answer):
        logger.info(
            "global_cache_rejected",
            extra={"event": "global_cache_rejected", "reason": "not_cacheable"},
        )
        return {"ok": False, "skipped": True, "reason": "not_cacheable"}

    now = utc_now()
    normalized = normalize_question(question)
    q_hash = question_hash(question)
    a_hash = answer_hash(answer)
    user_hash = stable_user_hash(user_id)
    embedding = embed_question_for_global_cache(normalized)
    embedding_json = json.dumps(embedding[0], ensure_ascii=False)
    expires_at = now + timedelta(days=_ttl_days())

    candidate, similarity = _find_candidate(session, normalized, embedding)
    if candidate is None:
        candidate = GlobalQACache(
            canonical_question=redact_sensitive_text(question),
            normalized_question=normalized,
            answer=redact_sensitive_text(answer),
            answer_language=_infer_answer_language(answer),
            topic=_topic_from_question(question),
            status="candidate",
            hit_count=1,
            distinct_user_count=1,
            observed_question_count=1,
            source_question_hashes_json=json.dumps([q_hash], ensure_ascii=False),
            answer_hash=a_hash,
            embedding_json=embedding_json,
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
        hashes = _source_hashes(candidate)
        if q_hash not in hashes:
            hashes.append(q_hash)
        candidate.hit_count = int(candidate.hit_count or 0) + 1
        candidate.observed_question_count = int(candidate.observed_question_count or 0) + 1
        candidate.source_question_hashes_json = json.dumps(hashes[-100:], ensure_ascii=False)
        candidate.last_seen_at = now
        candidate.updated_at = now
        candidate.expires_at = expires_at
        if not candidate.answer or candidate.status == "candidate":
            candidate.answer = redact_sensitive_text(answer)
            candidate.answer_hash = a_hash
            candidate.answer_language = _infer_answer_language(answer)
            candidate.model_used = model_used or candidate.model_used
        session.add(candidate)
        session.commit()
        session.refresh(candidate)

    observation = GlobalQAObservation(
        global_cache_id=int(candidate.id),
        user_id_hash=user_hash,
        question_hash=q_hash,
        normalized_question=normalized,
        similarity_score=float(similarity),
        backend_answer_hash=a_hash,
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
    promoted = promote_candidate_if_threshold_met(session, int(candidate.id))
    return {
        "ok": True,
        "candidate_id": candidate.id,
        "observation_id": observation.id,
        "status": candidate.status,
        "promoted": promoted,
    }


def promote_candidate_if_threshold_met(session: Session, candidate_id: int) -> bool:
    candidate = session.get(GlobalQACache, candidate_id)
    if not candidate or candidate.status != "candidate":
        return False
    if int(candidate.hit_count or 0) < _promote_hits():
        return False
    if _require_distinct_users() and int(candidate.distinct_user_count or 0) < _promote_hits():
        return False
    candidate.status = "approved"
    candidate.confidence = max(float(candidate.confidence or 0.0), 0.90)
    candidate.reviewed_at = candidate.reviewed_at
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


def build_global_knowledge_sync_payload(session: Session, since: Any = None, limit: int = 250) -> dict:
    since_dt = _parse_since(since)
    now = utc_now()
    safe_limit = max(1, min(int(limit or 250), 500))
    query = (
        select(GlobalQACache)
        .where(GlobalQACache.status == "approved")
        .order_by(GlobalQACache.updated_at.asc())
    )
    if since_dt is not None:
        query = query.where(GlobalQACache.updated_at > since_dt)
    rows = list(session.exec(query).all())
    entries: List[Dict[str, Any]] = []
    for row in rows:
        if len(entries) >= safe_limit:
            break
        if not _not_expired(row, now):
            continue
        if row.safety_label in {"private", "personal_high_risk", "unsafe"}:
            continue
        entries.append(
            {
                "id": row.id,
                "canonicalQuestion": row.canonical_question,
                "normalizedQuestion": row.normalized_question,
                "answer": row.answer,
                "answerLanguage": row.answer_language,
                "topic": row.topic,
                "answerHash": row.answer_hash,
                "embedding": json.loads(row.embedding_json or "[]") if row.embedding_json else [],
                "embeddingNorm": row.embedding_norm,
                "confidence": row.confidence,
                "safetyLabel": row.safety_label,
                "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
                "expiresAt": row.expires_at.isoformat() if row.expires_at else None,
            }
        )
    logger.info(
        "global_knowledge_sync_completed",
        extra={"event": "global_knowledge_sync_completed", "cache_hit": False, "question_length": len(entries)},
    )
    return {"ok": True, "entries": entries, "count": len(entries), "serverTime": now.isoformat(), "since": since_dt.isoformat() if since_dt else None}

