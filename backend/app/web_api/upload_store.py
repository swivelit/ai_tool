from __future__ import annotations

import json
import os
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Protocol


DEFAULT_UPLOAD_TTL_SECONDS = 3_600
MAX_UPLOAD_TTL_SECONDS = 86_400
UPLOAD_KEY_PREFIX = "swico:web-upload:"
UPLOAD_OWNER_KEY_PREFIX = "swico:web-upload-owner:"


class UploadStoreUnavailable(RuntimeError):
    """Raised when the configured temporary store cannot be used safely."""


@dataclass(frozen=True)
class ExtractedChunk:
    text: str
    source: str


@dataclass(frozen=True)
class EphemeralUpload:
    id: str
    owner_user_id: int
    name: str
    extension: str
    media_type: str
    size_bytes: int
    created_at: str
    expires_at: str
    chunks: list[ExtractedChunk]
    source_locators: list[str]
    warnings: list[str]
    warning_codes: list[str] = field(default_factory=list)
    virtual_text_operation: str | None = None
    binary_base64: str | None = None

    def display_metadata(self, *, status: str = "ready") -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "media_type": self.media_type,
            "size_bytes": self.size_bytes,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "status": status,
            "warnings": list(self.warnings),
            "warning_codes": list(self.warning_codes),
            "virtual_text_operation": self.virtual_text_operation,
        }


class EphemeralUploadStore(Protocol):
    ttl_seconds: int

    def put(self, upload: EphemeralUpload) -> None: ...
    def is_owned(self, upload_id: str, owner_user_id: int) -> bool: ...
    def get(self, upload_id: str) -> EphemeralUpload | None: ...
    def delete(self, upload_id: str) -> bool: ...
    def available(self) -> bool: ...
    def get_auxiliary(self, key: str) -> str | None: ...
    def set_auxiliary(self, key: str, value: str, ttl_seconds: int) -> None: ...
    def delete_auxiliary(self, key: str) -> bool: ...


def utc_iso(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    return current.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def expiration_iso(ttl_seconds: int) -> str:
    return utc_iso(datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds))


def upload_ttl_seconds() -> int:
    try:
        value = int(os.getenv("WEB_UPLOAD_TTL_SECONDS", str(DEFAULT_UPLOAD_TTL_SECONDS)))
    except ValueError:
        value = DEFAULT_UPLOAD_TTL_SECONDS
    return min(MAX_UPLOAD_TTL_SECONDS, max(1, value))


def _encode(upload: EphemeralUpload) -> str:
    return json.dumps(asdict(upload), ensure_ascii=False, separators=(",", ":"))


def _decode(value: str | bytes) -> EphemeralUpload:
    payload = json.loads(value.decode("utf-8") if isinstance(value, bytes) else value)
    payload["chunks"] = [ExtractedChunk(**chunk) for chunk in payload.get("chunks", [])]
    return EphemeralUpload(**payload)


