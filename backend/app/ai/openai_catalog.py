from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal, Optional


OpenAIEndpoint = Literal["responses", "chat_completions"]
LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
LONG_CONTEXT_MODELS = frozenset({"gpt-5.5", "gpt-5.6-terra", "gpt-5.6-sol"})
CURRENT_SWICO_STANDARD_RATES: dict[str, tuple[str, str, str]] = {
    "gpt-5.4-mini": ("0.75", "0.075", "4.50"),
    "gpt-5.4-nano": ("0.20", "0.02", "1.25"),
    "gpt-5.5": ("5.00", "0.50", "30.00"),
    "gpt-5.6-terra": ("2.50", "0.25", "15.00"),
    "gpt-5.6-sol": ("5.00", "0.50", "30.00"),
}


class OpenAIPricingConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class OpenAIModelSpec:
    model: str
    family: str
    tier: str
    endpoint: OpenAIEndpoint
    input_price_per_1m: float
    cached_input_price_per_1m: Optional[float]
    output_price_per_1m: float
    supports_temperature: bool
    supports_response_format: bool
    supports_reasoning_effort: bool
    supports_tools: bool
    free_user_allowed: bool
    supports_vision: bool = False
    admin_only: bool = False
    enabled_by_default: bool = True


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_float(name: str, default: float) -> float:
    try:
        return max(0.0, float(str(os.getenv(name, default)).strip()))
    except Exception:
        return float(default)


def _env_endpoint(name: str, default: OpenAIEndpoint) -> OpenAIEndpoint:
    api_mode = str(os.getenv("OPENAI_API_MODE", "auto") or "auto").strip().lower()
    if api_mode in {"responses", "response"}:
        return "responses"
    if api_mode in {"chat", "chat_completions", "chat-completions"}:
        return "chat_completions"
    raw = str(os.getenv(name, "") or "").strip().lower()
    if raw in {"responses", "response"}:
        return "responses"
    if raw in {"chat", "chat_completions", "chat-completions"}:
        return "chat_completions"
    return default


def _price_key(model: str) -> str:
    return model.upper().replace("-", "_").replace(".", "_")


def price_environment_names(model: str) -> tuple[str, str, str]:
    key = _price_key(model)
    return (
        f"OPENAI_PRICE_{key}_INPUT_PER_1M",
        f"OPENAI_PRICE_{key}_CACHED_INPUT_PER_1M",
        f"OPENAI_PRICE_{key}_OUTPUT_PER_1M",
    )


def pricing_multipliers(model: str, input_tokens: int) -> tuple[float, float, str]:
    if str(model or "").strip() in LONG_CONTEXT_MODELS and int(input_tokens) > LONG_CONTEXT_THRESHOLD_TOKENS:
        return 2.0, 1.5, "long_context_over_272000"
    return 1.0, 1.0, "standard_context"


def _production_tier_references_model(model: str) -> bool:
    tier_names = ["LITE", "STANDARD"]
    if _env_bool("SWICO_PRO_ENABLED", False):
        tier_names.append("PRO")
    for tier_name in tier_names:
        primary = str(os.getenv(f"SWICO_{tier_name}_MODEL_PRIMARY", "") or "").strip()
        fallbacks = {
            item.strip()
            for item in str(os.getenv(f"SWICO_{tier_name}_MODEL_FALLBACKS", "") or "").split(",")
            if item.strip()
        }
        if model == primary or model in fallbacks:
            return True
    return False


def _rates(model: str, default_input: float, default_cached: Optional[float], default_output: float) -> tuple[float, Optional[float], float]:
    input_name, cached_name, output_name = price_environment_names(model)
    cached_default = 0.0 if default_cached is None else default_cached
    production = str(os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "development"))).strip().lower() in {"prod", "production"}
    if production and _production_tier_references_model(model):
        required = (input_name, output_name) if default_cached is None else (input_name, cached_name, output_name)
        expected = dict(zip(
            (input_name, cached_name, output_name),
            CURRENT_SWICO_STANDARD_RATES.get(model, (str(default_input), str(cached_default), str(default_output))),
        ))
        invalid = []
        for name in required:
            try:
                if (
                    name not in os.environ
                    or float(str(os.environ[name]).strip()) <= 0
                    or float(str(os.environ[name]).strip()) != float(expected[name])
                ):
                    invalid.append(name)
            except (TypeError, ValueError):
                invalid.append(name)
        if invalid:
            raise OpenAIPricingConfigurationError(
                "Missing or invalid OpenAI pricing variables: " + ", ".join(invalid)
            )
    cached = _env_float(cached_name, cached_default)
    return (
        _env_float(input_name, default_input),
        cached if default_cached is not None else None,
        _env_float(output_name, default_output),
    )


