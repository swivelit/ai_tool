import pytest

from app.ai.model_health import clear_model_health, mark_model_unavailable
from app.ai.router import AIProviderRouter
from app.ai.swico_tiers import SwicoTierUnavailableError
from app.ai.types import AIRequest
from app.openai_model_router import OpenAIModelRouter


def _models(selections):
    return [selection.model for selection in selections]


def _public_defaults(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "gpt-5-nano")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-4.1-nano,gpt-4o-mini")
    monkeypatch.setenv("OPENAI_MODEL_REASONING_PRIMARY", "gpt-5-mini")
    monkeypatch.setenv("OPENAI_MODEL_REASONING_LIGHT_PRIMARY", "gpt-4.1-mini")
    monkeypatch.setenv("OPENAI_MODEL_REASONING_FALLBACKS", "gpt-4.1-mini,gpt-4o-mini")
    monkeypatch.setenv("OPENAI_DISABLED_MODELS", "")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "true")


def test_compiler_explanation_uses_cheap_general_ladder(monkeypatch):
    _public_defaults(monkeypatch)
    router = OpenAIModelRouter()

    selections = router.select_candidates("normal_qa", "What is a compiler?")

    assert _models(selections)[:3] == ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"]
    assert selections[0].tier == "cheap"
    assert router.last_selection_metadata["primary_model_candidate"] == "gpt-5-nano"
    assert router.last_selection_metadata["selected_model_reason"] == "cost_optimizer_choice"
    assert router.classify_task("What is a compiler?") == "normal_qa"


def test_simple_education_stays_on_cheap_ladder(monkeypatch):
    _public_defaults(monkeypatch)
    selections = OpenAIModelRouter().select_candidates(
        "normal_qa",
        "Explain what a compiler is in simple terms",
    )

    assert _models(selections)[:3] == ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"]


def test_architecture_and_debug_use_reasoning_ladder(monkeypatch):
    _public_defaults(monkeypatch)
    router = OpenAIModelRouter()

    architecture = router.select_candidates("normal_qa", "Design the backend architecture for my app")
    debug = router.select_candidates("normal_qa", "Debug this React Native stack trace: TypeError at App.tsx")

    assert "gpt-5-mini" in _models(architecture)
    assert "gpt-4.1-mini" in _models(architecture)
    assert architecture[0].model == "gpt-5-mini"
    assert "gpt-5-mini" in _models(debug)
    assert "gpt-4.1-mini" in _models(debug)


def test_o4_mini_not_used_for_free_users_by_default(monkeypatch):
    _public_defaults(monkeypatch)
    monkeypatch.delenv("OPENAI_ENABLE_O_SERIES_FOR_FREE", raising=False)

    selections = OpenAIModelRouter().select_candidates(
        "hard_reasoning",
        "Solve a hard system design problem",
        user_tier="free",
    )

    assert "o4-mini" not in _models(selections)


def test_flagship_models_disabled_for_free_users(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "gpt-5.5")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-5.4-mini,gpt-4o-mini")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "true")

    selections = OpenAIModelRouter().select_candidates("normal_qa", "What is a compiler?", user_tier="free")

    assert _models(selections) == ["gpt-4o-mini"]


def test_skipped_primary_model_records_disabled_reason(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "gpt-5")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-4.1-nano,gpt-4o-mini")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "true")
    router = OpenAIModelRouter()

    selections = router.select_candidates("normal_qa", "What is a compiler?", user_tier="free")

    assert selections[0].model == "gpt-4.1-nano"
    assert router.last_selection_metadata["primary_model_candidate"] == "gpt-5"
    assert router.last_selection_metadata["selected_model_reason"] == "primary_model_disabled"
    assert router.last_selection_metadata["skipped_models"][0]["reason"] == "primary_model_disabled"


def test_legacy_completion_models_are_not_used_for_chat_routes(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "babbage-002")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "davinci-002,gpt-4o-mini")

    selections = OpenAIModelRouter().select_candidates("normal_qa", "What is a compiler?", user_tier="free")

    assert _models(selections) == ["gpt-4o-mini"]


def test_ai_provider_router_sets_openai_candidate_ladder(monkeypatch):
    _public_defaults(monkeypatch)
    route = AIProviderRouter().select_route(
        AIRequest(
            user_id=1,
            message="What is a compiler?",
            reply_language="en",
            channel="text",
            request_id="ladder-route",
            metadata={},
        )
    )

    assert route.provider == "openai"
    assert route.intent == "general"
    assert route.model == "gpt-5-nano"
    assert route.model_candidates[:3] == ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"]
    assert route.provider_endpoint_candidates[0] == "responses"


@pytest.mark.parametrize(
    ("tier", "expected"),
    [
        ("lite", ["gpt-5.4-mini", "gpt-5.4-nano"]),
        ("standard", ["gpt-5.6-terra", "gpt-5.5"]),
        ("pro", ["gpt-5.6-sol", "gpt-5.6-terra"]),
    ],
)
def test_swico_tiers_use_only_their_configured_ladder(monkeypatch, tier, expected):
    monkeypatch.setenv("SWICO_PRO_ENABLED", "true")
    monkeypatch.setenv(f"SWICO_{tier.upper()}_MODEL_PRIMARY", expected[0])
    monkeypatch.setenv(f"SWICO_{tier.upper()}_MODEL_FALLBACKS", expected[1])
    monkeypatch.setenv("OPENAI_DISABLED_MODELS", "")
    clear_model_health()
    selections = OpenAIModelRouter().select_swico_candidates(
        tier, "The same task must not change public ladders", user_tier="paid"
    )
    assert _models(selections) == expected
    assert all(selection.endpoint == "responses" for selection in selections)


def test_swico_tier_never_crosses_to_another_ladder_when_unavailable(monkeypatch):
    monkeypatch.setenv("SWICO_STANDARD_MODEL_PRIMARY", "gpt-5.6-terra")
    monkeypatch.setenv("SWICO_STANDARD_MODEL_FALLBACKS", "gpt-5.5")
    monkeypatch.setenv("SWICO_LITE_MODEL_PRIMARY", "gpt-5.4-mini")
    monkeypatch.setenv("SWICO_LITE_MODEL_FALLBACKS", "gpt-5.4-nano")
    clear_model_health()
    mark_model_unavailable("openai", "gpt-5.6-terra", "responses", "test")
    mark_model_unavailable("openai", "gpt-5.5", "responses", "test")
    with pytest.raises(SwicoTierUnavailableError):
        OpenAIModelRouter().select_swico_candidates(
            "standard", "Do not downgrade this request", user_tier="paid"
        )
    clear_model_health()


def test_web_router_uses_product_tier_separately_from_permission_tier(monkeypatch):
    monkeypatch.setenv("SWICO_STANDARD_MODEL_PRIMARY", "gpt-5.6-terra")
    monkeypatch.setenv("SWICO_STANDARD_MODEL_FALLBACKS", "gpt-5.5")
    clear_model_health()
    route = AIProviderRouter().select_route(AIRequest(
        user_id=1, message="Write code", reply_language="en", channel="text",
        request_id="swico-route", metadata={
            "client_surface": "web", "swico_tier": "standard", "user_tier": "paid",
        },
    ))
    assert route.model_candidates == ["gpt-5.6-terra", "gpt-5.5"]
    assert route.metadata["swico_tier"] == "standard"
