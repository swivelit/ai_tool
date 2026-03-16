from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlmodel import Session

from config import (
    FAST_RAG_AUTO_RELOAD,
    FAST_RAG_CACHE_MATCH_THRESHOLD,
    FAST_RAG_DATASET_PATH,
    FAST_RAG_MAX_CACHE_ROWS,
    FAST_RAG_PREFIX_MATCH_THRESHOLD,
    FAST_RAG_STRONG_MATCH_THRESHOLD,
)
from .models import Item, QACache, User


DEFAULT_FAST_RAG_ROWS = [
    {
        "query": "hi",
        "label": "greeting",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "hello",
        "label": "greeting",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "hey",
        "label": "greeting",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "ஹாய் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "vanakkam",
        "label": "greeting",
        "english_template": "Hi {user_name}, how are you doing?",
        "tamil_template": "வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "good morning",
        "label": "greeting",
        "english_template": "Good morning {user_name}, how are you doing?",
        "tamil_template": "காலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "காலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "good afternoon",
        "label": "greeting",
        "english_template": "Good afternoon {user_name}, how are you doing?",
        "tamil_template": "மதிய வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "மதிய வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "good evening",
        "label": "greeting",
        "english_template": "Good evening {user_name}, how are you doing?",
        "tamil_template": "மாலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
        "theni_tamil_template": "மாலை வணக்கம் {user_name}, எப்படி இருக்கீங்க?",
    },
    {
        "query": "how are you",
        "label": "smalltalk",
        "english_template": "I am doing well, {user_name}. How can I help you today?",
        "tamil_template": "நான் நல்லா இருக்கேன் {user_name}. இன்று என்ன உதவி வேண்டும்?",
        "theni_tamil_template": "நான் நல்லா இருக்கேன் {user_name}. இன்று என்ன உதவி வேண்டும்?",
    },
    {
        "query": "thanks",
        "label": "smalltalk",
        "english_template": "You're welcome, {user_name}.",
        "tamil_template": "பரவாயில்லை {user_name}, உதவியது சந்தோஷம்.",
        "theni_tamil_template": "பரவாயில்லை {user_name}, உதவியது சந்தோஷம்.",
    },
    {
        "query": "thank you",
        "label": "smalltalk",
        "english_template": "You're welcome, {user_name}.",
        "tamil_template": "பரவாயில்லை {user_name}, உதவியது சந்தோஷம்.",
        "theni_tamil_template": "பரவாயில்லை {user_name}, உதவியது சந்தோஷம்.",
    },
    {
        "query": "what is my name",
        "label": "profile",
        "english_template": "Your name is {user_name}.",
        "tamil_template": "உங்கள் பெயர் {user_name}.",
        "theni_tamil_template": "உங்கள் பெயர் {user_name}.",
    },
    {
        "query": "who am i",
        "label": "profile",
        "english_template": "Your name is {user_name}.",
        "tamil_template": "உங்கள் பெயர் {user_name}.",
        "theni_tamil_template": "உங்கள் பெயர் {user_name}.",
    },
    {
        "query": "who are you",
        "label": "assistant_identity",
        "english_template": "I'm {assistant_name}, your assistant. I can help with reminders, schedules, and quick answers.",
        "tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
        "theni_tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
    },
    {
        "query": "what is your name",
        "label": "assistant_identity",
        "english_template": "I'm {assistant_name}, your assistant. I can help with reminders, schedules, and quick answers.",
        "tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
        "theni_tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
    },
    {
        "query": "help",
        "label": "assistant_identity",
        "english_template": "I'm {assistant_name}, your assistant. I can help with reminders, schedules, and quick answers.",
        "tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
        "theni_tamil_template": "நான் {assistant_name}. நினைவூட்டல்கள், அட்டவணை, மற்றும் விரைவு பதில்களில் நான் உதவ முடியும்.",
    },
]


@dataclass
class FastRAGRow:
    query: str
    label: str
    english_template: str
    tamil_template: str
    theni_tamil_template: str


