"""Separate binary Valkey namespace. No disk or production in-memory fallback."""
from __future__ import annotations
import os
import time
import redis
from .config import settings

PREFIX = "swico:video:"
RESERVATION = 20 * 1024 * 1024


class VideoCache:
    def __init__(self, client=None):
        url = os.getenv("WEB_UPLOAD_CACHE_URL", "").strip()
        if client is None and not url:
            raise RuntimeError("video_cache_unconfigured")
        self.client = client or redis.Redis.from_url(url, decode_responses=False, socket_timeout=5, socket_connect_timeout=3)

    def health(self) -> dict:
        info = self.client.info("memory")
        maximum, used = int(info.get("maxmemory", 0)), int(info.get("used_memory", 0))
        # Reserve headroom for unrelated workloads. Never change global eviction.
        enough = maximum > 0 and maximum - used >= 32 * 1024 * 1024 + RESERVATION
        return {"available": enough, "bounded_maxmemory": maximum > 0}

    def reserve(self, job: str, deadline: int) -> None:
        if not self.health()["available"]:
            raise RuntimeError("video_cache_headroom")
        result = self.client.eval("""
            redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
            if redis.call('ZSCORE', KEYS[1], ARGV[2]) then redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2]); return 1 end
            if (redis.call('ZCARD', KEYS[1])+1)*tonumber(ARGV[4]) > tonumber(ARGV[5]) then return 0 end
            redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2]); return 1
        """, 1, PREFIX + "reservations", int(time.time()), job, deadline, RESERVATION, settings().cache_budget)
        if result != 1:
            raise RuntimeError("video_cache_capacity")

    def put(self, job: str, part: str, data: bytes, deadline: int) -> None:
        if part not in {"male", "female", "output"}:
            raise ValueError("invalid_media_part")
        limit = settings().max_output if part == "output" else 2 * 1024 * 1024
        if len(data) > limit or deadline <= time.time():
            raise ValueError("media_limit")
        key = PREFIX + job + ":" + part
        # Immutable bytes: repeated transfer succeeds only for identical content.
        result = self.client.eval("""
            if not redis.call('ZSCORE', KEYS[2], ARGV[3]) then return -1 end
            local old = redis.call('GET', KEYS[1])
            if old then if old == ARGV[1] then return 1 else return 0 end end
            redis.call('SET', KEYS[1], ARGV[1], 'EXAT', ARGV[2]); return 1
        """, 2, key, PREFIX + "reservations", data, deadline, job)
        if result != 1:
            raise ValueError("media_changed_or_reservation_lost")

    def pin(self, job: str, roles: list[str], deadline: int) -> None:
        keys = [PREFIX + job + ":" + role for role in roles]
        result = self.client.eval("""
            for _,key in ipairs(KEYS) do if redis.call('EXISTS', key) == 0 then return 0 end end
            for _,key in ipairs(KEYS) do redis.call('EXPIREAT', key, ARGV[1]) end
            return 1
        """, len(keys), *keys, deadline)
        if result != 1:
            raise RuntimeError("video_sources_expired")

    def get(self, job: str, part: str) -> bytes | None:
        if part not in {"male", "female", "output"}:
            raise ValueError("invalid_media_part")
        return self.client.get(PREFIX + job + ":" + part)

    def expire_output(self, job: str, deadline: int) -> None:
        # READY's delivery window, not the old processing deadline, owns capacity.
        # Never release a reservation while its result remains retrievable.
        result = self.client.eval("""
            if redis.call('EXISTS', KEYS[1]) == 0 or not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end
            redis.call('EXPIREAT', KEYS[1], ARGV[1])
            redis.call('ZADD', KEYS[2], ARGV[1], ARGV[2]); return 1
        """, 2, PREFIX + job + ":output", PREFIX + "reservations", deadline, job)
        if not result:
            raise RuntimeError("video_output_lost_before_finalization")

    def has_output(self, job: str) -> bool:
        return bool(self.client.exists(PREFIX + job + ":output"))

    def clear_output(self, job: str) -> None:
        self.client.delete(PREFIX + job + ":output")

    def delete_sources(self, job: str) -> None:
        self.client.delete(PREFIX + job + ":male", PREFIX + job + ":female")

    def delete(self, job: str) -> None:
        self.client.delete(*(PREFIX + job + ":" + p for p in ("male", "female", "output")))
        self.client.zrem(PREFIX + "reservations", job)


def cache() -> VideoCache:
    return VideoCache()
