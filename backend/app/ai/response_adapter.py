from __future__ import annotations

import json
from typing import Any

try:
    from config import PIPELINE_VERSION
except Exception:  # pragma: no cover
    PIPELINE_VERSION = "ai_router_v1"

from .types import AIProviderResponse


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def ai_response_to_pipeline(response: AIProviderResponse) -> dict[str, Any]:
    language = str(response.language or "en").lower()
    text = str(response.text or "").strip()
    is_english = language == "en" and response.provider != "sarvam"
    direct_source = response.provider
    if isinstance(response.raw, dict) and response.raw.get("source"):
        direct_source = str(response.raw["source"])
    core_meta = {
        "provider": response.provider,
        "model_used": response.model,
        "route": response.route,
        "reason": response.reason,
        "intent": response.intent,
        "language": response.language,
        "estimated_cost_amount": response.estimated_cost_amount,
        "estimated_cost_currency": response.estimated_cost_currency,
    }
    if response.raw:
        core_meta["raw"] = response.raw

    pipeline = {
        "pipeline_version": PIPELINE_VERSION,
        "raw_english": text if is_english else "",
        "remodeled_english": text if is_english else "",
        "tamil_text": "" if is_english else text,
        "theni_tamil_text": "" if is_english else text,
        "direct_answer_source": direct_source,
        "direct_answer_confidence": "1.0000",
        "predicted_label": response.intent or "general",
        "risk_level": "high" if response.intent == "unsafe_or_sensitive" else "low",
        "route_taken": response.route or response.provider,
        "cache_hit": "true" if response.provider == "cache" else "false",
        "stage_notes": _json([response.reason] if response.reason else []),
        "core_meta": _json(core_meta),
        "remodel_meta": _json({}),
        "review_meta": _json({}),
        "translation_meta": _json({}),
        "timings_ms": _json({}),
        "model_used": response.model,
        "model_tier": _model_tier(response),
        "model_reason": response.reason,
        "provider": response.provider,
        "cost_estimate": response.estimated_cost_amount,
        "cost_currency": response.estimated_cost_currency,
    }
    if not is_english:
        pipeline["remodeled_english"] = text
    return pipeline


def _model_tier(response: AIProviderResponse) -> str:
    if response.provider == "openai":
        if response.model == "gpt-5-mini":
            return "reasoning"
        if response.model == "gpt-5-nano":
            return "cheap"
    if response.provider == "sarvam":
        if response.model == "sarvam-105b":
            return "reasoning"
        if response.model:
            return "indic"
    return response.provider
