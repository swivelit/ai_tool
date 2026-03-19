from __future__ import annotations

import csv
import hashlib
import json
import logging
import math
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlmodel import Session

from .models import Conversation, DailyRoutine, Item, QACache, RagEmbedding, User, UserProfile

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore

try:
    from config import (
        FAST_RAG_DATASET_PATH,
        OPENAI_API_KEY,
        RAG_ENABLED,
        RAG_EMBED_CACHE_SIZE,
        RAG_EMBEDDING_MODEL,
        RAG_ENABLE_FAST_RAG_SEMANTIC,
        RAG_ENABLE_FOLLOWUP_REWRITE,
        RAG_FAST_RAG_MIN_SCORE,
        RAG_MAX_CACHE_CANDIDATES,
        RAG_MAX_CONTEXT_CHARS,
        RAG_MAX_CONVERSATION_CANDIDATES,
        RAG_MAX_ITEM_CANDIDATES,
        RAG_MIN_SCORE,
        RAG_RECENCY_HALF_LIFE_DAYS,
        RAG_TOP_K,
    )
except Exception:  # pragma: no cover
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
    FAST_RAG_DATASET_PATH = str(Path(__file__).resolve().parent.parent / "data" / "fast_rag_replies.csv")

    def _env_bool(name: str, default: bool) -> bool:
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}

    def _env_int(name: str, default: int) -> int:
        try:
            return int(str(os.getenv(name, default)).strip())
        except Exception:
            return int(default)

    def _env_float(name: str, default: float) -> float:
        try:
            return float(str(os.getenv(name, default)).strip())
        except Exception:
            return float(default)

    RAG_ENABLED = _env_bool("RAG_ENABLED", True)
    RAG_EMBEDDING_MODEL = os.getenv("RAG_EMBEDDING_MODEL", "text-embedding-3-small")
    RAG_ENABLE_FAST_RAG_SEMANTIC = _env_bool("RAG_ENABLE_FAST_RAG_SEMANTIC", True)
    RAG_ENABLE_FOLLOWUP_REWRITE = _env_bool("RAG_ENABLE_FOLLOWUP_REWRITE", True)
    RAG_FAST_RAG_MIN_SCORE = _env_float("RAG_FAST_RAG_MIN_SCORE", 0.86)
    RAG_MAX_ITEM_CANDIDATES = max(20, _env_int("RAG_MAX_ITEM_CANDIDATES", 250))
    RAG_MAX_CONVERSATION_CANDIDATES = max(10, _env_int("RAG_MAX_CONVERSATION_CANDIDATES", 80))
    RAG_MAX_CACHE_CANDIDATES = max(10, _env_int("RAG_MAX_CACHE_CANDIDATES", 60))
    RAG_TOP_K = max(2, _env_int("RAG_TOP_K", 6))
    RAG_MIN_SCORE = _env_float("RAG_MIN_SCORE", 0.56)
    RAG_MAX_CONTEXT_CHARS = max(800, _env_int("RAG_MAX_CONTEXT_CHARS", 3200))
    RAG_RECENCY_HALF_LIFE_DAYS = max(0.1, _env_float("RAG_RECENCY_HALF_LIFE_DAYS", 14.0))
    RAG_EMBED_CACHE_SIZE = max(256, _env_int("RAG_EMBED_CACHE_SIZE", 4096))

CURRENT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = CURRENT_DIR.parent
DATA_DIR = BACKEND_ROOT / "data"
FAST_RAG_DATASET_PATH = Path(FAST_RAG_DATASET_PATH)
LOCAL_RAG_KEYWORDS_PATH = DATA_DIR / "local_rag_keywords.csv"
LOCAL_RAG_SYNONYMS_PATH = DATA_DIR / "local_rag_synonyms.csv"


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.getenv(name, default)).strip())
    except Exception:
        return int(default)


def _env_float(name: str, default: float) -> float:
    try:
        return float(str(os.getenv(name, default)).strip())
    except Exception:
        return float(default)


FAST_RAG_AUTO_RELOAD = _env_bool("FAST_RAG_AUTO_RELOAD", True)
FAST_RAG_STRONG_MATCH_THRESHOLD = _env_float("FAST_RAG_STRONG_MATCH_THRESHOLD", 0.9)
FAST_RAG_PREFIX_MATCH_THRESHOLD = _env_float("FAST_RAG_PREFIX_MATCH_THRESHOLD", 0.965)
FAST_RAG_CACHE_MATCH_THRESHOLD = _env_float("FAST_RAG_CACHE_MATCH_THRESHOLD", 0.94)
FAST_RAG_MAX_CACHE_ROWS = max(5, _env_int("FAST_RAG_MAX_CACHE_ROWS", 40))


DEFAULT_FAST_RAG_ROWS = [
    {
        "query": "hi",
        "label": "greeting",
        "route": "instant",
        "priority": "100",
        "tags": "greeting|smalltalk",
        "required_terms": "",
        "blocked_terms": "schedule|reminder|task|todo|plan|today|tomorrow",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "hello",
        "label": "greeting",
        "route": "instant",
        "priority": "100",
        "tags": "greeting|smalltalk",
        "required_terms": "",
        "blocked_terms": "schedule|reminder|task|todo|plan|today|tomorrow",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "vanakkam",
        "label": "greeting",
        "route": "instant",
        "priority": "100",
        "tags": "greeting|smalltalk",
        "required_terms": "",
        "blocked_terms": "schedule|reminder|task|todo|plan|today|tomorrow",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "how are you",
        "label": "smalltalk",
        "route": "instant",
        "priority": "95",
        "tags": "smalltalk|wellbeing",
        "required_terms": "",
        "blocked_terms": "",
        "english_template": "I am doing well, {user_name}. How can I help you today?",
        "tamil_template": "நான் நல்லா இருக்கேன் {user_name}. இன்று என்ன உதவி வேண்டும்?",
        "theni_tamil_template": "நான் நல்லா இருக்கேன் {user_name}. இன்று என்ன உதவி வேண்டும்?",
    },
    {
        "query": "thanks",
        "label": "smalltalk",
        "route": "instant",
        "priority": "92",
        "tags": "smalltalk|gratitude",
        "required_terms": "",
        "blocked_terms": "",
        "english_template": "You're welcome, {user_name}.",
        "tamil_template": "பரவாயில்லை {user_name}, உதவியது சந்தோஷம்.",
        "theni_tamil_template": "பரவாயில்லை {user_name}, உதவியது சந்தோஷம்.",
    },
    {
        "query": "what is my name",
        "label": "profile",
        "route": "instant",
        "priority": "96",
        "tags": "profile|identity",
        "required_terms": "name",
        "blocked_terms": "assistant",
        "english_template": "Your name is {user_name}.",
        "tamil_template": "உங்கள் பெயர் {user_name}.",
        "theni_tamil_template": "உங்கள் பெயர் {user_name}.",
    },
    {
        "query": "what is my place",
        "label": "profile",
        "route": "instant",
        "priority": "90",
        "tags": "profile|place|location",
        "required_terms": "place",
        "blocked_terms": "assistant",
        "english_template": "Your place is {place}.",
        "tamil_template": "உங்கள் இடம் {place}.",
        "theni_tamil_template": "உங்கள் இடம் {place}.",
    },
    {
        "query": "who are you",
        "label": "assistant_identity",
        "route": "instant",
        "priority": "96",
        "tags": "assistant|identity|help",
        "required_terms": "",
        "blocked_terms": "my name|my place",
        "english_template": "I'm {assistant_name}, your assistant. I can help with reminders, schedules, routines, and quick answers.",
        "tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, தினசரி பழக்கம், மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
        "theni_tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, தினசரி பழக்கம், மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
    },
    {
        "query": "help",
        "label": "assistant_identity",
        "route": "instant",
        "priority": "88",
        "tags": "assistant|help|capabilities",
        "required_terms": "",
        "blocked_terms": "",
        "english_template": "I'm {assistant_name}, your assistant. I can help with reminders, schedules, routines, and quick answers.",
        "tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, தினசரி பழக்கம், மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
        "theni_tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, தினசரி பழக்கம், மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
    },
]