class LocalRAGService:
    def __init__(self, dataset_path: Optional[Path] = None) -> None:
        self.dataset_path = dataset_path or FAST_RAG_DATASET_PATH
        self.rows: List[FastRAGRow] = []
        self._dataset_mtime_ns: Optional[int] = None
        self.reload(force=True)

    def reload(self, *, force: bool = False) -> None:
        self._ensure_default_dataset()
        try:
            current_mtime = self.dataset_path.stat().st_mtime_ns
        except OSError:
            current_mtime = None

        if not force and self.rows and current_mtime == self._dataset_mtime_ns:
            return

        self.rows = self._load_rows()
        self._dataset_mtime_ns = current_mtime

    def _reload_if_needed(self) -> None:
        if not FAST_RAG_AUTO_RELOAD:
            return
        self.reload(force=False)

    def _ensure_default_dataset(self) -> None:
        self.dataset_path.parent.mkdir(parents=True, exist_ok=True)
        if self.dataset_path.exists():
            return

        with self.dataset_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=["query", "label", "english_template", "tamil_template", "theni_tamil_template"],
            )
            writer.writeheader()
            writer.writerows(DEFAULT_FAST_RAG_ROWS)

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
                rows.append(
                    FastRAGRow(
                        query=query,
                        label=str(row.get("label", "local")).strip() or "local",
                        english_template=str(row.get("english_template", "")).strip(),
                        tamil_template=str(row.get("tamil_template", "")).strip(),
                        theni_tamil_template=str(row.get("theni_tamil_template", "")).strip()
                        or str(row.get("tamil_template", "")).strip(),
                    )
                )
        return rows

    @staticmethod
    def normalize_lookup_text(text: str) -> str:
        parts = re.findall(r"[a-z0-9_\u0B80-\u0BFF]+", str(text or "").lower())
        return " ".join(parts)

    @classmethod
    def token_overlap_score(cls, left: str, right: str) -> float:
        left_tokens = set(cls.normalize_lookup_text(left).split())
        right_tokens = set(cls.normalize_lookup_text(right).split())
        if not left_tokens and not right_tokens:
            return 1.0
        if not left_tokens or not right_tokens:
            return 0.0
        return len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))

    @classmethod
    def string_similarity(cls, left: str, right: str) -> float:
        return SequenceMatcher(None, cls.normalize_lookup_text(left), cls.normalize_lookup_text(right)).ratio()

    @staticmethod
    def _build_pipeline_result(
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
            "pipeline_version": "local_rag_service_v2",
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
                include = parsed >= now_local and parsed <= upcoming_cutoff

            if include:
                collected.append((parsed, item))

        collected.sort(key=lambda pair: pair[0])
        return [item for _, item in collected[:5]]

    def _build_schedule_answer(self, session: Session, user_id: int, normalized_query: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
        if not any(word in normalized_query for word in ["schedule", "reminder", "reminders", "task", "tasks", "todo", "plan"]):
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

    @staticmethod
    def _format_template(template: str, *, user_name: str, assistant_name: str) -> str:
        return str(template or "").format(user_name=user_name, assistant_name=assistant_name).strip()

    def _match_fast_row(self, normalized_message: str) -> Optional[Tuple[FastRAGRow, float]]:
        best_row: Optional[FastRAGRow] = None
        best_score = 0.0

        for row in self.rows:
            row_query = self.normalize_lookup_text(row.query)
            if not row_query:
                continue

            token_score = self.token_overlap_score(normalized_message, row_query)
            string_score = self.string_similarity(normalized_message, row_query)
            score = max(token_score, string_score)

            if normalized_message == row_query:
                score = 1.0
            elif normalized_message.startswith(row_query):
                score = max(score, FAST_RAG_PREFIX_MATCH_THRESHOLD)
            elif row_query in normalized_message:
                score = max(score, 0.975)

            if score > best_score:
                best_row = row
                best_score = score

        if best_row is None or best_score < FAST_RAG_STRONG_MATCH_THRESHOLD:
            return None
        return best_row, round(best_score, 4)

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
            session.exec(select(QACache).where(QACache.user_id == user_id).order_by(QACache.updated_at.desc())).all()
        )[:FAST_RAG_MAX_CACHE_ROWS]

        best_payload: Optional[Dict[str, Any]] = None
        best_score = 0.0
        for row in cache_rows:
            normalized_question = self.normalize_lookup_text(row.question)
            token_score = self.token_overlap_score(normalized_message, normalized_question)
            string_score = self.string_similarity(normalized_message, normalized_question)
            score = max(token_score, string_score)
            if normalized_question == normalized_message:
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

        normalized = self.normalize_lookup_text(message)
        if not normalized:
            return None

        user = session.get(User, user_id) if user_id else None
        display_name = (user.name if user and user.name else "there").strip() or "there"
        assistant_name = (user.assistant_name if user and user.assistant_name else "Elli").strip() or "Elli"

        matched = self._match_fast_row(normalized)
        if matched is not None:
            row, score = matched
            english = self._format_template(row.english_template, user_name=display_name, assistant_name=assistant_name)
            tamil = self._format_template(row.tamil_template, user_name=display_name, assistant_name=assistant_name)
            theni = self._format_template(
                row.theni_tamil_template or row.tamil_template,
                user_name=display_name,
                assistant_name=assistant_name,
            )
            return self._build_pipeline_result(
                raw_english=english,
                remodeled_english=english,
                tamil_text=tamil,
                theni_tamil_text=theni,
                route_taken="local_fast_rag",
                direct_answer_source=f"fast_rag_csv:{row.query}",
                direct_answer_confidence=f"{score:.4f}",
                predicted_label=row.label,
                stage_notes=["Answered from backend/data/fast_rag_replies.csv without calling OpenAI."],
                timings_ms={"total_ms": 0.0},
            )

        if user_id:
            schedule_result = self._build_schedule_answer(session, user_id, normalized, user)
            if schedule_result is not None:
                return schedule_result

            cached = self._try_cached_answer(session, user_id, normalized)
            if cached is not None:
                return cached

        return None