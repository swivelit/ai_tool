from __future__ import annotations

from datetime import datetime
from typing import Any

from ..ai.swico_tiers import (
    SWICO_TIER_LABELS,
    configured_model_ladder,
    default_swico_tier,
    normalize_swico_tier,
)
from ..time_utils import ensure_utc, utc_now
from .pricing import price_usage


TOKENS_PER_PRICING_UNIT = 1_000_000
BLENDED_INPUT_PARTS = 70
BLENDED_OUTPUT_PARTS = 30
BLENDED_TOTAL_PARTS = BLENDED_INPUT_PARTS + BLENDED_OUTPUT_PARTS


def _reference_prices(tier: str) -> tuple[Any, Any]:
    selected = normalize_swico_tier(tier)
    model = configured_model_ladder(selected)[0]
    return (
        price_usage("openai", model, TOKENS_PER_PRICING_UNIT, 0),
        price_usage("openai", model, 0, TOKENS_PER_PRICING_UNIT),
    )


def _pricing_is_valid(tier: str) -> bool:
    try:
        input_price, output_price = _reference_prices(tier)
    except Exception:
        return False
    return int(input_price.micros) > 0 and int(output_price.micros) > 0


def paid_display_tier(tier: str = "lite") -> str:
    """Resolve the provider-neutral paid tier used to display token equivalents."""
    selected = normalize_swico_tier(tier, enforce_availability=False)
    if selected != "free":
        return selected

    configured_default = normalize_swico_tier(default_swico_tier())
    candidates = [configured_default, "lite"]
    for candidate in candidates:
        if candidate != "free" and _pricing_is_valid(candidate):
            return candidate
    # Keep the display basis deterministic even when pricing is unavailable;
    # token_estimate will mark the result unavailable rather than fabricating 0.
    return "lite"


def micros_for_blended_tokens(tokens: int, *, tier: str = "lite") -> int:
    """Return a tier-relative 70/30 estimate, rounded up to a micro-INR."""
    requested = max(0, int(tokens))
    selected = normalize_swico_tier(tier, enforce_availability=False)
    input_price, output_price = _reference_prices(
        paid_display_tier(selected) if selected == "free" else selected
    )
    numerator = requested * (
        int(input_price.micros) * BLENDED_INPUT_PARTS
        + int(output_price.micros) * BLENDED_OUTPUT_PARTS
    )
    denominator = TOKENS_PER_PRICING_UNIT * BLENDED_TOTAL_PARTS
    if numerator <= 0 or denominator <= 0:
        return 0
    return (numerator + denominator - 1) // denominator


def token_estimate(
    balance_micros: int, *, tier: str = "lite", now: datetime | None = None
) -> dict[str, Any]:
    """Return provider-neutral presentation metadata for internal micro-INR value."""
    selected = normalize_swico_tier(tier, enforce_availability=False)
    display_tier = paid_display_tier(selected)
    label = SWICO_TIER_LABELS[display_tier]
    pricing_as_of = ensure_utc(now or utc_now())
    available = max(0, int(balance_micros))
    base = {
        "tier": selected,
        "tier_label": SWICO_TIER_LABELS[selected],
        "selected_tier": selected,
        "display_tier": display_tier,
        "display_tier_label": label,
        "pricing_as_of": pricing_as_of,
        "blended_assumption": "70% input tokens and 30% output tokens; cached input excluded.",
        "estimate_available": False,
        "availability": "unavailable",
    }
    notice = (
        f"Estimated using {label} token-equivalent pricing. Actual usage depends on message size, "
        "response length, and task complexity."
    )
    try:
        input_price, output_price = _reference_prices(display_tier)
    except Exception:
        return {
            **base,
            "estimated_blended_tokens": None,
            "range_min_tokens": None,
            "range_max_tokens": None,
            "explanation": "Estimate temporarily unavailable.",
        }
    if input_price.micros <= 0 or output_price.micros <= 0:
        return {
            **base,
            "estimated_blended_tokens": None,
            "range_min_tokens": None,
            "range_max_tokens": None,
            "explanation": "Estimate temporarily unavailable.",
        }

    input_tokens = available * TOKENS_PER_PRICING_UNIT // int(input_price.micros)
    output_tokens = available * TOKENS_PER_PRICING_UNIT // int(output_price.micros)
    blended_price_numerator = (
        int(input_price.micros) * BLENDED_INPUT_PARTS
        + int(output_price.micros) * BLENDED_OUTPUT_PARTS
    )
    blended = (
        available * TOKENS_PER_PRICING_UNIT * BLENDED_TOTAL_PARTS
        // blended_price_numerator
    )
    return {
        **base,
        "estimated_blended_tokens": blended,
        "range_min_tokens": min(input_tokens, output_tokens),
        "range_max_tokens": max(input_tokens, output_tokens),
        "estimate_available": True,
        "availability": "available",
        "explanation": notice if selected != "free" else (
            f"Estimated token equivalent using {label} pricing; Swico Free has no paid allowance."
        ),
    }