DEFAULT_KEYWORD_ROWS = [
    {"intent": "schedule", "scope": "base", "keywords": "schedule|reminder|reminders|task|tasks|todo|plan|plans|upcoming|நினைவூட்டல்|நினைவூட்டல்கள்|அட்டவணை|டாஸ்க்|வேலை"},
    {"intent": "schedule", "scope": "today", "keywords": "today|இன்று"},
    {"intent": "schedule", "scope": "tomorrow", "keywords": "tomorrow|நாளை"},
    {"intent": "routine", "scope": "wake", "keywords": "wake|wake up|get up|wakeup|morning time|எழு|எழுந்திரு|எழுவேன்"},
    {"intent": "routine", "scope": "sleep", "keywords": "sleep|sleep time|bedtime|go to bed|தூங்கு|தூக்கம்|தூங்க"},
    {"intent": "routine", "scope": "work", "keywords": "work|office|job|work time|working hours|office time|வேலை|ஆபீஸ்"},
    {"intent": "routine", "scope": "habits", "keywords": "habit|habits|daily habits|routine habits|பழக்கம்|பழக்கங்கள்"},
    {"intent": "routine", "scope": "summary", "keywords": "routine|daily routine|day routine|routine summary|நாள் திட்டம்|தினசரி திட்டம்"},
]

DEFAULT_SYNONYM_ROWS = [
    {"root": "greeting", "synonyms": "hi|hello|hey|vanakkam|வணக்கம்|ஹலோ"},
    {"root": "reminder", "synonyms": "reminder|task|todo|plan|schedule|நினைவூட்டல்|அட்டவணை"},
    {"root": "routine", "synonyms": "routine|daily routine|habit|habits|day plan|தினசரி|பழக்கம்"},
    {"root": "wake", "synonyms": "wake|wakeup|get up|morning|எழு|எழுந்திரு"},
    {"root": "sleep", "synonyms": "sleep|bed|bedtime|தூங்கு|தூக்கம்"},
    {"root": "work", "synonyms": "work|office|job|career|வேலை|ஆபீஸ்"},
    {"root": "name", "synonyms": "name|identity|called|பெயர்"},
    {"root": "place", "synonyms": "place|location|town|native|ஊர்|இடம்"},
    {"root": "assistant", "synonyms": "assistant|ai|bot|helper|உதவியாளர்"},
]


@dataclass
class FastRAGRow:
    query: str
    label: str
    route: str
    priority: int
    english_template: str
    tamil_template: str
    theni_tamil_template: str
    tags: Tuple[str, ...] = ()
    required_terms: Tuple[str, ...] = ()
    blocked_terms: Tuple[str, ...] = ()


@dataclass
class KeywordRule:
    intent: str
    scope: str
    keywords: Tuple[str, ...]


@dataclass
class RagSnippet:
    source_type: str
    source_id: str
    updated_at: datetime
    text: str
    score: float
    score_semantic: float
    score_lexical: float
    score_recency: float


