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
import subprocess
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
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
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
    verify_firebase_id_token,
    validate_auth_configuration,
)
from .database import SessionLocal, engine, get_session
from .job_queue import DBJobQueue
from .model_runtime import patch_openai_client
from .models import AgentRun, AgentStep, Conversation, DailyRoutine, DocumentArtifact, GlobalQACache, GlobalQAObservation, Item, Job, OpenAIUsageLog, QACache, RagEmbedding, User, UserProfile
from .time_utils import utc_now as _utc_now
from .observability import (
    APP_RELEASE,
    CHAT_TURN_SUMMARY_LOGS_ENABLED,
    CLIENT_TURN_LOGS_ENABLED,
    LOG_CHAT_CONTENT,
    LOG_CHAT_CONTENT_MAX_CHARS,
    build_turn_summary_payload,
    bootstrap_observability,
    chat_log_payload,
    clear_request_context,
    get_request_id,
    new_request_id,
    sanitize_log_text,
    set_request_context,
)
from .vector_store import VectorStore
from .local_rag_service import LocalRAGService
from .agentic_service import AgenticService
from .orchestrator_task import run_orchestrator, run_rule_orchestrator
from .global_qa_cache import (
    build_global_knowledge_sync_payload,
    global_qa_schema_ready,
    lookup_approved_global_cache,
    record_backend_openai_answer,
)
from .openai_model_router import OpenAIConfigurationError, OpenAIModelRouter, record_openai_usage
from .openai_tracked import OpenAIBudgetExceededError, get_tracked_chat_completion_metadata, tracked_chat_completion, tracked_openai_generation
from .ai.model_health import clear_model_health, model_health_snapshot
from .ai.openai_catalog import get_model_spec, get_openai_model_catalog
from .ai.budget import enforce_free_voice_quota, enforce_provider_budget
from .ai.orchestrator import run_text_turn
from .ai.providers.sarvam_provider import (
    SarvamProvider,
    estimate_audio_duration_details,
    estimate_stt_cost,
    estimate_tts_cost,
    extract_sarvam_transcript,
    normalize_audio_language,
    normalize_sarvam_tts_model,
    normalize_stt_upload_mime_type,
    redact_sarvam_provider_message,
    resolve_sarvam_tts_voice,
    sarvam_provider_error_detail,
)
from .ai.agent_runtime import agentic_mode_enabled, fetch_agent_run_for_user
from .ai.response_adapter import ai_response_to_pipeline
from .ai.types import AIProviderResponse, AIRequest
from .ai.usage import record_ai_usage_event


bootstrap_observability()
patch_openai_client()

from config import (
    DEFAULT_REPLY_LANGUAGE,
    DEFAULT_SPEECH_LANGUAGE,
    GENERATED_DOCS_DIR,
    AI_TEXT_CHAT_ENABLED,
    LOGS_DIR,
    PIPELINE_VERSION,
    RAG_CONTEXT_HEADER,
    RAG_CONTEXT_INCLUDE_IN_STAGE_CONTEXT,
    RAG_CONTEXT_MAX_SNIPPETS,
    VOICE_ONLY_PUBLIC_MODE,
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


def _admin_emails() -> set[str]:
    return {
        item.strip().lower()
        for item in str(os.getenv("ADMIN_EMAILS", "")).split(",")
        if item.strip()
    }


def _debug_admin_token() -> str:
    return os.getenv("DEBUG_ADMIN_TOKEN", "").strip()


async def require_debug_admin(request: Request) -> Optional[AuthUser]:
    configured_admin_emails = _admin_emails()
    configured_debug_token = _debug_admin_token()
    if not configured_admin_emails and not configured_debug_token:
        raise HTTPException(status_code=403, detail="Admin access required")

    supplied_debug_token = request.headers.get("x-admin-token", "").strip()
    if (
        configured_debug_token
        and supplied_debug_token
        and hmac.compare_digest(supplied_debug_token, configured_debug_token)
    ):
        return None

    authorization = request.headers.get("authorization", "")
    if authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        if token:
            try:
                decoded = verify_firebase_id_token(token)
            except AuthConfigurationError as exc:
                logger.exception("Firebase auth is not configured for debug admin check")
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            except Exception:
                decoded = {}
            email = str(decoded.get("email") or "").strip().lower() if isinstance(decoded, dict) else ""
            if email and email in configured_admin_emails:
                return AuthUser(firebase_uid=str(decoded.get("uid") or ""), email=email)

    raise HTTPException(status_code=403, detail="Admin access required")


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
SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech"

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
SARVAM_PROVIDER: Optional[SarvamProvider] = None
STAGE_CACHE = ThreadSafeLRUCache(max_size=128)


def _is_openai_configured() -> bool:
    return bool(OPENAI_API_KEY)


def _openai_required_error(operation: str = "This operation") -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=f"{operation} requires OPENAI_API_KEY to be configured on the server.",
    )


OPENAI_PROVIDER_CONFIG_DETAIL = "OpenAI provider/configuration error. Check OPENAI_API_KEY and OPENAI_MODEL settings."
OPENAI_PROVIDER_RATE_LIMIT_DETAIL = "OpenAI provider rate limit reached. Try again later."
OPENAI_PROVIDER_CONNECTION_DETAIL = "OpenAI provider is temporarily unavailable. Try again later."
OPENAI_PROVIDER_TIMEOUT_DETAIL = "OpenAI provider timed out. Try again later."
OPENAI_PROVIDER_STATUS_DETAIL = "OpenAI provider returned an upstream error. Try again later."


def _openai_provider_http_exception(exc: BaseException) -> Optional[HTTPException]:
    if isinstance(exc, OpenAIBudgetExceededError):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, OpenAIConfigurationError):
        return HTTPException(status_code=503, detail=OPENAI_PROVIDER_CONFIG_DETAIL)
    if isinstance(
        exc,
        (
            openai.AuthenticationError,
            openai.PermissionDeniedError,
            openai.NotFoundError,
            openai.BadRequestError,
        ),
    ):
        return HTTPException(status_code=503, detail=OPENAI_PROVIDER_CONFIG_DETAIL)
    if isinstance(exc, openai.RateLimitError):
        return HTTPException(status_code=503, detail=OPENAI_PROVIDER_RATE_LIMIT_DETAIL)
    if isinstance(exc, openai.APITimeoutError):
        return HTTPException(status_code=504, detail=OPENAI_PROVIDER_TIMEOUT_DETAIL)
    if isinstance(exc, openai.APIConnectionError):
        return HTTPException(status_code=503, detail=OPENAI_PROVIDER_CONNECTION_DETAIL)
    if isinstance(exc, openai.APIStatusError):
        return HTTPException(status_code=502, detail=OPENAI_PROVIDER_STATUS_DETAIL)
    return None


@app.exception_handler(OpenAIConfigurationError)
async def openai_configuration_exception_handler(request: Request, exc: OpenAIConfigurationError):
    mapped = _openai_provider_http_exception(exc)
    status_code = mapped.status_code if mapped is not None else 503
    detail = mapped.detail if mapped is not None else OPENAI_PROVIDER_CONFIG_DETAIL
    return JSONResponse(status_code=status_code, content={"detail": detail})


@app.exception_handler(openai.OpenAIError)
async def openai_provider_exception_handler(request: Request, exc: openai.OpenAIError):
    mapped = _openai_provider_http_exception(exc)
    status_code = mapped.status_code if mapped is not None else 502
    detail = mapped.detail if mapped is not None else OPENAI_PROVIDER_STATUS_DETAIL
    return JSONResponse(status_code=status_code, content={"detail": detail})


