from __future__ import annotations

import csv
import hashlib
import json
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

from .models import Conversation, DailyRoutine, Item, QACache, RagEmbedding, User

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore

try:
    from config import (
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
    # If config isn't importable (edge cases), fall back to env-only behavior.
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
    _fb = lambda x: str(os.getenv(x, "")).strip().lower()  # noqa: E731
    _fi = lambda x, d: int(str(os.getenv(x, d)).strip() or d)  # noqa: E731
    _ff = lambda x, d: float(str(os.getenv(x, d)).strip() or d)  # noqa: E731

    RAG_ENABLED = _fb("RAG_ENABLED") in {"1", "true", "yes", "y", "on"} if _fb("RAG_ENABLED") else True
    RAG_EMBEDDING_MODEL = os.getenv("RAG_EMBEDDING_MODEL", "text-embedding-3-small")
    RAG_ENABLE_FAST_RAG_SEMANTIC = (
        _fb("RAG_ENABLE_FAST_RAG_SEMANTIC") in {"1", "true", "yes", "y", "on"}
        if _fb("RAG_ENABLE_FAST_RAG_SEMANTIC")
        else True
    )
    RAG_FAST_RAG_MIN_SCORE = _ff("RAG_FAST_RAG_MIN_SCORE", 0.86)
    RAG_MAX_ITEM_CANDIDATES = max(20, _fi("RAG_MAX_ITEM_CANDIDATES", 250))
    RAG_MAX_CONVERSATION_CANDIDATES = max(10, _fi("RAG_MAX_CONVERSATION_CANDIDATES", 80))
    RAG_MAX_CACHE_CANDIDATES = max(10, _fi("RAG_MAX_CACHE_CANDIDATES", 60))
    RAG_TOP_K = max(2, _fi("RAG_TOP_K", 6))
    RAG_MIN_SCORE = _ff("RAG_MIN_SCORE", 0.56)
    RAG_MAX_CONTEXT_CHARS = max(800, _fi("RAG_MAX_CONTEXT_CHARS", 3200))
    RAG_RECENCY_HALF_LIFE_DAYS = max(0.1, _ff("RAG_RECENCY_HALF_LIFE_DAYS", 14.0))
    RAG_ENABLE_FOLLOWUP_REWRITE = (
        _fb("RAG_ENABLE_FOLLOWUP_REWRITE") in {"1", "true", "yes", "y", "on"}
        if _fb("RAG_ENABLE_FOLLOWUP_REWRITE")
        else True
    )
    RAG_EMBED_CACHE_SIZE = max(256, _fi("RAG_EMBED_CACHE_SIZE", 4096))

CURRENT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = CURRENT_DIR.parent
DATA_DIR = BACKEND_ROOT / "data"
FAST_RAG_DATASET_PATH = DATA_DIR / "fast_rag_replies.csv"
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
        "query": "hey",
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
        "query": "வணக்கம்",
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
        "query": "good morning",
        "label": "greeting",
        "route": "instant",
        "priority": "98",
        "tags": "greeting|morning",
        "required_terms": "",
        "blocked_terms": "schedule|reminder|task|todo|plan",
        "english_template": "Good morning {user_name}, how are you doing?",
        "tamil_template": "காலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "காலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "good afternoon",
        "label": "greeting",
        "route": "instant",
        "priority": "98",
        "tags": "greeting|afternoon",
        "required_terms": "",
        "blocked_terms": "schedule|reminder|task|todo|plan",
        "english_template": "Good afternoon {user_name}, how are you doing?",
        "tamil_template": "மதிய வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "மதிய வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "good evening",
        "label": "greeting",
        "route": "instant",
        "priority": "98",
        "tags": "greeting|evening",
        "required_terms": "",
        "blocked_terms": "schedule|reminder|task|todo|plan",
        "english_template": "Good evening {user_name}, how are you doing?",
        "tamil_template": "மாலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "மாலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
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
        "query": "thank you",
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
        "query": "who am i",
        "label": "profile",
        "route": "instant",
        "priority": "96",
        "tags": "profile|identity",
        "required_terms": "",
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
        "query": "where am i from",
        "label": "profile",
        "route": "instant",
        "priority": "90",
        "tags": "profile|place|location",
        "required_terms": "",
        "blocked_terms": "assistant",
        "english_template": "You are registered from {place}.",
        "tamil_template": "நீங்கள் {place} இடத்திலிருந்து பதிவு செய்யப்பட்டுள்ளீர்கள்.",
        "theni_tamil_template": "நீங்கள் {place} இடத்திலிருந்து பதிவு செய்யப்பட்டுள்ளீர்கள்.",
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
        "query": "what is your name",
        "label": "assistant_identity",
        "route": "instant",
        "priority": "96",
        "tags": "assistant|identity|help",
        "required_terms": "assistant|your",
        "blocked_terms": "my name|my place",
        "english_template": "I'm {assistant_name}, your assistant.",
        "tamil_template": "நான் {assistant_name}, உங்கள் உதவியாளர்.",
        "theni_tamil_template": "நான் {assistant_name}, உங்கள் உதவியாளர்.",
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

        # --- Advanced RAG / Embeddings ---
        self._rag_enabled = bool(RAG_ENABLED and OpenAI is not None and bool(str(OPENAI_API_KEY or "").strip()))
        self._embedding_model = str(RAG_EMBEDDING_MODEL or "text-embedding-3-small").strip() or "text-embedding-3-small"
        self._openai = OpenAI(api_key=OPENAI_API_KEY) if self._rag_enabled else None
        # LRU cache: content_hash -> (embedding, norm, updated_at_epoch)
        self._embed_cache: "OrderedDict[str, Tuple[List[float], float, float]]" = OrderedDict()
        # In-memory embeddings for fast_rag rows (query templates)
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

        # Fast-rag semantic vectors are recomputed lazily.
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
        self._write_csv_if_missing(
            self.keywords_path,
            ["intent", "scope", "keywords"],
            DEFAULT_KEYWORD_ROWS,
        )
        self._write_csv_if_missing(
            self.synonyms_path,
            ["root", "synonyms"],
            DEFAULT_SYNONYM_ROWS,
        )

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
        parts = [part.strip() for part in re.split(r"[|,]", text) if part.strip()]
        return tuple(parts)

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
                        theni_tamil_template=str(row.get("theni_tamil_template", "")).strip()
                        or str(row.get("tamil_template", "")).strip(),
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
                aliases = {self.normalize_lookup_text(root)} if root else set()
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

    # --------------------
    # Embeddings helpers (Advanced RAG)
    # --------------------
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
        # dot product
        dot = 0.0
        # Safe for mismatched dims (rare). We use min length.
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
        if not self._rag_enabled or self._openai is None:
            return []
        if not texts:
            return []

        try:
            # OpenAI Python v2.x: client.embeddings.create(model=..., input=[...])
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
        """Embeds a query in-memory only (not persisted)."""
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
        """Fetches a persisted embedding or creates it.

        Returns (embedding, norm, content_hash).
        """
        if not self._rag_enabled:
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

        # 1) DB lookup
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

        # 2) Create
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
                # Ignore (table might not exist yet, or race/unique conflict).
                try:
                    session.rollback()
                except Exception:
                    pass

        return vec, norm, content_hash
    
    def _format_template(self, template: str, *, user_name: str, assistant_name: str, place: str) -> str:
        safe_place = place or "your saved place"
        return str(template or "").format(
            user_name=user_name,
            assistant_name=assistant_name,
            place=safe_place,
        ).strip()

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
            "pipeline_version": "local_rag_service_v3",
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
        """Ensures semantic vectors for fast_rag rows are loaded.

        This is lazy to keep boot time fast and to avoid embedding calls if you don't use them.
        """
        if not (self._rag_enabled and RAG_ENABLE_FAST_RAG_SEMANTIC):
            return
        if not self.rows:
            return

        # Reuse if dataset didn't change.
        current_state = self._file_mtime_state()
        if self._fast_row_vectors and self._fast_row_vectors_state == current_state:
            return

        texts = [str(row.query or "").strip() for row in self.rows]
        texts = [t for t in texts if t]
        if not texts:
            return

        # Batch embeddings to reduce network overhead.
        vectors: List[List[float]] = []
        batch_size = 64
        for i in range(0, len(texts), batch_size):
            chunk = texts[i : i + batch_size]
            out = self._openai_embed(chunk)
            if out and len(out) == len(chunk):
                vectors.extend(out)
            else:
                # If something failed, stop; we'll just skip semantic matching.
                vectors = []
                break

        if not vectors or len(vectors) != len(texts):
            return

        new_map: Dict[str, Tuple[List[float], float]] = {}
        for text, vec in zip(texts, vectors):
            if not vec:
                continue
            new_map[text] = (vec, self._vector_norm(vec))

        self._fast_row_vectors = new_map
        self._fast_row_vectors_state = current_state
    
    def build_rag_context(self, session: Session, user_id: Optional[int], message: str) -> Dict[str, Any]:
        """Returns a compact RAG context block for prompting the main LLM.

        Output format:
        {
          "context_text": "...",
          "snippets": [ {source_type, source_id, score, ...}, ... ],
          "timings_ms": { ... }
        }
        """
        t0 = time.perf_counter()

        if not (self._rag_enabled and RAG_ENABLED and user_id):
            return {"context_text": "", "snippets": [], "timings_ms": {"rag_total_ms": 0.0}}

        query_text = self._maybe_rewrite_followup_query(session, int(user_id), message)
        normalized_query = self.normalize_lookup_text(query_text)
        q_tokens = set(self._tokens(normalized_query))
        exp_q = self._expand_tokens(q_tokens)
        return {"context_text": context_text, "snippets": snippet_meta, "timings_ms": timings}

    def try_answer(self, session: Session, user_id: Optional[int], message: str) -> Optional[Dict[str, Any]]:
        self._reload_if_needed()
        return None 