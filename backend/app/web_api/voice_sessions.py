"""One-use realtime voice tickets backed by the existing Valkey service."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass, asdict
from typing import Any


TICKET_PREFIX = "swico:voice:ticket:"
ACTIVE_PREFIX = "swico:voice:active:"


@dataclass(frozen=True)
class VoiceTicket:
    session_id: str
    user_id: int
    tier: str
    language: str
    billing_exempt: bool
    expires_at_epoch: int
    playback_mode: str = "buffered_mp3"
    output_codec: str = "mp3"
    sample_rate: int = 24_000
    media_source_allowed: bool = False


class VoiceSessionConflict(RuntimeError):
    pass


class VoiceTicketStoreUnavailable(RuntimeError):
    """The configured shared ticket store cannot be used safely."""


def configured_voice_ticket_store_url() -> str:
    return os.getenv("WEB_UPLOAD_CACHE_URL", "").strip()


class VoiceTicketStore:
    def __init__(self, url: str | None = None) -> None:
        self._url = str(url if url is not None else configured_voice_ticket_store_url()).strip()
        self._redis = None
        self._items: dict[str, tuple[int, str]] = {}
        self._locks: dict[int, tuple[int, str]] = {}
        self._lock = threading.RLock()
        if self._url:
            import redis
            self._redis = redis.Redis.from_url(
                self._url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2
            )

    @property
    def configured(self) -> bool:
        return bool(self._url)

    def reachable(self) -> bool:
        """Perform a bounded metadata-only readiness check; never touches tickets."""
        if self._redis is None:
            return False
        try:
            return bool(self._redis.ping())
        except Exception:
            return False

    def session_status(self, user_id: int) -> tuple[bool, int]:
        """Return lock presence/TTL only; never return a session ID or ticket."""
        if self._redis is not None:
            try:
                ttl = int(self._redis.ttl(f"{ACTIVE_PREFIX}{int(user_id)}"))
            except Exception:
                return False, 0
            return ttl != -2, max(0, ttl)
        now = int(time.time())
        with self._lock:
            current = self._locks.get(int(user_id))
            if not current or current[0] <= now:
                if current:
                    self._locks.pop(int(user_id), None)
                return False, 0
            return True, max(0, current[0] - now)

    @staticmethod
    def _digest(ticket: str) -> str:
        return hashlib.sha256(ticket.encode("utf-8")).hexdigest()

    def mint(self, metadata: VoiceTicket, ttl_seconds: int, max_session_seconds: int) -> str:
        ticket = secrets.token_urlsafe(32)
        digest = self._digest(ticket)
        payload = json.dumps(asdict(metadata), separators=(",", ":"), sort_keys=True)
        # A ticket that is never connected must not block the user for the full
        # session duration. The lock is extended atomically only on consume.
        lock_ttl = max(1, int(ttl_seconds))
        if self._redis is not None:
            lock_key = f"{ACTIVE_PREFIX}{metadata.user_id}"
            try:
                if not self._redis.set(lock_key, metadata.session_id, nx=True, ex=lock_ttl):
                    raise VoiceSessionConflict("A Voice Mode session is already active.")
                self._redis.setex(f"{TICKET_PREFIX}{digest}", int(ttl_seconds), payload)
            except VoiceSessionConflict:
                raise
            except Exception:
                try:
                    self._redis.delete(lock_key)
                except Exception:
                    pass
                raise VoiceTicketStoreUnavailable("Voice ticket store is unavailable.") from None
            return ticket
        if os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "development")).strip().lower() in {"prod", "production"}:
            raise VoiceTicketStoreUnavailable("Voice ticket store is not configured.")
        now = int(time.time())
        with self._lock:
            current = self._locks.get(metadata.user_id)
            if current and current[0] > now:
                raise VoiceSessionConflict("A Voice Mode session is already active.")
            self._locks[metadata.user_id] = (now + lock_ttl, metadata.session_id)
            self._items[digest] = (now + int(ttl_seconds), payload)
        return ticket

    def consume(self, ticket: str) -> VoiceTicket | None:
        digest = self._digest(ticket)
        if self._redis is not None:
            value = self._redis.getdel(f"{TICKET_PREFIX}{digest}")
        else:
            with self._lock:
                row = self._items.pop(digest, None)
            value = row[1] if row and row[0] > int(time.time()) else None
        if not value:
            return None
        data = json.loads(value)
        metadata = VoiceTicket(**data)
        now = int(time.time())
        if metadata.expires_at_epoch < now:
            self.release(metadata)
            return None
        max_session = max(1, int(os.getenv("WEB_REALTIME_VOICE_MAX_SESSION_SECONDS", "900")))
        if self._redis is not None:
            lock_key = f"{ACTIVE_PREFIX}{metadata.user_id}"
            script = (
                "if redis.call('get',KEYS[1])==ARGV[1] then "
                "return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end"
            )
            if not self._redis.eval(script, 1, lock_key, metadata.session_id, max_session):
                return None
        else:
            with self._lock:
                current = self._locks.get(metadata.user_id)
                if not current or not hmac.compare_digest(current[1], metadata.session_id):
                    return None
                self._locks[metadata.user_id] = (now + max_session, metadata.session_id)
        return metadata

    def release(self, metadata: VoiceTicket) -> None:
        if self._redis is not None:
            key = f"{ACTIVE_PREFIX}{metadata.user_id}"
            # Compare-and-delete prevents an old socket from releasing a newer session.
            script = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end"
            self._redis.eval(script, 1, key, metadata.session_id)
            return
        with self._lock:
            current = self._locks.get(metadata.user_id)
            if current and hmac.compare_digest(current[1], metadata.session_id):
                self._locks.pop(metadata.user_id, None)