@app.exception_handler(OpenAIBudgetExceededError)
async def openai_budget_exception_handler(request: Request, exc: OpenAIBudgetExceededError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


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


def _get_sarvam_provider() -> SarvamProvider:
    global SARVAM_PROVIDER
    SARVAM_PROVIDER = SarvamProvider(http_post=requests.post, api_key_getter=_sarvam_api_key)
    return SARVAM_PROVIDER


def _ai_router_enabled() -> bool:
    return os.getenv("AI_ROUTER_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}


def _legacy_pipeline_enabled() -> bool:
    return os.getenv("AI_LEGACY_PIPELINE_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _normalize_reply_language(value: Optional[str]) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"en", "english"}:
        return "en"
    if normalized in {"ta", "tamil", "mixed", "tanglish"}:
        return "ta"
    return "ta"


def _normalize_speech_language_query(value: Optional[str]) -> Optional[str]:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    lowered = normalized.lower()
    if lowered in {"auto", "detect", "auto-detect", "autodetect", "unknown"}:
        return None
    return normalized


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
    if normalized not in {"pdf", "excel", "xlsx", "ppt", "pptx", "docx"}:
        raise HTTPException(400, "Unsupported export format")
    return _document_format_key(normalized)


def _job_handle_export(session: Session, payload: Dict[str, Any]) -> Dict[str, Any]:
    item_id = int(payload["item_id"])
    export_format = _validate_export_format(payload["export_format"])
    item = session.get(Item, item_id)
    if not item:
        raise RuntimeError("Item not found")
    artifact, path = _create_document_artifact(
        session,
        item=item,
        format_key=export_format,
        source_text=item.raw_text,
        metadata={"source": "export_job"},
    )
    return _build_download_payload(path, item=item, artifact=artifact)


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


def _observability_config_payload() -> Dict[str, Any]:
    return {
        "ok": True,
        "environment": APP_ENV,
        "release": APP_RELEASE,
        "log_chat_content": bool(LOG_CHAT_CONTENT),
        "log_chat_content_max_chars": int(LOG_CHAT_CONTENT_MAX_CHARS),
        "client_turn_logs_enabled": bool(CLIENT_TURN_LOGS_ENABLED),
        "chat_turn_summary_logs_enabled": bool(CHAT_TURN_SUMMARY_LOGS_ENABLED),
    }


def emit_observability_config_log() -> None:
    payload = _observability_config_payload()
    logger.info(
        "observability_config",
        extra=chat_log_payload(
            event="observability_config",
            environment=payload["environment"],
            release=payload["release"],
            log_chat_content=payload["log_chat_content"],
            log_chat_content_max_chars=payload["log_chat_content_max_chars"],
            client_turn_logs_enabled=payload["client_turn_logs_enabled"],
            chat_turn_summary_logs_enabled=payload["chat_turn_summary_logs_enabled"],
        ),
    )


@app.on_event("startup")
def startup_runtime_services() -> None:
    emit_observability_config_log()
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
    except Exception as exc:
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        logger.error(
            "request_failed_exception",
            extra={
                "event": "request_failed_exception",
                "method": request.method,
                "path": request.url.path,
                "exception_class": exc.__class__.__name__,
                "exception_message": sanitize_log_text(str(exc), 240),
                "duration_ms": duration_ms,
            },
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
    target_language_code: Optional[str] = None
    speaker: Optional[str] = None


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
    request_id: Optional[str] = None
    client_fallback_reason: Optional[str] = None
    client_local_budget_ms: Optional[int] = None
    client_original_route: Optional[str] = None
    admin_email: Optional[str] = None


class FileSearchRequest(BaseModel):
    query: str = ""
    category: Optional[str] = None
    date: Optional[str] = None
    limit: int = 10


class AIModelProbeRequest(BaseModel):
    models: Optional[List[str]] = None


class ClientTurnLogRequest(BaseModel):
    event: str
    user_id: Optional[int] = None
    request_id: Optional[str] = None
    turn_id: Optional[str] = None
    channel: Optional[str] = None
    question_hash: Optional[str] = None
    question: Optional[str] = None
    question_preview: Optional[str] = None
    answer: Optional[str] = None
    answer_preview: Optional[str] = None
    question_length: Optional[int] = None
    answer_length: Optional[int] = None
    agent_source: Optional[str] = None
    route_taken: Optional[str] = None
    fallback_reason: Optional[str] = None
    duration_ms: Optional[float] = None
    local_duration_ms: Optional[float] = None
    backend_duration_ms: Optional[float] = None
    total_duration_ms: Optional[float] = None
    stage_timings: Optional[Dict[str, Any]] = None
    workflow_step: Optional[str] = None
    workflow_phase: Optional[str] = None
    step_index: Optional[int] = None
    decision: Optional[str] = None
    cache_hit: Optional[bool] = None
    cache_source: Optional[str] = None
    global_sync_status: Optional[str] = None
    http_status: Optional[int] = None
    error_name: Optional[str] = None
    error_message: Optional[str] = None
    model_used: Optional[str] = None
    model_tier: Optional[str] = None
    native_backend: Optional[str] = None
    local_runtime_mode: Optional[str] = None
    db_schema_ready: Optional[bool] = None
    screen: Optional[str] = None
    app_state: Optional[str] = None
    sync_id: Optional[str] = None
    page: Optional[int] = None
    limit: Optional[int] = None
    since: Optional[str] = None
    after_id: Optional[str] = None
    missing_tables: Optional[List[str]] = None
    last_step: Optional[str] = None
    started_at: Optional[str] = None
    error_type: Optional[str] = None
    app_version: Optional[str] = None
    api_base: Optional[str] = None
    build_number: Optional[str] = None
    mobile_build_id: Optional[str] = None
    mobile_git_sha: Optional[str] = None
    local_to_backend_fallback_ms: Optional[int] = None
    cloud_fallback_enabled: Optional[bool] = None
    created_at: Optional[str] = None
    provider: Optional[str] = None
    voice_phase: Optional[str] = None
    telemetry_delivery: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    tts_speaker: Optional[str] = None
    tts_language_code: Optional[str] = None
    tts_locale_style: Optional[str] = None
    voice_session_id: Optional[str] = None
    voice_surface: Optional[str] = None
    intent_before_cleanup: Optional[str] = None
    intent_after_cleanup: Optional[str] = None
    normalized_message_hash: Optional[str] = None
    wake_word_stripped: Optional[bool] = None
    chat_routing: Optional[str] = None
    voice_routing: Optional[str] = None
    native_safety_status: Optional[Dict[str, Any]] = None


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
    try:
        response = tracked_chat_completion(
            _get_openai_client(),
            task="json",
            route="main_llm_json",
            request_id=get_request_id(),
            messages=[
                {"role": "system", "content": system_prompt.strip()},
                {"role": "user", "content": user_content.strip()},
            ],
            temperature=temperature,
            response_format={"type": "json_object"},
        )
    except OpenAIBudgetExceededError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
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
    try:
        response = tracked_chat_completion(
            _get_openai_client(),
            task="simple_fallback",
            route="main_llm_text",
            request_id=get_request_id(),
            messages=[
                {"role": "system", "content": system_prompt.strip()},
                {"role": "user", "content": user_content.strip()},
            ],
            temperature=temperature,
        )
    except OpenAIBudgetExceededError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _extract_response_text(response)


def normalize_category(raw: str) -> str:
    cr = (raw or "Other").lower()
    if cr == "work":
        return "Work"
    if cr == "home":
        return "Home"
    if cr == "business":
        return "Business"
    if cr == "reminder":
        return "Reminder"
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


def _recent_ai_context_turns(session: Session, user_id: Optional[int], *, limit: int = 6) -> List[Dict[str, str]]:
    if user_id is None:
        return []
    try:
        rows = list(
            session.exec(
                select(Conversation)
                .where(Conversation.user_id == int(user_id))
                .order_by(Conversation.created_at.desc())
                .limit(max(1, limit))
            ).all()
        )
    except Exception:
        session.rollback()
        return []

    turns: List[Dict[str, str]] = []
    for row in reversed(rows):
        user_text = " ".join(str(row.user_input or "").strip().split())
        assistant_text = _assistant_text_from_conversation(row)
        if not user_text and not assistant_text:
            continue
        turns.append(
            {
                "user": user_text[:500],
                "assistant": assistant_text[:900],
            }
        )
    return turns[-limit:]


def _assistant_text_from_conversation(row: Conversation) -> str:
    try:
        payload = json.loads(row.llm_output_json or "{}")
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        return ""
    meta = payload.get("meta")
    if isinstance(meta, dict):
        details = str(meta.get("details") or "").strip()
        if details:
            return " ".join(details.split())
    pipeline = payload.get("pipeline")
    if isinstance(pipeline, dict):
        for key in ("theni_tamil_text", "tamil_text", "remodeled_english", "raw_english"):
            value = str(pipeline.get(key) or "").strip()
            if value:
                return " ".join(value.split())
    return ""


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


def _compact_profile_value(value: Any, limit: int = 800) -> Any:
    if isinstance(value, str):
        text = re.sub(r"\s+", " ", value).strip()
        return text[:limit]
    if isinstance(value, list):
        return [_compact_profile_value(item, limit=240) for item in value[:12]]
    if isinstance(value, dict):
        return {
            str(key)[:80]: _compact_profile_value(entry, limit=240)
            for key, entry in list(value.items())[:24]
            if not any(
                marker in str(key).lower()
                for marker in ("firebase_uid", "email", "auth", "token", "secret", "api_key", "password")
            )
        }
    return value


def build_profile_prompt_context(session: Session, user_id: Optional[int]) -> Dict[str, Any]:
    if not user_id:
        return {}

    user = session.get(User, int(user_id))
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == int(user_id))).first()
    onboarding = load_onboarding_profile(session, int(user_id))
    answers = onboarding.get("answers") if isinstance(onboarding, dict) else {}
    answers = answers if isinstance(answers, dict) else {}

    profile_summary = ""
    if profile and profile.profile_summary:
        profile_summary = str(profile.profile_summary).strip()
    elif isinstance(onboarding, dict):
        profile_summary = str(onboarding.get("profile_summary") or "").strip()

    return {
        "user": {
            "name": user.name if user else "",
            "place": user.place if user else "",
            "timezone": user.timezone if user else "Asia/Kolkata",
            "assistant_name": user.assistant_name if user else "Elli",
            "reply_language": _normalize_reply_language(user.reply_language if user else DEFAULT_REPLY_LANGUAGE),
        },
        "questionnaire_completed": bool(onboarding.get("questionnaire_completed")) if isinstance(onboarding, dict) else False,
        "profile_summary": _compact_profile_value(profile_summary, 1200),
        "communication_tone": _compact_profile_value(answers.get("communication_tone") or _infer_tone(profile_summary), 120),
        "answer_length": _compact_profile_value(answers.get("answer_length") or "medium", 80),
        "tamil_style": _compact_profile_value(answers.get("tamil_style") or "chennai_conversational", 120),
        "onboarding_answers": _compact_profile_value(answers, 240),
    }


def _profile_prompt_context_text(profile_context: Dict[str, Any]) -> str:
    if not profile_context:
        return ""
    return json.dumps(profile_context, ensure_ascii=False, sort_keys=True)


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
    model_used = str(core_meta.get("model_used") or review_meta.get("model_used") or "").strip()
    if model_used:
        result["model_used"] = model_used
        result["model_tier"] = str(core_meta.get("model_tier") or review_meta.get("model_tier") or "")
        result["model_reason"] = str(core_meta.get("model_reason") or review_meta.get("model_reason") or "")
    if bool(core_meta.get("openai_usage_tracked") or review_meta.get("openai_usage_tracked")):
        result["openai_usage_tracked"] = True

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


def _fast_fallback_metadata_for_item(text: str, answer: str) -> Dict[str, Any]:
    clean_text = " ".join(str(text or "").strip().split())
    return {
        "intent": "assistant",
        "category": "Other",
        "datetime": None,
        "title": (clean_text[:60] + "...") if len(clean_text) > 60 else clean_text or "Chat",
        "details": str(answer or "").strip(),
    }


def _dict_from_possible_json(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _document_request_from_pipeline(pipeline_result: Dict[str, Any], meta: Dict[str, Any]) -> Dict[str, Any]:
    request = dict(meta or {})
    core_meta = _dict_from_possible_json(pipeline_result.get("core_meta"))
    raw = _dict_from_possible_json(core_meta.get("raw"))
    if isinstance(raw.get("item_metadata"), dict):
        request.update(raw["item_metadata"])
    if str(request.get("intent") or "").lower() != "document":
        return {}
    formats = request.get("document_formats")
    if not isinstance(formats, list):
        formats = ["pdf"]
    normalized_formats = [_document_format_key(str(fmt)) for fmt in formats if str(fmt or "").strip()]
    request["document_formats"] = normalized_formats or ["pdf"]
    return request


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
        "model_used": result.get("model_used"),
        "model_tier": result.get("model_tier"),
        "model_reason": result.get("model_reason"),
        "provider": result.get("provider"),
        "cost_estimate": result.get("cost_estimate"),
        "cost_currency": result.get("cost_currency"),
        "openai_usage_tracked": bool(result.get("openai_usage_tracked")),
        "fallback_reason": result.get("fallback_reason"),
        "primary_model_candidate": result.get("primary_model_candidate"),
        "selected_model_reason": result.get("selected_model_reason"),
        "skipped_models": result.get("skipped_models"),
        "model_health_skip_reason": result.get("model_health_skip_reason"),
        "client_fallback_reason": result.get("client_fallback_reason"),
        "client_local_budget_ms": result.get("client_local_budget_ms"),
        "client_original_route": result.get("client_original_route"),
    }


def _materialize_document_request(
    session: Session,
    *,
    item: Item,
    pipeline_result: Dict[str, Any],
    meta: Dict[str, Any],
) -> list[Dict[str, Any]]:
    request = _document_request_from_pipeline(pipeline_result, meta)
    if not request:
        return []
    artifacts: list[Dict[str, Any]] = []
    source_text = str(request.get("source_text") or item.raw_text or "")
    for format_key in request.get("document_formats") or ["pdf"]:
        artifact, path = _create_document_artifact(
            session,
            item=item,
            format_key=str(format_key),
            source_text=source_text,
            metadata={"source": "voice_or_chat_command"},
        )
        artifacts.append(
            {
                "id": artifact.id,
                "title": artifact.title,
                "format": artifact.format,
                "category": artifact.category,
                "relative_path": artifact.relative_path,
                "source_text": artifact.source_text,
                **_build_download_payload(path, item=item, artifact=artifact),
            }
        )
    return artifacts


def _hydrate_tool_file_metadata(session: Session, *, user_id: Optional[int], files: Any) -> list[Dict[str, Any]]:
    if user_id is None or not isinstance(files, list):
        return files if isinstance(files, list) else []
    hydrated: list[Dict[str, Any]] = []
    for file_row in files:
        if not isinstance(file_row, dict):
            continue
        payload = dict(file_row)
        artifact_id = payload.get("id")
        try:
            artifact = session.get(DocumentArtifact, int(artifact_id)) if artifact_id is not None else None
        except Exception:
            session.rollback()
            artifact = None
        if artifact is not None and int(artifact.user_id) == int(user_id):
            payload.setdefault("item_id", artifact.item_id)
            payload.setdefault("title", artifact.title)
            payload.setdefault("format", artifact.format)
            payload.setdefault("category", artifact.category)
            payload.setdefault("relative_path", artifact.relative_path)
            payload.setdefault("source_text", artifact.source_text)
            try:
                path = _resolve_generated_doc_path(artifact.relative_path)
                item = session.get(Item, int(artifact.item_id)) if artifact.item_id is not None else None
                payload.update(_build_download_payload(path, item=item, artifact=artifact))
            except HTTPException:
                pass
        hydrated.append(payload)
    return hydrated


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
    metadata_override: Optional[Dict[str, Any]] = None,
    skip_expensive_side_effects: bool = False,
) -> tuple[Item, Dict[str, Any], Dict[str, Any]]:
    spoken_answer = _assistant_text_from_pipeline(pipeline_result, raw_text, reply_language)
    meta = metadata_override or _metadata_for_item(session, user_id, raw_text, spoken_answer)

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

    artifacts = _materialize_document_request(
        session,
        item=item,
        pipeline_result=pipeline_result,
        meta=meta,
    )
    if artifacts:
        meta["artifacts"] = artifacts
    if isinstance(meta.get("files"), list):
        meta["files"] = _hydrate_tool_file_metadata(session, user_id=user_id, files=meta.get("files"))

    if not skip_expensive_side_effects:
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
    if not skip_expensive_side_effects:
        try:
            upsert_qa_cache(session, user_id, raw_text, payload)
        except Exception:
            session.rollback()
            logger.exception(
                "QA cache side effect failed",
                extra={"user_id": user_id, "source": source},
            )
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


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _rag_snippet_count(pipeline: Dict[str, Any]) -> Optional[int]:
    for container_key in ("core_meta", "review_meta"):
        container = pipeline.get(container_key)
        if not isinstance(container, dict):
            continue
        rag_context = container.get("rag_context") or container.get("rag_context_used")
        if isinstance(rag_context, dict) and "snippet_count" in rag_context:
            try:
                return int(rag_context.get("snippet_count") or 0)
            except Exception:
                return None
    return None


def _backend_agent_source(pipeline: Dict[str, Any]) -> str:
    if str(pipeline.get("route_taken") or "").lower() == "global_knowledge_cache":
        return "global_rag"
    if _boolish(pipeline.get("cache_hit")):
        return "backend_cache"
    direct_source = str(pipeline.get("direct_answer_source") or "").lower()
    route_taken = str(pipeline.get("route_taken") or "").lower()
    if "openai" in direct_source or route_taken in {"full_pipeline", "full_rewrite"}:
        return "backend_openai"
    return "backend_pipeline"


def _safe_error_type(exc: BaseException) -> str:
    if isinstance(exc, HTTPException):
        return f"http_{exc.status_code}"
    return exc.__class__.__name__


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
    if value in {"auto", "detect", "auto-detect", "autodetect", "unknown"}:
        return None

    if value.startswith("ta"):
        return "ta-IN"
    if value.startswith("en"):
        return "en-IN"
    return None


def _sarvam_api_key() -> str:
    return (os.getenv("SARVAM_API_KEY") or SARVAM_API_KEY or "").strip()


def _redact_sarvam_provider_message(message: str) -> str:
    redacted = str(message or "")
    api_key = _sarvam_api_key()
    if api_key:
        redacted = redacted.replace(api_key, "[REDACTED]")
    redacted = re.sub(
        r"(?i)(api[-_ ]?subscription[-_ ]?key\s*[:=]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        redacted,
    )
    redacted = re.sub(
        r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+",
        r"\1[REDACTED]",
        redacted,
    )
    return redacted


def _sarvam_provider_error_detail(response: requests.Response, label: str) -> str:
    message = ""
    try:
        payload = response.json()
    except ValueError:
        payload = None

    if isinstance(payload, dict):
        error_payload = payload.get("error") if isinstance(payload.get("error"), dict) else payload
        message = str(
            error_payload.get("message")
            or error_payload.get("detail")
            or error_payload.get("error")
            or ""
        ).strip()

    if not message:
        message = str(getattr(response, "text", "") or "").strip()

    message = _redact_sarvam_provider_message(message)

    if len(message) > 300:
        message = f"{message[:300]}..."

    return f"{label} returned {response.status_code}{f': {message}' if message else ''}"


def _extract_sarvam_transcript(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()

    if not isinstance(payload, dict):
        return ""

    for key in ("transcript", "text", "transcript_text", "output_text"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    for key in ("results", "transcripts"):
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        parts: List[str] = []
        for value in values:
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
            elif isinstance(value, dict):
                text = _extract_sarvam_transcript(value)
                if text:
                    parts.append(text)
        if parts:
            return " ".join(parts).strip()

    return ""


def _transcribe_audio_file(
    file_path: str,
    language: Optional[str] = None,
    *,
    content_type: Optional[str] = None,
    filename: Optional[str] = None,
) -> str:
    return _get_sarvam_provider().stt_file(
        file_path,
        language,
        content_type=content_type,
        filename=filename,
    )


def _invoke_transcribe_audio_file(
    file_path: str,
    language: Optional[str] = None,
    *,
    content_type: Optional[str] = None,
    filename: Optional[str] = None,
) -> str:
    try:
        return _transcribe_audio_file(
            file_path,
            language,
            content_type=content_type,
            filename=filename,
        )
    except TypeError as exc:
        if "unexpected keyword argument" not in str(exc):
            raise
        return _transcribe_audio_file(file_path, language)


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


def _build_global_cache_pipeline_result(hit: Dict[str, Any]) -> Dict[str, Any]:
    answer = str(hit.get("answer") or "").strip()
    language = _normalize_reply_language(hit.get("answer_language") or "en")
    result = _build_pipeline_result(
        raw_english=answer,
        remodeled_english=answer,
        tamil_text=answer if language == "ta" else "",
        theni_tamil_text=answer if language == "ta" else "",
        route_taken="global_knowledge_cache",
        direct_answer_source="global_qa_cache",
        direct_answer_confidence=f"{float(hit.get('similarity_score') or hit.get('confidence') or 0.0):.4f}",
        predicted_label="global_knowledge",
        risk_level="low",
        stage_notes=["Answered from approved global repeated-question knowledge."],
        core_meta={
            "source": "global_qa_cache",
            "global_cache_id": hit.get("id"),
            "answer_hash": hit.get("answer_hash"),
            "topic": hit.get("topic"),
        },
        timings_ms={"total_ms": 0.0},
        cache_hit="true",
    )
    result["model_used"] = None
    result["model_tier"] = None
    result["model_reason"] = "global_cache_hit"
    return result


def _static_general_answer_pipeline_result(message: str) -> Optional[Dict[str, Any]]:
    normalized = _normalize_lookup_text(message)
    answers: Dict[str, tuple[str, str]] = {
        "do you know about ipl": (
            "Yes. The IPL, or Indian Premier League, is a professional Twenty20 cricket league in India with city-based franchise teams. It is known for short-format matches, auctions, playoffs, and a mix of Indian and international players.",
            "ipl_general",
        ),
        "tell me about indian premier league": (
            "The Indian Premier League is India's major franchise-based Twenty20 cricket league. Teams represent different cities or regions, matches are short and high-scoring, and the tournament usually includes a league stage followed by playoffs.",
            "ipl_general",
        ),
        "what is photosynthesis": (
            "Photosynthesis is the process plants use to make food. They use sunlight, carbon dioxide from the air, and water from the soil to produce glucose, and they release oxygen as a by-product.",
            "science_general",
        ),
        "explain quantum computing in simple words": (
            "Quantum computing is a different way of computing that uses qubits instead of normal bits. A normal bit is 0 or 1; a qubit can represent a richer state, which lets quantum computers explore some kinds of problems in special ways.",
            "science_general",
        ),
        "write a short email asking for a meeting": (
            "Subject: Meeting Request\n\nHi,\n\nI hope you are doing well. Could we schedule a short meeting this week to discuss this further? Please let me know a time that works for you.\n\nBest regards,",
            "writing",
        ),
        "give me 5 birthday gift ideas for my brother": (
            "1. Wireless earbuds\n2. A good backpack or laptop bag\n3. A book in a genre he likes\n4. A smartwatch or fitness band\n5. A personalized wallet or keychain",
            "ideas",
        ),
        "what is a compiler": (
            "A compiler is a program that translates source code written by a programmer into machine code, bytecode, or another executable form that a computer can run.",
            "computing_general",
        ),
        "explain black holes simply": (
            "A black hole is a region in space where gravity is so strong that even light cannot escape after it crosses the boundary called the event horizon. They usually form when very massive stars collapse.",
            "science_general",
        ),
        "summarize why the sky is blue": (
            "The sky looks blue because sunlight is scattered by tiny molecules in Earth's atmosphere. Shorter blue wavelengths scatter more than longer red wavelengths, a process often called Rayleigh scattering.",
            "science_general",
        ),
        "what is fistula": (
            "A fistula is an abnormal tunnel or connection between two body parts, such as between organs or from an organ to the skin. It can have different causes, so it is best to consult a clinician for diagnosis and treatment options.",
            "medical_general",
        ),
    }
    entry = answers.get(normalized)
    if entry is None:
        return None
    answer, label = entry
    return _build_pipeline_result(
        raw_english=answer,
        remodeled_english=answer,
        route_taken="static_general_answer",
        direct_answer_source="static_smoke_knowledge",
        direct_answer_confidence="0.9900",
        predicted_label=label,
        risk_level="low",
        stage_notes=["Answered from deterministic backend knowledge without calling OpenAI."],
        timings_ms={"total_ms": 0.0},
    )


def _is_openai_unavailable_exception(exc: BaseException) -> bool:
    if _openai_provider_http_exception(exc) is not None:
        return True
    if isinstance(exc, HTTPException) and int(exc.status_code) in {502, 503, 504}:
        detail = str(exc.detail or "")
        return "OPENAI_API_KEY" in detail or "OpenAI" in detail or "Model" in detail
    return False


def _is_backend_openai_pipeline(pipeline: Dict[str, Any]) -> bool:
    route_taken = str(pipeline.get("route_taken") or "").lower()
    direct_source = str(pipeline.get("direct_answer_source") or "").lower()
    return (
        route_taken in {"full_pipeline", "full_rewrite"}
        or "openai" in direct_source
        or str(pipeline.get("model_used") or "").strip() != ""
    )


def _record_backend_openai_side_effects(
    session: Session,
    *,
    user_id: Optional[int],
    question: str,
    pipeline_result: Dict[str, Any],
    answer: str,
    request_id: Optional[str],
) -> None:
    if not _is_backend_openai_pipeline(pipeline_result):
        return
    model_used = str(pipeline_result.get("model_used") or "").strip()
    model_tier = str(pipeline_result.get("model_tier") or "").strip()
    model_reason = str(pipeline_result.get("model_reason") or "").strip()
    if not model_used:
        selection = OpenAIModelRouter().select_model("normal_qa", question)
        model_used = selection.model
        model_tier = selection.tier
        model_reason = selection.reason
        estimated_input_tokens = selection.estimated_input_tokens
        estimated_output_tokens = selection.estimated_output_tokens
        estimated_cost_usd = selection.estimated_cost_usd
    else:
        router = OpenAIModelRouter()
        estimated_input_tokens = router.estimate_tokens(question)
        estimated_output_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS_DEFAULT", "900") or 900)
        estimated_cost_usd = router.estimate_cost(model_used, estimated_input_tokens, estimated_output_tokens)

    if not bool(pipeline_result.get("openai_usage_tracked")):
        record_openai_usage(
            session,
            user_id=user_id,
            request_id=request_id,
            route=str(pipeline_result.get("route_taken") or "api_chat"),
            model_used=model_used,
            model_tier=model_tier or "standard",
            reason=model_reason or "backend_openai_pipeline",
            estimated_input_tokens=estimated_input_tokens,
            estimated_output_tokens=estimated_output_tokens,
            estimated_cost_usd=estimated_cost_usd,
            cache_hit=False,
        )
    record_backend_openai_answer(
        session,
        user_id,
        question,
        answer,
        model_used,
        request_id=request_id,
    )


def _record_stage_timing(stage_timings: Dict[str, Any], label: str, started_at: float) -> None:
    stage_timings[label] = round((time.perf_counter() - started_at) * 1000, 2)


def _log_backend_workflow_step(
    event: str,
    *,
    user_id: Optional[int],
    question: Optional[str] = None,
    stage_timings: Optional[Dict[str, Any]] = None,
    **extra_fields: Any,
) -> None:
    logger.info(
        event,
        extra=chat_log_payload(
            event=event,
            user_id=user_id,
            request_id=get_request_id(),
            question=question,
            stage_timings=stage_timings or None,
            **extra_fields,
        ),
    )


def _handle_routing_fast_exit(
    session: Session,
    payload: ChatAPIRequest,
    text: str,
    routing: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    intent = str(routing.get("intent") or "GENERAL").upper()
    priority = str(routing.get("priority") or "low")
    confidence = float(routing.get("confidence") or 0.0)
    matched_keyword = str(routing.get("matched_keyword") or "")

    if intent == "EMERGENCY":
        res = "🚨 EMERGENCY DETECTED: Please stay safe and contact emergency services (112) immediately."
        return _build_direct_answer_pipeline_result(
            res,
            "EMERGENCY",
            "orchestrator_emergency",
            priority,
            confidence,
            matched_keyword,
        )

    if intent == "AMBIGUOUS":
        res = routing.get("clarification_question") or "Could you share a bit more so I can assist you better?"
        return _build_direct_answer_pipeline_result(
            res,
            "AMBIGUOUS",
            "orchestrator_clarification",
            priority,
            confidence,
            matched_keyword,
        )

    if intent in {"GREETING", "SMALLTALK", "PROFILE", "IDENTITY"}:
        tl_fast_res = _try_local_fast_path(session, payload.user_id, text)
        if tl_fast_res:
            return tl_fast_res

    return None


_FAST_FALLBACK_CURRENT_DATA_RE = re.compile(
    r"\b("
    r"latest|current|live|breaking|today|tonight|tomorrow|yesterday|now|"
    r"news|score|scores|weather|forecast|rain|temperature|stock|price|"
    r"election|result|results|fixture|schedule\s+today|standings"
    r")\b",
    re.IGNORECASE,
)
_FAST_FALLBACK_TOOL_RE = re.compile(
    r"\b(remind|reminder|calendar|appointment|todo|to\s+do|task|schedule|alarm)\b",
    re.IGNORECASE,
)
_FAST_FALLBACK_HIGH_RISK_RE = re.compile(
    r"\b("
    r"emergency|suicide|self\s*harm|kill myself|hurt myself|chest pain|"
    r"bleeding|cannot breathe|can't breathe|doctor|medical|medicine|"
    r"symptom|diagnosis|treatment|prescription|dosage|legal|lawyer|"
    r"lawsuit|contract|tax|financial advice|investment|loan|insurance|"
    r"bank account|credit card"
    r")\b",
    re.IGNORECASE,
)
_FAST_FALLBACK_PRIVATE_RE = re.compile(
    r"\b("
    r"my name|who am i|where do i live|my profile|my memory|remember|"
    r"what do you know about me|my routine|my goal|my address|my phone|"
    r"my email|my password|my salary|my bank"
    r")\b",
    re.IGNORECASE,
)


def _is_backend_fast_fallback_candidate(payload: ChatAPIRequest, text: str, routing: Dict[str, Any]) -> bool:
    if str(payload.client_fallback_reason or "").strip().lower() != "local_timeout":
        return False
    if str(routing.get("intent") or "").strip().upper() != "GENERAL":
        return False
    normalized = _normalize_lookup_text(text)
    if not normalized:
        return False
    for pattern in (
        _FAST_FALLBACK_CURRENT_DATA_RE,
        _FAST_FALLBACK_TOOL_RE,
        _FAST_FALLBACK_HIGH_RISK_RE,
        _FAST_FALLBACK_PRIVATE_RE,
    ):
        if pattern.search(normalized):
            return False
    return True


def _run_backend_fast_fallback(
    session: Session,
    payload: ChatAPIRequest,
    text: str,
    stage_timings: Dict[str, Any],
) -> Dict[str, Any]:
    reply_language = _normalize_reply_language(payload.reply_language)
    language_instruction = (
        "Answer directly in Tamil. Do not translate through a second step."
        if reply_language == "ta"
        else "Answer directly in English."
    )
    started = time.perf_counter()
    _log_backend_workflow_step(
        "backend_fast_fallback_started",
        user_id=payload.user_id,
        question=text,
        workflow_step="backend_fast_fallback",
        workflow_phase="started",
        client_fallback_reason=payload.client_fallback_reason,
        client_local_budget_ms=payload.client_local_budget_ms,
        client_original_route=payload.client_original_route,
        fallback_reason=payload.client_fallback_reason,
        original_route=payload.client_original_route,
        stage_timings=stage_timings,
    )
    try:
        response = tracked_chat_completion(
            _get_openai_client(),
            task="normal_qa",
            route="backend_fast_fallback",
            session=session,
            user_id=payload.user_id,
            request_id=payload.request_id or get_request_id(),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a concise, helpful assistant. The phone-local model timed out, "
                        "so answer the user's ordinary general question in one direct response. "
                        "Do not claim access to live or current data."
                    ),
                },
                {
                    "role": "user",
                    "content": f"{language_instruction}\n\nUser question: {text}",
                },
            ],
            temperature=0.3,
            max_tokens=700,
        )
    except OpenAIBudgetExceededError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    answer = _extract_response_text(response) or "I could not produce an answer in time. Please try again."
    metadata = get_tracked_chat_completion_metadata(response)
    _record_stage_timing(stage_timings, "backend_fast_fallback", started)
    _log_backend_workflow_step(
        "backend_fast_fallback_completed",
        user_id=payload.user_id,
        question=text,
        answer=answer,
        workflow_step="backend_fast_fallback",
        workflow_phase="completed",
        route_taken="backend_fast_fallback",
        agent_source="backend_openai",
        fallback_reason=payload.client_fallback_reason,
        model_used=metadata.get("model_used"),
        model_tier=metadata.get("model_tier"),
        duration_ms=stage_timings.get("backend_fast_fallback"),
        stage_timings=stage_timings,
    )
    result = _build_pipeline_result(
        raw_english=answer if reply_language == "en" else "",
        remodeled_english=answer if reply_language == "en" else "",
        tamil_text=answer if reply_language == "ta" else "",
        theni_tamil_text=answer if reply_language == "ta" else "",
        route_taken="backend_fast_fallback",
        direct_answer_source="backend_openai_fast_fallback",
        direct_answer_confidence="1.0000",
        predicted_label="general_qa",
        risk_level="low",
        stage_notes=["Answered through one tracked backend OpenAI fast-fallback call after local timeout."],
        core_meta={
            "source": "backend_openai_fast_fallback",
            "fallback_reason": payload.client_fallback_reason,
            "client_original_route": payload.client_original_route,
            **metadata,
        },
        timings_ms={"backend_fast_fallback": stage_timings.get("backend_fast_fallback", 0.0)},
    )
    result["fallback_reason"] = payload.client_fallback_reason
    result["client_fallback_reason"] = payload.client_fallback_reason
    result["client_original_route"] = payload.client_original_route
    if payload.client_local_budget_ms is not None:
        result["client_local_budget_ms"] = payload.client_local_budget_ms
    if metadata.get("model_used"):
        result["model_used"] = metadata.get("model_used")
        result["model_tier"] = metadata.get("model_tier")
        result["model_reason"] = metadata.get("reason")
        result["openai_usage_tracked"] = True
    return result


def _run_chat_logic(
    session: Session,
    payload: ChatAPIRequest,
    text: str,
    stage_timings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    stage_timings = stage_timings if stage_timings is not None else {}
    _log_backend_workflow_step(
        "backend_rule_orchestrator_started",
        user_id=payload.user_id,
        question=text,
        workflow_step="rule_orchestrator",
        workflow_phase="started",
        stage_timings=stage_timings,
    )
    started = time.perf_counter()
    routing = run_rule_orchestrator(text)
    _record_stage_timing(stage_timings, "rule_orchestrator", started)
    _log_backend_workflow_step(
        "backend_rule_orchestrator_completed",
        user_id=payload.user_id,
        question=text,
        workflow_step="rule_orchestrator",
        workflow_phase="completed",
        decision=str(routing.get("intent") or ""),
        route_taken=str(routing.get("intent") or ""),
        duration_ms=stage_timings.get("rule_orchestrator"),
        stage_timings=stage_timings,
    )
    fast_result = _handle_routing_fast_exit(session, payload, text, routing)
    if fast_result is not None:
        return fast_result
    if _is_backend_fast_fallback_candidate(payload, text, routing):
        return _run_backend_fast_fallback(session, payload, text, stage_timings)

    _log_backend_workflow_step(
        "backend_global_cache_lookup_started",
        user_id=payload.user_id,
        question=text,
        workflow_step="global_cache_lookup",
        workflow_phase="started",
        stage_timings=stage_timings,
    )
    started = time.perf_counter()
    try:
        global_hit = lookup_approved_global_cache(session, text, payload.reply_language)
    except (ProgrammingError, OperationalError) as exc:
        session.rollback()
        _record_stage_timing(stage_timings, "global_cache_lookup", started)
        _log_backend_workflow_step(
            "backend_global_cache_error",
            user_id=payload.user_id,
            question=text,
            workflow_step="global_cache_lookup",
            workflow_phase="failed",
            error_type=exc.__class__.__name__,
            error_message=sanitize_log_text(str(exc), 240),
            db_schema_ready=False,
            duration_ms=stage_timings.get("global_cache_lookup"),
            stage_timings=stage_timings,
        )
        global_hit = None
    else:
        _record_stage_timing(stage_timings, "global_cache_lookup", started)
    if global_hit is not None:
        _log_backend_workflow_step(
            "backend_global_cache_hit",
            user_id=payload.user_id,
            question=text,
            workflow_step="global_cache_lookup",
            workflow_phase="completed",
            cache_hit=True,
            cache_source="global_qa_cache",
            duration_ms=stage_timings.get("global_cache_lookup"),
            stage_timings=stage_timings,
        )
        return _build_global_cache_pipeline_result(global_hit)
    _log_backend_workflow_step(
        "backend_global_cache_miss",
        user_id=payload.user_id,
        question=text,
        workflow_step="global_cache_lookup",
        workflow_phase="completed",
        cache_hit=False,
        cache_source="global_qa_cache",
        duration_ms=stage_timings.get("global_cache_lookup"),
        stage_timings=stage_timings,
    )

    static_result = _static_general_answer_pipeline_result(text)
    if static_result is not None and static_result.get("predicted_label") == "ipl_general":
        _log_backend_workflow_step(
            "backend_static_general_answer",
            user_id=payload.user_id,
            question=text,
            workflow_step="static_general_answer",
            workflow_phase="completed",
            route_taken=static_result.get("route_taken"),
            direct_answer_source=static_result.get("direct_answer_source"),
            stage_timings=stage_timings,
        )
        return static_result

    _log_backend_workflow_step(
        "backend_full_orchestrator_started",
        user_id=payload.user_id,
        question=text,
        workflow_step="full_orchestrator",
        workflow_phase="started",
        stage_timings=stage_timings,
    )
    started = time.perf_counter()
    routing = run_orchestrator(_get_openai_client(required=False), text)
    _record_stage_timing(stage_timings, "full_orchestrator", started)
    _log_backend_workflow_step(
        "backend_full_orchestrator_completed",
        user_id=payload.user_id,
        question=text,
        workflow_step="full_orchestrator",
        workflow_phase="completed",
        decision=str(routing.get("intent") or ""),
        duration_ms=stage_timings.get("full_orchestrator"),
        stage_timings=stage_timings,
    )
    fast_result = _handle_routing_fast_exit(session, payload, text, routing)
    if fast_result is not None:
        return fast_result

    _log_backend_workflow_step(
        "backend_openai_fallback_started",
        user_id=payload.user_id,
        question=text,
        workflow_step="openai_fallback",
        workflow_phase="started",
        client_fallback_reason=payload.client_fallback_reason,
        client_local_budget_ms=payload.client_local_budget_ms,
        client_original_route=payload.client_original_route,
        fallback_reason=payload.client_fallback_reason,
        original_route=payload.client_original_route,
        stage_timings=stage_timings,
    )
    started = time.perf_counter()
    try:
        result = _run_agentic_or_pipeline(session, payload.user_id, text, payload.reply_language)
    except Exception as exc:
        static_result = _static_general_answer_pipeline_result(text)
        if static_result is not None and _is_openai_unavailable_exception(exc):
            _record_stage_timing(stage_timings, "openai_fallback", started)
            _log_backend_workflow_step(
                "backend_static_general_answer",
                user_id=payload.user_id,
                question=text,
                workflow_step="static_general_answer",
                workflow_phase="completed",
                route_taken=static_result.get("route_taken"),
                direct_answer_source=static_result.get("direct_answer_source"),
                safe_error_type=_safe_error_type(exc),
                duration_ms=stage_timings.get("openai_fallback"),
                stage_timings=stage_timings,
            )
            return static_result
        raise
    _record_stage_timing(stage_timings, "openai_fallback", started)
    _log_backend_workflow_step(
        "backend_openai_fallback_completed",
        user_id=payload.user_id,
        question=text,
        workflow_step="openai_fallback",
        workflow_phase="completed",
        route_taken=result.get("route_taken"),
        model_used=result.get("model_used"),
        model_tier=result.get("model_tier"),
        duration_ms=stage_timings.get("openai_fallback"),
        stage_timings=stage_timings,
    )
    return result


def _metadata_for_ai_response(text: str, response: AIProviderResponse) -> Dict[str, Any]:
    if isinstance(response.raw, dict) and isinstance(response.raw.get("item_metadata"), dict):
        return dict(response.raw["item_metadata"])
    clean_text = " ".join(str(text or "").strip().split())
    intent = "assistant"
    if response.intent in {"reminder", "routine", "profile", "settings"}:
        intent = response.intent
    return {
        "intent": intent,
        "category": "Other",
        "datetime": None,
        "title": (clean_text[:60] + "...") if len(clean_text) > 60 else clean_text or "Chat",
        "details": response.text,
    }


def _run_ai_router_chat_request(session: Session, payload: ChatAPIRequest) -> Dict[str, Any]:
    text = _resolve_chat_text(payload)
    request_id = payload.request_id or get_request_id()
    context_turns = _recent_ai_context_turns(session, payload.user_id, limit=6)
    profile_context = build_profile_prompt_context(session, payload.user_id)
    profile_prompt_context = _profile_prompt_context_text(profile_context)
    ai_response = run_text_turn(
        session,
        AIRequest(
            user_id=payload.user_id,
            message=text,
            reply_language=payload.reply_language,
            channel="text",
            request_id=request_id,
            metadata={
                "admin_email": getattr(payload, "admin_email", None),
                "client_fallback_reason": payload.client_fallback_reason,
                "client_local_budget_ms": payload.client_local_budget_ms,
                "client_original_route": payload.client_original_route,
                "context_turn_count": len(context_turns),
                "profile_context": profile_context,
                "profile_prompt_context": profile_prompt_context,
            },
            context_turns=context_turns,
        ),
        existing_context={
            "local_rag_service": LOCAL_RAG_SERVICE,
            "sarvam_provider": _get_sarvam_provider(),
        },
    )
    pipeline_result = ai_response_to_pipeline(ai_response)
    item, meta, normalized_pipeline = _save_item_from_pipeline(
        session,
        user_id=payload.user_id,
        source="text",
        raw_text=text,
        transcript=None,
        pipeline_result=pipeline_result,
        reply_language=payload.reply_language,
        metadata_override=_metadata_for_ai_response(text, ai_response),
        skip_expensive_side_effects=True,
    )
    response = _build_chat_response(item, meta, normalized_pipeline)
    response_meta = response.get("meta") if isinstance(response, dict) else {}
    if isinstance(response_meta, dict):
        response_meta.setdefault("request_id", request_id)
        response_meta.setdefault("route", ai_response.route)
        response_meta.setdefault("source", ai_response.provider)
        response_meta.setdefault("provider", ai_response.provider)
        response_meta.setdefault("model_used", ai_response.model)
        response_meta.setdefault("model_tier", normalized_pipeline.get("model_tier"))
        if isinstance(ai_response.raw, dict):
            response_meta.setdefault("model_candidates", ai_response.raw.get("model_candidates") or [])
            response_meta.setdefault("endpoint", ai_response.raw.get("endpoint") or "")
            response_meta.setdefault("openai_attempted_models", ai_response.raw.get("openai_attempted_models") or ai_response.raw.get("attempted_models") or [])
            response_meta.setdefault("fallback_attempted", bool(ai_response.raw.get("fallback_attempted")))
            response_meta.setdefault("primary_model_candidate", ai_response.raw.get("primary_model_candidate") or "")
            response_meta.setdefault("selected_model_reason", ai_response.raw.get("selected_model_reason") or "")
            response_meta.setdefault("skipped_models", ai_response.raw.get("skipped_models") or [])
            response_meta.setdefault("model_health_skip_reason", ai_response.raw.get("model_health_skip_reason") or "")
            if ai_response.raw.get("fallback_reason"):
                response_meta.setdefault("fallback_reason", ai_response.raw.get("fallback_reason"))
            if ai_response.raw.get("provider_error_type"):
                response_meta.setdefault("provider_error_type", ai_response.raw.get("provider_error_type"))
            response_meta.setdefault("embedding_calls", int(ai_response.raw.get("embedding_calls") or 0))
        response_meta.setdefault("ai_router_enabled", True)
        response_meta.setdefault("context_turn_count", len(context_turns))
        response_meta.setdefault("cost_estimate", ai_response.estimated_cost_amount)
        response_meta.setdefault("cost_currency", ai_response.estimated_cost_currency)
        if payload.client_fallback_reason:
            response_meta.setdefault("fallback_reason", payload.client_fallback_reason)
            response_meta.setdefault("client_fallback_reason", payload.client_fallback_reason)
        if payload.client_local_budget_ms is not None:
            response_meta.setdefault("client_local_budget_ms", payload.client_local_budget_ms)
        if payload.client_original_route:
            response_meta.setdefault("original_route", payload.client_original_route)
            response_meta.setdefault("client_original_route", payload.client_original_route)
    return response


def _run_chat_request(session: Session, payload: ChatAPIRequest) -> Dict[str, Any]:
    if _ai_router_enabled():
        return _run_ai_router_chat_request(session, payload)
    if not _legacy_pipeline_enabled():
        raise HTTPException(503, "AI router is disabled and the legacy pipeline is not enabled.")

    text = _resolve_chat_text(payload)
    stage_timings: Dict[str, Any] = {}
    pipeline_result = _run_chat_logic(session, payload, text, stage_timings)
    is_fast_backend_fallback = (
        str(pipeline_result.get("route_taken") or "") == "backend_fast_fallback"
    )
    fast_answer = str(
        pipeline_result.get("theni_tamil_text")
        or pipeline_result.get("tamil_text")
        or pipeline_result.get("remodeled_english")
        or pipeline_result.get("raw_english")
        or ""
    ).strip()
    item, meta, normalized_pipeline = _save_item_from_pipeline(
        session,
        user_id=payload.user_id,
        source="text",
        raw_text=text,
        transcript=None,
        pipeline_result=pipeline_result,
        reply_language=payload.reply_language,
        metadata_override=(
            _fast_fallback_metadata_for_item(text, fast_answer)
            if is_fast_backend_fallback
            else None
        ),
        skip_expensive_side_effects=is_fast_backend_fallback,
    )
    if not is_fast_backend_fallback:
        try:
            _record_backend_openai_side_effects(
                session,
                user_id=payload.user_id,
                question=text,
                pipeline_result=normalized_pipeline,
                answer=str(normalized_pipeline.get("remodeled_english") or item.details or ""),
                request_id=payload.request_id or get_request_id(),
            )
        except Exception:
            session.rollback()
            logger.exception(
                "OpenAI/global-cache side effects failed",
                extra={"user_id": payload.user_id, "request_id": payload.request_id or get_request_id()},
            )
    response = _build_chat_response(item, meta, normalized_pipeline)
    response_meta = response.get("meta") if isinstance(response, dict) else {}
    if isinstance(response_meta, dict):
        response_meta.setdefault("request_id", payload.request_id or get_request_id())
        response_meta.setdefault("route", normalized_pipeline.get("route_taken"))
        response_meta.setdefault("source", _backend_agent_source(normalized_pipeline))
        response_meta.setdefault("model_used", normalized_pipeline.get("model_used"))
        response_meta.setdefault("model_tier", normalized_pipeline.get("model_tier"))
        response_meta.setdefault("stageTimings", stage_timings)
        response_meta.setdefault("stage_timings", stage_timings)
        if payload.client_fallback_reason:
            response_meta.setdefault("fallback_reason", payload.client_fallback_reason)
            response_meta.setdefault("client_fallback_reason", payload.client_fallback_reason)
        if payload.client_local_budget_ms is not None:
            response_meta.setdefault("client_local_budget_ms", payload.client_local_budget_ms)
        if payload.client_original_route:
            response_meta.setdefault("original_route", payload.client_original_route)
            response_meta.setdefault("client_original_route", payload.client_original_route)
    _log_backend_workflow_step(
        "backend_chat_response_ready",
        user_id=payload.user_id,
        question=text,
        answer=str(normalized_pipeline.get("remodeled_english") or item.details or ""),
        workflow_step="chat_response",
        workflow_phase="completed",
        route_taken=normalized_pipeline.get("route_taken"),
        agent_source=_backend_agent_source(normalized_pipeline),
        cache_hit=normalized_pipeline.get("cache_hit") == "true",
        model_used=normalized_pipeline.get("model_used"),
        model_tier=normalized_pipeline.get("model_tier"),
        stage_timings=stage_timings,
    )
    return response


@app.post("/api/client/turn-log")
def api_client_turn_log(
    payload: ClientTurnLogRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    if payload.user_id is not None:
        assert_owner(int(payload.user_id), user)

    if not CLIENT_TURN_LOGS_ENABLED:
        return {"ok": True, "skipped": True}

    event = sanitize_log_text(payload.event, 80) or "client_turn_log"
    set_request_context(
        request_id=payload.request_id or get_request_id() or new_request_id(),
        route="/api/client/turn-log",
        user_id=str(user.id),
    )
    logger.info(
        event,
        extra=chat_log_payload(
            event=event,
            user_id=int(user.id),
            request_id=payload.request_id,
            turn_id=payload.turn_id,
            channel=payload.channel or "text",
            question_hash=payload.question_hash,
            question=payload.question,
            answer=payload.answer,
            question_length=payload.question_length,
            answer_length=payload.answer_length,
            agent_source=payload.agent_source,
            route_taken=payload.route_taken,
            fallback_reason=payload.fallback_reason,
            duration_ms=payload.duration_ms,
            local_duration_ms=payload.local_duration_ms,
            backend_duration_ms=payload.backend_duration_ms,
            total_duration_ms=payload.total_duration_ms,
            stage_timings=payload.stage_timings,
            workflow_step=payload.workflow_step,
            workflow_phase=payload.workflow_phase,
            step_index=payload.step_index,
            decision=payload.decision,
            cache_hit=payload.cache_hit,
            cache_source=payload.cache_source,
            global_sync_status=payload.global_sync_status,
            http_status=payload.http_status,
            error_name=payload.error_name,
            error_message=payload.error_message,
            model_used=payload.model_used,
            model_tier=payload.model_tier,
            native_backend=payload.native_backend,
            local_runtime_mode=payload.local_runtime_mode,
            db_schema_ready=payload.db_schema_ready,
            screen=payload.screen,
            app_state=payload.app_state,
            sync_id=payload.sync_id,
            page=payload.page,
            limit=payload.limit,
            since=payload.since,
            after_id=payload.after_id,
            missing_tables=payload.missing_tables,
            last_step=payload.last_step,
            started_at=payload.started_at,
            error_type=payload.error_type,
            app_version=payload.app_version,
            api_base=payload.api_base,
            build_number=payload.build_number,
            mobile_build_id=payload.mobile_build_id,
            mobile_git_sha=payload.mobile_git_sha,
            local_to_backend_fallback_ms=payload.local_to_backend_fallback_ms,
            cloud_fallback_enabled=payload.cloud_fallback_enabled,
            created_at=payload.created_at,
            provider=payload.provider,
            voice_phase=payload.voice_phase,
            telemetry_delivery=payload.telemetry_delivery,
            file_size=payload.file_size,
            mime_type=payload.mime_type,
            chat_routing=payload.chat_routing,
            voice_routing=payload.voice_routing,
            native_safety_status=payload.native_safety_status,
        ),
    )
    if CHAT_TURN_SUMMARY_LOGS_ENABLED:
        logger.info(
            "client_turn_summary",
            extra=build_turn_summary_payload(
                event="client_turn_summary",
                client_event=event,
                user_id=int(user.id),
                request_id=payload.request_id,
                turn_id=payload.turn_id,
                channel=payload.channel or "text",
                question_hash=payload.question_hash,
                question=payload.question,
                answer=payload.answer,
                question_length=payload.question_length,
                answer_length=payload.answer_length,
                agent_source=payload.agent_source,
                route_taken=payload.route_taken,
                fallback_reason=payload.fallback_reason,
                duration_ms=payload.duration_ms,
                local_duration_ms=payload.local_duration_ms,
                backend_duration_ms=payload.backend_duration_ms,
                total_duration_ms=payload.total_duration_ms,
                stage_timings=payload.stage_timings,
                workflow_step=payload.workflow_step,
                workflow_phase=payload.workflow_phase,
                step_index=payload.step_index,
                decision=payload.decision,
                cache_hit=payload.cache_hit,
                cache_source=payload.cache_source,
                global_sync_status=payload.global_sync_status,
                http_status=payload.http_status,
                error_name=payload.error_name,
                error_message=payload.error_message,
                model_used=payload.model_used,
                model_tier=payload.model_tier,
                native_backend=payload.native_backend,
                local_runtime_mode=payload.local_runtime_mode,
                db_schema_ready=payload.db_schema_ready,
                screen=payload.screen,
                app_state=payload.app_state,
                sync_id=payload.sync_id,
                page=payload.page,
                limit=payload.limit,
                since=payload.since,
                after_id=payload.after_id,
                missing_tables=payload.missing_tables,
                last_step=payload.last_step,
                started_at=payload.started_at,
                error_type=payload.error_type,
                app_version=payload.app_version,
                api_base=payload.api_base,
                build_number=payload.build_number,
                mobile_build_id=payload.mobile_build_id,
                mobile_git_sha=payload.mobile_git_sha,
                local_to_backend_fallback_ms=payload.local_to_backend_fallback_ms,
                cloud_fallback_enabled=payload.cloud_fallback_enabled,
                created_at=payload.created_at,
                provider=payload.provider,
                voice_phase=payload.voice_phase,
                telemetry_delivery="received",
                file_size=payload.file_size,
                mime_type=payload.mime_type,
                chat_routing=payload.chat_routing,
                voice_routing=payload.voice_routing,
                native_safety_status=payload.native_safety_status,
            ),
        )
    return {"ok": True}


@app.get("/api/debug/observability")
def api_debug_observability(
    auth_user: AuthUser = Depends(get_current_user),
):
    return _observability_config_payload()


def _alembic_revision_status(session: Session) -> Dict[str, Any]:
    try:
        from alembic.config import Config
        from alembic.runtime.migration import MigrationContext
        from alembic.script import ScriptDirectory

        config = Config(str(BACKEND_ROOT / "alembic.ini"))
        script = ScriptDirectory.from_config(config)
        context = MigrationContext.configure(session.get_bind())
        current = context.get_current_revision()
        return {
            "current": current,
            "head": script.get_current_head(),
            "ok": bool(current and current == script.get_current_head()),
        }
    except Exception as exc:
        return {
            "current": None,
            "head": None,
            "ok": False,
            "error": sanitize_log_text(str(exc), 160),
        }


def _backend_release_sha() -> str:
    for name in ("APP_RELEASE_SHA", "RENDER_GIT_COMMIT", "GIT_SHA", "SOURCE_VERSION"):
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    release = str(APP_RELEASE or "").strip()
    if release and release != "dev":
        return release
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=BACKEND_ROOT.parent,
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
        value = str(result.stdout or "").strip()
        if result.returncode == 0 and value:
            return value
    except Exception:
        pass
    return "dev"


def _active_model_routing_config() -> Dict[str, Any]:
    try:
        router = OpenAIModelRouter()
        return {
            "openai_models": dict(router.models),
            "max_output_default": router.max_output_default,
            "max_output_hard": router.max_output_hard,
            "disabled_models": sorted(router.disabled_models),
            "sarvam_chat_model": os.getenv("SARVAM_CHAT_MODEL", "sarvam-30b") or "sarvam-30b",
            "sarvam_reasoning_model": os.getenv("SARVAM_CHAT_MODEL_REASONING", "sarvam-105b") or "sarvam-105b",
            "sarvam_stt_model": os.getenv("SARVAM_STT_MODEL", "saaras:v3") or "saaras:v3",
            "default_speech_language": DEFAULT_SPEECH_LANGUAGE,
            "default_reply_language": DEFAULT_REPLY_LANGUAGE,
        }
    except Exception as exc:
        return {"error": sanitize_log_text(str(exc), 160)}


@app.get("/api/version")
def api_version(session: Session = Depends(get_session)):
    return {
        "ok": True,
        "backend_release_sha": _backend_release_sha(),
        "app_release": APP_RELEASE,
        "release_timestamp": (
            os.getenv("APP_RELEASE_TIMESTAMP")
            or os.getenv("RELEASE_TIMESTAMP")
            or os.getenv("BUILD_TIMESTAMP")
            or ""
        ),
        "alembic": _alembic_revision_status(session),
        "AI_ROUTER_ENABLED": _ai_router_enabled(),
        "AGENTIC_MODE_ENABLED": agentic_mode_enabled(),
        "VOICE_ONLY_PUBLIC_MODE": VOICE_ONLY_PUBLIC_MODE,
        "AI_TEXT_CHAT_ENABLED": AI_TEXT_CHAT_ENABLED,
        "model_routing": _active_model_routing_config(),
        "providers": {
            "sarvam_configured": bool(_sarvam_api_key()),
            "openai_configured": bool(str(os.getenv("OPENAI_API_KEY") or "").strip()),
        },
    }


@app.get("/api/agent/runs/{run_id}")
def api_agent_run(
    run_id: int,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    payload = fetch_agent_run_for_user(session, int(run_id), int(user.id))
    if payload is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return {"ok": True, "run": payload}


@app.get("/api/debug/schema-status")
def api_debug_schema_status(
    session: Session = Depends(get_session),
    _admin_user: Optional[AuthUser] = Depends(require_debug_admin),
):
    readiness = global_qa_schema_ready(session)
    return {
        "ok": bool(readiness.get("ok")),
        "globalQa": {
            "ok": bool(readiness.get("ok")),
            "missingTables": readiness.get("missing_tables") or [],
        },
        "alembic": _alembic_revision_status(session),
    }


def _admin_ai_probe_enabled() -> bool:
    return str(os.getenv("ENABLE_ADMIN_AI_PROBE", "false")).strip().lower() in {"1", "true", "yes", "y", "on"}


@app.get("/api/admin/ai/provider-health")
def api_admin_ai_provider_health(
    _admin_user: Optional[AuthUser] = Depends(require_debug_admin),
):
    if not _admin_ai_probe_enabled():
        raise HTTPException(status_code=403, detail="Admin AI probe is disabled")
    return {"ok": True, "models": model_health_snapshot()}


@app.post("/api/admin/ai/model-probe")
def api_admin_ai_model_probe(
    payload: AIModelProbeRequest,
    session: Session = Depends(get_session),
    _admin_user: Optional[AuthUser] = Depends(require_debug_admin),
):
    if not _admin_ai_probe_enabled():
        raise HTTPException(status_code=403, detail="Admin AI probe is disabled")
    catalog = get_openai_model_catalog()
    requested_models = [str(model or "").strip() for model in (payload.models or []) if str(model or "").strip()]
    models = requested_models or [
        name
        for name, spec in catalog.items()
        if spec.enabled_by_default and (spec.free_user_allowed or not spec.admin_only)
    ]
    client = _get_openai_client()
    rows: list[dict[str, Any]] = []
    for model in models:
        spec = get_model_spec(model)
        clear_model_health("openai", model)
        started = time.perf_counter()
        try:
            response = tracked_openai_generation(
                client,
                messages=[{"role": "user", "content": "Say ok in one short sentence."}],
                input_text="Say ok in one short sentence.",
                instructions="Return a one-sentence health probe answer. Do not include secrets.",
                task="normal_qa",
                route="admin_model_probe",
                candidates=[
                    {
                        "model": model,
                        "tier": spec.tier,
                        "endpoint": spec.endpoint,
                        "reason": "admin_probe",
                        "max_output_tokens": 16,
                    }
                ],
                session=session,
                request_id=get_request_id(),
                max_output_tokens=16,
            )
            metadata = get_tracked_chat_completion_metadata(response)
            rows.append(
                {
                    "provider": "openai",
                    "model": model,
                    "endpoint": metadata.get("endpoint") or spec.endpoint,
                    "ok": True,
                    "error_type": "",
                    "latency_ms": int(round((time.perf_counter() - started) * 1000)),
                }
            )
        except Exception as exc:
            rows.append(
                {
                    "provider": "openai",
                    "model": model,
                    "endpoint": spec.endpoint,
                    "ok": False,
                    "error_type": exc.__class__.__name__,
                    "error_message_sanitized": sanitize_log_text(str(exc), 160),
                    "latency_ms": int(round((time.perf_counter() - started) * 1000)),
                }
            )
    return {"ok": True, "results": rows}


@app.get("/api/debug/global-qa-cache")
def api_debug_global_qa_cache(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    session: Session = Depends(get_session),
    _admin_user: Optional[AuthUser] = Depends(require_debug_admin),
):
    normalized_status = str(status or "").strip().lower()
    if normalized_status and normalized_status not in {"candidate", "approved", "rejected"}:
        raise HTTPException(status_code=400, detail="status must be candidate, approved, or rejected")
    query = select(GlobalQACache).order_by(GlobalQACache.updated_at.desc()).limit(limit)
    if normalized_status:
        query = query.where(GlobalQACache.status == normalized_status)
    rows = list(session.exec(query).all())
    safe_rows = [
        row
        for row in rows
        if str(row.safety_label or "").strip().lower() not in {"private", "personal_high_risk"}
    ]
    return {
        "ok": True,
        "count": len(safe_rows),
        "entries": [
            {
                "id": row.id,
                "canonical_question": row.canonical_question,
                "status": row.status,
                "hit_count": row.hit_count,
                "distinct_user_count": row.distinct_user_count,
                "observed_question_count": row.observed_question_count,
                "confidence": row.confidence,
                "review_notes": row.review_notes,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            }
            for row in safe_rows
        ],
    }


@app.get("/api/global-knowledge/sync")
def api_global_knowledge_sync(
    since: Optional[str] = Query(default=None),
    afterId: Optional[int] = Query(default=None, ge=1),
    limit: int = Query(default=250, ge=1, le=500),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    started = time.perf_counter()
    set_request_context(user_id=str(user.id))
    logger.info(
        "backend_global_sync_requested",
        extra=chat_log_payload(
            event="backend_global_sync_requested",
            user_id=int(user.id),
            request_id=get_request_id(),
            workflow_step="global_knowledge_sync",
            workflow_phase="started",
            since=since,
            after_id=str(afterId) if afterId is not None else None,
            limit=limit,
        ),
    )
    try:
        payload = build_global_knowledge_sync_payload(session, since=since, limit=limit, after_id=afterId)
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        logger.exception(
            "backend_global_sync_failed",
            extra=chat_log_payload(
                event="backend_global_sync_failed",
                user_id=int(user.id),
                request_id=get_request_id(),
                workflow_step="global_knowledge_sync",
                workflow_phase="failed",
                error_type=exc.__class__.__name__,
                error_message=sanitize_log_text(str(exc), 240),
                duration_ms=duration_ms,
                since=since,
                after_id=str(afterId) if afterId is not None else None,
                limit=limit,
            ),
        )
        raise
    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    logger.info(
        "backend_global_sync_completed",
        extra=chat_log_payload(
            event="backend_global_sync_completed",
            user_id=int(user.id),
            request_id=get_request_id(),
            workflow_step="global_knowledge_sync",
            workflow_phase="completed",
            global_sync_status="ok" if payload.get("ok") else str(payload.get("error") or "failed"),
            db_schema_ready=payload.get("schemaReady", True),
            cache_hit=False,
            duration_ms=duration_ms,
            since=since,
            after_id=str(afterId) if afterId is not None else None,
            limit=limit,
            missing_tables=payload.get("missingTables") or [],
        ),
    )
    return payload


@app.post("/api/chat")
def api_chat(
    payload: ChatAPIRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    payload = payload.model_copy(
        update={
            "user_id": int(user.id),
            "reply_language": payload.reply_language or getattr(user, "reply_language", None),
            "admin_email": auth_user.email,
        }
    )
    text = _resolve_chat_text(payload)
    started = time.perf_counter()
    set_request_context(request_id=payload.request_id or get_request_id() or new_request_id(), user_id=str(user.id))
    logger.info(
        "backend_chat_received",
        extra=chat_log_payload(
            event="backend_chat_received",
            user_id=int(user.id),
            request_id=get_request_id(),
            channel="text",
            question=text,
            workflow_step="chat_received",
            workflow_phase="started",
            client_fallback_reason=payload.client_fallback_reason,
            client_local_budget_ms=payload.client_local_budget_ms,
            client_original_route=payload.client_original_route,
            fallback_reason=payload.client_fallback_reason,
            original_route=payload.client_original_route,
        ),
    )
    logger.info(
        "chat_turn_started",
        extra=chat_log_payload(
            event="chat_turn_started",
            user_id=int(user.id),
            request_id=get_request_id(),
            channel="text",
            question=text,
        ),
    )
    try:
        response = _run_chat_request(
            session,
            payload.model_copy(update={"message": text, "text": None}),
        )
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        mapped_openai_exc = _openai_provider_http_exception(exc)
        status_code = (
            mapped_openai_exc.status_code
            if mapped_openai_exc is not None
            else exc.status_code
            if isinstance(exc, HTTPException)
            else getattr(exc, "status_code", 500)
        )
        logger.info(
            "chat_turn_failed",
            extra=chat_log_payload(
                event="chat_turn_failed",
                user_id=int(user.id),
                request_id=get_request_id(),
                channel="text",
                question=text,
                safe_error_type=_safe_error_type(exc),
                status_code=status_code,
                duration_ms=duration_ms,
            ),
        )
        if CHAT_TURN_SUMMARY_LOGS_ENABLED:
            logger.info(
                "chat_turn_summary",
                extra=build_turn_summary_payload(
                    event="chat_turn_summary",
                    user_id=int(user.id),
                    request_id=get_request_id(),
                    channel="text",
                    question=text,
                    route_taken="failed",
                    agent_source="backend_pipeline",
                    safe_error_type=_safe_error_type(exc),
                    status_code=status_code,
                    duration_ms=duration_ms,
                ),
            )
        if isinstance(exc, OpenAIBudgetExceededError):
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        if mapped_openai_exc is not None:
            raise mapped_openai_exc from exc
        raise

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    pipeline = response.get("pipeline") if isinstance(response, dict) else {}
    pipeline = pipeline if isinstance(pipeline, dict) else {}
    meta = response.get("meta") if isinstance(response, dict) else {}
    meta = meta if isinstance(meta, dict) else {}
    answer = ""
    if isinstance(response, dict):
        assistant = response.get("assistant")
        if isinstance(assistant, dict):
            answer = str(assistant.get("text") or assistant.get("english") or "")
        item = response.get("item")
        if not answer and isinstance(item, dict):
            answer = str(item.get("details") or "")
    logger.info(
        "chat_turn_completed",
        extra=chat_log_payload(
            event="chat_turn_completed",
            user_id=int(user.id),
            request_id=get_request_id(),
            channel="text",
            question=text,
            route_taken=pipeline.get("route_taken"),
            predicted_label=pipeline.get("predicted_label"),
            direct_answer_source=pipeline.get("direct_answer_source"),
            direct_answer_confidence=pipeline.get("direct_answer_confidence"),
            model_used=pipeline.get("model_used"),
            model_tier=pipeline.get("model_tier"),
            fallback_reason=(
                pipeline.get("fallback_reason")
                or pipeline.get("client_fallback_reason")
                or meta.get("fallback_reason")
                or meta.get("fallbackReason")
            ),
            client_fallback_reason=(
                pipeline.get("client_fallback_reason")
                or meta.get("client_fallback_reason")
                or meta.get("clientFallbackReason")
            ),
            client_local_budget_ms=(
                pipeline.get("client_local_budget_ms")
                or meta.get("client_local_budget_ms")
                or meta.get("clientLocalBudgetMs")
            ),
            client_original_route=(
                pipeline.get("client_original_route")
                or meta.get("client_original_route")
                or meta.get("clientOriginalRoute")
            ),
            cache_hit=pipeline.get("cache_hit"),
            rag_snippet_count=_rag_snippet_count(pipeline),
            agent_source=_backend_agent_source(pipeline),
            answer=answer,
            duration_ms=duration_ms,
            stage_timings=meta.get("stageTimings") or meta.get("stage_timings") or pipeline.get("timings_ms"),
        ),
    )
    if CHAT_TURN_SUMMARY_LOGS_ENABLED:
        logger.info(
            "chat_turn_summary",
            extra=build_turn_summary_payload(
                event="chat_turn_summary",
                user_id=int(user.id),
                request_id=get_request_id(),
                channel="text",
                question=text,
                answer=answer,
                route_taken=pipeline.get("route_taken"),
                predicted_label=pipeline.get("predicted_label"),
                direct_answer_source=pipeline.get("direct_answer_source"),
                direct_answer_confidence=pipeline.get("direct_answer_confidence"),
                model_used=pipeline.get("model_used"),
                model_tier=pipeline.get("model_tier"),
                cache_hit=pipeline.get("cache_hit"),
                fallback_reason=(
                    pipeline.get("fallback_reason")
                    or meta.get("fallback_reason")
                    or meta.get("fallbackReason")
                ),
                rag_snippet_count=_rag_snippet_count(pipeline),
                agent_source=_backend_agent_source(pipeline),
                duration_ms=duration_ms,
                stage_timings=meta.get("stageTimings") or meta.get("stage_timings") or pipeline.get("timings_ms"),
            ),
        )
    return response


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
    payload = payload.model_copy(
        update={
            "user_id": int(user.id),
            "reply_language": payload.reply_language or getattr(user, "reply_language", None),
            "admin_email": auth_user.email,
        }
    )
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
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    text = str(payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required.")
    user = get_owned_user(session, auth_user)
    enforce_provider_budget(session, "sarvam", currency="INR")
    started = time.perf_counter()
    premium = str(os.getenv("SARVAM_TTS_PREMIUM", "false")).strip().lower() in {"1", "true", "yes", "on"}
    model = normalize_sarvam_tts_model(
        os.getenv("SARVAM_TTS_MODEL_PREMIUM") if premium else os.getenv("SARVAM_TTS_MODEL"),
        premium=premium,
    )
    voice = resolve_sarvam_tts_voice(
        payload.target_language_code or os.getenv("SARVAM_TTS_LANGUAGE", "ta-IN") or "ta-IN",
        payload.speaker,
    )
    resolved_speaker = str(voice["speaker"])
    resolved_language_code = str(voice["target_language_code"])
    locale_style = str(voice["style"])
    logger.info(
        "tts_started",
        extra=chat_log_payload(
            event="tts_started",
            target_language_code=resolved_language_code,
            tts_language_code=resolved_language_code,
            resolved_speaker=resolved_speaker,
            tts_locale_style=locale_style,
            model=model,
            text=text,
        ),
    )
    audio_base64 = _get_sarvam_provider().tts(
        text,
        target_language_code=resolved_language_code,
        speaker=resolved_speaker,
        premium=premium,
    )
    record_ai_usage_event(
        session,
        AIProviderResponse(
            text="",
            provider="sarvam",
            model=model,
            route="sarvam_tts",
            reason="tts_endpoint",
            language=resolved_language_code,
            intent="tts",
            characters=len(text),
            estimated_cost_amount=estimate_tts_cost(text, model),
            estimated_cost_currency="INR",
        ),
        user_id=int(user.id),
        request_id=get_request_id(),
        latency_ms=int(round((time.perf_counter() - started) * 1000)),
        metadata={
            "text_length": len(text),
            "speaker": resolved_speaker,
            "target_language_code": resolved_language_code,
            "locale_style": locale_style,
            "model": model,
        },
    )
    return {
        "audio_base64": audio_base64,
        "speaker": resolved_speaker,
        "target_language_code": resolved_language_code,
        "locale_style": locale_style,
        "model": model,
    }


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
    started = time.perf_counter()
    user = get_owned_user(session, auth_user)
    if user_id is not None:
        assert_owner(int(user_id), user)
    set_request_context(user_id=str(user.id))
    reply_language = _normalize_reply_language(
        reply_language if reply_language else (getattr(user, "reply_language", None) or DEFAULT_REPLY_LANGUAGE)
    )
    speech_language = _normalize_speech_language_query(speech_language)

    content_type = str(file.content_type or "").split(";")[0].strip().lower()
    filename = file.filename or "audio.m4a"
    upload_bytes = await read_limited_upload(file)
    logger.info(
        "voice_upload_received",
        extra=chat_log_payload(
            event="voice_upload_received",
            user_id=int(user.id),
            request_id=get_request_id(),
            filename=filename,
            content_type=content_type,
            size_bytes=len(upload_bytes),
            reply_language=reply_language,
            speech_language=speech_language,
        ),
    )
    if len(upload_bytes) <= 0:
        raise HTTPException(400, "Audio file is empty. Please record for a moment and try again.")
    suffix = os.path.splitext(file.filename or "")[-1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(upload_bytes)
        tmp_path = tmp.name

    try:
        provider_content_type = normalize_stt_upload_mime_type(tmp_path, content_type)
        estimated_audio_seconds, duration_estimation_method = estimate_audio_duration_details(
            tmp_path,
            content_type,
            len(upload_bytes),
        )
        enforce_free_voice_quota(
            session,
            int(user.id),
            additional_seconds=estimated_audio_seconds,
            admin_email=auth_user.email,
        )
        enforce_provider_budget(session, "sarvam", currency="INR")
        transcript_text = _invoke_transcribe_audio_file(
            tmp_path,
            speech_language,
            content_type=content_type,
            filename=filename,
        )
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text=transcript_text,
                provider="sarvam",
                model=os.getenv("SARVAM_STT_MODEL", "saaras:v3") or "saaras:v3",
                route="sarvam_stt",
                reason="voice_upload_stt",
                language=normalize_audio_language(speech_language) or "auto",
                intent="stt",
                audio_seconds=estimated_audio_seconds,
                characters=len(transcript_text),
                estimated_cost_amount=estimate_stt_cost(estimated_audio_seconds),
                estimated_cost_currency="INR",
            ),
            user_id=int(user.id),
            request_id=get_request_id(),
            latency_ms=int(round((time.perf_counter() - started) * 1000)),
            metadata={
                "file_size": len(upload_bytes),
                "content_type": content_type,
                "provider_content_type": provider_content_type,
                "filename": filename,
                "duration_estimation_method": duration_estimation_method,
            },
        )

        use_ai_router = _ai_router_enabled()
        if use_ai_router:
            context_turns = _recent_ai_context_turns(session, int(user.id), limit=6)
            profile_context = build_profile_prompt_context(session, int(user.id))
            profile_prompt_context = _profile_prompt_context_text(profile_context)
            ai_response = run_text_turn(
                session,
                AIRequest(
                    user_id=int(user.id),
                    message=transcript_text,
                    reply_language=reply_language,
                    channel="voice",
                    request_id=get_request_id(),
                    metadata={
                        "admin_email": auth_user.email,
                        "file_size": len(upload_bytes),
                        "content_type": content_type,
                        "provider_content_type": provider_content_type,
                        "audio_seconds": estimated_audio_seconds,
                        "duration_estimation_method": duration_estimation_method,
                        "context_turn_count": len(context_turns),
                        "profile_context": profile_context,
                        "profile_prompt_context": profile_prompt_context,
                    },
                    context_turns=context_turns,
                ),
                existing_context={
                    "local_rag_service": LOCAL_RAG_SERVICE,
                    "sarvam_provider": _get_sarvam_provider(),
                },
            )
            pipeline_result = ai_response_to_pipeline(ai_response)
            metadata_override = _metadata_for_ai_response(transcript_text, ai_response)
            skip_expensive_side_effects = True
        elif _legacy_pipeline_enabled():
            pipeline_result = _run_agentic_or_pipeline(
                session,
                int(user.id),
                transcript_text,
                reply_language,
            )
            metadata_override = None
            skip_expensive_side_effects = False
        else:
            raise HTTPException(503, "AI router is disabled and the legacy pipeline is not enabled.")

        item, meta, normalized_pipeline = _save_item_from_pipeline(
            session,
            user_id=int(user.id),
            source="voice",
            raw_text=transcript_text,
            transcript=transcript_text,
            pipeline_result=pipeline_result,
            reply_language=reply_language,
            metadata_override=metadata_override,
            skip_expensive_side_effects=skip_expensive_side_effects,
        )
        response = _build_chat_response(item, meta, normalized_pipeline)
        response_meta = response.get("meta") if isinstance(response, dict) else {}
        if isinstance(response_meta, dict) and use_ai_router:
            response_meta.setdefault("provider", normalized_pipeline.get("provider"))
            response_meta.setdefault("model_used", normalized_pipeline.get("model_used"))
            response_meta.setdefault("model_tier", normalized_pipeline.get("model_tier"))
            response_meta.setdefault("route", normalized_pipeline.get("route_taken"))
            response_meta.setdefault("ai_router_enabled", True)
        if CHAT_TURN_SUMMARY_LOGS_ENABLED:
            assistant = response.get("assistant") if isinstance(response, dict) else {}
            answer = ""
            if isinstance(assistant, dict):
                answer = str(assistant.get("text") or assistant.get("english") or "")
            pipeline = response.get("pipeline") if isinstance(response, dict) else {}
            pipeline = pipeline if isinstance(pipeline, dict) else {}
            logger.info(
                "voice_turn_summary",
                extra=build_turn_summary_payload(
                    event="voice_turn_summary",
                    user_id=int(user.id),
                    request_id=get_request_id(),
                    channel="voice",
                    question=transcript_text,
                    answer=answer,
                    route_taken=pipeline.get("route_taken"),
                    predicted_label=pipeline.get("predicted_label"),
                    direct_answer_source=pipeline.get("direct_answer_source"),
                    cache_hit=pipeline.get("cache_hit"),
                    fallback_reason=pipeline.get("fallback_reason"),
                    rag_snippet_count=_rag_snippet_count(pipeline),
                    agent_source=_backend_agent_source(pipeline),
                    duration_ms=round((time.perf_counter() - started) * 1000, 2),
                    voice_phase="completed",
                ),
            )
        return response
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
        transcript_text = _invoke_transcribe_audio_file(
            tmp_path,
            language or locale,
            content_type=str(file.content_type or "").split(";")[0].strip().lower(),
            filename=file.filename,
        )
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


def _delete_related_item_memory(session: Session, item: Item, user_id: int) -> None:
    item_id = str(item.id)
    raw_text = str(item.raw_text or "")

    qa_rows = list(
        session.exec(
            select(QACache).where(
                QACache.user_id == user_id,
                QACache.question == raw_text,
            )
        ).all()
    )
    conversation_query = select(Conversation).where(
        Conversation.user_id == user_id,
        Conversation.channel == item.source,
        Conversation.user_input == raw_text,
    )
    if item.transcript is not None:
        conversation_query = conversation_query.where(Conversation.transcript == item.transcript)
    conversation_rows = list(session.exec(conversation_query).all())

    session.exec(
        delete(RagEmbedding).where(
            RagEmbedding.user_id == user_id,
            RagEmbedding.source_type == "item",
            RagEmbedding.source_id == item_id,
        )
    )

    for row in qa_rows:
        if row.id is not None:
            session.exec(
                delete(RagEmbedding).where(
                    RagEmbedding.user_id == user_id,
                    RagEmbedding.source_type == "qa_cache",
                    RagEmbedding.source_id == str(row.id),
                )
            )
        session.delete(row)

    for row in conversation_rows:
        if row.id is not None:
            session.exec(
                delete(RagEmbedding).where(
                    RagEmbedding.user_id == user_id,
                    RagEmbedding.source_type == "conversation",
                    RagEmbedding.source_id == str(row.id),
                )
            )
        session.delete(row)


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

    try:
        _delete_related_item_memory(session, item, int(user.id))
    except Exception:
        session.rollback()
        logger.warning(
            "Failed to delete item-related memory rows",
            extra={"user_id": int(user.id), "item_id": item_id},
            exc_info=True,
        )

    session.delete(item)
    safe_commit(session, "delete_item")

    return {"ok": True, "id": item_id}


DOCS_BASE_DIR = Path(GENERATED_DOCS_DIR).resolve()
PDF_BASE_DIR = DOCS_BASE_DIR / "pdf"
EXCEL_BASE_DIR = DOCS_BASE_DIR / "xlsx"
PPT_BASE_DIR = DOCS_BASE_DIR / "pptx"
DOCX_BASE_DIR = DOCS_BASE_DIR / "docx"


def ensure_dir(path: str | Path) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)


def _safe_export_segment(value: Optional[str], *, default: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._-")
    return cleaned or default


def _category_export_dir(base_dir: Path, category: Optional[str], created_at: Optional[datetime] = None) -> Path:
    ensure_dir(base_dir)
    category_dir = base_dir / _safe_export_segment(category, default="Other")
    ensure_dir(category_dir)
    date_value = (created_at or _utc_now()).date().isoformat()
    dated_dir = category_dir / date_value
    ensure_dir(dated_dir)
    return dated_dir


def _export_path_for_item(base_dir: Path, item: Item, extension: str) -> Path:
    category_dir = _category_export_dir(base_dir, item.category, item.created_at)
    title = _safe_export_segment(item.title or item.raw_text, default=f"item_{item.id}")
    return category_dir / f"{title or f'item_{item.id}'}.{extension}"


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


def _build_download_payload(path: Path, *, item: Optional[Item] = None, artifact: Optional[DocumentArtifact] = None) -> Dict[str, Any]:
    resolved = path.resolve()
    relative_path = resolved.relative_to(DOCS_BASE_DIR).as_posix()
    user_id = int(item.user_id) if item is not None else int(getattr(artifact, "user_id", 0) or 0)
    item_id = int(item.id) if item is not None and item.id is not None else (
        int(artifact.item_id) if artifact is not None and artifact.item_id is not None else None
    )
    if user_id <= 0:
        raise HTTPException(404, "File not found")
    token = _sign_download_payload(
        {
            "path": relative_path,
            "user_id": user_id,
            "item_id": item_id,
            "artifact_id": int(artifact.id) if artifact and artifact.id is not None else None,
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


def _pdf_safe_text(value: Any, unicode_font_available: bool) -> str:
    text = str(value or "")
    if unicode_font_available:
        return text
    return text.encode("latin-1", errors="replace").decode("latin-1")


def _draw_pdf_wrapped_line(
    pdf: Any,
    text: str,
    x: float,
    y: float,
    max_width: float,
    font_name: str,
    font_size: int,
    page_height: float,
    margin: float,
) -> float:
    from reportlab.pdfbase import pdfmetrics

    line_height = font_size + 5
    words = str(text or "").split()
    if not words:
        words = [""]
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
        if pdfmetrics.stringWidth(word, font_name, font_size) <= max_width:
            current = word
        else:
            chunk = ""
            for char in word:
                candidate_chunk = f"{chunk}{char}"
                if pdfmetrics.stringWidth(candidate_chunk, font_name, font_size) <= max_width:
                    chunk = candidate_chunk
                else:
                    if chunk:
                        lines.append(chunk)
                    chunk = char
            current = chunk
    if current:
        lines.append(current)

    for line in lines:
        if y < margin:
            pdf.showPage()
            pdf.setFont(font_name, font_size)
            y = page_height - margin
        pdf.drawString(x, y, line)
        y -= line_height
    return y


def _document_body_for_item(item: Item, source_text: str = "") -> str:
    body = " ".join(str(source_text or "").strip().split())
    if not body:
        body = " ".join(str(item.raw_text or "").strip().split())
    if re.match(r"^created\s+(?:pdf|docx|xlsx|pptx|word|excel|powerpoint)", body, flags=re.I):
        body = " ".join(str(item.raw_text or "").strip().split())
    return body or str(item.title or f"Item {item.id}")


def _document_metadata_lines(item: Item, source_text: str = "") -> list[tuple[str, str]]:
    created = item.created_at.isoformat() if item.created_at else _utc_now().isoformat()
    return [
        ("Title", str(item.title or f"Item {item.id}")),
        ("Category", str(item.category or "Other")),
        ("Created", created),
        ("Body", _document_body_for_item(item, source_text)),
    ]


def generate_docx(item: Item, *, source_text: str = "") -> Path:
    from docx import Document

    path = _export_path_for_item(DOCX_BASE_DIR, item, "docx")
    doc = Document()
    doc.add_heading(item.title or f"Item {item.id}", level=1)
    for label, value in _document_metadata_lines(item, source_text):
        if label == "Body":
            continue
        doc.add_paragraph(f"{label}: {value}")
    if item.datetime_str:
        doc.add_paragraph(f"When: {item.datetime_str}")
    doc.add_paragraph(_document_body_for_item(item, source_text))
    doc.save(str(path))
    return path


def generate_pdf(item: Item, *, source_text: str = "") -> Path:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    path = _export_path_for_item(PDF_BASE_DIR, item, "pdf")

    font_candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/NotoSansTamil-Regular.ttf",
    ]
    font_path = next((p for p in font_candidates if os.path.exists(p)), None)
    font_name = "Helvetica"
    if font_path:
        font_name = "GeneratedDocFont"
        try:
            pdfmetrics.registerFont(TTFont(font_name, font_path))
        except Exception:
            font_name = "Helvetica"
            font_path = None

    page_width, page_height = letter
    margin = 54
    y = page_height - margin
    pdf = canvas.Canvas(str(path), pagesize=letter, pageCompression=0)
    pdf.setFont(font_name, 15)
    y = _draw_pdf_wrapped_line(
        pdf,
        _pdf_safe_text(item.title or f"Item {item.id}", bool(font_path)),
        margin,
        y,
        page_width - (margin * 2),
        font_name,
        15,
        page_height,
        margin,
    )
    y -= 10
    pdf.setFont(font_name, 11)
    for label, value in _document_metadata_lines(item, source_text):
        if label == "Body":
            continue
        line = f"{label}: {value}"
        y = _draw_pdf_wrapped_line(
            pdf,
            _pdf_safe_text(line, bool(font_path)),
            margin,
            y,
            page_width - (margin * 2),
            font_name,
            11,
            page_height,
            margin,
        )
    if item.datetime_str:
        y = _draw_pdf_wrapped_line(
            pdf,
            _pdf_safe_text(f"When: {item.datetime_str}", bool(font_path)),
            margin,
            y,
            page_width - (margin * 2),
            font_name,
            11,
            page_height,
            margin,
        )
    y -= 8
    y = _draw_pdf_wrapped_line(
        pdf,
        _pdf_safe_text(_document_body_for_item(item, source_text), bool(font_path)),
        margin,
        y,
        page_width - (margin * 2),
        font_name,
        11,
        page_height,
        margin,
    )

    pdf.save()
    return path


def generate_excel(item: Item, *, source_text: str = "") -> Path:
    from openpyxl import Workbook

    path = _export_path_for_item(EXCEL_BASE_DIR, item, "xlsx")
    wb = Workbook()
    ws = wb.active
    ws.title = "Item"
    rows = [("ID", item.id), ("Intent", item.intent), ("When", item.datetime_str)]
    rows.extend(_document_metadata_lines(item, source_text))
    for i, (k, v) in enumerate(rows, start=1):
        ws.cell(row=i, column=1, value=k)
        ws.cell(row=i, column=2, value=v)
    wb.save(str(path))
    return path


def generate_ppt(item: Item, *, source_text: str = "") -> Path:
    from pptx import Presentation

    path = _export_path_for_item(PPT_BASE_DIR, item, "pptx")

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = item.title or f"Item {item.id}"
    tf = slide.placeholders[1].text_frame
    tf.text = f"Category: {item.category}\nCreated: {item.created_at.isoformat() if item.created_at else _utc_now().isoformat()}"
    if item.datetime_str:
        tf.add_paragraph().text = f"When: {item.datetime_str}"
    tf.add_paragraph().text = _document_body_for_item(item, source_text)

    prs.save(str(path))
    return path


def _document_format_key(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"excel", "xls"}:
        return "xlsx"
    if normalized in {"ppt", "powerpoint"}:
        return "pptx"
    if normalized in {"word", "document"}:
        return "docx"
    return normalized if normalized in {"pdf", "docx", "xlsx", "pptx"} else "pdf"


def _generator_for_document_format(format_key: str):
    return {
        "pdf": generate_pdf,
        "docx": generate_docx,
        "xlsx": generate_excel,
        "pptx": generate_ppt,
    }.get(_document_format_key(format_key))


def _record_document_artifact(
    session: Session,
    *,
    item: Item,
    path: Path,
    format_key: str,
    source_text: str = "",
    metadata: Optional[Dict[str, Any]] = None,
) -> DocumentArtifact:
    resolved = path.resolve()
    relative_path = resolved.relative_to(DOCS_BASE_DIR).as_posix()
    artifact = DocumentArtifact(
        user_id=int(item.user_id),
        item_id=int(item.id) if item.id is not None else None,
        title=item.title or f"Item {item.id}",
        format=_document_format_key(format_key),
        category=normalize_category(item.category),
        relative_path=relative_path,
        source_text=str(source_text or item.raw_text or ""),
        metadata_json=json.dumps(metadata or {}, ensure_ascii=False),
        created_at=_utc_now(),
    )
    session.add(artifact)
    session.commit()
    session.refresh(artifact)
    return artifact


def _create_document_artifact(
    session: Session,
    *,
    item: Item,
    format_key: str,
    source_text: str = "",
    metadata: Optional[Dict[str, Any]] = None,
) -> tuple[DocumentArtifact, Path]:
    generator = _generator_for_document_format(format_key)
    if generator is None:
        raise HTTPException(400, "Unsupported export format")
    try:
        path = generator(item, source_text=source_text)
    except TypeError:
        path = generator(item)
    artifact = _record_document_artifact(
        session,
        item=item,
        path=path,
        format_key=format_key,
        source_text=source_text,
        metadata=metadata,
    )
    return artifact, path


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
    artifact, path = _create_document_artifact(session, item=item, format_key="pdf", source_text=item.raw_text)
    return _build_download_payload(path, item=item, artifact=artifact)


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
    artifact, path = _create_document_artifact(session, item=item, format_key="xlsx", source_text=item.raw_text)
    return _build_download_payload(path, item=item, artifact=artifact)


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
    artifact, path = _create_document_artifact(session, item=item, format_key="pptx", source_text=item.raw_text)
    return _build_download_payload(path, item=item, artifact=artifact)


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
    artifact, path = _create_document_artifact(session, item=item, format_key="docx", source_text=item.raw_text)
    return _build_download_payload(path, item=item, artifact=artifact)


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
    artifact_id = int(payload.get("artifact_id") or 0)
    if item_id:
        _get_owned_item(session, item_id, int(user.id))
    elif artifact_id:
        artifact = session.get(DocumentArtifact, artifact_id)
        if artifact is None or int(artifact.user_id) != int(user.id):
            raise HTTPException(404, "File not found")
    else:
        raise HTTPException(404, "File not found")
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


def _serialize_document_artifact_for_user(session: Session, artifact: DocumentArtifact, user: User) -> Dict[str, Any]:
    item = session.get(Item, int(artifact.item_id)) if artifact.item_id is not None else None
    download: Dict[str, Any] = {}
    if item is not None and int(item.user_id) == int(user.id):
        try:
            path = _resolve_generated_doc_path(artifact.relative_path)
            download = _build_download_payload(path, item=item, artifact=artifact)
        except HTTPException:
            download = {}
    return {
        "id": artifact.id,
        "item_id": artifact.item_id,
        "title": artifact.title,
        "format": artifact.format,
        "category": artifact.category,
        "relative_path": artifact.relative_path,
        "source_text": artifact.source_text,
        "created_at": artifact.created_at.isoformat() if artifact.created_at else None,
        "download_url": download.get("download_url"),
        "download_id": download.get("download_id"),
    }


def _search_document_artifact_rows(
    session: Session,
    *,
    user_id: int,
    query: str = "",
    category: Optional[str] = None,
    date_value: Optional[str] = None,
    limit: int = 10,
) -> list[DocumentArtifact]:
    rows = list(
        session.exec(
            select(DocumentArtifact)
            .where(DocumentArtifact.user_id == int(user_id))
            .order_by(DocumentArtifact.created_at.desc())
        ).all()
    )
    normalized_category = normalize_category(category) if category else ""
    parsed_date = None
    if date_value:
        try:
            parsed_date = datetime.fromisoformat(str(date_value)).date()
        except Exception:
            parsed_date = None
    tokens = re.findall(r"[a-z0-9\u0B80-\u0BFF]+", str(query or "").lower())
    matches: list[DocumentArtifact] = []
    for row in rows:
        if normalized_category and row.category != normalized_category:
            continue
        if parsed_date is not None and row.created_at.date() != parsed_date:
            continue
        if tokens:
            haystack = f"{row.title} {row.source_text} {row.relative_path}".lower()
            if not all(token in haystack for token in tokens if token not in {"file", "files", "notes", "note"}):
                continue
        matches.append(row)
        if len(matches) >= max(1, min(limit, 50)):
            break
    return matches


@app.get("/api/files/search")
def api_files_search(
    q: str = Query(default=""),
    category: Optional[str] = Query(default=None),
    date_value: Optional[str] = Query(default=None, alias="date"),
    limit: int = Query(default=10),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    rows = _search_document_artifact_rows(
        session,
        user_id=int(user.id),
        query=q,
        category=category,
        date_value=date_value,
        limit=limit,
    )
    return {
        "ok": True,
        "files": [_serialize_document_artifact_for_user(session, row, user) for row in rows],
    }


@app.post("/api/files/search")
def api_files_search_post(
    payload: FileSearchRequest,
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth_user)
    rows = _search_document_artifact_rows(
        session,
        user_id=int(user.id),
        query=payload.query,
        category=payload.category,
        date_value=payload.date,
        limit=payload.limit,
    )
    return {
        "ok": True,
        "files": [_serialize_document_artifact_for_user(session, row, user) for row in rows],
    }
