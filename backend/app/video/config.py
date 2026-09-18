from __future__ import annotations

import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

AUP_VERSION = "video-adult-consent-2026-09-18"
TEMPLATE_IDS = ("couple-01", "couple-02")


def flag(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"true", "1", "yes"}


def number(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv("SWICO_VIDEO_" + name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError("Invalid SWICO_VIDEO_" + name)
    return value


@dataclass(frozen=True)
class Settings:
    enabled: bool
    paid: bool
    price: int
    ttl: int
    unlimited: frozenset[str]
    daily: int
    timezone: str
    worker_digest: str
    stale: int
    capacity: int
    per_user: int
    max_age: int
    max_output: int
    cache_budget: int
    origin: str


def settings() -> Settings:
    zone = os.getenv("SWICO_VIDEO_DAILY_RESET_TIMEZONE", "Asia/Kolkata")
    ZoneInfo(zone)
    origin = os.getenv("SWICO_VIDEO_PUBLIC_WEB_ORIGIN", "https://swico.in").rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Invalid SWICO_VIDEO_PUBLIC_WEB_ORIGIN")
    digest = os.getenv("SWICO_VIDEO_WORKER_TOKEN_SHA256", "").strip()
    if digest and not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid video worker digest")
    return Settings(
        flag("SWICO_VIDEO_ENABLED"), flag("SWICO_VIDEO_PAID_CHECKOUT_ENABLED"),
        number("PRICE_PAISE", 2500, 2500, 2500), number("OUTPUT_TTL_SECONDS", 600, 600, 600),
        frozenset(x.strip().casefold() for x in os.getenv("SWICO_VIDEO_UNLIMITED_EMAILS", "harishajidasan@gmail.com").split(",") if x.strip()),
        number("TESTER_DAILY_LIMIT", 5, 1, 5), zone, digest,
        number("WORKER_STALE_SECONDS", 45, 15, 90), number("MAX_INFLIGHT_JOBS", 6, 1, 6),
        number("MAX_ACTIVE_PER_USER", 1, 1, 1), number("MAX_JOB_AGE_SECONDS", 14400, 600, 14400),
        number("MAX_OUTPUT_BYTES", 16777216, 1048576, 16777216),
        number("CACHE_BUDGET_BYTES", 134217728, 25165824, 134217728), origin,
    )
