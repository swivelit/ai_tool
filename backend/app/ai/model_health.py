from __future__ import annotations

import os
import threading
import time
from typing import Optional


_LOCK = threading.Lock()
_UNAVAILABLE: dict[tuple[str, str, str], tuple[float, str]] = {}


def _ttl_default() -> int:
    try:
        return max(1, int(str(os.getenv("OPENAI_MODEL_PROBE_CACHE_TTL_SECONDS", "900")).strip()))
    except Exception:
        return 900


def mark_model_unavailable(
    provider: str,
    model: str,
    endpoint: str,
    error_type: str,
    ttl_seconds: Optional[int] = None,
) -> None:
    ttl = _ttl_default() if ttl_seconds is None else max(1, int(ttl_seconds))
    expires_at = time.time() + ttl
    key = (str(provider or "").lower(), str(model or ""), str(endpoint or ""))
    with _LOCK:
        _UNAVAILABLE[key] = (expires_at, str(error_type or "provider_error"))


def is_model_temporarily_unavailable(provider: str, model: str, endpoint: str) -> bool:
    key = (str(provider or "").lower(), str(model or ""), str(endpoint or ""))
    with _LOCK:
        value = _UNAVAILABLE.get(key)
        if value is None:
            return False
        expires_at, _error_type = value
        if expires_at <= time.time():
            _UNAVAILABLE.pop(key, None)
            return False
        return True


def clear_model_health(provider: Optional[str] = None, model: Optional[str] = None) -> None:
    provider_key = str(provider or "").lower()
    model_key = str(model or "")
    with _LOCK:
        for key in list(_UNAVAILABLE.keys()):
            key_provider, key_model, _endpoint = key
            if provider_key and key_provider != provider_key:
                continue
            if model_key and key_model != model_key:
                continue
            _UNAVAILABLE.pop(key, None)


def model_health_snapshot() -> list[dict[str, object]]:
    now = time.time()
    rows: list[dict[str, object]] = []
    with _LOCK:
        for key, (expires_at, error_type) in list(_UNAVAILABLE.items()):
            if expires_at <= now:
                _UNAVAILABLE.pop(key, None)
                continue
            provider, model, endpoint = key
            rows.append(
                {
                    "provider": provider,
                    "model": model,
                    "endpoint": endpoint,
                    "error_type": error_type,
                    "ttl_seconds": max(0, int(round(expires_at - now))),
                }
            )
    return rows

