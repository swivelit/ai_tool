from __future__ import annotations

import json
import os
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from typing import Any

from ..ai.openai_catalog import get_model_spec, pricing_multipliers

MICROS_PER_INR = Decimal("1000000")
PAISE_PER_INR = Decimal("100")
MILLION = Decimal("1000000")
MILLISECONDS_PER_HOUR = Decimal("3600000")
TEN_THOUSAND = Decimal("10000")


def env_decimal(name: str, default: str) -> Decimal:
    try:
        return Decimal(str(os.getenv(name, default)).strip())
    except Exception:
        return Decimal(default)


def credit_percent() -> Decimal:
    return env_decimal("BILLING_CREDIT_PERCENT", "50")


def calculate_topup(gross_amount_paise: int) -> tuple[int, int]:
    """Return credit micros and platform paise; fractional paise always go to the platform."""
    gross = int(gross_amount_paise)
    credit_paise = int((Decimal(gross) * credit_percent() / Decimal("100")).to_integral_value(rounding=ROUND_FLOOR))
    return credit_paise * 10_000, gross - credit_paise


def estimate_tokens(text: str) -> int:
    # Deliberately conservative for multilingual text and provider instructions.
    return max(1, (len(str(text or "").encode("utf-8")) + 2) // 3)


@dataclass(frozen=True)
class PriceResult:
    amount: Decimal
    currency: str
    micros: int
    snapshot: dict[str, Any]


def _ceil_micros(value_inr: Decimal) -> int:
    markup = env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")
    return int((value_inr * markup * MICROS_PER_INR).to_integral_value(rounding=ROUND_CEILING))


def openai_price(
    model: str, input_tokens: int, output_tokens: int,
    cached_input_tokens: int = 0, cache_write_tokens: int = 0,
) -> PriceResult:
    spec = get_model_spec(model)
    writes = max(0, int(cache_write_tokens))
    # Some provider payloads report cache creation separately from total input.
    # Expanding the billable total prevents that representation from silently
    # undercharging a cache write.
    total_input = max(
        0, int(input_tokens), max(0, int(cached_input_tokens)) + writes
    )
    cached = min(max(0, int(cached_input_tokens)), total_input)
    uncached = total_input - cached
    input_multiplier, output_multiplier, pricing_rule = pricing_multipliers(
        model, input_tokens
    )
    input_factor = Decimal(str(input_multiplier))
    output_factor = Decimal(str(output_multiplier))
    amount_usd = (
        Decimal(uncached) * Decimal(str(spec.input_price_per_1m)) * input_factor
        + Decimal(cached) * Decimal(str(spec.cached_input_price_per_1m or spec.input_price_per_1m)) * input_factor
        + Decimal(max(0, int(output_tokens))) * Decimal(str(spec.output_price_per_1m)) * output_factor
    ) / MILLION
    fx = env_decimal("USD_TO_INR_BILLING_RATE", "90")
    buffer_percent = env_decimal("OPENAI_FX_BUFFER_PERCENT", "3")
    inr = amount_usd * fx * (Decimal("1") + buffer_percent / Decimal("100"))
    snapshot = {
        "provider": "openai", "model": model,
        "input_usd_per_1m": str(spec.input_price_per_1m),
        "cached_input_usd_per_1m": str(spec.cached_input_price_per_1m or spec.input_price_per_1m),
        "cache_write_input_usd_per_1m": str(spec.input_price_per_1m),
        "cache_write_tokens": writes,
        "output_usd_per_1m": str(spec.output_price_per_1m),
        "pricing_rule": pricing_rule,
        "input_price_multiplier": str(input_factor),
        "output_price_multiplier": str(output_factor),
        "usd_to_inr_rate": str(fx), "fx_buffer_percent": str(buffer_percent),
        "usage_markup_multiplier": str(env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")),
    }
    return PriceResult(amount=amount_usd, currency="USD", micros=_ceil_micros(inr), snapshot=snapshot)


def openai_reported_price(model: str, amount_usd: Decimal, snapshot: dict[str, Any]) -> PriceResult:
    fx = env_decimal("USD_TO_INR_BILLING_RATE", "90")
    buffer_percent = env_decimal("OPENAI_FX_BUFFER_PERCENT", "3")
    inr = amount_usd * fx * (Decimal("1") + buffer_percent / Decimal("100"))
    return PriceResult(
        amount=amount_usd, currency="USD", micros=_ceil_micros(inr),
        snapshot={
            **snapshot, "provider": "openai", "model": model,
            "provider_cost_source": "actual_provider_metadata", "usd_to_inr_rate": str(fx),
            "fx_buffer_percent": str(buffer_percent),
            "usage_markup_multiplier": str(env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")),
        },
    )


def sarvam_price(
    model: str, input_tokens: int, output_tokens: int,
    cached_input_tokens: int = 0, cache_write_tokens: int = 0,
) -> PriceResult:
    large = "105" in str(model).lower()
    prefix = "105B" if large else "30B"
    input_rate = env_decimal(
        f"SARVAM_PRICE_{prefix}_INPUT_INR_PER_1M",
        "29.28" if large else "2.5",
    )
    cached_rate = env_decimal(
        f"SARVAM_PRICE_{prefix}_CACHED_INPUT_INR_PER_1M",
        "10.98" if large else "1.5",
    )
    output_rate = env_decimal(
        f"SARVAM_PRICE_{prefix}_OUTPUT_INR_PER_1M",
        "73.2" if large else "10.0",
    )
    total_input = max(
        0,
        int(input_tokens),
        int(cached_input_tokens) + max(0, int(cache_write_tokens)),
    )
    uncached = max(0, total_input - int(cached_input_tokens))
    amount_inr = (
        Decimal(uncached) * input_rate
        + Decimal(max(0, int(cached_input_tokens))) * cached_rate
        + Decimal(max(0, int(output_tokens))) * output_rate
    ) / MILLION
    snapshot = {
        "provider": "sarvam", "model": model,
        "input_inr_per_1m": str(input_rate), "cached_input_inr_per_1m": str(cached_rate),
        "output_inr_per_1m": str(output_rate),
        "usage_markup_multiplier": str(env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")),
    }
    return PriceResult(amount=amount_inr, currency="INR", micros=_ceil_micros(amount_inr), snapshot=snapshot)


def stt_price(audio_milliseconds: int) -> PriceResult:
    """Price Sarvam speech-to-text from an integer duration without floats."""
    duration = max(0, int(audio_milliseconds))
    rate = env_decimal("SARVAM_PRICE_STT_INR_PER_HOUR", "30")
    amount_inr = Decimal(duration) * rate / MILLISECONDS_PER_HOUR
    markup = env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")
    return PriceResult(
        amount=amount_inr,
        currency="INR",
        micros=_ceil_micros(amount_inr),
        snapshot={
            "provider": "sarvam",
            "usage_kind": "stt",
            "rate_inr_per_hour": str(rate),
            "audio_milliseconds": duration,
            "formula": "audio_milliseconds * rate_inr_per_hour / 3600000",
            "usage_markup_multiplier": str(markup),
        },
    )


def tts_price(characters: int, model: str) -> PriceResult:
    """Price Sarvam text-to-speech from an integer character count."""
    count = max(0, int(characters))
    normalized_model = str(model or "").strip() or "bulbul:v2"
    version = "V3" if "v3" in normalized_model.lower() else "V2"
    variable = f"SARVAM_PRICE_TTS_{version}_INR_PER_10K_CHARS"
    rate = env_decimal(variable, "30" if version == "V3" else "15")
    amount_inr = Decimal(count) * rate / TEN_THOUSAND
    markup = env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")
    return PriceResult(
        amount=amount_inr,
        currency="INR",
        micros=_ceil_micros(amount_inr),
        snapshot={
            "provider": "sarvam",
            "usage_kind": "tts",
            "model": normalized_model,
            "rate_variable": variable,
            "rate_inr_per_10k_characters": str(rate),
            "characters": count,
            "formula": "characters * rate_inr_per_10k_characters / 10000",
            "usage_markup_multiplier": str(markup),
        },
    )


def price_usage(
    provider: str, model: str, input_tokens: int, output_tokens: int,
    cached_input_tokens: int = 0, cache_write_tokens: int = 0,
) -> PriceResult:
    if provider == "openai":
        return openai_price(
            model, input_tokens, output_tokens,
            cached_input_tokens, cache_write_tokens,
        )
    if provider == "sarvam":
        return sarvam_price(
            model, input_tokens, output_tokens,
            cached_input_tokens, cache_write_tokens,
        )
    return PriceResult(Decimal("0"), "INR", 0, {"provider": provider, "zero_charge": True})


def reserve_price(provider: str, model: str, input_tokens: int, max_output_tokens: int) -> PriceResult:
    base = price_usage(provider, model, input_tokens, max_output_tokens)
    multiplier = env_decimal("BILLING_RESERVE_MULTIPLIER", "1.25")
    micros = int((Decimal(base.micros) * multiplier).to_integral_value(rounding=ROUND_CEILING))
    return PriceResult(base.amount, base.currency, micros, {**base.snapshot, "reserve_multiplier": str(multiplier)})


def snapshot_json(snapshot: dict[str, Any]) -> str:
    return json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
