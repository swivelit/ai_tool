from __future__ import annotations

import pytest

from app.ai.provider_pool import (
    EmbeddingProviderRouter,
    MultiProviderBroker,
    ProviderHealthRegistry,
    ProviderTriagPlanner,
    configured_provider_aliases,
)
from app.ai.types import AIRequest


def _request(message: str, language: str = "en", **metadata: object) -> AIRequest:
    return AIRequest(
        user_id=1,
        message=message,
        reply_language=language,
        channel="text",
        request_id="provider-pool-test",
        metadata={"client_surface": "web", **metadata},
    )


def test_aliases_are_provider_model_pairs_and_free_stays_outside_pool():
    aliases = configured_provider_aliases({})
    assert set(aliases) == {
        "lite_fast", "lite_multilingual", "standard_balanced",
        "standard_multilingual", "pro_reasoning", "pro_multilingual",
        "vision_primary", "embedding_primary",
    }
    with pytest.raises(ValueError):
        configured_provider_aliases({"SWICO_MODEL_ALIAS_LITE_FAST": "vendor/model"})
    with pytest.raises(ValueError):
        ProviderTriagPlanner().plan(_request("Hi", "en"), "free")


@pytest.mark.parametrize(
    ("tier", "message", "language", "alias"),
    [
        ("lite", "What is photosynthesis?", "en", "lite_fast"),
        ("lite", "Indha question-ku answer sollunga", "tanglish", "lite_multilingual"),
        ("standard", "What is 2 + 2?", "en", "lite_fast"),
        ("pro", "Debug this algorithm and explain the complexity", "en", "pro_reasoning"),
        ("pro", "हिंदी में समझाइए", "hi", "pro_multilingual"),
    ],
)
def test_provider_pool_selects_tier_and_language_alias(tier, message, language, alias):
    route = MultiProviderBroker().plan(
        _request(message, language, swico_tier=tier), tier, max_output_tokens=420
    )
    assert route.metadata["provider_pool_alias"] == alias
    assert route.metadata["provider_pool_enabled"] is True


def test_image_uses_vision_alias_without_dual_generation():
    route = MultiProviderBroker().plan(
        _request("Describe this image", "en", swico_tier="standard", image_uploads=True),
        "standard",
        max_output_tokens=420,
    )
    assert route.metadata["provider_pool_alias"] == "vision_primary"
    assert route.metadata["provider_pool_alternate_provider"] == ""


def test_verifier_and_repair_use_opposite_provider():
    route = MultiProviderBroker().plan(
        _request("Explain this", "en", swico_tier="standard"),
        "standard",
        max_output_tokens=420,
    )
    planner = ProviderTriagPlanner()
    verifier = planner.verifier_route(route)
    repair = planner.repair_route(route, max_output_tokens=420)
    assert verifier is not None and repair is not None
    assert verifier.provider != route.provider
    assert repair.provider != route.provider


def test_pool_switches_away_from_marked_unhealthy_primary():
    planner = ProviderTriagPlanner(health=ProviderHealthRegistry({"openai"}))
    route = planner.route(
        _request("Explain this", "en", swico_tier="standard"),
        "standard",
        max_output_tokens=420,
    )
    assert route.provider == "sarvam"


def test_provider_scoring_uses_language_task_cost_and_local_health_telemetry():
    planner = ProviderTriagPlanner(
        health=ProviderHealthRegistry(
            telemetry={
                "openai": {"cost_score": 0.2, "latency_score": 0.9},
                "sarvam": {"cost_score": 0.8, "latency_score": 0.1},
            }
        )
    )
    english = planner.route(
        _request("What is 2 + 2?", "en"), "lite", max_output_tokens=420
    )
    indic = planner.route(
        _request("समझाइए", "hi"), "lite", max_output_tokens=420
    )
    assert english.metadata["provider_pool_alias"] == "lite_fast"
    assert indic.metadata["provider_pool_alias"] == "lite_multilingual"


def test_explicit_aliases_can_be_required_for_production_rollout():
    with pytest.raises(ValueError, match="SWICO_MODEL_ALIAS_LITE_FAST"):
        configured_provider_aliases({}, require_explicit=True)


def test_embedding_router_keeps_free_local_and_paid_alias_separate():
    assert EmbeddingProviderRouter().route("free").provider == "swico_free"
    paid = EmbeddingProviderRouter().route("lite")
    assert paid.name == "embedding_primary"
    assert paid.provider == "openai"