def _expired(upload: EphemeralUpload) -> bool:
    try:
        expires = datetime.fromisoformat(upload.expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return expires <= datetime.now(timezone.utc)


class InProcessEphemeralUploadStore:
    """Bounded local/test store. It is intentionally never selected in production."""

    def __init__(self, *, ttl_seconds: int = DEFAULT_UPLOAD_TTL_SECONDS, max_entries: int = 256) -> None:
        self.ttl_seconds = min(MAX_UPLOAD_TTL_SECONDS, max(1, int(ttl_seconds)))
        self.max_entries = max(1, int(max_entries))
        self._items: OrderedDict[str, EphemeralUpload] = OrderedDict()
        self._auxiliary: OrderedDict[str, tuple[str, datetime]] = OrderedDict()
        self._lock = threading.RLock()

    def _purge(self) -> None:
        for upload_id, upload in list(self._items.items()):
            if _expired(upload):
                self._items.pop(upload_id, None)
        now = datetime.now(timezone.utc)
        for key, (_value, expires_at) in list(self._auxiliary.items()):
            if expires_at <= now:
                self._auxiliary.pop(key, None)

    def put(self, upload: EphemeralUpload) -> None:
        with self._lock:
            self._purge()
            self._items[upload.id] = upload
            self._items.move_to_end(upload.id)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def get(self, upload_id: str) -> EphemeralUpload | None:
        with self._lock:
            self._purge()
            # Do not move the entry or change its expiry: reads are non-sliding.
            return self._items.get(upload_id)

    def is_owned(self, upload_id: str, owner_user_id: int) -> bool:
        with self._lock:
            self._purge()
            upload = self._items.get(upload_id)
            return bool(
                upload is not None
                and upload.owner_user_id == int(owner_user_id)
            )

    def delete(self, upload_id: str) -> bool:
        with self._lock:
            return self._items.pop(upload_id, None) is not None

    def available(self) -> bool:
        return True

    def get_auxiliary(self, key: str) -> str | None:
        with self._lock:
            self._purge()
            item = self._auxiliary.get(key)
            return item[0] if item else None

    def set_auxiliary(self, key: str, value: str, ttl_seconds: int) -> None:
        bounded_ttl = min(self.ttl_seconds, max(1, int(ttl_seconds)))
        with self._lock:
            self._purge()
            self._auxiliary[key] = (
                str(value),
                datetime.now(timezone.utc) + timedelta(seconds=bounded_ttl),
            )
            self._auxiliary.move_to_end(key)
            while len(self._auxiliary) > self.max_entries * 64:
                self._auxiliary.popitem(last=False)

    def delete_auxiliary(self, key: str) -> bool:
        with self._lock:
            return self._auxiliary.pop(key, None) is not None

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._auxiliary.clear()


class RedisEphemeralUploadStore:
    def __init__(self, url: str, *, ttl_seconds: int = DEFAULT_UPLOAD_TTL_SECONDS) -> None:
        if not str(url or "").strip():
            raise UploadStoreUnavailable("WEB_UPLOAD_CACHE_URL is not configured.")
        try:
            import redis
        except ImportError as exc:  # pragma: no cover - dependency is required in production
            raise UploadStoreUnavailable("The temporary upload cache client is unavailable.") from exc
        self.ttl_seconds = min(MAX_UPLOAD_TTL_SECONDS, max(1, int(ttl_seconds)))
        self._client = redis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2)

    @staticmethod
    def _key(upload_id: str) -> str:
        return f"{UPLOAD_KEY_PREFIX}{upload_id}"

    @staticmethod
    def _owner_key(upload_id: str, owner_user_id: int) -> str:
        return f"{UPLOAD_OWNER_KEY_PREFIX}{int(owner_user_id)}:{upload_id}"

    def put(self, upload: EphemeralUpload) -> None:
        try:
            self._client.setex(
                self._key(upload.id), self.ttl_seconds, _encode(upload)
            )
            self._client.setex(
                self._owner_key(upload.id, upload.owner_user_id),
                self.ttl_seconds,
                "1",
            )
        except Exception as exc:
            raise UploadStoreUnavailable("The temporary upload cache is unavailable.") from exc

    def is_owned(self, upload_id: str, owner_user_id: int) -> bool:
        try:
            return bool(
                self._client.exists(self._owner_key(upload_id, owner_user_id))
            )
        except Exception as exc:
            raise UploadStoreUnavailable(
                "The temporary upload cache is unavailable."
            ) from exc

    def get(self, upload_id: str) -> EphemeralUpload | None:
        try:
            value = self._client.get(self._key(upload_id))
        except Exception as exc:
            raise UploadStoreUnavailable("The temporary upload cache is unavailable.") from exc
        if value is None:
            return None
        upload = _decode(value)
        if _expired(upload):
            self.delete(upload_id)
            return None
        return upload

    def delete(self, upload_id: str) -> bool:
        try:
            return bool(self._client.delete(self._key(upload_id)))
        except Exception as exc:
            raise UploadStoreUnavailable("The temporary upload cache is unavailable.") from exc

    def available(self) -> bool:
        try:
            return bool(self._client.ping())
        except Exception:
            return False

    def get_auxiliary(self, key: str) -> str | None:
        try:
            value = self._client.get(key)
            return str(value) if value is not None else None
        except Exception as exc:
            raise UploadStoreUnavailable(
                "The temporary upload cache is unavailable."
            ) from exc

    def set_auxiliary(self, key: str, value: str, ttl_seconds: int) -> None:
        try:
            self._client.setex(key, max(1, int(ttl_seconds)), str(value))
        except Exception as exc:
            raise UploadStoreUnavailable(
                "The temporary upload cache is unavailable."
            ) from exc

    def delete_auxiliary(self, key: str) -> bool:
        try:
            return bool(self._client.delete(key))
        except Exception as exc:
            raise UploadStoreUnavailable(
                "The temporary upload cache is unavailable."
            ) from exc


class UnavailableEphemeralUploadStore:
    def __init__(self, *, ttl_seconds: int = DEFAULT_UPLOAD_TTL_SECONDS) -> None:
        self.ttl_seconds = ttl_seconds

    @staticmethod
    def _raise() -> None:
        raise UploadStoreUnavailable("The temporary upload cache is unavailable.")

    def put(self, upload: EphemeralUpload) -> None:
        self._raise()

    def get(self, upload_id: str) -> EphemeralUpload | None:
        self._raise()

    def is_owned(self, upload_id: str, owner_user_id: int) -> bool:
        self._raise()

    def delete(self, upload_id: str) -> bool:
        self._raise()

    def available(self) -> bool:
        return False

    def get_auxiliary(self, key: str) -> str | None:
        self._raise()

    def set_auxiliary(self, key: str, value: str, ttl_seconds: int) -> None:
        self._raise()

    def delete_auxiliary(self, key: str) -> bool:
        self._raise()


_store_lock = threading.Lock()
_store: EphemeralUploadStore | None = None
_store_signature: tuple[str, str, int] | None = None


def get_upload_store() -> EphemeralUploadStore:
    global _store, _store_signature
    environment = os.getenv("APP_ENV", "development").strip().lower()
    url = os.getenv("WEB_UPLOAD_CACHE_URL", "").strip()
    ttl = upload_ttl_seconds()
    signature = (environment, url, ttl)
    with _store_lock:
        if _store is not None and _store_signature == signature:
            return _store
        if environment in {"prod", "production", "staging"}:
            _store = RedisEphemeralUploadStore(url, ttl_seconds=ttl) if url else UnavailableEphemeralUploadStore(ttl_seconds=ttl)
        else:
            _store = InProcessEphemeralUploadStore(
                ttl_seconds=ttl,
                max_entries=int(os.getenv("WEB_UPLOAD_LOCAL_MAX_ENTRIES", "256")),
            )
        _store_signature = signature
        return _store


def reset_upload_store_for_tests() -> None:
    global _store, _store_signature
    with _store_lock:
        _store = None
        _store_signature = None
