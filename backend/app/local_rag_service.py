from __future__ import annotations

import csv
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlmodel import Session

from .models import DailyRoutine, Item, QACache, User

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


class LocalRAGService:
    def __init__(self, dataset_path: Optional[Path] = None) -> None:
        self.dataset_path = dataset_path or FAST_RAG_DATASET_PATH
        self.keywords_path = self.dataset_path.parent / LOCAL_RAG_KEYWORDS_PATH.name
        self.synonyms_path = self.dataset_path.parent / LOCAL_RAG_SYNONYMS_PATH.name
        self.rows: List[FastRAGRow] = []
        self.keyword_rules: List[KeywordRule] = []
        self.synonym_map: Dict[str, Set[str]] = {}
        self._file_state: Dict[Path, Optional[int]] = {}
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

    def _build_schedule_answer(self, session: Session, user_id: int, normalized_message: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
        if not self._matches_intent_scope(normalized_message, intent="schedule", scope="base"):
            return None

        scope = "upcoming"
        if self._matches_intent_scope(normalized_message, intent="schedule", scope="today"):
            scope = "today"
        elif self._matches_intent_scope(normalized_message, intent="schedule", scope="tomorrow"):
            scope = "tomorrow"

        scope_labels = {
            "today": ("today", "இன்று"),
            "tomorrow": ("tomorrow", "நாளை"),
            "upcoming": ("upcoming", "வரவிருக்கும்"),
        }
        label_en, label_ta = scope_labels[scope]

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

    def _build_routine_answer(self, session: Session, user_id: int, normalized_message: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
        if not self._matches_intent_scope(normalized_message, intent="routine"):
            return None

        routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
        display_name = (user.name if user and user.name else "there").strip() or "there"

        if not routine:
            english = f"I do not have your daily routine yet, {display_name}. Please complete your routine setup first."
            tamil = f"{display_name}, உங்கள் தினசரி பழக்க விவரம் இன்னும் சேமிக்கப்படவில்லை. முதலில் routine setup-ஐ முடிக்கவும்."
            return self._build_pipeline_result(
                raw_english=english,
                remodeled_english=english,
                tamil_text=tamil,
                theni_tamil_text=tamil,
                route_taken="local_routine_rag",
                direct_answer_source="local_daily_routine",
                direct_answer_confidence="1.0000",
                predicted_label="routine",
                stage_notes=["Answered from the user's saved daily routine without calling OpenAI."],
                timings_ms={"total_ms": 0.0},
            )

        work_window = ""
        if routine.work_start and routine.work_end:
            work_window = f" from {routine.work_start} to {routine.work_end}"
        habits = (routine.daily_habits or "").strip() or "No daily habits saved yet."

        if self._matches_intent_scope(normalized_message, intent="routine", scope="wake"):
            english = f"Your wake-up time is {routine.wake_time}, {display_name}."
            tamil = f"{display_name}, உங்கள் எழும் நேரம் {routine.wake_time}."
        elif self._matches_intent_scope(normalized_message, intent="routine", scope="sleep"):
            english = f"Your sleep time is {routine.sleep_time}, {display_name}."
            tamil = f"{display_name}, உங்கள் தூங்கும் நேரம் {routine.sleep_time}."
        elif self._matches_intent_scope(normalized_message, intent="routine", scope="work"):
            if routine.work_start and routine.work_end:
                english = f"Your work time is from {routine.work_start} to {routine.work_end}, {display_name}."
                tamil = f"{display_name}, உங்கள் வேலை நேரம் {routine.work_start} முதல் {routine.work_end} வரை."
            else:
                english = f"I do not have your work timing yet, {display_name}."
                tamil = f"{display_name}, உங்கள் வேலை நேரம் இன்னும் சேமிக்கப்படவில்லை."
        elif self._matches_intent_scope(normalized_message, intent="routine", scope="habits"):
            english = f"Your saved daily habits are: {habits}"
            tamil = f"உங்கள் சேமிக்கப்பட்ட தினசரி பழக்கங்கள்: {habits}"
        else:
            english = (
                f"Your routine summary, {display_name}: wake at {routine.wake_time}, "
                f"sleep at {routine.sleep_time}{work_window}. Habits: {habits}"
            )
            tamil = (
                f"{display_name}, உங்கள் routine summary: எழும் நேரம் {routine.wake_time}, "
                f"தூங்கும் நேரம் {routine.sleep_time}"
            )
            if routine.work_start and routine.work_end:
                tamil += f", வேலை நேரம் {routine.work_start} முதல் {routine.work_end} வரை"
            tamil += f". பழக்கங்கள்: {habits}"

        return self._build_pipeline_result(
            raw_english=english,
            remodeled_english=english,
            tamil_text=tamil,
            theni_tamil_text=tamil,
            route_taken="local_routine_rag",
            direct_answer_source="local_daily_routine",
            direct_answer_confidence="1.0000",
            predicted_label="routine",
            stage_notes=["Answered from the user's saved daily routine without calling OpenAI."],
            timings_ms={"total_ms": 0.0},
        )

    def _matches_intent_scope(self, normalized_message: str, *, intent: str, scope: Optional[str] = None) -> bool:
        message = self.normalize_lookup_text(normalized_message)
        message_tokens = set(self._tokens(message))
        if not message:
            return False

        matched = False
        for rule in self.keyword_rules:
            if rule.intent != intent:
                continue
            if scope is not None and rule.scope != scope:
                continue
            if scope is None and rule.scope not in {"base", "default", "today", "tomorrow", "wake", "sleep", "work", "habits", "summary"}:
                continue
            for keyword in rule.keywords:
                normalized_keyword = self.normalize_lookup_text(keyword)
                if not normalized_keyword:
                    continue
                keyword_tokens = set(self._tokens(normalized_keyword))
                if self._contains_phrase(message, normalized_keyword):
                    return True
                overlap = self._set_overlap(self._expand_tokens(message_tokens), self._expand_tokens(keyword_tokens))
                if overlap >= 0.84:
                    matched = True
        return matched

    def _score_row(self, normalized_message: str, row: FastRAGRow) -> float:
        row_query = self.normalize_lookup_text(row.query)
        if not row_query:
            return 0.0

        message_tokens = set(self._tokens(normalized_message))
        row_tokens = set(self._tokens(row_query))
        expanded_message = self._expand_tokens(message_tokens)
        expanded_row = self._expand_tokens(row_tokens)
        expanded_tags = self._expand_tokens(row.tags)

        for blocked in row.blocked_terms:
            blocked_normalized = self.normalize_lookup_text(blocked)
            if blocked_normalized and self._contains_phrase(normalized_message, blocked_normalized):
                return 0.0

        if row.required_terms:
            required_hits = 0
            for required in row.required_terms:
                required_normalized = self.normalize_lookup_text(required)
                if required_normalized and (
                    self._contains_phrase(normalized_message, required_normalized)
                    or self._set_overlap(expanded_message, self._expand_tokens(self._tokens(required_normalized))) >= 0.84
                ):
                    required_hits += 1
            if required_hits == 0:
                return 0.0

        token_score = self._set_overlap(expanded_message, expanded_row)
        text_score = self._string_similarity(normalized_message, row_query)
        tag_score = self._set_overlap(expanded_message, expanded_tags) if expanded_tags else 0.0

        score = (0.58 * token_score) + (0.27 * text_score) + (0.15 * tag_score)

        if normalized_message == row_query:
            score = 1.0
        else:
            message_token_count = len(message_tokens)
            row_token_count = len(row_tokens)
            if row_token_count >= 2 and self._contains_phrase(normalized_message, row_query):
                score = max(score, 0.985)
            elif normalized_message.startswith(row_query) and message_token_count <= row_token_count + 1:
                score = max(score, FAST_RAG_PREFIX_MATCH_THRESHOLD)
            elif row_query.startswith(normalized_message) and row_token_count <= message_token_count + 1:
                score = max(score, 0.955)

            if row_token_count <= 2 and message_token_count >= row_token_count + 3:
                score *= 0.72

        score += min(0.03, max(0, row.priority) / 5000.0)
        return min(1.0, round(score, 4))

    def _match_fast_row(self, normalized_message: str) -> Optional[Tuple[FastRAGRow, float]]:
        best_row: Optional[FastRAGRow] = None
        best_score = 0.0
        for row in self.rows:
            score = self._score_row(normalized_message, row)
            if score > best_score:
                best_row = row
                best_score = score
        if best_row is None or best_score < FAST_RAG_STRONG_MATCH_THRESHOLD:
            return None
        return best_row, best_score

    def _coerce_cached_pipeline(self, payload: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(payload, dict):
            return None
        pipeline = payload.get("pipeline")
        if not isinstance(pipeline, dict):
            return None
        return self._build_pipeline_result(
            raw_english=str(pipeline.get("raw_english", "")).strip(),
            remodeled_english=str(pipeline.get("remodeled_english", "")).strip() or str(pipeline.get("raw_english", "")).strip(),
            tamil_text=str(pipeline.get("tamil_text", "")).strip(),
            theni_tamil_text=str(pipeline.get("theni_tamil_text", "")).strip(),
            route_taken=str(pipeline.get("route_taken", "cached_answer")).strip() or "cached_answer",
            direct_answer_source=str(pipeline.get("direct_answer_source", "qa_cache")).strip() or "qa_cache",
            direct_answer_confidence=str(pipeline.get("direct_answer_confidence", "1.0000")).strip() or "1.0000",
            predicted_label=str(pipeline.get("predicted_label", "cached")).strip() or "cached",
            risk_level=str(pipeline.get("risk_level", "low")).strip() or "low",
            stage_notes=["Reused a cached answer and skipped a new OpenAI call."],
            core_meta=pipeline.get("core_meta") if isinstance(pipeline.get("core_meta"), dict) else {},
            remodel_meta=pipeline.get("remodel_meta") if isinstance(pipeline.get("remodel_meta"), dict) else {},
            review_meta=pipeline.get("review_meta") if isinstance(pipeline.get("review_meta"), dict) else {},
            translation_meta=pipeline.get("translation_meta") if isinstance(pipeline.get("translation_meta"), dict) else {},
            timings_ms=pipeline.get("timings_ms") if isinstance(pipeline.get("timings_ms"), dict) else {"total_ms": 0.0},
        )

    def _try_cached_answer(self, session: Session, user_id: Optional[int], normalized_message: str) -> Optional[Dict[str, Any]]:
        if not user_id:
            return None

        cache_rows = list(
            session.exec(
                select(QACache).where(QACache.user_id == user_id).order_by(QACache.updated_at.desc())
            ).all()
        )[:FAST_RAG_MAX_CACHE_ROWS]

        best_payload: Optional[Dict[str, Any]] = None
        best_score = 0.0
        normalized_message_tokens = set(self._tokens(normalized_message))
        expanded_message_tokens = self._expand_tokens(normalized_message_tokens)

        for row in cache_rows:
            normalized_question = self.normalize_lookup_text(row.question)
            if not normalized_question:
                continue
            normalized_question_tokens = set(self._tokens(normalized_question))
            score = max(
                self._set_overlap(expanded_message_tokens, self._expand_tokens(normalized_question_tokens)),
                self._string_similarity(normalized_message, normalized_question),
            )
            if normalized_message == normalized_question:
                score = 1.0

            if score > best_score:
                try:
                    payload = json.loads(row.answer or "{}")
                except Exception:
                    payload = {}
                best_payload = self._coerce_cached_pipeline(payload)
                best_score = score

        if best_payload and best_score >= FAST_RAG_CACHE_MATCH_THRESHOLD:
            best_payload["route_taken"] = "cached_answer"
            best_payload["direct_answer_source"] = "qa_cache"
            best_payload["direct_answer_confidence"] = f"{best_score:.4f}"
            best_payload["cache_hit"] = "true"
            best_payload["stage_notes"] = json.dumps(
                ["Reused a cached answer and skipped a new OpenAI call."], ensure_ascii=False
            )
            return best_payload
        return None

    def try_answer(self, session: Session, user_id: Optional[int], message: str) -> Optional[Dict[str, Any]]:
        self._reload_if_needed()

        normalized_message = self.normalize_lookup_text(message)
        if not normalized_message:
            return None

        user = session.get(User, user_id) if user_id else None
        display_name = (user.name if user and user.name else "there").strip() or "there"
        assistant_name = (user.assistant_name if user and user.assistant_name else "Elli").strip() or "Elli"
        place = (user.place if user and user.place else "your saved place").strip() or "your saved place"

        if user_id:
            schedule_result = self._build_schedule_answer(session, user_id, normalized_message, user)
            if schedule_result is not None:
                return schedule_result

            routine_result = self._build_routine_answer(session, user_id, normalized_message, user)
            if routine_result is not None:
                return routine_result

        matched = self._match_fast_row(normalized_message)
        if matched is not None:
            row, score = matched
            english = self._format_template(
                row.english_template,
                user_name=display_name,
                assistant_name=assistant_name,
                place=place,
            )
            tamil = self._format_template(
                row.tamil_template,
                user_name=display_name,
                assistant_name=assistant_name,
                place=place,
            )
            theni = self._format_template(
                row.theni_tamil_template or row.tamil_template,
                user_name=display_name,
                assistant_name=assistant_name,
                place=place,
            )
            return self._build_pipeline_result(
                raw_english=english,
                remodeled_english=english,
                tamil_text=tamil,
                theni_tamil_text=theni,
                route_taken=f"local_{row.route}",
                direct_answer_source=f"fast_rag_csv:{row.query}",
                direct_answer_confidence=f"{score:.4f}",
                predicted_label=row.label,
                stage_notes=[
                    "Answered from backend/data/fast_rag_replies.csv without calling OpenAI.",
                    "Keyword datasets in backend/data can be edited without changing Python code.",
                ],
                timings_ms={"total_ms": 0.0},
            )

        if user_id:
            cached = self._try_cached_answer(session, user_id, normalized_message)
            if cached is not None:
                return cached

        return None