from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from ..time_utils import ensure_utc, utc_now
from .pricing import price_usage


TOKENS_PER_PRICING_UNIT = 1_000_000
BLENDED_INPUT_PARTS = 70
BLENDED_OUTPUT_PARTS = 30
BLENDED_TOTAL_PARTS = BLENDED_INPUT_PARTS + BLENDED_OUTPUT_PARTS


def _reference_prices() -> tuple[str, str, Any, Any]:
    provider = os.getenv("USAGE_ESTIMATE_REFERENCE_PROVIDER", "openai").strip().lower()
    model = os.getenv("USAGE_ESTIMATE_REFERENCE_MODEL", "gpt-5-nano").strip()
    return (
        provider,
        model,
        price_usage(provider, model, TOKENS_PER_PRICING_UNIT, 0),
        price_usage(provider, model, 0, TOKENS_PER_PRICING_UNIT),
    )


def micros_for_blended_tokens(tokens: int) -> int:
    """Return the reference 70/30 blended value, rounded up to a whole micro-INR."""
    requested = max(0, int(tokens))
    _, _, input_price, output_price = _reference_prices()
    numerator = requested * (
        int(input_price.micros) * BLENDED_INPUT_PARTS
        + int(output_price.micros) * BLENDED_OUTPUT_PARTS
    )
    denominator = TOKENS_PER_PRICING_UNIT * BLENDED_TOTAL_PARTS
    if numerator <= 0 or denominator <= 0:
        return 0
    return (numerator + denominator - 1) // denominator


def token_estimate(
    balance_micros: int, *, now: datetime | None = None
) -> dict[str, Any]:
    """Estimate model-dependent tokens from internal micro-INR value.

    This is presentation metadata, never an entitlement or quota. All value
    conversion uses integer arithmetic and floors the result.
    """
    pricing_as_of = ensure_utc(now or utc_now())
    available = max(0, int(balance_micros))
    provider = os.getenv("USAGE_ESTIMATE_REFERENCE_PROVIDER", "openai").strip().lower()
    model = os.getenv("USAGE_ESTIMATE_REFERENCE_MODEL", "gpt-5-nano").strip()
    try:
        provider, model, input_price, output_price = _reference_prices()
    except Exception:
        return {
            "reference_provider": provider,
            "reference_model": model,
            "pricing_as_of": pricing_as_of,
            "pricing_snapshot": {},
            "estimated_input_only_tokens": 0,
            "estimated_output_only_tokens": 0,
            "estimated_blended_tokens": None,
            "blended_assumption": "70% input tokens and 30% output tokens; cached input excluded",
            "range_min_tokens": 0,
            "range_max_tokens": 0,
            "explanation": "Reference pricing is unavailable; no token estimate is available.",
        }
    pricing_snapshot = {
        "input": input_price.snapshot,
        "output": output_price.snapshot,
    }
    base = {
        "reference_provider": provider,
        "reference_model": model,
        "pricing_as_of": pricing_as_of,
        "pricing_snapshot": pricing_snapshot,
        "blended_assumption": "70% input tokens and 30% output tokens; cached input excluded",
    }
    if input_price.micros <= 0 or output_price.micros <= 0:
        return {
            **base,
            "estimated_input_only_tokens": 0,
            "estimated_output_only_tokens": 0,
            "estimated_blended_tokens": None,
            "range_min_tokens": 0,
            "range_max_tokens": 0,
            "explanation": "This reference model does not have chargeable pricing configured; no token estimate is available.",
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
        "estimated_input_only_tokens": input_tokens,
        "estimated_output_only_tokens": output_tokens,
        "estimated_blended_tokens": blended,
        "range_min_tokens": min(input_tokens, output_tokens),
        "range_max_tokens": max(input_tokens, output_tokens),
        "explanation": (
            f"Estimated using {provider}/{model} pricing. Actual token usage varies "
            "by model, provider, cached input and input/output mix."
        ),
    }
