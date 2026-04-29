from __future__ import annotations

import asyncio
import base64
import hmac
import hashlib
import json
import logging
import os
import re
import secrets
import sys
import tempfile
import threading
from collections import OrderedDict

import requests
import time
import openai
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel, Session, delete, select

CURRENT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = CURRENT_DIR.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

load_dotenv()

from .auth import (
    AuthConfigurationError,
    AuthUser,
    assert_owner,
    firebase_auth_runtime_status,
    get_current_user,
    get_owned_user,
    is_production_environment,
    normalize_app_env,
    validate_auth_configuration,
)
from .database import SessionLocal, engine, get_session
from .job_queue import DBJobQueue
from .model_runtime import patch_openai_client
from .models import Conversation, DailyRoutine, Item, Job, QACache, RagEmbedding, User, UserProfile
from .time_utils import utc_now as _utc_now
from .observability import bootstrap_observability, clear_request_context, new_request_id, set_request_context
from .vector_store import VectorStore
from .local_rag_service import LocalRAGService
from .agentic_service import AgenticService
from .orchestrator_task import run_orchestrator


bootstrap_observability()
patch_openai_client()

from config import (
    GENERATED_DOCS_DIR,
    LOGS_DIR,
    PIPELINE_VERSION,
    RAG_CONTEXT_HEADER,
    RAG_CONTEXT_INCLUDE_IN_STAGE_CONTEXT,
    RAG_CONTEXT_MAX_SNIPPETS,
)  # noqa: E402
from stage_behaviour_questions import BehaviourQuestionnaire, QUESTIONS as PIPELINE_QUESTIONS  # noqa: E402
from stage_english_remodel import EnglishRemodeler  # noqa: E402
from stage_openai_core import OpenAICore  # noqa: E402
from stage_translate import StageTranslator  # noqa: E402
from .behavioural_rag_filter import BehaviouralRAGFilter  # noqa: E402
try:
    from .openwakeword_api import router as openwakeword_router  # noqa: E402
except Exception as exc:  # pragma: no cover - protects core API startup from optional wakeword deps
    openwakeword_router = None
    OPENWAKEWORD_IMPORT_ERROR = exc
else:
    OPENWAKEWORD_IMPORT_ERROR = None

logger = logging.getLogger(__name__)

REQUIRED_PROFILE_SLOTS = {
    "preferred_language",
    "secondary_language",
    "occupation",
    "industry_or_field",
    "hobbies",
    "interests",
    "communication_tone",
    "answer_length",
    "personality_style",
    "assistant_persona",
    "planning_style",
    "learning_style",
    "main_goal",
    "dislikes",
    "work_rhythm",
}

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
ALLOWED_AUDIO_CONTENT_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/aac",
    "audio/webm",
    "application/octet-stream",
}

_download_token_secret = (
    os.getenv("DOWNLOAD_TOKEN_SECRET", "").strip()
    or os.getenv("SECRET_KEY", "").strip()
)

APP_ENV = normalize_app_env()

if not _download_token_secret:
    if APP_ENV in {"prod", "production"}:
        raise RuntimeError("DOWNLOAD_TOKEN_SECRET or SECRET_KEY must be set in production.")
    logger.warning("DOWNLOAD_TOKEN_SECRET is not set; using a dev-only random secret.")
    _download_token_secret = secrets.token_urlsafe(32)

DOWNLOAD_TOKEN_SECRET = _download_token_secret
DOWNLOAD_TOKEN_TTL_SECONDS = int(os.getenv("DOWNLOAD_TOKEN_TTL_SECONDS", "900") or 900)

def _utc_now_iso() -> str:
    return _utc_now().isoformat().replace("+00:00", "Z")


def safe_commit(session: Session, context: str) -> None:
    try:
        session.commit()
    except Exception:
        session.rollback()
        logger.exception("DB commit failed", extra={"context": context})
        raise


def _load_json_object(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _has_completed_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(_has_completed_value(item) for item in value)
    if isinstance(value, dict):
        return bool(value)
    return True


def _redact_user_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    redacted = dict(payload)
    for key in {
        "email",
        "firebase_uid",
        "transcript",
        "user_input",
        "profile_summary",
        "answers",
        "message",
        "text",
    }:
        if key in redacted:
            redacted[key] = "[REDACTED]"
    return redacted


async def read_limited_upload(file: UploadFile) -> bytes:
    content_type = str(file.content_type or "").split(";")[0].strip().lower()
    if content_type and content_type not in ALLOWED_AUDIO_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported file type")

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    return data


def _require_parent_user(session: Session, user_id: int) -> User:
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


PERSONALITY_QUESTIONS_VERSION = 1
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_JSON_MODEL = os.getenv("OPENAI_JSON_MODEL", "gpt-4o-mini")
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "").strip()

client: Optional[openai.OpenAI] = None
JOB_QUEUE: Optional[DBJobQueue] = None
VECTOR_STORE = VectorStore(engine, backend=os.getenv("VECTOR_STORE_BACKEND", "auto"))

DEFAULT_CORS_ORIGINS = [
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:19006",
    "http://127.0.0.1:19006",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
]

CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "").split(",")
    if origin.strip()
] or DEFAULT_CORS_ORIGINS

app = FastAPI(title="J AI Backend")
RUNTIME_STATUS: Dict[str, Any] = {
    "status": "starting",
    "services": {},
    "errors": [],
}

if openwakeword_router is not None:
    app.include_router(openwakeword_router)
else:
    logger = logging.getLogger(__name__)
    logger.warning(
        "OpenWakeWord routes disabled because optional dependencies failed to import: %s",
        OPENWAKEWORD_IMPORT_ERROR,
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _include_optional_legacy_onboarding_router() -> None:
    try:
        from . import onboarding_agent

        app.include_router(
            onboarding_agent.router,
            prefix="/api/onboarding",
            tags=["deprecated-onboarding"],
        )

        if getattr(onboarding_agent, "LEGACY_ONBOARDING_AVAILABLE", True):
            logger.info("Deprecated onboarding router loaded for compatibility only.")
        else:
            logger.warning(
                "Deprecated onboarding router loaded in compatibility mode only; legacy extras are unavailable: %s",
                getattr(onboarding_agent, "LEGACY_ONBOARDING_IMPORT_ERROR", "unknown import error"),
            )
    except Exception as exc:
        logger.warning(
            "Deprecated onboarding router was not included because it failed to import. Backend boot will continue without it: %s",
            exc,
        )


# Legacy compatibility route. Phone-local onboarding is the primary runtime path.
_include_optional_legacy_onboarding_router()

class ThreadSafeLRUCache:
    def __init__(self, max_size: int = 128):
        self.max_size = max(1, int(max_size))
        self._data: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get_copy(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            value = self._data.get(key)
            if value is None:
                return None
            self._data.move_to_end(key)
            return dict(value)

    def set(self, key: str, value: Dict[str, Any]) -> None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
            self._data[key] = dict(value)
            if len(self._data) > self.max_size:
                self._data.popitem(last=False)

    def pop(self, key: str, default: Optional[Any] = None) -> Optional[Any]:
        with self._lock:
            return self._data.pop(key, default)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def delete_prefix(self, prefix: str) -> None:
        with self._lock:
            keys_to_delete = [key for key in self._data if key.startswith(prefix)]
            for key in keys_to_delete:
                self._data.pop(key, None)


STAGE_BEHAVIOUR = BehaviourQuestionnaire()
LOCAL_RAG_SERVICE = LocalRAGService()
STAGE_CORE: Optional[OpenAICore] = None
STAGE_REMODELER: Optional[EnglishRemodeler] = None
STAGE_TRANSLATOR: Optional[StageTranslator] = None
AGENTIC_SERVICE: Optional[AgenticService] = None
SAFETY_FILTER: Optional[BehaviouralRAGFilter] = None
STAGE_CACHE = ThreadSafeLRUCache(max_size=128)


def _is_openai_configured() -> bool:
    return bool(OPENAI_API_KEY)


def _openai_required_error(operation: str = "This operation") -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=f"{operation} requires OPENAI_API_KEY to be configured on the server.",
    )


def _get_openai_client(*, required: bool = True) -> Optional[openai.OpenAI]:
    global client

    if not _is_openai_configured():
        if required:
            raise _openai_required_error()
        return None

    if client is None:
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
    return client


def _get_stage_core(*, required: bool = True) -> Optional[OpenAICore]:
    global STAGE_CORE

    if STAGE_CORE is None:
        if not _is_openai_configured():
            if required:
                raise _openai_required_error("The stage pipeline")
            return None
        STAGE_CORE = OpenAICore()

    return STAGE_CORE


def _get_stage_remodeler(*, required: bool = True) -> Optional[EnglishRemodeler]:
    global STAGE_REMODELER

    core = _get_stage_core(required=required)
    if core is None:
        return None

    if STAGE_REMODELER is None:
        STAGE_REMODELER = EnglishRemodeler(core)

    return STAGE_REMODELER


def _get_stage_translator(*, required: bool = True) -> Optional[StageTranslator]:
    global STAGE_TRANSLATOR

    core = _get_stage_core(required=required)
    if core is None:
        return None

    if STAGE_TRANSLATOR is None:
        STAGE_TRANSLATOR = StageTranslator(core)

    return STAGE_TRANSLATOR


def _get_agentic_service() -> AgenticService:
    global AGENTIC_SERVICE

    if AGENTIC_SERVICE is None:
        AGENTIC_SERVICE = AgenticService(_get_openai_client(required=False), LOCAL_RAG_SERVICE)

    return AGENTIC_SERVICE


def _get_safety_filter() -> Optional[BehaviouralRAGFilter]:
    global SAFETY_FILTER

    if SAFETY_FILTER is None:
        try:
            SAFETY_FILTER = BehaviouralRAGFilter()
        except Exception as exc:
            logger.warning("Failed to initialize SAFETY_FILTER: %s", exc)
            return None

    return SAFETY_FILTER


def _normalize_reply_language(value: Optional[str]) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"en", "english"}:
        return "en"
    if normalized in {"ta", "tamil", "mixed", "tanglish"}:
        return "ta"
    return "ta"


def _normalize_lookup_text(text: str) -> str:
    parts = re.findall(r"[a-z0-9_\u0B80-\u0BFF]+", str(text or "").lower())
    return " ".join(parts)


def _token_overlap_score(left: str, right: str) -> float:
    left_tokens = set(_normalize_lookup_text(left).split())
    right_tokens = set(_normalize_lookup_text(right).split())
    if not left_tokens and not right_tokens:
        return 1.0
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))


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
        "pipeline_version": PIPELINE_VERSION,
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