class LocalRAGService:
    def __init__(self, dataset_path: Optional[Path] = None) -> None:
        self.dataset_path = dataset_path or FAST_RAG_DATASET_PATH
        self.keywords_path = self.dataset_path.parent / LOCAL_RAG_KEYWORDS_PATH.name
        self.synonyms_path = self.dataset_path.parent / LOCAL_RAG_SYNONYMS_PATH.name
        self.rows: List[FastRAGRow] = []
        self.keyword_rules: List[KeywordRule] = []
        self.synonym_map: Dict[str, Set[str]] = {}
        self._file_state: Dict[Path, Optional[int]] = {}

        self._semantic_enabled = bool(RAG_ENABLED and OpenAI is not None and bool(str(OPENAI_API_KEY or "").strip()))
        self._embedding_model = str(RAG_EMBEDDING_MODEL or "text-embedding-3-small").strip() or "text-embedding-3-small"
        self._openai = OpenAI(api_key=OPENAI_API_KEY) if self._semantic_enabled else None
        self._embed_cache: "OrderedDict[str, Tuple[List[float], float, float]]" = OrderedDict()
        self._fast_row_vectors: Dict[str, Tuple[List[float], float]] = {}
        self._fast_row_vectors_state: Optional[Dict[Path, Optional[int]]] = None

        self.reload(force=True)

    def reload(self, *, force: bool = False) -> None:
        self._ensure_default_files()
        current_state = self._file_mtime_state()
        if not force and self.rows and current_state == self._file_state:
            return

        self.rows = self._load_rows()
        self.keyword_rules = self._load_keyword_rules()
        self.synonym_map = self._load_synonyms()
        self._file_state = current_state
        self._fast_row_vectors.clear()
        self._fast_row_vectors_state = None

    def _reload_if_needed(self) -> None:
        if FAST_RAG_AUTO_RELOAD:
            self.reload(force=False)

    def _file_mtime_state(self) -> Dict[Path, Optional[int]]:
        state: Dict[Path, Optional[int]] = {}
        for path in (self.dataset_path, self.keywords_path, self.synonyms_path):
            try:
                state[path] = path.stat().st_mtime_ns
            except OSError:
                state[path] = None
        return state

    def _ensure_default_files(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._write_csv_if_missing(
            self.dataset_path,
            [
                "query",
                "label",
                "route",
                "priority",
                "tags",
                "required_terms",
                "blocked_terms",
                "english_template",
                "tamil_template",
                "theni_tamil_template",
            ],
            DEFAULT_FAST_RAG_ROWS,
        )
        self._write_csv_if_missing(self.keywords_path, ["intent", "scope", "keywords"], DEFAULT_KEYWORD_ROWS)
        self._write_csv_if_missing(self.synonyms_path, ["root", "synonyms"], DEFAULT_SYNONYM_ROWS)

    @staticmethod
    def _write_csv_if_missing(path: Path, fieldnames: Sequence[str], rows: Sequence[Dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            return
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(fieldnames))
            writer.writeheader()
            for row in rows:
                writer.writerow({key: row.get(key, "") for key in fieldnames})

    @staticmethod
    def _parse_multi_value(raw: Any) -> Tuple[str, ...]:
        text = str(raw or "").strip()
        if not text:
            return ()
        return tuple(part.strip() for part in re.split(r"[|,]", text) if part.strip())

    def _load_rows(self) -> List[FastRAGRow]:
        rows: List[FastRAGRow] = []
        if not self.dataset_path.exists():
            return rows
        with self.dataset_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                query = str(row.get("query", "")).strip()
                if not query:
                    continue
                try:
                    priority = int(str(row.get("priority", "50") or "50").strip())
                except Exception:
                    priority = 50
                rows.append(
                    FastRAGRow(
                        query=query,
                        label=str(row.get("label", "local")).strip() or "local",
                        route=str(row.get("route", "instant")).strip() or "instant",
                        priority=priority,
                        english_template=str(row.get("english_template", "")).strip(),
                        tamil_template=str(row.get("tamil_template", "")).strip(),
                        theni_tamil_template=str(row.get("theni_tamil_template", "")).strip() or str(row.get("tamil_template", "")).strip(),
                        tags=self._parse_multi_value(row.get("tags", "")),
                        required_terms=self._parse_multi_value(row.get("required_terms", "")),
                        blocked_terms=self._parse_multi_value(row.get("blocked_terms", "")),
                    )
                )
        rows.sort(key=lambda row: (-row.priority, row.query.lower()))
        return rows

    def _load_keyword_rules(self) -> List[KeywordRule]:
        rules: List[KeywordRule] = []
        if not self.keywords_path.exists():
            return rules
        with self.keywords_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                intent = str(row.get("intent", "")).strip()
                scope = str(row.get("scope", "default")).strip() or "default"
                keywords = self._parse_multi_value(row.get("keywords", ""))
                if not intent or not keywords:
                    continue
                rules.append(KeywordRule(intent=intent, scope=scope, keywords=keywords))
        return rules

    def _load_synonyms(self) -> Dict[str, Set[str]]:
        groups: Dict[str, Set[str]] = {}
        if not self.synonyms_path.exists():
            return groups
        with self.synonyms_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                root = self.normalize_lookup_text(row.get("root", ""))
                aliases = {root} if root else set()
                aliases.update(
                    self.normalize_lookup_text(part)
                    for part in self._parse_multi_value(row.get("synonyms", ""))
                    if self.normalize_lookup_text(part)
                )
                if aliases:
                    for alias in aliases:
                        groups.setdefault(alias, set()).update(aliases)
        return groups

    @staticmethod
    def normalize_lookup_text(text: Any) -> str:
        parts = re.findall(r"[a-z0-9_\u0B80-\u0BFF]+", str(text or "").lower())
        return " ".join(parts)

    @classmethod
    def _tokens(cls, text: Any) -> List[str]:
        normalized = cls.normalize_lookup_text(text)
        return [token for token in normalized.split() if token]

    def _expand_tokens(self, tokens: Iterable[str]) -> Set[str]:
        expanded: Set[str] = set()
        for token in tokens:
            normalized = self.normalize_lookup_text(token)
            if not normalized:
                continue
            expanded.add(normalized)
            expanded.update(self.synonym_map.get(normalized, set()))
        return expanded

    def _contains_phrase(self, message: str, phrase: str) -> bool:
        normalized_message = self.normalize_lookup_text(message)
        normalized_phrase = self.normalize_lookup_text(phrase)
        if not normalized_message or not normalized_phrase:
            return False
        return normalized_phrase == normalized_message or f" {normalized_phrase} " in f" {normalized_message} "

    @staticmethod
    def _string_similarity(left: str, right: str) -> float:
        if not left or not right:
            return 0.0
        return SequenceMatcher(None, left, right).ratio()

    @staticmethod
    def _set_overlap(left: Set[str], right: Set[str]) -> float:
        if not left and not right:
            return 1.0
        if not left or not right:
            return 0.0
        return len(left & right) / max(1, len(left | right))

    @staticmethod
    def _sha256(text: str) -> str:
        return hashlib.sha256((text or "").encode("utf-8", errors="ignore")).hexdigest()

    @staticmethod
    def _vector_norm(vec: List[float]) -> float:
        return math.sqrt(sum((float(x) * float(x)) for x in (vec or []))) if vec else 0.0

    @staticmethod
    def _cosine(vec_a: List[float], norm_a: float, vec_b: List[float], norm_b: float) -> float:
        if not vec_a or not vec_b:
            return 0.0
        if norm_a <= 0.0:
            norm_a = LocalRAGService._vector_norm(vec_a)
        if norm_b <= 0.0:
            norm_b = LocalRAGService._vector_norm(vec_b)
        if norm_a <= 0.0 or norm_b <= 0.0:
            return 0.0
        dot = 0.0
        for i in range(min(len(vec_a), len(vec_b))):
            dot += float(vec_a[i]) * float(vec_b[i])
        return float(dot) / float(norm_a * norm_b)

    def _lru_get(self, key: str) -> Optional[Tuple[List[float], float]]:
        hit = self._embed_cache.get(key)
        if hit is None:
            return None
        vec, norm, _ts = hit
        self._embed_cache.move_to_end(key)
        return vec, norm

    def _lru_set(self, key: str, vec: List[float], norm: float) -> None:
        self._embed_cache[key] = (vec, norm, time.time())
        self._embed_cache.move_to_end(key)
        while len(self._embed_cache) > int(RAG_EMBED_CACHE_SIZE or 4096):
            self._embed_cache.popitem(last=False)

    def _openai_embed(self, texts: List[str]) -> List[List[float]]:
        if not self._semantic_enabled or self._openai is None or not texts:
            return []
        try:
            resp = self._openai.embeddings.create(model=self._embedding_model, input=texts)
            data = getattr(resp, "data", None)
            if data is None and isinstance(resp, dict):
                data = resp.get("data")
            vectors: List[List[float]] = []
            for item in data or []:
                emb = getattr(item, "embedding", None)
                if emb is None and isinstance(item, dict):
                    emb = item.get("embedding")
                vectors.append([float(x) for x in (emb or [])])
            return vectors
        except Exception:
            return []

    def _embed_query(self, text: str) -> Optional[Tuple[List[float], float]]:
        clean = str(text or "").strip()
        if not clean:
            return None
        key = f"query::{self._sha256(clean)}"
        cached = self._lru_get(key)
        if cached is not None:
            return cached
        vectors = self._openai_embed([clean])
        if not vectors:
            return None
        vec = vectors[0]
        norm = self._vector_norm(vec)
        self._lru_set(key, vec, norm)
        return vec, norm

    def _get_or_create_embedding(
        self,
        session: Optional[Session],
        *,
        user_id: Optional[int],
        source_type: str,
        source_id: str,
        content_text: str,
        updated_at: Optional[datetime],
    ) -> Optional[Tuple[List[float], float, str]]:
        if not self._semantic_enabled:
            return None
        content_text = str(content_text or "").strip()
        if not content_text:
            return None
        stamp = updated_at.isoformat() if isinstance(updated_at, datetime) else ""
        base = f"u={user_id or 0}|t={source_type}|id={source_id}|ts={stamp}|{content_text}"
        content_hash = self._sha256(base)

        cached = self._lru_get(content_hash)
        if cached is not None:
            vec, norm = cached
            return vec, norm, content_hash

        existing = None
        if session is not None:
            try:
                existing = session.exec(select(RagEmbedding).where(RagEmbedding.content_hash == content_hash)).first()
            except Exception:
                existing = None
        if existing is not None:
            try:
                vec = [float(x) for x in json.loads(existing.embedding_json or "[]")]
            except Exception:
                vec = []
            norm = float(existing.embedding_norm or 0.0) if vec else 0.0
            if vec:
                self._lru_set(content_hash, vec, norm)
                return vec, norm, content_hash

        vectors = self._openai_embed([content_text])
        if not vectors:
            return None
        vec = vectors[0]
        norm = self._vector_norm(vec)
        self._lru_set(content_hash, vec, norm)
        if session is not None:
            try:
                session.add(
                    RagEmbedding(
                        user_id=user_id,
                        source_type=str(source_type),
                        source_id=str(source_id),
                        content_hash=content_hash,
                        content_text=content_text,
                        embedding_json=json.dumps(vec, ensure_ascii=False),
                        embedding_norm=norm,
                        updated_at=updated_at or datetime.utcnow(),
                    )
                )
                session.commit()
            except Exception:
                try:
                    session.rollback()
                except Exception:
                    pass
        return vec, norm, content_hash

    def _format_template(self, template: str, *, user_name: str, assistant_name: str, place: str) -> str:
        safe_place = place or "your saved place"
        return str(template or "").format(user_name=user_name, assistant_name=assistant_name, place=safe_place).strip()

    @staticmethod
    def _get_user_timezone(user: Optional[User]) -> ZoneInfo:
        tz_name = (user.timezone if user and user.timezone else "Asia/Kolkata").strip() or "Asia/Kolkata"
        try:
            return ZoneInfo(tz_name)
        except Exception:
            return ZoneInfo("Asia/Kolkata")

    def _parse_item_datetime(self, raw_value: Optional[str], user: Optional[User]) -> Optional[datetime]:
        raw = str(raw_value or "").strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except Exception:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=self._get_user_timezone(user))
        return parsed.astimezone(self._get_user_timezone(user))

    def _format_item_time(self, item: Item, user: Optional[User]) -> str:
        parsed = self._parse_item_datetime(item.datetime_str, user)
        if parsed is None:
            return "Any time"
        return parsed.strftime("%I:%M %p").lstrip("0")

    def _collect_items_for_scope(self, session: Session, user_id: int, scope: str, user: Optional[User]) -> List[Item]:
        all_items = list(session.exec(select(Item).where(Item.user_id == user_id)).all())
        now_local = datetime.now(self._get_user_timezone(user))
        today = now_local.date()
        tomorrow = today + timedelta(days=1)
        upcoming_cutoff = now_local + timedelta(days=30)
        collected: List[Tuple[datetime, Item]] = []
        for item in all_items:
            parsed = self._parse_item_datetime(item.datetime_str, user)
            if parsed is None:
                continue
            include = False
            if scope == "today":
                include = parsed.date() == today
            elif scope == "tomorrow":
                include = parsed.date() == tomorrow
            else:
                include = now_local <= parsed <= upcoming_cutoff
            if include:
                collected.append((parsed, item))
        collected.sort(key=lambda pair: pair[0])
        return [item for _, item in collected[:5]]

    def _build_pipeline_result(
        self,
        *,
        raw_english: str,
        remodeled_english: Optional[str] = None,
        tamil_text: str = "",
        theni_tamil_text: str = "",
        route_taken: str,
        direct_answer_source: str = "",
        direct_answer_confidence: str = "",
        predicted_label: str = "local",
        risk_level: str = "low",
        stage_notes: Optional[List[str]] = None,
        core_meta: Optional[Dict[str, Any]] = None,
        remodel_meta: Optional[Dict[str, Any]] = None,
        review_meta: Optional[Dict[str, Any]] = None,
        translation_meta: Optional[Dict[str, Any]] = None,
        timings_ms: Optional[Dict[str, Any]] = None,
        cache_hit: str = "false",
    ) -> Dict[str, Any]:
        english = str(remodeled_english if remodeled_english is not None else raw_english).strip()
        return {
            "pipeline_version": "local_rag_service_v4",
            "raw_english": str(raw_english or "").strip(),
            "remodeled_english": english,
            "tamil_text": str(tamil_text or "").strip(),
            "theni_tamil_text": str(theni_tamil_text or tamil_text or "").strip(),
            "direct_answer_source": str(direct_answer_source or ""),
            "direct_answer_confidence": str(direct_answer_confidence or ""),
            "predicted_label": str(predicted_label or "local"),
            "risk_level": str(risk_level or "low"),
            "route_taken": str(route_taken or "local_rag"),
            "cache_hit": str(cache_hit or "false"),
            "stage_notes": json.dumps(stage_notes or [], ensure_ascii=False),
            "core_meta": json.dumps(core_meta or {}, ensure_ascii=False),
            "remodel_meta": json.dumps(remodel_meta or {}, ensure_ascii=False),
            "review_meta": json.dumps(review_meta or {}, ensure_ascii=False),
            "translation_meta": json.dumps(translation_meta or {}, ensure_ascii=False),
            "timings_ms": json.dumps(timings_ms or {"total_ms": 0.0}, ensure_ascii=False),
        }

    def _ensure_fast_row_vectors(self) -> None:
        if not (self._semantic_enabled and RAG_ENABLE_FAST_RAG_SEMANTIC):
            return
        if not self.rows:
            return
        current_state = self._file_mtime_state()
        if self._fast_row_vectors and self._fast_row_vectors_state == current_state:
            return
        texts = [str(row.query or "").strip() for row in self.rows if str(row.query or "").strip()]
        if not texts:
            return
        vectors: List[List[float]] = []
        batch_size = 64
        for i in range(0, len(texts), batch_size):
            chunk = texts[i : i + batch_size]
            out = self._openai_embed(chunk)
            if out and len(out) == len(chunk):
                vectors.extend(out)
            else:
                vectors = []
                break
        if not vectors or len(vectors) != len(texts):
            return
        self._fast_row_vectors = {text: (vec, self._vector_norm(vec)) for text, vec in zip(texts, vectors) if vec}
        self._fast_row_vectors_state = current_state

    def _score_text_pair(
        self,
        query_text: str,
        candidate_text: str,
        query_tokens: Set[str],
        expanded_query_tokens: Set[str],
        query_embedding: Optional[Tuple[List[float], float]],
        candidate_embedding: Optional[Tuple[List[float], float]],
    ) -> Tuple[float, float, float]:
        normalized_candidate = self.normalize_lookup_text(candidate_text)
        cand_tokens = set(self._tokens(normalized_candidate))
        expanded_candidate = self._expand_tokens(cand_tokens)

        token_overlap = self._set_overlap(expanded_query_tokens, expanded_candidate)
        seq_sim = self._string_similarity(query_text, normalized_candidate)
        phrase_boost = 1.0 if (query_text and normalized_candidate and (query_text in normalized_candidate or normalized_candidate in query_text)) else 0.0
        lexical = min(1.0, token_overlap * 0.55 + seq_sim * 0.35 + phrase_boost * 0.10)

        semantic = 0.0
        if query_embedding and candidate_embedding:
            semantic = max(0.0, self._cosine(query_embedding[0], query_embedding[1], candidate_embedding[0], candidate_embedding[1]))

        if semantic > 0.0:
            final = lexical * 0.45 + semantic * 0.55
        else:
            final = lexical
        return final, semantic, lexical

    def _recency_score(self, updated_at: Optional[datetime]) -> float:
        if not isinstance(updated_at, datetime):
            return 0.5
        now = datetime.utcnow()
        age_days = max(0.0, (now - updated_at.replace(tzinfo=None) if updated_at.tzinfo else now - updated_at).total_seconds() / 86400.0)
        half_life = max(0.1, float(RAG_RECENCY_HALF_LIFE_DAYS or 14.0))
        return math.exp(-math.log(2.0) * (age_days / half_life))

    def _maybe_rewrite_followup_query(self, session: Session, user_id: int, message: str) -> str:
        raw = str(message or "").strip()
        if not raw or not RAG_ENABLE_FOLLOWUP_REWRITE:
            return raw
        tokens = self._tokens(raw)
        followup_markers = {"it", "that", "this", "they", "them", "he", "she", "there", "then", "again", "same", "அது", "அதை", "இத", "இது", "அவங்க", "அவன்", "அவள்"}
        is_short = len(tokens) <= 6
        has_followup_marker = any(tok in followup_markers for tok in tokens)
        if not (is_short or has_followup_marker):
            return raw
        try:
            rows = list(
                session.exec(
                    select(Conversation)
                    .where(Conversation.user_id == user_id)
                    .order_by(Conversation.created_at.desc())
                ).all()
            )[:3]
        except Exception:
            rows = []
        if not rows:
            return raw
        context_parts: List[str] = []
        for row in rows:
            if row.user_input:
                context_parts.append(str(row.user_input).strip())
                break
        if not context_parts:
            return raw
        anchor = context_parts[0]
        if anchor and self.normalize_lookup_text(anchor) != self.normalize_lookup_text(raw):
            return f"{raw} | context: {anchor}"
        return raw

    def _row_language_text(self, row: FastRAGRow, reply_language: str, user_name: str, assistant_name: str, place: str) -> Tuple[str, str, str]:
        english = self._format_template(row.english_template, user_name=user_name, assistant_name=assistant_name, place=place)
        tamil = self._format_template(row.tamil_template or row.english_template, user_name=user_name, assistant_name=assistant_name, place=place)
        theni = self._format_template(row.theni_tamil_template or row.tamil_template or row.english_template, user_name=user_name, assistant_name=assistant_name, place=place)
        return english, tamil, theni

    def _match_fast_row(self, normalized: str, user: Optional[User]) -> Optional[Tuple[FastRAGRow, float, str]]:
        if not normalized:
            return None
        self._ensure_fast_row_vectors()
        q_tokens = set(self._tokens(normalized))
        exp_q = self._expand_tokens(q_tokens)
        query_embedding = self._embed_query(normalized) if (self._semantic_enabled and RAG_ENABLE_FAST_RAG_SEMANTIC) else None

        best_row: Optional[FastRAGRow] = None
        best_score = 0.0
        best_source = ""

        for row in self.rows:
            row_text = self.normalize_lookup_text(row.query)
            if not row_text:
                continue
            if row.required_terms and not any(self._contains_phrase(normalized, term) for term in row.required_terms):
                continue
            if row.blocked_terms and any(self._contains_phrase(normalized, term) for term in row.blocked_terms):
                continue

            exact = 1.0 if normalized == row_text else 0.0
            prefix = 1.0 if normalized.startswith(row_text) or row_text.startswith(normalized) else 0.0
            overlap = self._set_overlap(exp_q, self._expand_tokens(self._tokens(row_text)))
            seq = self._string_similarity(normalized, row_text)
            lexical = max(exact, min(1.0, overlap * 0.6 + seq * 0.4), prefix * FAST_RAG_PREFIX_MATCH_THRESHOLD)
            semantic = 0.0
            if query_embedding and row.query in self._fast_row_vectors:
                vec, norm = self._fast_row_vectors[row.query]
                semantic = self._cosine(query_embedding[0], query_embedding[1], vec, norm)

            final = lexical if semantic <= 0.0 else lexical * 0.55 + semantic * 0.45
            if exact >= 1.0:
                final = 1.0

            if final > best_score:
                best_row = row
                best_score = final
                best_source = "semantic_fast_rag" if semantic > lexical else "lexical_fast_rag"

        if best_row is None:
            return None
        if best_score < max(RAG_FAST_RAG_MIN_SCORE, 0.72):
            return None
        return best_row, best_score, best_source

    def _build_schedule_answer(self, session: Session, user_id: int, normalized_query: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
        schedule_tokens = {"schedule", "reminder", "reminders", "task", "tasks", "todo", "plan", "plans", "upcoming", "நினைவூட்டல்", "நினைவூட்டல்கள்", "அட்டவணை"}
        if not any(tok in normalized_query.split() or tok in normalized_query for tok in schedule_tokens):
            return None
        scope = "upcoming"
        label_en = "upcoming"
        label_ta = "வரவிருக்கும்"
        if "today" in normalized_query or "இன்று" in normalized_query:
            scope = "today"
            label_en = "today"
            label_ta = "இன்று"
        elif "tomorrow" in normalized_query or "நாளை" in normalized_query:
            scope = "tomorrow"
            label_en = "tomorrow"
            label_ta = "நாளை"
        items = self._collect_items_for_scope(session, user_id, scope, user)
        display_name = (user.name if user and user.name else "there").strip() or "there"
        if not items:
            english = f"You do not have any {label_en} reminders, {display_name}."
            tamil = f"{display_name}, உங்களுக்கு {label_ta} எந்த நினைவூட்டலும் இல்லை."
            return self._build_pipeline_result(
                raw_english=english,
                remodeled_english=english,
                tamil_text=tamil,
                theni_tamil_text=tamil,
                route_taken="local_schedule_rag",
                direct_answer_source="local_schedule_memory",
                direct_answer_confidence="1.0000",
                predicted_label="schedule",
                stage_notes=["Answered from the user's saved reminders without calling OpenAI."],
                timings_ms={"total_ms": 0.0},
            )
        english_lines = [f"You have {len(items)} {label_en} reminder(s), {display_name}:"]
        tamil_lines = [f"{display_name}, உங்களுக்கு {label_ta} {len(items)} நினைவூட்டல்(கள்) இருக்கின்றன:"]
        for idx, item in enumerate(items, start=1):
            title = (item.title or item.raw_text or "Untitled").strip()
            time_label = self._format_item_time(item, user)
            english_lines.append(f"{idx}. {time_label} - {title}")
            tamil_lines.append(f"{idx}. {time_label} - {title}")
        english = "\n".join(english_lines)
        tamil = "\n".join(tamil_lines)
        return self._build_pipeline_result(
            raw_english=english,
            remodeled_english=english,
            tamil_text=tamil,
            theni_tamil_text=tamil,
            route_taken="local_schedule_rag",
            direct_answer_source="local_schedule_memory",
            direct_answer_confidence="1.0000",
            predicted_label="schedule",
            stage_notes=["Answered from the user's saved reminders without calling OpenAI."],
            timings_ms={"total_ms": 0.0},
        )

    def _build_routine_answer(self, session: Session, user_id: int, normalized_query: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
        routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
        if routine is None:
            return None
        name = (user.name if user and user.name else "there").strip() or "there"
        english = ""
        tamil = ""
        label = "routine"

        if any(term in normalized_query for term in ["wake", "wakeup", "wake up", "எழு", "எழுந்திரு"]):
            english = f"{name}, your wake-up time is {routine.wake_time}."
            tamil = f"{name}, உங்கள் எழும் நேரம் {routine.wake_time}."
            label = "routine_wake"
        elif any(term in normalized_query for term in ["sleep", "bedtime", "go to bed", "தூங்கு", "தூக்கம்"]):
            english = f"{name}, your sleep time is {routine.sleep_time}."
            tamil = f"{name}, உங்கள் தூங்கும் நேரம் {routine.sleep_time}."
            label = "routine_sleep"
        elif any(term in normalized_query for term in ["work", "office", "job", "வேலை", "ஆபீஸ்"]):
            if routine.work_start or routine.work_end:
                english = f"{name}, your work time is {routine.work_start or 'not set'} to {routine.work_end or 'not set'}."
                tamil = f"{name}, உங்கள் வேலை நேரம் {routine.work_start or 'set இல்லை'} முதல் {routine.work_end or 'set இல்லை'} வரை."
            else:
                english = f"{name}, your work timings are not set yet."
                tamil = f"{name}, உங்கள் வேலை நேரம் இன்னும் அமைக்கப்படவில்லை."
            label = "routine_work"
        elif any(term in normalized_query for term in ["habit", "habits", "பழக்கம்", "பழக்கங்கள்"]):
            habits = str(routine.daily_habits or "").strip()
            if habits:
                english = f"{name}, your daily habits are: {habits}."
                tamil = f"{name}, உங்கள் தினசரி பழக்கங்கள்: {habits}."
            else:
                english = f"{name}, your daily habits are not set yet."
                tamil = f"{name}, உங்கள் தினசரி பழக்கங்கள் இன்னும் அமைக்கப்படவில்லை."
            label = "routine_habits"
        elif any(term in normalized_query for term in ["routine", "daily routine", "day routine", "தினசரி", "நாள் திட்டம்"]):
            habits = str(routine.daily_habits or "").strip() or "Not set"
            english = (
                f"{name}, your routine is: wake at {routine.wake_time}, sleep at {routine.sleep_time}, "
                f"work from {routine.work_start or 'not set'} to {routine.work_end or 'not set'}, habits: {habits}."
            )
            tamil = (
                f"{name}, உங்கள் தினசரி திட்டம்: எழும் நேரம் {routine.wake_time}, தூங்கும் நேரம் {routine.sleep_time}, "
                f"வேலை நேரம் {routine.work_start or 'set இல்லை'} முதல் {routine.work_end or 'set இல்லை'} வரை, பழக்கங்கள்: {habits}."
            )
            label = "routine_summary"
        if not english:
            return None
        return self._build_pipeline_result(
            raw_english=english,
            remodeled_english=english,
            tamil_text=tamil,
            theni_tamil_text=tamil,
            route_taken="local_routine_rag",
            direct_answer_source="local_routine_memory",
            direct_answer_confidence="1.0000",
            predicted_label=label,
            stage_notes=["Answered from the user's saved daily routine without calling OpenAI."],
            timings_ms={"total_ms": 0.0},
        )

    def _build_user_profile_answer(self, normalized_query: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
        if user is None:
            return None
        name = (user.name or "there").strip() or "there"
        assistant_name = (user.assistant_name or "Ellie").strip() or "Ellie"
        place = (user.place or "your saved place").strip() or "your saved place"
        if normalized_query in {"what is my name", "whats my name", "who am i", "my name"}:
            english = f"Your name is {name}."
            tamil = f"உங்கள் பெயர் {name}."
            return self._build_pipeline_result(raw_english=english, remodeled_english=english, tamil_text=tamil, theni_tamil_text=tamil, route_taken="local_profile_rag", direct_answer_source="local_profile_memory", direct_answer_confidence="1.0000", predicted_label="profile", stage_notes=["Answered from the saved user profile without calling OpenAI."], timings_ms={"total_ms": 0.0})
        if normalized_query in {"what is my place", "where am i from", "my place", "ஊர்", "இடம்"}:
            english = f"Your place is {place}."
            tamil = f"உங்கள் இடம் {place}."
            return self._build_pipeline_result(raw_english=english, remodeled_english=english, tamil_text=tamil, theni_tamil_text=tamil, route_taken="local_profile_rag", direct_answer_source="local_profile_memory", direct_answer_confidence="1.0000", predicted_label="profile", stage_notes=["Answered from the saved user profile without calling OpenAI."], timings_ms={"total_ms": 0.0})
        if normalized_query in {"who are you", "what is your name", "whats your name", "your name", "what can you do", "help"}:
            english = f"I'm {assistant_name}, your assistant. I can help with reminders, schedules, routines, and quick answers."
            tamil = f"நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, தினசரி பழக்கம், மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்."
            return self._build_pipeline_result(raw_english=english, remodeled_english=english, tamil_text=tamil, theni_tamil_text=tamil, route_taken="local_assistant_identity", direct_answer_source="local_assistant_profile", direct_answer_confidence="1.0000", predicted_label="assistant_identity", stage_notes=["Answered from app configuration without calling OpenAI."], timings_ms={"total_ms": 0.0})
        return None

    def _candidate_from_item(self, item: Item) -> Tuple[str, str, datetime]:
        title = str(item.title or "").strip()
        details = str(item.details or "").strip()
        raw_text = str(item.raw_text or "").strip()
        dt = str(item.datetime_str or "").strip()
        parts = [p for p in [title, raw_text, details, dt] if p]
        text = " | ".join(parts)
        return str(item.id or ""), text, item.updated_at or item.created_at or datetime.utcnow()

    def _candidate_from_conversation(self, row: Conversation) -> Tuple[str, str, datetime]:
        user_text = str(row.user_input or "").strip()
        answer_parts: List[str] = []
        try:
            payload = json.loads(row.llm_output_json or "{}") if row.llm_output_json else {}
        except Exception:
            payload = {}
        if isinstance(payload, dict):
            for key in ["remodeled_english", "raw_english", "tamil_text", "theni_tamil_text"]:
                value = str(payload.get(key, "")).strip()
                if value:
                    answer_parts.append(value)
                    break
        text = " | ".join([p for p in [user_text, *answer_parts] if p])
        return str(row.id or ""), text, row.created_at or datetime.utcnow()

    def _candidate_from_cache(self, row: QACache) -> Tuple[str, str, datetime]:
        question = str(row.question or "").strip()
        answer = ""
        try:
            payload = json.loads(row.answer or "{}") if row.answer else {}
        except Exception:
            payload = {}
        if isinstance(payload, dict):
            answer = str(payload.get("remodeled_english") or payload.get("raw_english") or payload.get("tamil_text") or "").strip()
        if not answer:
            answer = str(row.answer or "").strip()
        return str(row.id or ""), f"{question} | {answer}", row.updated_at or datetime.utcnow()

    def _candidate_from_routine(self, routine: DailyRoutine) -> Tuple[str, str, datetime]:
        text = (
            f"Daily routine. Wake: {routine.wake_time}. Sleep: {routine.sleep_time}. "
            f"Work: {routine.work_start or 'not set'} to {routine.work_end or 'not set'}. "
            f"Habits: {routine.daily_habits or 'not set'}."
        )
        return str(routine.id or routine.user_id), text, routine.updated_at or datetime.utcnow()

    def _candidate_from_profile(self, profile: UserProfile) -> Tuple[str, str, datetime]:
        summary = str(profile.profile_summary or "").strip()
        answers = str(profile.answers_json or "").strip()
        text = " | ".join(p for p in [summary, answers] if p)
        return str(profile.id or profile.user_id), text, profile.updated_at or datetime.utcnow()

    def _candidate_from_user(self, user: User) -> Tuple[str, str, datetime]:
        text = (
            f"User profile. Name: {user.name}. Place: {user.place or 'not set'}. "
            f"Timezone: {user.timezone or 'Asia/Kolkata'}. Assistant: {user.assistant_name or 'Ellie'}."
        )
        return str(user.id or ""), text, user.created_at or datetime.utcnow()

    def build_rag_context(self, session: Session, user_id: Optional[int], message: str) -> Dict[str, Any]:
        t0 = time.perf_counter()
        if not (RAG_ENABLED and user_id):
            return {"context_text": "", "snippets": [], "timings_ms": {"rag_total_ms": 0.0}}

        query_text = self._maybe_rewrite_followup_query(session, int(user_id), message)
        normalized_query = self.normalize_lookup_text(query_text)
        if not normalized_query:
            return {"context_text": "", "snippets": [], "timings_ms": {"rag_total_ms": 0.0}}

        q_tokens = set(self._tokens(normalized_query))
        exp_q = self._expand_tokens(q_tokens)
        query_embedding = self._embed_query(normalized_query) if self._semantic_enabled else None

        t_fetch = time.perf_counter()
        candidates: List[RagSnippet] = []

        items = list(
            session.exec(
                select(Item).where(Item.user_id == int(user_id)).order_by(Item.updated_at.desc())
            ).all()
        )[: int(RAG_MAX_ITEM_CANDIDATES)]
        for item in items:
            source_id, content_text, updated_at = self._candidate_from_item(item)
            if not content_text:
                continue
            cand_embedding = None
            emb = self._get_or_create_embedding(session, user_id=int(user_id), source_type="item", source_id=source_id, content_text=content_text, updated_at=updated_at)
            if emb is not None:
                cand_embedding = (emb[0], emb[1])
            base, semantic, lexical = self._score_text_pair(normalized_query, content_text, q_tokens, exp_q, query_embedding, cand_embedding)
            recency = self._recency_score(updated_at)
            score = base * 0.82 + recency * 0.18
            if score >= max(0.18, float(RAG_MIN_SCORE) - 0.18):
                candidates.append(RagSnippet("item", source_id, updated_at, content_text, score, semantic, lexical, recency))

        convs = list(
            session.exec(
                select(Conversation).where(Conversation.user_id == int(user_id)).order_by(Conversation.created_at.desc())
            ).all()
        )[: int(RAG_MAX_CONVERSATION_CANDIDATES)]
        for row in convs:
            source_id, content_text, updated_at = self._candidate_from_conversation(row)
            if not content_text:
                continue
            cand_embedding = None
            emb = self._get_or_create_embedding(session, user_id=int(user_id), source_type="conversation", source_id=source_id, content_text=content_text, updated_at=updated_at)
            if emb is not None:
                cand_embedding = (emb[0], emb[1])
            base, semantic, lexical = self._score_text_pair(normalized_query, content_text, q_tokens, exp_q, query_embedding, cand_embedding)
            recency = self._recency_score(updated_at)
            score = base * 0.80 + recency * 0.20
            if score >= max(0.18, float(RAG_MIN_SCORE) - 0.20):
                candidates.append(RagSnippet("conversation", source_id, updated_at, content_text, score, semantic, lexical, recency))

        cache_rows = list(
            session.exec(
                select(QACache).where(QACache.user_id == int(user_id)).order_by(QACache.updated_at.desc())
            ).all()
        )[: int(RAG_MAX_CACHE_CANDIDATES)]
        for row in cache_rows:
            source_id, content_text, updated_at = self._candidate_from_cache(row)
            if not content_text:
                continue
            cand_embedding = None
            emb = self._get_or_create_embedding(session, user_id=int(user_id), source_type="qa_cache", source_id=source_id, content_text=content_text, updated_at=updated_at)
            if emb is not None:
                cand_embedding = (emb[0], emb[1])
            base, semantic, lexical = self._score_text_pair(normalized_query, content_text, q_tokens, exp_q, query_embedding, cand_embedding)
            recency = self._recency_score(updated_at)
            score = base * 0.84 + recency * 0.16
            if score >= max(0.18, float(RAG_MIN_SCORE) - 0.18):
                candidates.append(RagSnippet("qa_cache", source_id, updated_at, content_text, score, semantic, lexical, recency))

        routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == int(user_id))).first()
        if routine is not None:
            source_id, content_text, updated_at = self._candidate_from_routine(routine)
            cand_embedding = None
            emb = self._get_or_create_embedding(session, user_id=int(user_id), source_type="routine", source_id=source_id, content_text=content_text, updated_at=updated_at)
            if emb is not None:
                cand_embedding = (emb[0], emb[1])
            base, semantic, lexical = self._score_text_pair(normalized_query, content_text, q_tokens, exp_q, query_embedding, cand_embedding)
            recency = self._recency_score(updated_at)
            score = base * 0.82 + recency * 0.18
            if score >= max(0.16, float(RAG_MIN_SCORE) - 0.25):
                candidates.append(RagSnippet("routine", source_id, updated_at, content_text, score, semantic, lexical, recency))

        user = session.get(User, int(user_id))
        if user is not None:
            source_id, content_text, updated_at = self._candidate_from_user(user)
            cand_embedding = None
            emb = self._get_or_create_embedding(session, user_id=int(user_id), source_type="user", source_id=source_id, content_text=content_text, updated_at=updated_at)
            if emb is not None:
                cand_embedding = (emb[0], emb[1])
            base, semantic, lexical = self._score_text_pair(normalized_query, content_text, q_tokens, exp_q, query_embedding, cand_embedding)
            recency = self._recency_score(updated_at)
            score = base * 0.78 + recency * 0.22
            if score >= max(0.12, float(RAG_MIN_SCORE) - 0.30):
                candidates.append(RagSnippet("user", source_id, updated_at, content_text, score, semantic, lexical, recency))

        profile = session.exec(select(UserProfile).where(UserProfile.user_id == int(user_id))).first()
        if profile is not None:
            source_id, content_text, updated_at = self._candidate_from_profile(profile)
            if content_text:
                cand_embedding = None
                emb = self._get_or_create_embedding(session, user_id=int(user_id), source_type="user_profile", source_id=source_id, content_text=content_text, updated_at=updated_at)
                if emb is not None:
                    cand_embedding = (emb[0], emb[1])
                base, semantic, lexical = self._score_text_pair(normalized_query, content_text, q_tokens, exp_q, query_embedding, cand_embedding)
                recency = self._recency_score(updated_at)
                score = base * 0.82 + recency * 0.18
                if score >= max(0.16, float(RAG_MIN_SCORE) - 0.26):
                    candidates.append(RagSnippet("user_profile", source_id, updated_at, content_text, score, semantic, lexical, recency))

        fetch_ms = round((time.perf_counter() - t_fetch) * 1000, 2)

        dedup: Dict[Tuple[str, str], RagSnippet] = {}
        for snippet in candidates:
            key = (snippet.source_type, snippet.source_id)
            existing = dedup.get(key)
            if existing is None or snippet.score > existing.score:
                dedup[key] = snippet

        ranked = sorted(dedup.values(), key=lambda s: (s.score, s.score_semantic, s.score_lexical, s.updated_at), reverse=True)
        ranked = [r for r in ranked if r.score >= float(RAG_MIN_SCORE)] or ranked[: max(1, int(RAG_TOP_K))]
        top = ranked[: max(1, int(RAG_TOP_K))]

        context_chunks: List[str] = []
        snippet_meta: List[Dict[str, Any]] = []
        used_chars = 0
        for idx, snip in enumerate(top, start=1):
            cleaned = re.sub(r"\s+", " ", snip.text).strip()
            if len(cleaned) > 420:
                cleaned = cleaned[:417].rstrip() + "..."
            label = f"[{idx}] {snip.source_type}#{snip.source_id}: {cleaned}"
            if used_chars and used_chars + len(label) + 1 > int(RAG_MAX_CONTEXT_CHARS):
                break
            context_chunks.append(label)
            used_chars += len(label) + 1
            snippet_meta.append(
                {
                    "source_type": snip.source_type,
                    "source_id": snip.source_id,
                    "score": round(float(snip.score), 4),
                    "score_semantic": round(float(snip.score_semantic), 4),
                    "score_lexical": round(float(snip.score_lexical), 4),
                    "score_recency": round(float(snip.score_recency), 4),
                }
            )

        context_text = "\n".join(context_chunks).strip()
        timings = {
            "rag_fetch_ms": fetch_ms,
            "rag_total_ms": round((time.perf_counter() - t0) * 1000, 2),
            "rag_candidates": len(candidates),
            "rag_selected": len(snippet_meta),
        }
        return {"context_text": context_text, "snippets": snippet_meta, "timings_ms": timings}

    # ── Response Filtering & Remodelling Layer ──────────────────────────

    _filter_logger = logging.getLogger("local_rag.response_filter")

    # Keywords used for rule-based conflict detection (no API call needed)
    _NON_VEG_KEYWORDS: Set[str] = {
        "chicken", "mutton", "beef", "pork", "fish", "prawn", "shrimp",
        "crab", "lobster", "lamb", "bacon", "sausage", "steak", "meat",
        "egg", "eggs", "turkey", "duck", "goat", "venison", "salami",
        "கோழி", "மட்டன்", "மீன்", "இறால்", "நண்டு", "முட்டை",
    }
    _HIGH_ACTIVITY_KEYWORDS: Set[str] = {
        "run", "running", "sprint", "jogging", "jog", "push-up", "pushup",
        "pull-up", "pullup", "burpee", "hiit", "crossfit", "heavy lift",
        "deadlift", "squat", "plank", "jumping", "jump", "marathon",
    }

    _EMPTY_SAFETY_PROFILE: Dict[str, Any] = {
        "diet": "",
        "allergies": [],
        "injuries": [],
        "activity": "",
    }

    def _get_user_safety_profile(
        self,
        session: Session,
        user_id: int,
    ) -> Dict[str, Any]:
        """Fetch diet/allergy/injury/activity from UserProfile.answers_json.

        Returns an empty profile (no filtering) when the DB row is missing
        or the JSON doesn't contain the expected keys. No dummy values are
        assumed — only real user data triggers conflict detection.
        """
        try:
            profile = session.exec(
                select(UserProfile).where(UserProfile.user_id == user_id)
            ).first()
            if profile is not None and profile.answers_json:
                data = json.loads(profile.answers_json)
                if isinstance(data, dict):
                    return {
                        "diet": str(data.get("diet", "")).strip().lower(),
                        "allergies": [
                            str(a).strip().lower()
                            for a in (data.get("allergies") or [])
                            if str(a).strip()
                        ],
                        "injuries": [
                            str(i).strip().lower()
                            for i in (data.get("injuries") or [])
                            if str(i).strip()
                        ],
                        "activity": str(data.get("activity", "")).strip().lower(),
                    }
        except Exception:
            pass
        return dict(self._EMPTY_SAFETY_PROFILE)

    def _detect_profile_conflicts(
        self,
        response_text: str,
        user_profile: Dict[str, Any],
    ) -> List[Dict[str, str]]:
        """Rule-based conflict detection — no API call, pure string matching."""
        conflicts: List[Dict[str, str]] = []
        lower_response = response_text.lower()
        tokens = set(re.findall(r"[a-z0-9\u0B80-\u0BFF]+", lower_response))

        # 1. Diet conflict (non-veg suggestion for vegetarian user)
        diet = str(user_profile.get("diet", "")).strip().lower()
        if diet in {"vegetarian", "vegan", "veg"}:
            found = tokens & self._NON_VEG_KEYWORDS
            if found:
                conflicts.append({
                    "type": "diet",
                    "detail": f"Non-vegetarian items mentioned: {', '.join(sorted(found))}",
                })

        # 2. Allergy conflict
        allergies = [str(a).strip().lower() for a in user_profile.get("allergies", []) if str(a).strip()]
        for allergen in allergies:
            if allergen in lower_response:
                conflicts.append({
                    "type": "allergy",
                    "detail": f"Allergic ingredient mentioned: {allergen}",
                })

        # 3. Injury / physical limitation conflict
        injuries = [str(i).strip().lower() for i in user_profile.get("injuries", []) if str(i).strip()]
        if injuries:
            found_activity = tokens & self._HIGH_ACTIVITY_KEYWORDS
            if found_activity:
                conflicts.append({
                    "type": "injury",
                    "detail": f"High-intensity activity ({', '.join(sorted(found_activity))}) may conflict with injuries: {', '.join(injuries)}",
                })

        # 4. Activity-level mismatch
        activity = str(user_profile.get("activity", "moderate")).strip().lower()
        if activity == "low":
            found_heavy = tokens & self._HIGH_ACTIVITY_KEYWORDS
            if found_heavy:
                conflicts.append({
                    "type": "activity_level",
                    "detail": f"Intense activity ({', '.join(sorted(found_heavy))}) suggested for a low-activity user",
                })

        return conflicts

    def _remodel_for_safety(
        self,
        original_english: str,
        user_profile: Dict[str, Any],
        conflicts: List[Dict[str, str]],
    ) -> Optional[str]:
        """Call OpenAI to produce a safe alternative only when conflicts exist."""
        if not conflicts or self._openai is None:
            return None

        conflict_summary = "; ".join(c["detail"] for c in conflicts)
        prompt = (
            "You are a safety-aware assistant. The following response was generated "
            "for a user but contains conflicts with their personal profile.\n\n"
            f"--- Original Response ---\n{original_english}\n\n"
            f"--- User Profile ---\n{json.dumps(user_profile, ensure_ascii=False)}\n\n"
            f"--- Detected Conflicts ---\n{conflict_summary}\n\n"
            "Please rewrite the response so that:\n"
            "1. All conflicting suggestions are replaced with safe alternatives.\n"
            "2. The overall meaning and helpfulness are preserved.\n"
            "3. Keep the tone friendly and natural.\n"
            "4. Do NOT mention the conflict or that you modified anything.\n"
            "Return ONLY the corrected response text, nothing else."
        )
        try:
            resp = self._openai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=512,
                temperature=0.4,
            )
            choice = resp.choices[0] if resp.choices else None
            if choice and choice.message and choice.message.content:
                return str(choice.message.content).strip()
        except Exception as exc:
            self._filter_logger.warning("Remodel API call failed: %s", exc)
        return None

    def _filter_and_remodel_response(
        self,
        result: Dict[str, Any],
        session: Session,
        user_id: Optional[int],
    ) -> Dict[str, Any]:
        """Post-processing filter applied to every pipeline result.

        • If no conflict is detected the result is returned unchanged
          (zero extra latency, no OpenAI call).
        • If a conflict is found the English text is remodelled via OpenAI
          and the result dict is updated in-place.
        """
        if not user_id:
            return result

        english_text = str(result.get("remodeled_english") or result.get("raw_english") or "").strip()
        if not english_text:
            return result

        user_profile = self._get_user_safety_profile(session, int(user_id))
        conflicts = self._detect_profile_conflicts(english_text, user_profile)

        if not conflicts:
            return result

        # Log the detected conflicts
        self._filter_logger.info(
            "Conflicts detected for user %s: %s",
            user_id,
            json.dumps(conflicts, ensure_ascii=False),
        )

        remodeled = self._remodel_for_safety(english_text, user_profile, conflicts)
        if remodeled:
            self._filter_logger.info(
                "Response remodelled for user %s | original_len=%d | new_len=%d",
                user_id,
                len(english_text),
                len(remodeled),
            )
            # Update the result dict — keep original as raw, put safe version as remodeled
            result["raw_english"] = english_text
            result["remodeled_english"] = remodeled

            # Update stage notes
            try:
                notes = json.loads(result.get("stage_notes", "[]"))
            except Exception:
                notes = []
            if isinstance(notes, list):
                notes.append(f"Response filtered: {'; '.join(c['type'] for c in conflicts)} conflict(s) detected and remodelled.")
                result["stage_notes"] = json.dumps(notes, ensure_ascii=False)

            result["risk_level"] = "filtered"
        else:
            self._filter_logger.warning(
                "Conflict detected but remodel failed for user %s — returning original.",
                user_id,
            )

        return result

    # ── Main entry point ───────────────────────────────────────────────

    def try_answer(self, session: Session, user_id: Optional[int], message: str) -> Optional[Dict[str, Any]]:
        self._reload_if_needed()
        normalized = self.normalize_lookup_text(message)
        if not normalized:
            return None

        user = session.get(User, user_id) if user_id else None
        if user_id:
            schedule_answer = self._build_schedule_answer(session, int(user_id), normalized, user)
            if schedule_answer is not None:
                return self._filter_and_remodel_response(schedule_answer, session, user_id)

            routine_answer = self._build_routine_answer(session, int(user_id), normalized, user)
            if routine_answer is not None:
                return self._filter_and_remodel_response(routine_answer, session, user_id)

            cache_rows = list(
                session.exec(
                    select(QACache).where(QACache.user_id == int(user_id)).order_by(QACache.updated_at.desc())
                ).all()
            )[: int(FAST_RAG_MAX_CACHE_ROWS)]
            best_payload: Optional[Dict[str, Any]] = None
            best_score = 0.0
            for row in cache_rows:
                q_norm = self.normalize_lookup_text(row.question)
                if not q_norm:
                    continue
                overlap = self._set_overlap(set(self._tokens(normalized)), set(self._tokens(q_norm)))
                seq = self._string_similarity(normalized, q_norm)
                score = max(overlap, seq)
                if q_norm == normalized:
                    score = 1.0
                if score > best_score:
                    try:
                        payload = json.loads(row.answer or "{}")
                    except Exception:
                        payload = {}
                    if isinstance(payload, dict):
                        best_payload = payload
                        best_score = score
            if best_payload and best_score >= FAST_RAG_CACHE_MATCH_THRESHOLD:
                raw_english = str(best_payload.get("raw_english", "")).strip() or str(best_payload.get("remodeled_english", "")).strip()
                remodeled_english = str(best_payload.get("remodeled_english", "")).strip() or raw_english
                tamil_text = str(best_payload.get("tamil_text", "")).strip()
                theni_tamil_text = str(best_payload.get("theni_tamil_text", "")).strip() or tamil_text
                return self._filter_and_remodel_response(
                    self._build_pipeline_result(
                        raw_english=raw_english,
                        remodeled_english=remodeled_english,
                        tamil_text=tamil_text,
                        theni_tamil_text=theni_tamil_text,
                        route_taken="cached_answer",
                        direct_answer_source="qa_cache",
                        direct_answer_confidence=f"{best_score:.4f}",
                        predicted_label=str(best_payload.get("predicted_label", "cached")).strip() or "cached",
                        risk_level=str(best_payload.get("risk_level", "low")).strip() or "low",
                        stage_notes=["Reused a cached answer and skipped a new OpenAI call."],
                        core_meta=best_payload.get("core_meta") if isinstance(best_payload.get("core_meta"), dict) else {},
                        remodel_meta=best_payload.get("remodel_meta") if isinstance(best_payload.get("remodel_meta"), dict) else {},
                        review_meta=best_payload.get("review_meta") if isinstance(best_payload.get("review_meta"), dict) else {},
                        translation_meta=best_payload.get("translation_meta") if isinstance(best_payload.get("translation_meta"), dict) else {},
                        timings_ms=best_payload.get("timings_ms") if isinstance(best_payload.get("timings_ms"), dict) else {"total_ms": 0.0},
                        cache_hit="true",
                    ),
                    session,
                    user_id,
                )

        direct_profile = self._build_user_profile_answer(normalized, user)
        if direct_profile is not None:
            return self._filter_and_remodel_response(direct_profile, session, user_id)

        match = self._match_fast_row(normalized, user)
        if match is None:
            return None
        row, score, source = match
        user_name = (user.name if user and user.name else "there").strip() or "there"
        assistant_name = (user.assistant_name if user and user.assistant_name else "Ellie").strip() or "Ellie"
        place = (user.place if user and user.place else "your saved place").strip() or "your saved place"
        english, tamil, theni = self._row_language_text(row, "ta", user_name, assistant_name, place)
        return self._filter_and_remodel_response(
            self._build_pipeline_result(
                raw_english=english,
                remodeled_english=english,
                tamil_text=tamil,
                theni_tamil_text=theni,
                route_taken=f"fast_rag_{row.route}",
                direct_answer_source=source,
                direct_answer_confidence=f"{score:.4f}",
                predicted_label=row.label,
                stage_notes=["Answered from fast local RAG without calling OpenAI."],
                timings_ms={"total_ms": 0.0},
            ),
            session,
            user_id,
        )