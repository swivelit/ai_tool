from __future__ import annotations

import json
import logging
import os
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