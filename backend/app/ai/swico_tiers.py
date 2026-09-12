from __future__ import annotations

import os
from typing import Literal, cast


SwicoTier = Literal["free", "lite", "standard", "pro"]

SWICO_TIER_IDS: tuple[SwicoTier, ...] = ("free", "lite", "standard", "pro")
SWICO_TIER_LABELS: dict[SwicoTier, str] = {
    "free": "Swico Free",
    "lite": "Swico Lite",
    "standard": "Swico",
    "pro": "Swico Pro",
}
SWICO_TIER_DESCRIPTIONS: dict[SwicoTier, str] = {
    "free": "Free AI for everyday questions.",
    "lite": "Fast and efficient for everyday questions.",
    "standard": "Balanced quality and speed for most tasks.",
    "pro": "Best for complex reasoning, planning, and coding.",
}

# Web tier routing is intentionally closed over an explicit compatibility
# allowlist. Existing catalog models remain available to non-web/mobile routes.
SWICO_TIER_MODEL_ALLOWLIST = frozenset(
    {
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.5",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
    }
)

_MODEL_DEFAULTS: dict[SwicoTier, tuple[str, str]] = {
    "lite": ("gpt-5.4-mini", "gpt-5.4-nano"),
    "standard": ("gpt-5.6-terra", "gpt-5.5"),
    "pro": ("gpt-5.6-sol", "gpt-5.6-terra"),
}


class SwicoTierConfigurationError(RuntimeError):
    pass


class SwicoTierUnavailableError(RuntimeError):
    """Raised when no configured candidate is currently usable for a tier."""

    status_code = 503


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def default_swico_tier() -> SwicoTier:
    value = str(os.getenv("SWICO_DEFAULT_TIER", "lite") or "lite").strip().lower()
    return cast(SwicoTier, value) if value in SWICO_TIER_IDS else "lite"


def tier_selection_enabled() -> bool:
    return _env_bool("SWICO_TIER_SELECTION_ENABLED", True)


def pro_enabled() -> bool:
    return _env_bool("SWICO_PRO_ENABLED", False)


def free_enabled() -> bool:
    return _env_bool("SWICO_FREE_ENABLED", False)


def free_output_token_ceiling() -> int:
    """Return the server-side Free output ceiling, failing closed to 256."""
    try:
        value = int(os.getenv("SWICO_FREE_MAX_OUTPUT_TOKENS", "256"))
    except (TypeError, ValueError):
        return 256
    return value if 64 <= value <= 512 else 256


def normalize_swico_tier(value: object, *, enforce_availability: bool = True) -> SwicoTier:
    normalized = str(value or "").strip().lower()
    tier = cast(SwicoTier, normalized) if normalized in SWICO_TIER_IDS else "lite"
    if enforce_availability:
        # Free availability is an account/rollout decision made by the web
        # service. Never turn a deliberately saved Free selection into a paid
        # tier merely because the Free runtime is down; callers must surface
        # the unavailable selection and reject the request without billing.
        if tier == "pro" and not pro_enabled():
            return "lite"
    return tier


def configured_model_ladder(tier: SwicoTier) -> list[str]:
    normalized = normalize_swico_tier(tier, enforce_availability=False)
    if normalized == "free":
        raise SwicoTierConfigurationError("Swico Free does not use the paid model ladder")
    primary_default, fallback_default = _MODEL_DEFAULTS[normalized]
    prefix = f"SWICO_{normalized.upper()}_MODEL"
    primary = str(os.getenv(f"{prefix}_PRIMARY", primary_default) or "").strip()
    fallbacks = [
        item.strip()
        for item in str(os.getenv(f"{prefix}_FALLBACKS", fallback_default) or "").split(",")
        if item.strip()
    ]
    candidates: list[str] = []
    for model in [primary, *fallbacks]:
        if not model or model in candidates:
            continue
        if model not in SWICO_TIER_MODEL_ALLOWLIST:
            raise SwicoTierConfigurationError(
                f"{prefix}_PRIMARY/{prefix}_FALLBACKS contains a model outside the web tier allowlist"
            )
        candidates.append(model)
    if not candidates:
        raise SwicoTierConfigurationError(f"{prefix}_PRIMARY must configure an allowlisted model")
    return candidates


def public_tier_settings(tier: object, *, free_available: bool | None = None) -> dict[str, object]:
    free_is_available = free_enabled() if free_available is None else bool(free_available)
    current = normalize_swico_tier(tier)
    free_unavailable = current == "free" and not free_is_available
    return {
        "tier": current,
        "tier_label": SWICO_TIER_LABELS[current],
        "tier_description": SWICO_TIER_DESCRIPTIONS[current],
        "tier_selection_enabled": tier_selection_enabled(),
        "availability_reason": "Swico Free is temporarily unavailable." if free_unavailable else None,
        "tiers": [
            {
                "id": item,
                "label": SWICO_TIER_LABELS[item],
                "description": SWICO_TIER_DESCRIPTIONS[item],
                "available": (
                    free_is_available if item == "free"
                    else pro_enabled() if item == "pro"
                    else True
                ),
                "selected": item == current,
            }
            for item in SWICO_TIER_IDS
        ],
    }