def _spec(
    model: str,
    *,
    family: str,
    tier: str,
    endpoint: OpenAIEndpoint,
    default_input: float,
    default_cached: Optional[float],
    default_output: float,
    supports_temperature: bool,
    supports_response_format: bool,
    supports_reasoning_effort: bool,
    supports_tools: bool,
    free_user_allowed: bool,
    admin_only: bool = False,
    enabled_by_default: bool = True,
) -> OpenAIModelSpec:
    input_rate, cached_rate, output_rate = _rates(model, default_input, default_cached, default_output)
    return OpenAIModelSpec(
        model=model,
        family=family,
        tier=tier,
        endpoint=endpoint,
        input_price_per_1m=input_rate,
        cached_input_price_per_1m=cached_rate,
        output_price_per_1m=output_rate,
        supports_temperature=supports_temperature,
        supports_response_format=supports_response_format,
        supports_reasoning_effort=supports_reasoning_effort,
        supports_tools=supports_tools,
        free_user_allowed=free_user_allowed,
        supports_vision=(
            family not in {"embedding-3", "gpt-3.5"}
        ),
        admin_only=admin_only,
        enabled_by_default=enabled_by_default,
    )


def get_openai_model_catalog() -> dict[str, OpenAIModelSpec]:
    """Return the model compatibility and pricing catalog.

    The defaults are intentionally conservative for public/free traffic. Model
    availability still depends on the account; provider calls can mark a model
    temporarily unavailable and use the next catalog candidate.
    """

    gpt41_nano_endpoint = _env_endpoint("OPENAI_MODEL_ENDPOINT_GPT_4_1_NANO", "chat_completions")
    return {
        "text-embedding-3-small": _spec(
            "text-embedding-3-small",
            family="embedding-3",
            tier="embedding",
            endpoint="responses",
            default_input=0.02,
            default_cached=None,
            default_output=0.0,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=False,
            supports_tools=False,
            free_user_allowed=False,
        ),
        "gpt-5-nano": _spec(
            "gpt-5-nano",
            family="gpt-5",
            tier="cheap",
            endpoint="responses",
            default_input=0.05,
            default_cached=0.005,
            default_output=0.40,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-5-mini": _spec(
            "gpt-5-mini",
            family="gpt-5",
            tier="reasoning",
            endpoint="responses",
            default_input=0.25,
            default_cached=0.025,
            default_output=2.00,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-5.4-mini": _spec(
            "gpt-5.4-mini",
            family="gpt-5.4",
            tier="swico_lite",
            endpoint="responses",
            default_input=0.75,
            default_cached=0.075,
            default_output=4.50,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-5.4-nano": _spec(
            "gpt-5.4-nano",
            family="gpt-5.4",
            tier="swico_lite",
            endpoint="responses",
            default_input=0.20,
            default_cached=0.02,
            default_output=1.25,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-5.5": _spec(
            "gpt-5.5",
            family="gpt-5.5",
            tier="swico_standard",
            endpoint="responses",
            default_input=5.00,
            default_cached=0.50,
            default_output=30.00,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-5.6-terra": _spec(
            "gpt-5.6-terra",
            family="gpt-5.6",
            tier="swico_standard",
            endpoint="responses",
            default_input=2.50,
            default_cached=0.25,
            default_output=15.00,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-5.6-sol": _spec(
            "gpt-5.6-sol",
            family="gpt-5.6",
            tier="swico_pro",
            endpoint="responses",
            default_input=5.00,
            default_cached=0.50,
            default_output=30.00,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-4.1-nano": _spec(
            "gpt-4.1-nano",
            family="gpt-4.1",
            tier="cheap_fallback",
            endpoint=gpt41_nano_endpoint,
            default_input=0.10,
            default_cached=0.025,
            default_output=0.40,
            supports_temperature=True,
            supports_response_format=True,
            supports_reasoning_effort=False,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-4.1-mini": _spec(
            "gpt-4.1-mini",
            family="gpt-4.1",
            tier="reasoning_light",
            endpoint="chat_completions",
            default_input=0.40,
            default_cached=0.10,
            default_output=1.60,
            supports_temperature=True,
            supports_response_format=True,
            supports_reasoning_effort=False,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "gpt-4o-mini": _spec(
            "gpt-4o-mini",
            family="gpt-4o",
            tier="cheap_fallback",
            endpoint="chat_completions",
            default_input=0.15,
            default_cached=0.075,
            default_output=0.60,
            supports_temperature=True,
            supports_response_format=True,
            supports_reasoning_effort=False,
            supports_tools=True,
            free_user_allowed=True,
        ),
        "o4-mini": _spec(
            "o4-mini",
            family="o-series",
            tier="hard_reasoning",
            endpoint="responses",
            default_input=1.10,
            default_cached=0.275,
            default_output=4.40,
            supports_temperature=False,
            supports_response_format=False,
            supports_reasoning_effort=True,
            supports_tools=True,
            free_user_allowed=_env_bool("OPENAI_ENABLE_O_SERIES_FOR_FREE", False),
            admin_only=not _env_bool("OPENAI_ENABLE_O_SERIES_FOR_FREE", False),
        ),
        "gpt-3.5-turbo-0125": _spec(
            "gpt-3.5-turbo-0125",
            family="gpt-3.5",
            tier="emergency_fallback",
            endpoint="chat_completions",
            default_input=0.50,
            default_cached=None,
            default_output=1.50,
            supports_temperature=True,
            supports_response_format=True,
            supports_reasoning_effort=False,
            supports_tools=True,
            free_user_allowed=True,
            enabled_by_default=_env_bool("OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK", False),
        ),
    }


def get_model_spec(model: str) -> OpenAIModelSpec:
    catalog = get_openai_model_catalog()
    normalized = str(model or "").strip()
    if normalized in catalog:
        return catalog[normalized]
    input_rate, cached_rate, output_rate = _rates(normalized or "unknown", 0.15, 0.075, 0.60)
    return OpenAIModelSpec(
        model=normalized,
        family="custom",
        tier="custom",
        # Unknown/custom models must opt into Chat Completions explicitly. The
        # safe compatibility default is the Responses API.
        endpoint=_env_endpoint(f"OPENAI_MODEL_ENDPOINT_{_price_key(normalized)}", "responses"),
        input_price_per_1m=input_rate,
        cached_input_price_per_1m=cached_rate,
        output_price_per_1m=output_rate,
        supports_temperature=False,
        supports_response_format=False,
        supports_reasoning_effort=False,
        supports_tools=False,
        free_user_allowed=True,
        supports_vision=_env_bool(
            f"OPENAI_MODEL_SUPPORTS_VISION_{_price_key(normalized)}", False
        ),
        enabled_by_default=True,
    )


def estimate_model_cost(
    model: str, input_tokens: int, output_tokens: int,
    cached_input_tokens: int = 0, cache_write_tokens: int = 0,
) -> float:
    spec = get_model_spec(model)
    total_input = max(
        0,
        int(input_tokens),
        int(cached_input_tokens) + max(0, int(cache_write_tokens)),
    )
    input_multiplier, output_multiplier, _rule = pricing_multipliers(
        model, total_input
    )
    cached = min(max(0, int(cached_input_tokens)), total_input)
    uncached = max(0, total_input - cached)
    cached_rate = spec.cached_input_price_per_1m or spec.input_price_per_1m
    return (
        (uncached / 1_000_000.0)
        * spec.input_price_per_1m
        * input_multiplier
        + (cached / 1_000_000.0)
        * cached_rate
        * input_multiplier
        + (max(0, output_tokens) / 1_000_000.0)
        * spec.output_price_per_1m
        * output_multiplier
    )
