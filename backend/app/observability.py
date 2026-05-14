from __future__ import annotations

import json
import logging
import os
import re
import hashlib
import sys
import time
import uuid
from contextvars import ContextVar
from logging.config import dictConfig
from typing import Any, Dict, Optional

try:  # optional dependency in local/dev
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration
except Exception:  # pragma: no cover
    sentry_sdk = None
    FastApiIntegration = None
    SqlalchemyIntegration = None

APP_NAME = os.getenv("APP_NAME", "j-ai-backend").strip() or "j-ai-backend"
APP_ENV = os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "development")).strip() or "development"
APP_RELEASE = os.getenv("APP_RELEASE", os.getenv("RENDER_GIT_COMMIT", "dev")).strip() or "dev"

LOG_CHAT_CONTENT = (
    os.getenv("LOG_CHAT_CONTENT", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)
LOG_CHAT_CONTENT_MAX_CHARS = max(
    1,
    int(os.getenv("LOG_CHAT_CONTENT_MAX_CHARS", "240") or 240),
)
CLIENT_TURN_LOGS_ENABLED = (
    os.getenv("CLIENT_TURN_LOGS_ENABLED", "true").strip().lower()
    not in {"0", "false", "no", "off"}
)
CHAT_TURN_SUMMARY_LOGS_ENABLED = (
    os.getenv("CHAT_TURN_SUMMARY_LOGS_ENABLED", "true").strip().lower()
    not in {"0", "false", "no", "off"}
)

_REDACT_PATTERNS = [
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)((?:openai|sarvam|firebase|api)[-_ ]?(?:api[-_ ]?)?key\s*[:=]\s*)[^\s,;\"']+"),
    re.compile(r"(?i)((?:id[_-]?token|firebase[_-]?token|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*)[^\s,;\"']+"),
    re.compile(r"(?i)(api-subscription-key\s*[:=]\s*)[^\s,;\"']+"),
]

_SAFE_EXTRA_KEYS = {
    "event",
    "client_event",
    "channel",
    "turn_id",
    "app_version",
    "api_base",
    "build_number",
    "log_chat_content",
    "log_chat_content_max_chars",
    "client_turn_logs_enabled",
    "chat_turn_summary_logs_enabled",
    "question_hash",
    "question_length",
    "question_preview",
    "answer_hash",
    "answer_length",
    "answer_preview",
    "route_taken",
    "predicted_label",
    "direct_answer_source",
    "direct_answer_confidence",
    "cache_hit",
    "rag_snippet_count",
    "agent_source",
    "fallback_reason",
    "original_route",
    "local_duration_ms",
    "backend_duration_ms",
    "total_duration_ms",
    "safe_error_type",
    "safe_provider_error",
    "provider",
    "voice_phase",
    "telemetry_delivery",
    "upload_filename",
    "content_type",
    "mime_type",
    "size_bytes",
    "file_size",
    "reply_language",
    "speech_language",
    "model",
    "mode",
    "language_code",
    "transcript_hash",
    "transcript_length",
    "transcript_preview",
    "target_language_code",
    "speaker",
    "text_length",
    "text_preview",
    "audio_count",
    "stage_timings",
    "error_type",
    "skipped",
    "created_at",
    "chat_routing",
    "voice_routing",
}

_request_id_ctx: ContextVar[str] = ContextVar("request_id", default="")
_route_ctx: ContextVar[str] = ContextVar("route", default="")
_user_ctx: ContextVar[str] = ContextVar("user_id", default="")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": int(time.time() * 1000),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "service": APP_NAME,
            "environment": APP_ENV,
            "release": APP_RELEASE,
            "request_id": getattr(record, "request_id", None) or get_request_id(),
            "route": getattr(record, "route", None) or _route_ctx.get(""),
            "user_id": getattr(record, "user_id", None) or _user_ctx.get(""),
        }

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        for key in (
            "status_code",
            "duration_ms",
            "method",
            "path",
            "job_id",
            "job_type",
            "attempt",
            "endpoint",
            "operation",
            "vector_backend",
        ):
            value = getattr(record, key, None)
            if value not in (None, ""):
                payload[key] = value

        for key in _SAFE_EXTRA_KEYS:
            value = getattr(record, key, None)
            if value not in (None, ""):
                payload["filename" if key == "upload_filename" else key] = redact_log_value(value)

        return json.dumps(payload, ensure_ascii=False)


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id()
        record.route = _route_ctx.get("")
        record.user_id = _user_ctx.get("")
        return True


_CONFIGURED = False


def configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    log_level = os.getenv("LOG_LEVEL", "INFO").upper().strip() or "INFO"
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "filters": {"request_context": {"()": RequestContextFilter}},
            "formatters": {"json": {"()": JsonFormatter}},
            "handlers": {
                "default": {
                    "class": "logging.StreamHandler",
                    "stream": sys.stdout,
                    "formatter": "json",
                    "filters": ["request_context"],
                }
            },
            "root": {"handlers": ["default"], "level": log_level},
        }
    )
    _CONFIGURED = True


_SENTRY_INITIALIZED = False