def _coerce_cached_pipeline(payload: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(payload, dict):
        return None
    pipeline = payload.get("pipeline")
    if not isinstance(pipeline, dict):
        return None

    return _build_pipeline_result(
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


def _get_user_timezone(user: Optional[User]) -> ZoneInfo:
    tz_name = (user.timezone if user and user.timezone else "Asia/Kolkata").strip() or "Asia/Kolkata"
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("Asia/Kolkata")


def _parse_item_datetime(raw_value: Optional[str], user: Optional[User]) -> Optional[datetime]:
    raw = str(raw_value or "").strip()
    if not raw:
        return None

    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=_get_user_timezone(user))

    return parsed.astimezone(_get_user_timezone(user))


def _format_item_time(item: Item, user: Optional[User]) -> str:
    parsed = _parse_item_datetime(item.datetime_str, user)
    if parsed is None:
        return "Any time"
    return parsed.strftime("%I:%M %p").lstrip("0")


def _collect_items_for_scope(session: Session, user_id: int, scope: str, user: Optional[User]) -> List[Item]:
    all_items = list(session.exec(select(Item).where(Item.user_id == user_id)).all())
    now_local = datetime.now(_get_user_timezone(user))
    today = now_local.date()
    tomorrow = today + timedelta(days=1)
    upcoming_cutoff = now_local + timedelta(days=30)
    collected: List[tuple[datetime, Item]] = []

    for item in all_items:
        parsed = _parse_item_datetime(item.datetime_str, user)
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


def _build_schedule_answer(session: Session, user_id: int, normalized_query: str, user: Optional[User]) -> Optional[Dict[str, Any]]:
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

    items = _collect_items_for_scope(session, user_id, scope, user)
    display_name = (user.name if user and user.name else "there").strip() or "there"

    if not items:
        english = f"You do not have any {label_en} reminders, {display_name}."
        tamil = f"{display_name}, உங்களுக்கு {label_ta} எந்த நினைவூட்டலும் இல்லை."
        return _build_pipeline_result(
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
        time_label = _format_item_time(item, user)
        english_lines.append(f"{idx}. {time_label} - {title}")
        tamil_lines.append(f"{idx}. {time_label} - {title}")

    english = "\n".join(english_lines)
    tamil = "\n".join(tamil_lines)
    return _build_pipeline_result(
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


def _try_local_fast_path(session: Session, user_id: Optional[int], message: str) -> Optional[Dict[str, Any]]:
    """
    Refactored: Delegates to the centralized LocalRAGService with safety checks.
    Ensures 90% confidence and source validity (Friend's Suggestion).
    """
    # 🏃 Call the centralized, smart service
    fast_path = LOCAL_RAG_SERVICE.try_answer(session, user_id, message)
    
    if fast_path is not None:
        confidence = float(fast_path.get("direct_answer_confidence", 0.0))
        source = str(fast_path.get("direct_answer_source", "")).strip()

        # 🛡️ Apply the 90% Safety Filter (The 'Proper Check')
        if confidence >= 0.90 and source not in ["", "unknown"]:
            return fast_path
    
    return None

def _serialize_job(job: Optional[Job]) -> Dict[str, Any]:
    if job is None:
        raise HTTPException(404, "Job not found")
    result_payload = {}
    if job.result_json:
        try:
            result_payload = json.loads(job.result_json)
        except Exception:
            result_payload = {"raw": job.result_json}
    return {
        "id": job.id,
        "job_type": job.job_type,
        "status": job.status,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "error_message": job.error_message,
        "result": result_payload,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def _get_job_queue() -> DBJobQueue:
    global JOB_QUEUE
    if JOB_QUEUE is None:
        JOB_QUEUE = DBJobQueue(engine, poll_seconds=float(os.getenv("JOB_QUEUE_POLL_SECONDS", "1.0") or 1.0))
    return JOB_QUEUE


def _job_worker_enabled() -> bool:
    return os.getenv("JOB_WORKER_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}


def _async_jobs_available() -> bool:
    if not _job_worker_enabled():
        return False
    return _get_job_queue().is_running()


def _require_async_jobs_available() -> None:
    if not _async_jobs_available():
        raise HTTPException(503, "Async jobs are disabled because no background job worker is running.")


def _validate_export_format(export_format: str) -> str:
    normalized = str(export_format or "").strip().lower()
    if normalized not in {"pdf", "excel", "ppt", "docx"}:
        raise HTTPException(400, "Unsupported export format")
    return normalized


def _job_handle_export(session: Session, payload: Dict[str, Any]) -> Dict[str, Any]:
    item_id = int(payload["item_id"])
    export_format = _validate_export_format(payload["export_format"])
    item = session.get(Item, item_id)
    if not item:
        raise RuntimeError("Item not found")
    generators = {
        "pdf": generate_pdf,
        "excel": generate_excel,
        "ppt": generate_ppt,
        "docx": generate_docx,
    }
    generator = generators.get(export_format)
    if generator is None:
        raise RuntimeError(f"Unsupported export format: {export_format}")
    return _build_download_payload(generator(item), item=item)


def _job_handle_chat(session: Session, payload: Dict[str, Any]) -> Dict[str, Any]:
    message = str(payload.get("message") or payload.get("text") or "").strip()
    if not message:
        raise RuntimeError("message is required")
    user_id = payload.get("user_id")
    reply_language = payload.get("reply_language")
    pipeline_result = _run_agentic_or_pipeline(session, user_id, message, reply_language)
    item, meta, normalized_pipeline = _save_item_from_pipeline(
        session,
        user_id=user_id,
        source="text",
        raw_text=message,
        transcript=None,
        pipeline_result=pipeline_result,
        reply_language=reply_language,
    )
    return _build_chat_response(item, meta, normalized_pipeline)


def _register_job_handlers() -> None:
    queue = _get_job_queue()
    queue.register("export", _job_handle_export)
    queue.register("chat", _job_handle_chat)

def _record_runtime_service(name: str, *, ok: bool, required: bool, detail: str = "") -> None:
    RUNTIME_STATUS["services"][name] = {
        "ok": ok,
        "required": required,
        "detail": detail,
    }
    if not ok:
        RUNTIME_STATUS["errors"].append({"service": name, "detail": detail, "required": required})


@app.on_event("startup")
def startup_runtime_services() -> None:
    RUNTIME_STATUS["status"] = "starting"
    RUNTIME_STATUS["services"] = {}
    RUNTIME_STATUS["errors"] = []

    if not _is_openai_configured():
        logger.warning("OPENAI_API_KEY is not set. OpenAI-dependent endpoints will return HTTP 503 until configured.")
        _record_runtime_service("openai", ok=False, required=False, detail="OPENAI_API_KEY is not configured.")
    else:
        _record_runtime_service("openai", ok=True, required=False)

    auth_required = is_production_environment(APP_ENV)
    try:
        validate_auth_configuration(APP_ENV)
        auth_status = firebase_auth_runtime_status()
        token_verification_configured = bool(auth_status.get("token_verification_configured"))
        if token_verification_configured:
            _record_runtime_service("firebase_auth", ok=True, required=auth_required)
        else:
            _record_runtime_service(
                "firebase_auth",
                ok=False,
                required=auth_required,
                detail="Firebase token verification is not configured.",
            )
    except AuthConfigurationError as exc:
        logger.error("Firebase auth configuration check failed: %s", exc)
        _record_runtime_service(
            "firebase_auth",
            ok=False,
            required=auth_required,
            detail=str(exc),
        )

    auto_create_tables = os.getenv("AUTO_CREATE_TABLES", "").strip().lower() in {"1", "true", "yes", "on"}
    if str(engine.url).startswith("sqlite"):
        auto_create_tables = os.getenv("AUTO_CREATE_TABLES", "true").strip().lower() not in {"0", "false", "no", "off"}

    try:
        if auto_create_tables:
            SQLModel.metadata.create_all(engine)
            _record_runtime_service("database_schema", ok=True, required=True, detail="create_all enabled")
        else:
            _record_runtime_service("database_schema", ok=True, required=True, detail="create_all disabled; run Alembic migrations before startup")
    except Exception as exc:
        logger.exception("Database schema initialization failed")
        _record_runtime_service("database_schema", ok=False, required=True, detail=str(exc))

    try:
        VECTOR_STORE.initialize()
        _record_runtime_service("vector_store", ok=True, required=True, detail=getattr(VECTOR_STORE, "mode", "initialized"))
    except Exception as exc:
        logger.exception("Vector store initialization failed")
        _record_runtime_service("vector_store", ok=False, required=True, detail=str(exc))

    try:
        _register_job_handlers()
        if _job_worker_enabled():
            _get_job_queue().start()
            detail = "worker started"
        else:
            detail = "worker disabled"
        _record_runtime_service("job_queue", ok=True, required=True, detail=detail)
    except Exception as exc:
        logger.exception("Job queue initialization failed")
        _record_runtime_service("job_queue", ok=False, required=True, detail=str(exc))

    required_errors = [error for error in RUNTIME_STATUS["errors"] if error.get("required")]
    RUNTIME_STATUS["status"] = "degraded" if required_errors else "ok"

    if required_errors and os.getenv("FAIL_STARTUP_ON_REQUIRED_SERVICE_ERROR", "false").lower() in {"1", "true", "yes", "on"}:
        raise RuntimeError(f"Required runtime services failed: {required_errors}")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or new_request_id()
    start = time.perf_counter()
    set_request_context(request_id=request_id, route=request.url.path)
    try:
        response = await call_next(request)
    except Exception:
        logger.exception(
            "request failed",
            extra={"method": request.method, "path": request.url.path},
        )
        clear_request_context()
        raise
    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    response.headers["x-request-id"] = request_id
    logger.info(
        "request completed",
        extra={
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "duration_ms": duration_ms,
        },
    )
    clear_request_context()
    return response


@app.api_route("/", methods=["GET", "HEAD"])
def root():
    return {
        "ok": True,
        "app": "J AI",
        "message": "Persona-aware Tamil assistant backend is running.",
        "endpoints": {
            "health": "/health",
            "text": "/api/chat",
            "voice": "/transcribe-and-analyze",
        },
    }


def _health_status_code(payload: Dict[str, Any]) -> int:
    return 200 if payload["status"] == "ok" else 503


def _public_health_payload() -> Dict[str, Any]:
    return {
        "status": RUNTIME_STATUS.get("status") or "starting",
        "app": "J AI",
    }


def _debug_health_payload() -> Dict[str, Any]:
    return {
        "status": RUNTIME_STATUS.get("status") or "starting",
        "app": "J AI",
        "pipeline_version": PIPELINE_VERSION,
        "services": RUNTIME_STATUS.get("services", {}),
        "auth": {
            "firebase": firebase_auth_runtime_status(),
        },
        "errors": RUNTIME_STATUS.get("errors", []),
        "mode": PIPELINE_VERSION,
        "features": [
            "persona_context",
            "openai_core_answer",
            "english_remodel",
            "tamil_translation",
            "theni_tamil_conversion",
            "whisper_audio_transcription",
            "advanced_hybrid_rag",
            "semantic_memory_rag",
            "qa_cache_rag",
        ],
    }


@app.get("/health")
def health():
    payload = _public_health_payload()
    return JSONResponse(payload, status_code=_health_status_code(payload))


@app.get("/api/health")
def api_health():
    payload = _public_health_payload()
    return JSONResponse(payload, status_code=_health_status_code(payload))


@app.get("/api/debug/health")
def debug_health():
    if APP_ENV in {"prod", "production"}:
        raise HTTPException(status_code=404, detail="Not found")
    payload = _debug_health_payload()
    return JSONResponse(payload, status_code=_health_status_code(payload))


PARSE_DT_PROMPT = """
You convert natural language datetime into ISO datetime.
Input includes:
- timezone (IANA)
- now (ISO)
- text

Return ONLY JSON:
{
  "iso": "YYYY-MM-DDTHH:MM:SS" or null,
  "human": "human readable summary",
  "confidence": 0.0 to 1.0
}
"""

SYSTEM_PROMPT = """
You are a personal AI assistant.

You will receive JSON input with:
- context:
    - user (name, place, timezone)
    - routine (daily schedule and habits)
    - personality (communication style, motivation, sensitivity)
- input (the user's message)

Rules:
- Always respect the user's routine when suggesting times or actions
- Always match your tone to the personality profile
- If personality is missing, be neutral and polite
- If routine is missing, ask clarifying questions
- Never suggest actions outside wake/sleep boundaries unless explicitly asked
- If a request conflicts with routine, explain and suggest an alternative
- If onboarding_profile is available:
    - You MUST use it to personalize your response
    - Refer to user's goals, preferences, and background
    - Tailor suggestions based on onboarding answers
    - Do NOT ignore onboarding data
- If onboarding_profile is available:
    - You MUST prioritize it over generic responses
    - Use it to guide decisions, not just tone
Return ONLY JSON:
{
  "intent": "reminder|note|task|document|other",
  "category": "Work|Home|Business|Other",
  "datetime": "... or null",
  "title": "...",
  "details": "..."
}
"""

PERSONALITY_QUESTIONS = [
    "How would you describe yourself in one sentence?",
    "Do you prefer strict reminders or gentle nudges?",
    "Are you more spontaneous or planned?",
    "What usually motivates you?",
    "How do you want the assistant to talk to you?",
]

PERSONALITY_SUMMARY_PROMPT = """
You are analyzing a user's personality.

Based on their answers, create a concise profile including:
- communication tone
- motivation style
- structure vs flexibility preference
- emotional sensitivity

Return plain text. No JSON.
"""

CHECKIN_PROMPT = """
- Match message tone to personality
- If personality prefers gentle nudges, avoid commands
- If personality prefers strictness, be direct

You will receive:
- user profile (name, place, timezone)
- user routine (wake_time, sleep_time, work_start, work_end, daily_habits)

Create 3–8 smart check-ins for today.
Respect the user's routine and time boundaries.

Each check-in must include:
- title
- when (HH:MM 24h)
- message (address user by name)

Return ONLY JSON:
{ "checkins": [ { "title":"...", "when":"08:00", "message":"..." } ] }
"""


class TTSRequest(BaseModel):
    text: str


class ParseDatetimeRequest(BaseModel):
    text: str
    timezone: str = "Asia/Kolkata"
    now_iso: Optional[str] = None


class DailyRoutineIn(BaseModel):
    wake_time: str
    sleep_time: str
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    daily_habits: Optional[str] = None


class DailyRoutineOut(DailyRoutineIn):
    user_id: int


class TextAnalysisRequest(BaseModel):
    text: str
    user_id: Optional[int] = None
    meta: Optional[Dict[str, Any]] = None
    reply_language: Optional[str] = None


PersonalityAnswerValue = Union[str, List[str]]


class PersonalityAnswersIn(BaseModel):
    answers: Dict[str, PersonalityAnswerValue]


class TextAnalysisResponse(BaseModel):
    id: int
    intent: str
    category: str
    raw_text: str
    transcript: Optional[str] = None
    datetime: Optional[str] = None
    title: Optional[str] = None
    details: Optional[str] = None
    created_at: Optional[str] = None
    source: Optional[str] = None


class UserCreate(BaseModel):
    user_id: Optional[int] = None
    firebase_uid: Optional[str] = None
    email: Optional[str] = None
    name: str
    place: Optional[str] = None
    timezone: Optional[str] = "Asia/Kolkata"
    assistant_name: Optional[str] = "Elli"
    reply_language: Optional[str] = "ta"


class ChatAPIRequest(BaseModel):
    user_id: Optional[int] = None
    message: Optional[str] = None
    text: Optional[str] = None
    include_pipeline: bool = True
    reply_language: Optional[str] = None


class PipelineChatRequest(BaseModel):
    user_id: int
    message: str

class AgentMessageRequest(BaseModel):
    message: str
    reply_language: Optional[str] = None

class AgentMemorySyncRequest(BaseModel):
    force: bool = False

def _extract_response_text(response: Any) -> str:
    """Standard OpenAI Response parsing"""
    try:
        if hasattr(response, "choices") and response.choices:
            return str(response.choices[0].message.content or "").strip()
        return ""
    except Exception:
        return ""


def llm_json(system_prompt: str, user_content: str, temperature: float = 0.2) -> Dict[str, Any]:
    response = _get_openai_client().chat.completions.create(
        model=OPENAI_JSON_MODEL,
        messages=[
            {"role": "system", "content": system_prompt.strip()},
            {"role": "user", "content": user_content.strip()},
        ],
        temperature=temperature,
        response_format={"type": "json_object"},
    )
    raw = _extract_response_text(response)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning(
            "LLM returned invalid JSON",
            extra={"raw_length": len(raw or "")},
        )
        raise HTTPException(
            status_code=502,
            detail="Model returned invalid JSON",
        ) from exc

    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=502,
            detail="Model returned JSON but not an object",
        )

    return parsed


def llm_text(system_prompt: str, user_content: str, temperature: float = 0.2) -> str:
    response = _get_openai_client().chat.completions.create(
        model=OPENAI_JSON_MODEL,
        messages=[
            {"role": "system", "content": system_prompt.strip()},
            {"role": "user", "content": user_content.strip()},
        ],
        temperature=temperature,
    )
    return _extract_response_text(response)


def normalize_category(raw: str) -> str:
    cr = (raw or "Other").lower()
    if cr == "work":
        return "Work"
    if cr == "home":
        return "Home"
    if cr == "business":
        return "Business"
    return "Other"


def validate_hhmm(v: str) -> None:
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", str(v or "").strip()):
        raise HTTPException(400, f"Invalid time format: {v}")


def normalize_optional(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = str(v).strip()
    return v if v else None


def item_to_response(item: Item) -> TextAnalysisResponse:
    return TextAnalysisResponse(
        id=item.id,
        intent=item.intent,
        category=item.category,
        raw_text=item.raw_text,
        transcript=item.transcript,
        datetime=item.datetime_str,
        title=item.title,
        details=item.details,
        created_at=item.created_at.isoformat() if item.created_at else None,
        source=item.source,
    )


def log_conversation(
    session: Session,
    user_id: Optional[int],
    channel: str,
    user_input: str,
    transcript: Optional[str],
    llm_json_out: Optional[dict],
):
    row = Conversation(
        user_id=user_id,
        channel=channel,
        user_input=user_input,
        transcript=transcript,
        llm_output_json=json.dumps(llm_json_out, ensure_ascii=False) if llm_json_out else None,
        created_at=_utc_now(),
    )
    try:
        session.add(row)
        session.commit()
    except Exception:
        session.rollback()
        logger.exception("Failed to log conversation", extra={"user_id": user_id, "channel": channel})


def upsert_qa_cache(session: Session, user_id: Optional[int], question: str, answer_json: dict):
    q = select(QACache).where(QACache.question == question)
    if user_id is not None:
        q = q.where(QACache.user_id == user_id)
    row = session.exec(q).first()
    if row:
        row.answer = json.dumps(answer_json, ensure_ascii=False)
        row.hits = (row.hits or 0) + 1
        row.updated_at = _utc_now()
        session.add(row)
        safe_commit(session, "upsert_qa_cache_update")
        return

    try:
        session.add(
            QACache(
                user_id=user_id,
                question=question,
                answer=json.dumps(answer_json, ensure_ascii=False),
                hits=1,
                updated_at=_utc_now(),
            )
        )
        session.commit()
    except IntegrityError:
        session.rollback()
        row = session.exec(q).first()
        if not row:
            raise
        row.answer = json.dumps(answer_json, ensure_ascii=False)
        row.hits = (row.hits or 0) + 1
        row.updated_at = _utc_now()
        session.add(row)
        safe_commit(session, "upsert_qa_cache_integrity_update")
    except Exception:
        session.rollback()
        logger.exception("Failed to upsert QA cache", extra={"user_id": user_id})
        raise

# -----------------------------
# 🔹 ADD YOUR FUNCTION HERE
# -----------------------------

def load_onboarding_profile(session: Session, user_id: Union[int, str]) -> Dict[str, Any]:
    """Load onboarding/personality context from the database.

    Older code attempted to read ``user_database.json`` from the app directory,
    but that file is not part of the repo and the rest of the app stores
    onboarding answers in ``UserProfile.answers_json``. Keeping this helper
    backed by the DB prevents ``build_user_context()`` from silently handing the
    LLM an empty onboarding profile.
    """
    try:
        numeric_user_id = int(user_id)
    except (TypeError, ValueError):
        return {}

    profile = session.exec(select(UserProfile).where(UserProfile.user_id == numeric_user_id)).first()
    if not profile:
        return {}

    answers = _load_json_object(profile.answers_json)
    return {
        "user_id": numeric_user_id,
        "answers": answers,
        "profile_summary": profile.profile_summary or "",
        "questions_version": profile.questions_version,
        "questionnaire_completed": _questionnaire_completed(profile),
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
    }


def build_user_context(session: Session, user_id: int) -> dict:
    user = session.get(User, user_id)
    if not user:
        return {}

    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    onboarding_profile = load_onboarding_profile(session, user_id)
    if profile and profile.questions_version != PERSONALITY_QUESTIONS_VERSION:
        personality = "Personality profile outdated. Be neutral and helpful."
    elif profile and profile.profile_summary:
        personality = profile.profile_summary
    else:
        personality = "No personality profile yet. Be neutral and helpful."

    return {
        "user": {
            "name": user.name,
            "place": user.place,
            "timezone": user.timezone,
        },
        "routine": {
            "wake_time": routine.wake_time if routine else None,
            "sleep_time": routine.sleep_time if routine else None,
            "work_start": routine.work_start if routine else None,
            "work_end": routine.work_end if routine else None,
            "daily_habits": routine.daily_habits if routine else None,
        },
        "personality": personality,

        "onboarding_profile": onboarding_profile
    }


def _infer_hobbies(habits_text: str) -> List[str]:
    s = (habits_text or "").lower()
    hobbies = []
    if "walk" in s:
        hobbies.append("walking")
    if "read" in s:
        hobbies.append("reading")
    if "gym" in s or "workout" in s:
        hobbies.append("fitness")
    if "pray" in s:
        hobbies.append("spirituality")
    if "cook" in s:
        hobbies.append("cooking")
    if "music" in s:
        hobbies.append("music")
    return hobbies[:4]


def _infer_tone(summary: str) -> str:
    s = (summary or "").lower()
    if any(word in s for word in ["short", "brief"]):
        return "brief"
    if any(word in s for word in ["detail", "deep"]):
        return "detailed"
    if any(word in s for word in ["casual", "friendly"]):
        return "friendly_casual"
    if any(word in s for word in ["formal", "respectful"]):
        return "respectful"
    return "warm"


def _infer_personality_style(summary: str) -> str:
    s = (summary or "").lower()
    if "calm" in s:
        return "calm"
    if "friendly" in s:
        return "friendly"
    if "ambitious" in s or "goal" in s:
        return "ambitious"
    if "sensitive" in s or "emotional" in s:
        return "emotional_sensitive"
    return "practical"


def _default_stage_answers(
    user: Optional[User],
    routine: Optional[DailyRoutine],
    db_profile: Optional[UserProfile],
) -> Dict[str, Any]:
    habits_text = routine.daily_habits if routine else ""
    summary = db_profile.profile_summary if db_profile and db_profile.profile_summary else ""
    return {
        "age_group": "26-35",
        "gender_context": "prefer_not_to_say",
        "life_stage": "none_of_these",
        "food_preference": "mixed_flexible",
        "health_conditions": ["none"],
        "food_caution": "no_special_caution",
        "daily_activity": "moderate_walks",
        "sleep_pattern": "average",
        "personality_style": _infer_personality_style(summary),
        "stress_support": "step_by_step_plan",
        "communication_tone": _infer_tone(summary),
        "answer_length": "medium",
        "hobbies": _infer_hobbies(habits_text or ""),
        "main_goal": "career_or_business",
        "family_role": "working_professional",
    }


def _sync_stage_profile(session: Session, user_id: Optional[int]) -> Dict[str, Any]:
    uid = str(user_id or "guest")
    user = session.get(User, user_id) if user_id else None
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first() if user_id else None
    db_profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first() if user_id else None

    answers = _default_stage_answers(user, routine, db_profile)
    profile = {
        "profile_version": "ai_tool_db_bridge",
        "user_id": uid,
        "created_at": _utc_now_iso(),
        "answers": answers,
        "behaviour_rules": STAGE_BEHAVIOUR._derive_behaviour_rules(answers),
        "rag_personality_hints": STAGE_BEHAVIOUR._infer_personality_rag_from_answers(answers),
        "app_profile": {
            "name": user.name if user else "Guest",
            "place": user.place if user else "",
            "timezone": user.timezone if user else "Asia/Kolkata",
            "assistant_name": user.assistant_name if user else "Elli",
            "reply_language": _normalize_reply_language(user.reply_language if user else "ta"),
        },
        "daily_routine": {
            "wake_time": routine.wake_time if routine else "07:30",
            "sleep_time": routine.sleep_time if routine else "23:30",
            "work_start": routine.work_start if routine else "09:30",
            "work_end": routine.work_end if routine else "18:30",
            "daily_habits": routine.daily_habits if routine else "",
        },
    }

    existing = None
    if STAGE_BEHAVIOUR.profile_exists(uid):
        try:
            existing = STAGE_BEHAVIOUR.load_profile(uid)
        except Exception:
            existing = None
    if existing:
        profile["created_at"] = existing.get("created_at", profile["created_at"])

    profile = STAGE_BEHAVIOUR._upgrade_profile(profile)
    if db_profile and db_profile.profile_summary:
        stage_summary = str(profile.get("profile_summary", "")).strip()
        profile["profile_summary"] = (
            f"{stage_summary}\n\nExisting app personality summary: {db_profile.profile_summary.strip()}".strip()
        )

    STAGE_BEHAVIOUR.save_profile(uid, profile)
    return profile


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return json.dumps(str(value), ensure_ascii=False)


def _log_stage_history(user_id: Optional[int], profile: Dict[str, Any], query: str, result: Dict[str, Any]) -> None:
    uid = str(user_id or "guest")
    log_path = LOGS_DIR / f"{uid}_history.jsonl"
    record = {
        "timestamp": _utc_now_iso(),
        "user_id": uid,
        "query": "[REDACTED]",
        "profile_summary": "[REDACTED]",
        "profile_card": {},
        "result": {k: v for k, v in result.items() if k not in {"raw_english", "remodeled_english", "tamil_text", "theni_tamil_text"}},
    }
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")

def _build_augmented_profile_context(
    session: Session,
    user_id: Optional[int],
    message: str,
    base_profile_context: str,
) -> tuple[str, Dict[str, Any]]:
    if not (RAG_CONTEXT_INCLUDE_IN_STAGE_CONTEXT and user_id):
        return base_profile_context, {
            "enabled": False,
            "reason": "rag_context_disabled_or_guest",
            "snippet_count": 0,
            "context_chars": 0,
            "timings_ms": {"rag_total_ms": 0.0},
            "snippets": [],
        }

    try:
        rag_payload = LOCAL_RAG_SERVICE.build_rag_context(session, user_id, message)
    except Exception as exc:
        return base_profile_context, {
            "enabled": True,
            "reason": "rag_context_error",
            "error": str(exc),
            "snippet_count": 0,
            "context_chars": 0,
            "timings_ms": {"rag_total_ms": 0.0},
            "snippets": [],
        }

    context_text = str((rag_payload or {}).get("context_text") or "").strip()
    snippets = (rag_payload or {}).get("snippets") or []
    timings = (rag_payload or {}).get("timings_ms") or {"rag_total_ms": 0.0}

    safe_snippets: List[Dict[str, Any]] = []
    for snippet in list(snippets)[: max(1, RAG_CONTEXT_MAX_SNIPPETS)]:
        if not isinstance(snippet, dict):
            continue
        safe_snippets.append(
            {
                "source_type": str(snippet.get("source_type", "")),
                "source_id": str(snippet.get("source_id", "")),
                "score": float(snippet.get("score", 0.0) or 0.0),
                "score_semantic": float(snippet.get("score_semantic", 0.0) or 0.0),
                "score_lexical": float(snippet.get("score_lexical", 0.0) or 0.0),
                "score_recency": float(snippet.get("score_recency", 0.0) or 0.0),
            }
        )

    meta = {
        "enabled": True,
        "reason": "ok" if context_text else "no_matching_context",
        "snippet_count": len(safe_snippets),
        "context_chars": len(context_text),
        "timings_ms": timings,
        "snippets": safe_snippets,
    }

    if not context_text:
        return base_profile_context, meta

    merged = f"{base_profile_context.strip()}\n\n{RAG_CONTEXT_HEADER.strip()}\n{context_text}".strip()
    return merged, meta


def _run_stage_pipeline(session: Session, user_id: Optional[int], message: str, reply_language: Optional[str] = None) -> Dict[str, Any]:
    pipeline_user = session.get(User, user_id) if user_id else None
    resolved_reply_language = _normalize_reply_language(reply_language or (pipeline_user.reply_language if pipeline_user else None))
    uid = str(user_id or "guest")
    cache_key = f"{uid}:{resolved_reply_language}::{' '.join(message.strip().lower().split())}"
    cached = STAGE_CACHE.get_copy(cache_key)
    if cached is not None:
        cached["cache_hit"] = "true"
        return cached

    # 🧠 SMARTER FAST-PATH (Fixing the "Dead End" bug with Friend's Suggestion)
    fast_path = LOCAL_RAG_SERVICE.try_answer(session, user_id, message)
    
    if fast_path is not None:
        confidence = float(fast_path.get("direct_answer_confidence", 0.0))
        source = str(fast_path.get("direct_answer_source", "")).strip()

        # Only accept strong answers from valid sources (90% threshold)
        if confidence >= 0.90 and source not in ["", "unknown"]:
            STAGE_CACHE.set(cache_key, fast_path)
            return fast_path
        else:
            logger.debug("Fast path skipped; falling back to OpenAI", extra={"confidence": confidence, "source": source})

    profile = _sync_stage_profile(session, user_id)
    onboarding_profile = load_onboarding_profile(session, user_id)
    total_start = time.perf_counter()
    timings: Dict[str, float] = {}
    stage_notes: List[str] = []

    t0 = time.perf_counter()
    base_profile_context = STAGE_BEHAVIOUR.build_runtime_context(profile, user_query=message)
    if onboarding_profile:
        base_profile_context += f"\n\n[ONBOARDING PROFILE]\n{json.dumps(onboarding_profile, ensure_ascii=False)}"
    profile_context, rag_context_meta = _build_augmented_profile_context(session, user_id, message, base_profile_context)
    timings["context_ms"] = round((time.perf_counter() - t0) * 1000, 2)
    rag_timing_payload = rag_context_meta.get("timings_ms") if isinstance(rag_context_meta, dict) else {}
    if isinstance(rag_timing_payload, dict):
        for key, value in rag_timing_payload.items():
            try:
                timings[str(key)] = round(float(value), 2)
            except Exception:
                continue
    if rag_context_meta.get("snippet_count", 0):
        stage_notes.append(
            f"Added {int(rag_context_meta.get('snippet_count', 0))} advanced RAG snippet(s) from user memory and cache."
        )

    stage_remodeler = _get_stage_remodeler()

    t0 = time.perf_counter()
    direct_match = stage_remodeler.get_direct_answer_match(message)
    timings["direct_match_ms"] = round((time.perf_counter() - t0) * 1000, 2)

    core_meta: Dict[str, Any] = {
        "answer": "",
        "answer_style": "",
        "risk_level": "low",
        "safety_notes": "",
        "rag_context": rag_context_meta,
    }
    remodel_meta: Dict[str, Any] = {}
    review_meta: Dict[str, Any] = {}
    translation_meta: Dict[str, Any] = {}
    route_taken = "full_pipeline"
    direct_answer_source = ""
    direct_answer_confidence = ""
    predicted_label = "unknown"
    risk_level = "low"

    if direct_match and direct_match.confidence >= 0.92:
        raw_english = direct_match.answer
        remodeled_english = direct_match.answer
        route_taken = "dataset_direct_answer"
        direct_answer_source = f"{direct_match.match_type}:{direct_match.query}"
        direct_answer_confidence = f"{direct_match.confidence:.4f}"
        predicted_label = direct_match.label
        stage_notes.append("Used a high-confidence direct answer from the local dataset.")
    else:
        stage_core = _get_stage_core()

        t0 = time.perf_counter()
        core_meta = stage_core.answer_user_query_structured(message, profile_context)
        if isinstance(core_meta, dict):
            core_meta["rag_context"] = rag_context_meta
        timings["core_answer_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        raw_english = str(core_meta.get("answer", "")).strip()

        t0 = time.perf_counter()
        remodel_meta = stage_remodeler.remodel_with_meta(message, raw_english, profile)
        timings["remodel_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        remodeled_english = str(remodel_meta.get("answer", raw_english)).strip() or raw_english

        t0 = time.perf_counter()
        review_meta = stage_core.review_answer(message, remodeled_english, profile_context)
        if isinstance(review_meta, dict):
            review_meta["rag_context_used"] = bool(rag_context_meta.get("snippet_count", 0))
        timings["review_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        remodeled_english = str(review_meta.get("final_answer", remodeled_english)).strip() or remodeled_english

        route_taken = str(remodel_meta.get("route", "full_rewrite"))
        predicted_label = str(remodel_meta.get("predicted_label", "unknown"))
        risk_level = str(remodel_meta.get("risk_level") or core_meta.get("risk_level") or "low")
        direct_answer_source = str(remodel_meta.get("direct_answer_source", ""))
        if remodel_meta.get("direct_answer_confidence") not in (None, ""):
            direct_answer_confidence = f"{float(remodel_meta.get('direct_answer_confidence', 0.0)):.4f}"

        for note in (core_meta.get("safety_notes"), remodel_meta.get("route_reason"), review_meta.get("review_note")):
            if str(note or "").strip():
                stage_notes.append(str(note).strip())

    # ── RAG Safety Filter ──────────────────────────────────────────────────────
    # This sits BETWEEN the OpenAI response and the final output sent to the UI.
    # It checks the user's real profile data (diet, allergies, injuries, activity)
    # and rewrites / re-translates the response if any conflict is found.
    _safety_result = {
        "raw_english": raw_english,
        "remodeled_english": remodeled_english,
        "stage_notes": json.dumps(stage_notes, ensure_ascii=False),
        "risk_level": risk_level,
    }

    # FIX: Use the getter and check for None before calling .apply()
    checker = _get_safety_filter()
    if checker is not None:
        _safety_result = checker.apply(_safety_result, session, user_id)
    else:
        logger.warning("Safety filter skipped because it is not initialized")

    raw_english       = _safety_result.get("raw_english", raw_english)
    remodeled_english = _safety_result.get("remodeled_english", remodeled_english)
    risk_level        = _safety_result.get("risk_level", risk_level)
    try:
        stage_notes = json.loads(_safety_result.get("stage_notes", "[]"))
    except Exception:
        pass
    # If the safety filter already re-translated (MT Task), carry those forward
    _safety_tamil       = _safety_result.get("tamil_text", "")
    _safety_theni       = _safety_result.get("theni_tamil_text", "")

    theni_tamil_text = ""
    tamil_text = ""
    if _safety_tamil:
        # MT Task: safety filter already retranslated → use that directly
        tamil_text       = _safety_tamil
        theni_tamil_text = _safety_theni
        translation_meta = {"source": "safety_filter_retranslation"}
    elif resolved_reply_language == "ta":
        stage_translator = _get_stage_translator(required=False)
        if stage_translator is None:
            logger.warning("Tamil translator unavailable; falling back to English")
            translation_meta = {"skipped": True, "reason": "translator_unavailable", "fallback_language": "en"}
        else:
            t0 = time.perf_counter()
            translation_meta = stage_translator.english_to_tamil_with_meta(remodeled_english, profile)
            tamil_text = str(translation_meta.get("tamil_text", "")).strip()
            timings["english_to_tamil_ms"] = round((time.perf_counter() - t0) * 1000, 2)

            t0 = time.perf_counter()
            theni_tamil_text = stage_translator.tamil_to_thenitamil(tamil_text)
            timings["tamil_to_theni_ms"] = round((time.perf_counter() - t0) * 1000, 2)
    else:
        translation_meta = {"skipped": True, "reason": "reply_language_is_english"}

    total_ms = round((time.perf_counter() - total_start) * 1000, 2)
    result: Dict[str, Any] = {
        "pipeline_version": PIPELINE_VERSION,
        "raw_english": raw_english,
        "remodeled_english": remodeled_english,
        "tamil_text": tamil_text,
        "theni_tamil_text": theni_tamil_text,
        "direct_answer_source": direct_answer_source,
        "direct_answer_confidence": direct_answer_confidence,
        "predicted_label": predicted_label,
        "risk_level": risk_level,
        "route_taken": route_taken,
        "cache_hit": "false",
        "stage_notes": _safe_json(stage_notes),
        "core_meta": _safe_json(core_meta),
        "remodel_meta": _safe_json(remodel_meta),
        "review_meta": _safe_json(review_meta),
        "translation_meta": _safe_json(translation_meta),
        "timings_ms": json.dumps({**timings, "total_ms": total_ms}, ensure_ascii=False),
    }

    _log_stage_history(user_id, profile, message, result)
    STAGE_CACHE.set(cache_key, result)
    return result


def _metadata_for_item(session: Session, user_id: Optional[int], text: str, fallback_details: str) -> Dict[str, Any]:
    user_context = {}
    if user_id:
        user_context = build_user_context(session, user_id)
    if user_id and not user_context.get("personality"):
        user_context["personality"] = "Unknown personality. Be neutral and helpful."

    user_content = json.dumps({"context": user_context, "input": text}, ensure_ascii=False)

    try:
        data = llm_json(SYSTEM_PROMPT, user_content, temperature=0.2)
        if not data.get("details"):
            data["details"] = fallback_details
        return data
    except Exception:
        clean_text = " ".join(text.strip().split())
        return {
            "intent": "other",
            "category": "Other",
            "datetime": None,
            "title": (clean_text[:60] + "...") if len(clean_text) > 60 else clean_text,
            "details": fallback_details,
        }


def _normalized_pipeline_result(result: Dict[str, Any]) -> Dict[str, Any]:
    def _maybe(value: Any, default: Any):
        if isinstance(value, str):
            text = value.strip()
            if text and text[:1] in "[{":
                try:
                    return json.loads(text)
                except Exception:
                    return default
        return value if value not in (None, "") else default

    return {
        "pipeline_version": result.get("pipeline_version", PIPELINE_VERSION),
        "raw_english": result.get("raw_english", ""),
        "remodeled_english": result.get("remodeled_english", ""),
        "tamil_text": result.get("tamil_text", ""),
        "theni_tamil_text": result.get("theni_tamil_text", ""),
        "direct_answer_source": result.get("direct_answer_source", ""),
        "direct_answer_confidence": result.get("direct_answer_confidence", ""),
        "predicted_label": result.get("predicted_label", ""),
        "risk_level": result.get("risk_level", ""),
        "route_taken": result.get("route_taken", ""),
        "cache_hit": result.get("cache_hit", "false"),
        "stage_notes": _maybe(result.get("stage_notes"), []),
        "core_meta": _maybe(result.get("core_meta"), {}),
        "remodel_meta": _maybe(result.get("remodel_meta"), {}),
        "review_meta": _maybe(result.get("review_meta"), {}),
        "translation_meta": _maybe(result.get("translation_meta"), {}),
        "timings_ms": _maybe(result.get("timings_ms"), {}),
    }


def _assistant_text_from_pipeline(
    pipeline_result: Dict[str, Any],
    fallback: str,
    reply_language: Optional[str] = None,
) -> str:
    resolved_reply_language = _normalize_reply_language(reply_language)
    if resolved_reply_language == "en":
        return str(pipeline_result.get("remodeled_english") or "").strip() or fallback

    return (
        str(pipeline_result.get("theni_tamil_text") or "").strip()
        or str(pipeline_result.get("tamil_text") or "").strip()
        or str(pipeline_result.get("remodeled_english") or "").strip()
        or fallback
    )

def _save_item_from_pipeline(
    session: Session,
    *,
    user_id: Optional[int],
    source: str,
    raw_text: str,
    transcript: Optional[str],
    pipeline_result: Dict[str, Any],
    reply_language: Optional[str] = None,
) -> tuple[Item, Dict[str, Any], Dict[str, Any]]:
    spoken_answer = _assistant_text_from_pipeline(pipeline_result, raw_text, reply_language)
    meta = _metadata_for_item(session, user_id, raw_text, spoken_answer)

    item = Item(
        intent=str(meta.get("intent", "other")).lower(),
        category=normalize_category(str(meta.get("category", "Other"))),
        raw_text=raw_text,
        transcript=transcript,
        datetime_str=meta.get("datetime"),
        title=meta.get("title") or raw_text[:60],
        details=spoken_answer,
        source=source,
        user_id=user_id,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    session.add(item)
    session.commit()
    session.refresh(item)

    try:
        source_id, content_text, updated_at = LOCAL_RAG_SERVICE._candidate_from_item(item)
        LOCAL_RAG_SERVICE._get_or_create_embedding(
            session,
            user_id=user_id,
            source_type="item",
            source_id=source_id,
            content_text=content_text,
            updated_at=updated_at,
        )
    except Exception:
        session.rollback()
        logger.warning(
            "RAG embedding failed",
            extra={"user_id": user_id, "item_id": getattr(item, "id", None)},
            exc_info=True,
        )

    normalized_pipeline = _normalized_pipeline_result(pipeline_result)
    payload = {"pipeline": normalized_pipeline, "meta": meta}
    log_conversation(session, user_id, source, raw_text, transcript, payload)
    upsert_qa_cache(session, user_id, raw_text, payload)
    return item, meta, normalized_pipeline


def _build_chat_response(item: Item, meta: Dict[str, Any], pipeline: Dict[str, Any]) -> Dict[str, Any]:
    assistant_text = item.details or item.raw_text
    return {
        "ok": True,
        "item": {
            "id": item.id,
            "intent": item.intent,
            "category": item.category,
            "title": item.title,
            "details": assistant_text,
            "datetime": item.datetime_str,
            "source": item.source,
            "raw_text": item.raw_text,
            "transcript": item.transcript,
            "created_at": item.created_at.isoformat() if item.created_at else None,
        },
        "assistant": {
            "text": assistant_text,
            "english": pipeline.get("remodeled_english", ""),
            "tamil": pipeline.get("tamil_text", ""),
            "theni_tamil": pipeline.get("theni_tamil_text", ""),
        },
        "pipeline": pipeline,
        "meta": meta,
    }


def _resolve_chat_text(payload: ChatAPIRequest) -> str:
    text = (payload.message or payload.text or "").strip()
    if not text:
        raise HTTPException(400, "message or text is required")
    return text


def _run_agentic_or_pipeline(
    session: Session,
    user_id: Optional[int],
    message: str,
    reply_language: Optional[str] = None,
) -> Dict[str, Any]:
    
    onboarding_profile = load_onboarding_profile(session, user_id)

    return _get_agentic_service().orchestrate_chat(
        session,
        user_id,
        message,
        reply_language,
        pipeline_runner=_run_stage_pipeline,
        onboarding_profile=onboarding_profile
    )


def _extract_openai_error_message(exc: Exception) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error_payload = body.get("error") or {}
        message = str(error_payload.get("message") or "").strip()
        if message:
            return message
    message = str(exc).strip()
    return message or "OpenAI request failed"


def _is_audio_too_short_error(exc: Exception) -> bool:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error_payload = body.get("error") or {}
        code = str(error_payload.get("code") or "").strip().lower()
        message = str(error_payload.get("message") or "").strip().lower()
        if code == "audio_too_short":
            return True
        if "audio file is too short" in message:
            return True
    return "audio file is too short" in str(exc).lower()


def _normalize_audio_language(language: Optional[str]) -> Optional[str]:
    value = str(language or "").strip().lower()
    if not value:
        return None

    # Let the transcription model auto-detect when requested.
    if value in {"auto", "detect", "auto-detect", "autodetect"}:
        return None

    if value.startswith("ta"):
        return "ta"
    if value.startswith("en"):
        return "en"
    return None


def _transcribe_audio_file(file_path: str, language: Optional[str] = None) -> str:
    normalized_language = _normalize_audio_language(language)

    try:
        if not os.path.exists(file_path) or os.path.getsize(file_path) <= 0:
            raise HTTPException(400, "Audio file is empty. Please record for a moment and try again.")

        request_kwargs: Dict[str, Any] = {
            "model": "whisper-1",
            "response_format": "json",
        }
        if normalized_language:
            request_kwargs["language"] = normalized_language

        with open(file_path, "rb") as audio_file:
            transcript_obj = _get_openai_client().audio.transcriptions.create(
                file=audio_file,
                **request_kwargs,
            )
    except openai.BadRequestError as exc:
        if _is_audio_too_short_error(exc):
            raise HTTPException(400, "Audio file is too short. Please record for at least a moment and try again.") from exc
        raise HTTPException(400, _extract_openai_error_message(exc)) from exc

    text = str(getattr(transcript_obj, "text", "") or "").strip()
    if not text:
        raise HTTPException(400, "Failed to transcribe audio")
    return text


@app.post("/parse-datetime")
def parse_datetime(
    payload: ParseDatetimeRequest,
    auth_user: AuthUser = Depends(get_current_user),
):
    now_iso = payload.now_iso or _utc_now_iso()
    user_content = json.dumps(
        {"timezone": payload.timezone, "now": now_iso, "text": payload.text},
        ensure_ascii=False,
    )
    out = llm_json(PARSE_DT_PROMPT, user_content, temperature=0.0)
    return {
        "iso": out.get("iso"),
        "human": out.get("human") or "",
        "confidence": float(out.get("confidence") or 0.0),
    }
def _normalize_email(email: Optional[str]) -> Optional[str]:
    normalized = (email or "").strip().lower()
    return normalized or None


def _questionnaire_completed(profile: Optional[UserProfile]) -> bool:
    if not profile:
        return False

    answers = _load_json_object(profile.answers_json)
    if not answers:
        return False

    for slot in REQUIRED_PROFILE_SLOTS:
        if not _has_completed_value(answers.get(slot)):
            return False

    return True


def _ensure_user_profile(session: Session, user_id: int) -> UserProfile:
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if profile:
        return profile

    profile = UserProfile(
        user_id=user_id,
        answers_json=json.dumps({}, ensure_ascii=False),
        questions_version=PERSONALITY_QUESTIONS_VERSION,
        updated_at=_utc_now(),
    )
    session.add(profile)
    safe_commit(session, "_ensure_user_profile")
    session.refresh(profile)
    return profile


def _serialize_user_payload(user: User, profile: Optional[UserProfile]) -> Dict[str, Any]:
    assistant_name = (user.assistant_name or "Elli").strip() or "Elli"

    return {
        "id": int(user.id) if user.id is not None else None,
        "firebase_uid": user.firebase_uid,
        "email": user.email or "",
        "name": user.name,
        "place": user.place or "",
        "timezone": user.timezone or "Asia/Kolkata",
        "assistant_name": assistant_name,
        "reply_language": _normalize_reply_language(getattr(user, "reply_language", "ta")),
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "profile_id": int(profile.id) if profile and profile.id is not None else None,
        "profile_user_id": int(profile.user_id) if profile and profile.user_id is not None else None,
        "questionnaire_completed": _questionnaire_completed(profile),
    }

def _find_existing_user(
    session: Session,
    *,
    user_id: Optional[int] = None,
    firebase_uid: Optional[str] = None,
    email: Optional[str] = None,
) -> Optional[User]:
    user: Optional[User] = None

    if user_id:
        user = session.get(User, user_id)
        if user:
            return user

    if firebase_uid:
        user = session.exec(select(User).where(User.firebase_uid == firebase_uid)).first()
        if user:
            return user

    if email:
        user = session.exec(select(User).where(User.email == email)).first()
        if user:
            return user

    return None


@app.post("/users")
def create_user(
    payload: UserCreate,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    assistant_name = (payload.assistant_name or "Elli").strip() or "Elli"
    reply_language = _normalize_reply_language(payload.reply_language)
    normalized_email = _normalize_email(auth_user.email or payload.email)
    firebase_uid = auth_user.firebase_uid

    existing_by_uid = session.exec(
        select(User).where(User.firebase_uid == firebase_uid)
    ).first()

    existing_by_email = None
    if normalized_email:
        existing_by_email = session.exec(
            select(User).where(User.email == normalized_email)
        ).first()

    if existing_by_uid and existing_by_email and existing_by_uid.id != existing_by_email.id:
        raise HTTPException(
            status_code=409,
            detail="Firebase UID and email belong to different users",
        )

    user = existing_by_uid or existing_by_email

    if user and user.firebase_uid and user.firebase_uid != firebase_uid:
        raise HTTPException(
            status_code=409,
            detail="Email already belongs to a different Firebase user",
        )

    try:
        if user is None:
            user = User(
                firebase_uid=firebase_uid,
                email=normalized_email,
                name=payload.name,
                place=payload.place,
                timezone=payload.timezone or "Asia/Kolkata",
                assistant_name=assistant_name,
                reply_language=reply_language,
            )
        else:
            user.firebase_uid = firebase_uid
            user.email = normalized_email or user.email
            user.name = payload.name
            user.place = payload.place
            user.timezone = payload.timezone or user.timezone or "Asia/Kolkata"
            user.assistant_name = assistant_name
            user.reply_language = reply_language or getattr(user, "reply_language", "ta") or "ta"

        session.add(user)
        safe_commit(session, "create_user")
        session.refresh(user)
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="User could not be created because of a conflicting identity record.",
        ) from exc

    profile = _ensure_user_profile(session, int(user.id))
    response_payload = _serialize_user_payload(user, profile)

    logger.info("User profile saved", extra={"user_id": user.id})
    _get_agentic_service().persist_profile_snapshot(session, int(user.id))
    return response_payload


@app.get("/users/resolve")
def resolve_user(
    firebase_uid: Optional[str] = Query(default=None),
    email: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    # Compatibility endpoint: identity is resolved only from the verified bearer token.
    user = session.exec(select(User).where(User.firebase_uid == auth_user.firebase_uid)).first()
    if not user:
        return {"found": False}

    profile = _ensure_user_profile(session, int(user.id))
    return {
        "found": True,
        "user": _serialize_user_payload(user, profile),
    }


@app.get("/users/me")
def get_me(
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    profile = _ensure_user_profile(session, int(user.id))
    return _serialize_user_payload(user, profile)


@app.get("/users/{user_id}")
def get_user(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    profile = _ensure_user_profile(session, user_id)
    return _serialize_user_payload(user, profile)


@app.delete("/users/{user_id}")
def delete_user_account(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)

    try:
        session.exec(delete(Item).where(Item.user_id == user_id))
        session.exec(delete(Conversation).where(Conversation.user_id == user_id))
        session.exec(delete(QACache).where(QACache.user_id == user_id))
        session.exec(delete(DailyRoutine).where(DailyRoutine.user_id == user_id))
        session.exec(delete(UserProfile).where(UserProfile.user_id == user_id))
        session.exec(delete(RagEmbedding).where(RagEmbedding.user_id == user_id))
        session.exec(delete(Job).where(Job.user_id == user_id))
        session.delete(user)
        safe_commit(session, "delete_user_account")
    except Exception:
        session.rollback()
        logger.exception("Failed to delete user account", extra={"user_id": user_id})
        raise

    for path_getter in (STAGE_BEHAVIOUR._profile_path, STAGE_BEHAVIOUR._history_log_path):
        try:
            path_getter(str(user_id)).unlink(missing_ok=True)
        except Exception:
            logger.warning("Failed to delete stage file", extra={"user_id": user_id})

    STAGE_CACHE.delete_prefix(f"{user_id}:")

    return {"ok": True, "deleted_user_id": user_id}

@app.get("/personality/questions")
def get_personality_questions():
    return {"version": PERSONALITY_QUESTIONS_VERSION, "questions": PERSONALITY_QUESTIONS}


@app.get("/api/questions")
def get_pipeline_questions():
    return {"questions": PIPELINE_QUESTIONS}


@app.get("/api/profile/{user_id}")
def get_pipeline_profile(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    profile = _sync_stage_profile(session, user_id)
    return {"exists": True, "profile": profile}


@app.post("/api/profile/{user_id}")
def save_pipeline_profile(
    user_id: int,
    payload: PersonalityAnswersIn,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    _get_agentic_service().sync_answers_to_profile(session, user_id, payload.answers)
    stage_profile = _sync_stage_profile(session, user_id)
    STAGE_CACHE.clear()
    return {"ok": True, "profile": stage_profile}


@app.get("/api/agents/profiler/{user_id}")
def get_profiler_state(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    return _get_agentic_service().get_profiler_state(session, user_id)


@app.post("/api/agents/profiler/{user_id}/start")
def start_profiler_agent(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    return _get_agentic_service().start_profiler(session, user_id)


@app.post("/api/agents/profiler/{user_id}/message")
def profiler_agent_message(
    user_id: int,
    payload: AgentMessageRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    try:
        return _get_agentic_service().profiler_turn(session, user_id, payload.message, payload.reply_language)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.post("/api/agents/memory/{user_id}/sync")
def sync_memory_agent(
    user_id: int,
    payload: AgentMemorySyncRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    return _get_agentic_service().maybe_sync_memory(session, user_id, force=bool(payload.force))


def _build_direct_answer_pipeline_result(
    text: str, 
    intent: str, 
    route: str,
    priority: str = "low",
    confidence: float = 1.0,
    matched_keyword: str = ""
) -> Dict[str, Any]:
    """Helper for the orchestrator to return a fast answer without a full pipeline call."""
    return _build_pipeline_result(
        raw_english=text,
        remodeled_english=text,
        route_taken=route,
        predicted_label=intent.lower(),
        risk_level="high" if intent == "EMERGENCY" else "low",
        direct_answer_source="orchestrator_fast_exit",
        direct_answer_confidence=f"{confidence:.4f}",
        stage_notes=[
            f"Orchestrator identified intent: {intent}.",
            f"Matched keyword: '{matched_keyword}'" if matched_keyword else "No keyword matched.",
            f"Priority level: {priority}."
        ]
    )


def _run_chat_logic(session: Session, payload: ChatAPIRequest, text: str) -> Dict[str, Any]:
    routing = run_orchestrator(_get_openai_client(required=False), text)

    if routing["intent"] == "EMERGENCY":
        res = "🚨 EMERGENCY DETECTED: Please stay safe and contact emergency services (112) immediately."
        return _build_direct_answer_pipeline_result(
            res,
            "EMERGENCY",
            "orchestrator_emergency",
            routing["priority"],
            routing["confidence"],
            routing.get("matched_keyword", ""),
        )

    if routing["intent"] == "AMBIGUOUS":
        res = routing.get("clarification_question") or "Could you share a bit more so I can assist you better?"
        return _build_direct_answer_pipeline_result(
            res,
            "AMBIGUOUS",
            "orchestrator_clarification",
            routing["priority"],
            routing["confidence"],
            routing.get("matched_keyword", ""),
        )

    if routing["intent"] in {"GREETING", "SMALLTALK", "PROFILE", "IDENTITY"}:
        tl_fast_res = _try_local_fast_path(session, payload.user_id, text)
        if tl_fast_res:
            return tl_fast_res

    return _run_agentic_or_pipeline(session, payload.user_id, text, payload.reply_language)


def _run_chat_request(session: Session, payload: ChatAPIRequest) -> Dict[str, Any]:
    text = _resolve_chat_text(payload)
    pipeline_result = _run_chat_logic(session, payload, text)
    item, meta, normalized_pipeline = _save_item_from_pipeline(
        session,
        user_id=payload.user_id,
        source="text",
        raw_text=text,
        transcript=None,
        pipeline_result=pipeline_result,
        reply_language=payload.reply_language,
    )
    return _build_chat_response(item, meta, normalized_pipeline)


@app.post("/api/chat")
def api_chat(
    payload: ChatAPIRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    payload = payload.model_copy(update={"user_id": int(user.id)})
    return _run_chat_request(session, payload)


def _run_chat_payload(payload: ChatAPIRequest) -> Dict[str, Any]:
    with SessionLocal() as session:
        return _run_chat_request(session, payload)


def _sse_event(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/chat/stream")
async def api_chat_stream(
    payload: ChatAPIRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    payload = payload.model_copy(update={"user_id": int(user.id)})
    chunk_size = max(12, int(os.getenv("STREAM_CHUNK_SIZE", "32") or 32))

    async def event_generator():
        started_at = time.perf_counter()
        yield _sse_event("status", {"phase": "accepted"})
        await asyncio.sleep(0)
        yield _sse_event("status", {"phase": "running"})
        await asyncio.sleep(0)

        response = await asyncio.to_thread(_run_chat_payload, payload)
        assistant_text = str((((response or {}).get("assistant") or {}).get("text")) or "")
        for index in range(0, len(assistant_text), chunk_size):
            yield _sse_event(
                "token",
                {"delta": assistant_text[index : index + chunk_size]},
            )
            await asyncio.sleep(0)
        yield _sse_event(
            "done",
            {
                "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
                "response": response,
            },
        )

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/chat/jobs")
def enqueue_chat_job(
    payload: ChatAPIRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    _require_async_jobs_available()
    user = get_owned_user(session, auth_user)
    text = _resolve_chat_text(payload)
    job = _get_job_queue().enqueue(
        session,
        job_type="chat",
        user_id=int(user.id),
        payload={
            "user_id": int(user.id),
            "message": text,
            "reply_language": payload.reply_language,
        },
        max_attempts=int(os.getenv("JOB_CHAT_MAX_ATTEMPTS", "3") or 3),
    )
    return {"ok": True, "job": _serialize_job(job)}


@app.get("/api/jobs/{job_id}")
def get_job_status(
    job_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    job = _get_job_queue().get_job(session, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(404, "Job not found")
    return {"ok": True, "job": _serialize_job(job)}


@app.get("/api/flags")
def get_feature_flags():
    voice_strategy = os.getenv("VOICE_ROUTING_MODE", "backend").strip().lower() or "backend"
    async_jobs_enabled = _async_jobs_available()
    return {
        "ok": True,
        "flags": {
            "voiceRoutingMode": voice_strategy,
            "streamingChatEnabled": True,
            "asyncExportJobsEnabled": async_jobs_enabled,
            "asyncChatJobsEnabled": async_jobs_enabled,
            "vectorStoreBackend": VECTOR_STORE.mode,
        },
    }

@app.post("/api/tts")
def api_tts(
    payload: TTSRequest,
    auth_user: AuthUser = Depends(get_current_user),
):
    if not SARVAM_API_KEY:
        raise HTTPException(status_code=503, detail="SARVAM_API_KEY is not configured.")
    
    url = "https://api.sarvam.ai/text-to-speech"
    headers = {
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json"
    }
    
    req_payload = {
        "inputs": [payload.text],
        "target_language_code": "ta-IN",
        "speaker": "manisha",
        "model": "bulbul:v2",
        "pace": 0.85
    }
    
    try:
        response = requests.post(
            url,
            headers=headers,
            json=req_payload,
            timeout=(5, 30),
        )
    except requests.Timeout:
        raise HTTPException(status_code=504, detail="TTS provider timed out.")
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"TTS provider error: {exc}")
    
    # Fallback to "text" instead of "inputs" if the API format diverges.
    # Keep the same timeout and exception handling as the first provider call so
    # the fallback path cannot hang the worker thread or surface as an unhandled 500.
    if response.status_code in [422, 400] and "inputs" in req_payload:
        req_payload["text"] = payload.text
        del req_payload["inputs"]
        try:
            response = requests.post(
                url,
                headers=headers,
                json=req_payload,
                timeout=(5, 30),
            )
        except requests.Timeout:
            raise HTTPException(status_code=504, detail="TTS retry timed out.")
        except requests.RequestException as exc:
            raise HTTPException(status_code=502, detail=f"TTS retry failed: {exc}")
        
    if response.status_code == 200:
        data = response.json()
        if "audios" in data and len(data["audios"]) > 0:
            return {"audio_base64": data["audios"][0]}
        else:
            raise HTTPException(status_code=500, detail="Response did not contain 'audios' field.")
    else:
        raise HTTPException(status_code=response.status_code, detail=response.text)


@app.post("/users/{user_id}/questionnaire")
def save_mobile_questionnaire(
    user_id: int,
    payload: Dict[str, Any],
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    """Deprecated compatibility endpoint for older mobile builds.

    Questionnaire completion is derived from saved personality/profiler answers in
    ``UserProfile.answers_json``. This route intentionally does not write daily
    routine data; daily routine writes belong to ``PUT /users/{user_id}/daily-routine``.
    """
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)

    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    completed = _questionnaire_completed(profile)

    return {
        "ok": True,
        "deprecated": True,
        "message": (
            "Questionnaire completion is derived from /users/{user_id}/personality "
            "answers_json. This endpoint no longer writes daily routine data."
        ),
        "questionnaire_completed": completed,
        "user": _serialize_user_payload(user, profile),
    }


@app.post("/users/{user_id}/generate-daily-checkins")
def generate_daily_checkins(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    if not routine:
        raise HTTPException(400, "Daily routine not set. Please configure routine first.")
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    user_content = json.dumps(
        {
            "user": {"name": user.name, "place": user.place, "timezone": user.timezone},
            "personality": profile.profile_summary if profile and profile.profile_summary else "No personality profile yet. Be neutral and helpful.",
            "routine": {
                "wake_time": routine.wake_time,
                "sleep_time": routine.sleep_time,
                "work_start": routine.work_start,
                "work_end": routine.work_end,
                "daily_habits": routine.daily_habits,
            },
            "today": str(date.today()),
        },
        ensure_ascii=False,
    )
    out = llm_json(CHECKIN_PROMPT, user_content, temperature=0.2)
    checkins = out.get("checkins", [])
    checkins.sort(key=lambda x: x.get("when", "99:99"))
    log_conversation(session, user_id, "system", "generate-daily-checkins", None, out)
    return {"checkins": checkins}


@app.get("/users/{user_id}/daily-routine", response_model=DailyRoutineOut)
def get_daily_routine(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    if not routine:
        raise HTTPException(404, "Daily routine not set")
    return routine


@app.put("/users/{user_id}/daily-routine", response_model=DailyRoutineOut)
def upsert_daily_routine(
    user_id: int,
    payload: DailyRoutineIn,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    work_start = normalize_optional(payload.work_start)
    work_end = normalize_optional(payload.work_end)
    daily_habits = normalize_optional(payload.daily_habits)
    validate_hhmm(payload.wake_time)
    validate_hhmm(payload.sleep_time)
    if work_start:
        validate_hhmm(work_start)
    if work_end:
        validate_hhmm(work_end)

    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    if routine:
        routine.wake_time = payload.wake_time
        routine.sleep_time = payload.sleep_time
        routine.work_start = work_start
        routine.work_end = work_end
        routine.daily_habits = daily_habits
        routine.updated_at = _utc_now()
    else:
        _require_parent_user(session, user_id)
        routine = DailyRoutine(
            user_id=user_id,
            wake_time=payload.wake_time,
            sleep_time=payload.sleep_time,
            work_start=work_start,
            work_end=work_end,
            daily_habits=daily_habits,
            updated_at=_utc_now(),
        )
        session.add(routine)
    safe_commit(session, "upsert_daily_routine")
    session.refresh(routine)
    STAGE_CACHE.clear()
    _sync_stage_profile(session, user_id)
    _get_agentic_service().persist_profile_snapshot(session, user_id)
    return routine


@app.get("/users/{user_id}/personality")
def get_personality(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if not profile:
        raise HTTPException(404, "Personality profile not found")
    return {"answers": _load_json_object(profile.answers_json), "summary": profile.profile_summary}


@app.post("/users/{user_id}/personality")
def save_personality_answers(
    user_id: int,
    payload: PersonalityAnswersIn,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    _get_agentic_service().sync_answers_to_profile(session, user_id, payload.answers)
    STAGE_CACHE.clear()
    _sync_stage_profile(session, user_id)
    return {"ok": True}


@app.post("/users/{user_id}/personality/generate-summary")
def generate_personality_summary(
    user_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    assert_owner(user_id, user)
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if not profile:
        raise HTTPException(404, "Personality answers not found")
    answers = _load_json_object(profile.answers_json)
    if not answers:
        raise HTTPException(400, "No personality answers provided yet")
    result = _get_agentic_service().sync_answers_to_profile(session, user_id, answers)
    STAGE_CACHE.clear()
    _sync_stage_profile(session, user_id)
    return {"summary": result.get("summary", "")}

@app.post("/analyze-text", response_model=TextAnalysisResponse)
def analyze_text(
    payload: TextAnalysisRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    reply_language = payload.reply_language or (payload.meta or {}).get("reply_language")
    pipeline_result = _run_agentic_or_pipeline(session, int(user.id), payload.text, reply_language)
    item, _, _ = _save_item_from_pipeline(
        session,
        user_id=int(user.id),
        source="text",
        raw_text=payload.text,
        transcript=None,
        pipeline_result=pipeline_result,
        reply_language=reply_language,
    )
    return item_to_response(item)


async def _transcribe_and_analyze_upload(
    *,
    user_id: Optional[int],
    reply_language: Optional[str],
    speech_language: Optional[str],
    file: UploadFile,
    session: Session,
    auth_user: AuthUser,
) -> Dict[str, Any]:
    user = get_owned_user(session, auth_user)
    if user_id is not None:
        assert_owner(int(user_id), user)

    suffix = os.path.splitext(file.filename or "")[-1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await read_limited_upload(file))
        tmp_path = tmp.name

    try:
        transcript_text = _transcribe_audio_file(tmp_path, speech_language)

        pipeline_result = _run_agentic_or_pipeline(
            session,
            int(user.id),
            transcript_text,
            reply_language,
        )

        item, meta, normalized_pipeline = _save_item_from_pipeline(
            session,
            user_id=int(user.id),
            source="voice",
            raw_text=transcript_text,
            transcript=transcript_text,
            pipeline_result=pipeline_result,
            reply_language=reply_language,
        )
        return _build_chat_response(item, meta, normalized_pipeline)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@app.post("/transcribe-and-analyze")
async def transcribe_and_analyze(
    user_id: Optional[int] = None,
    reply_language: Optional[str] = None,
    speech_language: Optional[str] = None,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    return await _transcribe_and_analyze_upload(
        user_id=user_id,
        reply_language=reply_language,
        speech_language=speech_language,
        file=file,
        session=session,
        auth_user=auth_user,
    )


@app.post("/api/transcribe-and-analyze")
async def api_transcribe_and_analyze(
    user_id: Optional[int] = None,
    reply_language: Optional[str] = None,
    speech_language: Optional[str] = None,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    return await _transcribe_and_analyze_upload(
        user_id=user_id,
        reply_language=reply_language,
        speech_language=speech_language,
        file=file,
        session=session,
        auth_user=auth_user,
    )

@app.post("/wake-phrase/transcribe")
@app.post("/api/wake-phrase/transcribe")
async def transcribe_wake_phrase(
    language: Optional[str] = Query(default=None),
    locale: Optional[str] = Query(default=None),
    file: UploadFile = File(...),
    auth_user: AuthUser = Depends(get_current_user),
):
    suffix = os.path.splitext(file.filename or "")[-1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await read_limited_upload(file))
        tmp_path = tmp.name

    try:
        transcript_text = _transcribe_audio_file(tmp_path, language or locale)
        return {
            "ok": True,
            "transcript": transcript_text,
            "language": _normalize_audio_language(language or locale),
        }
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _require_positive_user_id(user_id: Optional[int]) -> int:
    if user_id is None or int(user_id) <= 0:
        raise HTTPException(400, "user_id is required")
    return int(user_id)


def _get_owned_item(session: Session, item_id: int, user_id: int) -> Item:
    item = session.get(Item, item_id)
    if not item or item.user_id != user_id:
        raise HTTPException(404, "Item not found")
    return item


@app.get("/items", response_model=List[TextAnalysisResponse])
def list_items(
    session: Session = Depends(get_session),
    user_id: Optional[int] = Query(default=None),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if user_id is not None:
        assert_owner(int(user_id), user)

    query = (
        select(Item)
        .where(Item.user_id == int(user.id))
        .order_by(Item.created_at.desc())
    )
    items = session.exec(query).all()
    return [item_to_response(i) for i in items]


@app.get("/items/{item_id}", response_model=TextAnalysisResponse)
def get_item(
    item_id: int,
    session: Session = Depends(get_session),
    user_id: Optional[int] = Query(default=None),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if user_id is not None:
        assert_owner(int(user_id), user)
    item = _get_owned_item(session, item_id, int(user.id))
    return item_to_response(item)


@app.delete("/items/{item_id}")
def delete_item(
    item_id: int,
    user_id: Optional[int] = Query(default=None),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if user_id is not None:
        assert_owner(int(user_id), user)
    item = _get_owned_item(session, item_id, int(user.id))

    session.delete(item)
    safe_commit(session, "delete_item")

    return {"ok": True, "id": item_id}


DOCS_BASE_DIR = Path(GENERATED_DOCS_DIR).resolve()
PDF_BASE_DIR = DOCS_BASE_DIR / "pdf"
EXCEL_BASE_DIR = DOCS_BASE_DIR / "excel"
PPT_BASE_DIR = DOCS_BASE_DIR / "ppt"
DOCX_BASE_DIR = DOCS_BASE_DIR / "docx"


def ensure_dir(path: str | Path) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)


def _safe_export_segment(value: Optional[str], *, default: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._-")
    return cleaned or default


def _category_export_dir(base_dir: Path, category: Optional[str]) -> Path:
    ensure_dir(base_dir)
    category_dir = base_dir / _safe_export_segment(category, default="Other")
    ensure_dir(category_dir)
    return category_dir


def _sign_download_payload(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(DOWNLOAD_TOKEN_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def _verify_download_token(token: str) -> Dict[str, Any]:
    token = str(token or "").strip()
    if "." not in token:
        raise HTTPException(404, "File not found")
    body, sig = token.rsplit(".", 1)
    expected = hmac.new(DOWNLOAD_TOKEN_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(404, "File not found")
    try:
        padded = body + "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(404, "File not found") from exc
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(404, "File not found")
    return payload if isinstance(payload, dict) else {}


def _build_download_payload(path: Path, *, item: Item) -> Dict[str, Any]:
    resolved = path.resolve()
    relative_path = resolved.relative_to(DOCS_BASE_DIR).as_posix()
    token = _sign_download_payload(
        {
            "path": relative_path,
            "user_id": int(item.user_id),
            "item_id": int(item.id),
            "exp": int(time.time()) + DOWNLOAD_TOKEN_TTL_SECONDS,
        }
    )
    return {"ok": True, "download_id": token, "download_url": f"/download/{token}"}


def _resolve_generated_doc_path(raw_path: str) -> Path:
    relative_path = str(raw_path or "").strip().lstrip("/")
    if not relative_path:
        raise HTTPException(404, "File not found")

    candidate = (DOCS_BASE_DIR / relative_path).resolve()
    try:
        candidate.relative_to(DOCS_BASE_DIR)
    except ValueError as exc:
        raise HTTPException(404, "File not found") from exc

    if not candidate.is_file():
        raise HTTPException(404, "File not found")

    return candidate


def generate_docx(item: Item) -> Path:
    from docx import Document

    category_dir = _category_export_dir(DOCX_BASE_DIR, item.category)
    path = category_dir / f"item_{item.id}.docx"
    doc = Document()
    doc.add_heading(item.title or f"Item {item.id}", level=1)
    doc.add_paragraph(f"Intent: {item.intent}")
    doc.add_paragraph(f"Category: {item.category}")
    if item.datetime_str:
        doc.add_paragraph(f"When: {item.datetime_str}")
    doc.add_paragraph(item.details or item.raw_text)
    doc.save(str(path))
    return path


def generate_pdf(item: Item) -> Path:
    from fpdf import FPDF

    category_dir = _category_export_dir(PDF_BASE_DIR, item.category)
    path = category_dir / f"item_{item.id}.pdf"

    pdf = FPDF()
    pdf.add_page()

    font_candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ]
    font_path = next((p for p in font_candidates if os.path.exists(p)), None)

    if font_path:
        pdf.add_font("DejaVu", "", font_path, uni=True)
        pdf.set_font("DejaVu", size=14)
    else:
        pdf.set_font("Arial", size=12)

    pdf.cell(0, 10, txt=item.title or f"Item {item.id}", ln=True)
    pdf.set_font_size(11)
    pdf.multi_cell(0, 8, txt=f"Intent: {item.intent}")
    pdf.multi_cell(0, 8, txt=f"Category: {item.category}")
    if item.datetime_str:
        pdf.multi_cell(0, 8, txt=f"When: {item.datetime_str}")
    pdf.ln(2)
    pdf.multi_cell(0, 8, txt=item.details or item.raw_text)

    pdf.output(str(path))
    return path


def generate_excel(item: Item) -> Path:
    from openpyxl import Workbook

    category_dir = _category_export_dir(EXCEL_BASE_DIR, item.category)
    path = category_dir / f"item_{item.id}.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "Item"
    rows = [
        ("ID", item.id),
        ("Title", item.title),
        ("Intent", item.intent),
        ("Category", item.category),
        ("When", item.datetime_str),
        ("Details", item.details or item.raw_text),
    ]
    for i, (k, v) in enumerate(rows, start=1):
        ws.cell(row=i, column=1, value=k)
        ws.cell(row=i, column=2, value=v)
    wb.save(str(path))
    return path


def generate_ppt(item: Item) -> Path:
    from pptx import Presentation

    category_dir = _category_export_dir(PPT_BASE_DIR, item.category)
    path = category_dir / f"item_{item.id}.pptx"

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = item.title or f"Item {item.id}"
    tf = slide.placeholders[1].text_frame
    tf.text = f"Intent: {item.intent}\nCategory: {item.category}"
    if item.datetime_str:
        tf.add_paragraph().text = f"When: {item.datetime_str}"
    tf.add_paragraph().text = item.details or item.raw_text

    prs.save(str(path))
    return path


def _enqueue_export_job(
    session: Session,
    *,
    item_id: int,
    export_format: str,
    user: User,
) -> Dict[str, Any]:
    _require_async_jobs_available()
    normalized_format = _validate_export_format(export_format)
    item = _get_owned_item(session, item_id, int(user.id))
    job = _get_job_queue().enqueue(
        session,
        job_type="export",
        user_id=int(user.id),
        payload={"item_id": item_id, "export_format": normalized_format},
        max_attempts=int(os.getenv("JOB_EXPORT_MAX_ATTEMPTS", "3") or 3),
    )
    return {"ok": True, "job": _serialize_job(job)}


@app.post("/items/{item_id}/exports/{export_format}/jobs")
def item_generate_export_job(
    item_id: int,
    export_format: str,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    return _enqueue_export_job(session, item_id=item_id, export_format=export_format, user=user)


@app.post("/items/{item_id}/generate-pdf")
def item_generate_pdf(
    item_id: int,
    session: Session = Depends(get_session),
    background: bool = Query(default=False),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if background:
        return _enqueue_export_job(session, item_id=item_id, export_format="pdf", user=user)
    item = _get_owned_item(session, item_id, int(user.id))
    path = generate_pdf(item)
    return _build_download_payload(path, item=item)


@app.post("/items/{item_id}/generate-excel")
def item_generate_excel(
    item_id: int,
    session: Session = Depends(get_session),
    background: bool = Query(default=False),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if background:
        return _enqueue_export_job(session, item_id=item_id, export_format="excel", user=user)
    item = _get_owned_item(session, item_id, int(user.id))
    path = generate_excel(item)
    return _build_download_payload(path, item=item)


@app.post("/items/{item_id}/generate-ppt")
def item_generate_ppt(
    item_id: int,
    session: Session = Depends(get_session),
    background: bool = Query(default=False),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if background:
        return _enqueue_export_job(session, item_id=item_id, export_format="ppt", user=user)
    item = _get_owned_item(session, item_id, int(user.id))
    path = generate_ppt(item)
    return _build_download_payload(path, item=item)


@app.post("/items/{item_id}/generate-docx")
def item_generate_docx(
    item_id: int,
    session: Session = Depends(get_session),
    background: bool = Query(default=False),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if background:
        return _enqueue_export_job(session, item_id=item_id, export_format="docx", user=user)
    item = _get_owned_item(session, item_id, int(user.id))
    path = generate_docx(item)
    return _build_download_payload(path, item=item)


@app.get("/download/{download_id}")
def download_generated_by_token(
    download_id: str,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    payload = _verify_download_token(download_id)
    if int(payload.get("user_id") or 0) != int(user.id):
        raise HTTPException(404, "File not found")
    item_id = int(payload.get("item_id") or 0)
    _get_owned_item(session, item_id, int(user.id))
    resolved_path = _resolve_generated_doc_path(str(payload.get("path") or ""))
    return FileResponse(str(resolved_path), filename=resolved_path.name)


@app.get("/download")
def download_generated(
    download_id: Optional[str] = Query(default=None),
    path: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    if path:
        raise HTTPException(400, "Raw path downloads are disabled. Use a signed download_id.")
    if not download_id:
        raise HTTPException(400, "download_id is required")
    return download_generated_by_token(download_id, session, auth_user)