def configure_sentry() -> None:
    global _SENTRY_INITIALIZED
    if _SENTRY_INITIALIZED:
        return

    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn or sentry_sdk is None:
        return

    sentry_sdk.init(
        dsn=dsn,
        environment=APP_ENV,
        release=APP_RELEASE,
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1") or 0.1),
        profiles_sample_rate=float(os.getenv("SENTRY_PROFILES_SAMPLE_RATE", "0.0") or 0.0),
        integrations=[
            integration
            for integration in [
                FastApiIntegration() if FastApiIntegration else None,
                SqlalchemyIntegration() if SqlalchemyIntegration else None,
            ]
            if integration is not None
        ],
        send_default_pii=False,
    )
    _SENTRY_INITIALIZED = True


def bootstrap_observability() -> None:
    configure_logging()
    configure_sentry()


def new_request_id() -> str:
    return uuid.uuid4().hex


def get_request_id() -> str:
    return _request_id_ctx.get("")


def get_request_context() -> Dict[str, str]:
    return {
        "request_id": _request_id_ctx.get(""),
        "route": _route_ctx.get(""),
        "user_id": _user_ctx.get(""),
    }


def redact_log_text(value: Any) -> str:
    text = str(value or "")
    for pattern in _REDACT_PATTERNS:
        text = pattern.sub(r"\1[REDACTED]", text)
    return text


def redact_log_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_log_text(value)
    if isinstance(value, dict):
        return {str(key): redact_log_value(entry) for key, entry in value.items()}
    if isinstance(value, list):
        return [redact_log_value(entry) for entry in value]
    return value


def sanitize_log_text(text: Any, max_chars: Optional[int] = None) -> str:
    normalized = re.sub(r"\s+", " ", redact_log_text(text)).strip()
    limit = max(1, int(max_chars or LOG_CHAT_CONTENT_MAX_CHARS))
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[:limit]}..."


def hash_log_text(text: Any) -> str:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def chat_log_payload(**kwargs: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    question = kwargs.pop("question", None)
    answer = kwargs.pop("answer", None)
    transcript = kwargs.pop("transcript", None)
    tts_text = kwargs.pop("text", None)

    for key, value in kwargs.items():
        if value not in (None, ""):
            payload["upload_filename" if key == "filename" else key] = redact_log_value(value)

    if question is not None:
        question_text = str(question or "")
        payload["question_hash"] = hash_log_text(question_text)
        payload["question_length"] = len(question_text)
        if LOG_CHAT_CONTENT:
            payload["question_preview"] = sanitize_log_text(question_text)

    if answer is not None:
        answer_text = str(answer or "")
        payload["answer_hash"] = hash_log_text(answer_text)
        payload["answer_length"] = len(answer_text)
        if LOG_CHAT_CONTENT:
            payload["answer_preview"] = sanitize_log_text(answer_text)

    if transcript is not None:
        transcript_text = str(transcript or "")
        payload["transcript_hash"] = hash_log_text(transcript_text)
        payload["transcript_length"] = len(transcript_text)
        if LOG_CHAT_CONTENT:
            payload["transcript_preview"] = sanitize_log_text(transcript_text)

    if tts_text is not None:
        text_value = str(tts_text or "")
        payload["text_length"] = len(text_value)
        if LOG_CHAT_CONTENT:
            payload["text_preview"] = sanitize_log_text(text_value)

    return payload


def build_turn_summary_payload(**kwargs: Any) -> Dict[str, Any]:
    payload = chat_log_payload(**kwargs)
    event = str(payload.get("event") or kwargs.get("event") or "turn_summary")
    payload["event"] = sanitize_log_text(event, 80)
    return payload


def set_request_context(*, request_id: Optional[str] = None, route: Optional[str] = None, user_id: Optional[str] = None) -> None:
    if request_id is not None:
        _request_id_ctx.set(str(request_id))
    if route is not None:
        _route_ctx.set(str(route))
    if user_id is not None:
        _user_ctx.set(str(user_id))

    if sentry_sdk is not None:
        with sentry_sdk.configure_scope() as scope:  # pragma: no branch
            scope.set_tag("request_id", _request_id_ctx.get(""))
            scope.set_tag("route", _route_ctx.get(""))
            if _user_ctx.get(""):
                scope.set_user({"id": _user_ctx.get("")})
            else:
                scope.set_user(None)


def add_sentry_context(name: str, payload: Dict[str, Any]) -> None:
    if sentry_sdk is None:
        return
    with sentry_sdk.configure_scope() as scope:  # pragma: no branch
        scope.set_context(str(name), payload)


def capture_exception(exc: BaseException) -> None:
    if sentry_sdk is None:
        return
    sentry_sdk.capture_exception(exc)


def clear_request_context() -> None:
    _request_id_ctx.set("")
    _route_ctx.set("")
    _user_ctx.set("")
    if sentry_sdk is not None:
        with sentry_sdk.configure_scope() as scope:  # pragma: no branch
            scope.set_tag("request_id", "")
            scope.set_tag("route", "")
            scope.set_user(None)
