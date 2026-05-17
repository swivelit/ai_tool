from __future__ import annotations

from sqlmodel import select

import app.openai_model_router as model_router_module
from app.database import SessionLocal
from app.models import OpenAIUsageLog
from app.openai_model_router import OpenAIModelRouter, get_today_estimated_openai_spend, record_openai_usage
from app.openai_tracked import OpenAIBudgetExceededError, get_tracked_chat_completion_metadata, tracked_chat_completion, tracked_embedding


MODEL_ENV_VARS = (
    "OPENAI_MODEL_CHEAP_PRIMARY",
    "OPENAI_MODEL_CHEAP_FALLBACKS",
    "OPENAI_MODEL_REASONING_LIGHT_PRIMARY",
    "OPENAI_MODEL_REASONING_PRIMARY",
    "OPENAI_MODEL_REASONING_FALLBACKS",
    "OPENAI_MODEL_HARD_REASONING",
    "OPENAI_MODEL_CHEAP",
    "OPENAI_MODEL_STANDARD",
    "OPENAI_MODEL_REASONING",
    "OPENAI_MODEL_HIGH",
    "OPENAI_JSON_MODEL",
    "OPENAI_MODEL",
)


def _clear_model_env(monkeypatch):
    for name in MODEL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def test_model_router_uses_safe_default_when_env_models_are_missing(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setattr(model_router_module, "CONFIG_OPENAI_MODEL_DEFAULT", "")
    router = OpenAIModelRouter()

    selected = router.select_model("normal_qa", "What is a compiler?")

    assert selected.model == "gpt-5-nano"
    assert selected.model.strip()


def test_model_router_respects_explicit_env_models(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-env-model")
    monkeypatch.setenv("OPENAI_MODEL_STANDARD", "standard-env-model")
    monkeypatch.setenv("OPENAI_MODEL_REASONING", "reasoning-env-model")
    monkeypatch.setenv("OPENAI_MODEL_HIGH", "high-env-model")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "false")
    monkeypatch.setenv("OPENAI_HIGH_MODEL_ALLOWLIST", "highest")
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "10")
    router = OpenAIModelRouter()

    assert router.select_model("classification", "classify this").model == "cheap-env-model"
    assert router.select_model("normal_qa", "latest news", needs_live_data=True).model == "cheap-env-model"
    assert (
        router.select_model("normal_qa", "Design a multi-step coding architecture.").model
        == "reasoning-env-model"
    )
    assert router.select_model("highest", "Use the highest model.", route="highest").model == "high-env-model"


def test_select_model_never_returns_empty_model(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setattr(model_router_module, "CONFIG_OPENAI_MODEL_DEFAULT", "")
    router = OpenAIModelRouter()

    selections = [
        router.select_model("classification", "classify this"),
        router.select_model("normal_qa", "Explain black holes simply."),
        router.select_model("normal_qa", "Design a multi-step coding architecture."),
        router.select_model("normal_qa", "latest IPL score", needs_live_data=True),
        router.select_model("highest", "Use the highest model.", route="highest"),
    ]

    assert all(selection.model.strip() for selection in selections)


def test_model_router_uses_cheap_for_classification(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-model")
    monkeypatch.setenv("OPENAI_MODEL_STANDARD", "standard-model")
    router = OpenAIModelRouter()

    selected = router.select_model("classification", "classify this")

    assert selected.model == "cheap-model"
    assert selected.tier == "cheap"


def test_model_router_uses_cheap_or_standard_for_simple_qa(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-model")
    monkeypatch.setenv("OPENAI_MODEL_STANDARD", "standard-model")
    monkeypatch.delenv("OPENAI_NORMAL_QA_USE_STANDARD", raising=False)
    router = OpenAIModelRouter()

    selected = router.select_model("normal_qa", "What is a compiler?")

    assert selected.model == "cheap-model"
    assert selected.tier == "cheap"


def test_model_router_uses_reasoning_for_complex_coding(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-model")
    monkeypatch.setenv("OPENAI_MODEL_STANDARD", "standard-model")
    monkeypatch.setenv("OPENAI_MODEL_REASONING", "reasoning-model")
    router = OpenAIModelRouter()

    selected = router.select_model(
        "normal_qa",
        "Design a multi-step coding architecture and debugging plan for a compiler.",
    )

    assert selected.model == "reasoning-model"
    assert selected.tier == "reasoning"


def test_highest_model_disabled_even_for_high_task(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_REASONING", "reasoning-model")
    monkeypatch.setenv("OPENAI_MODEL_HIGH", "high-model")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "true")
    monkeypatch.setenv("OPENAI_HIGH_MODEL_ALLOWLIST", "highest")
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "10")
    router = OpenAIModelRouter()

    selected = router.select_model("highest", "Use the highest model.")

    assert selected.model != "high-model"
    assert selected.tier == "reasoning"


def test_gpt5_defaults_route_simple_and_coding_without_highest(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("OPENAI_MODEL_HIGH", "gpt-5")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "true")
    router = OpenAIModelRouter()

    simple = router.select_model("normal_qa", "What is a compiler?")
    coding = router.select_model("normal_qa", "Debug this React Native architecture.")
    high = router.select_model("highest", "Use the flagship model.", route="highest")

    assert simple.model == "gpt-5-nano"
    assert coding.model == "gpt-5-mini"
    assert high.model != "gpt-5"
    assert simple.max_output_tokens <= 450
    assert coding.max_output_tokens <= 450


def test_select_candidates_simple_ladder(monkeypatch):
    _clear_model_env(monkeypatch)
    router = OpenAIModelRouter()

    selections = router.select_candidates("normal_qa", "What is a compiler?")

    assert [selection.model for selection in selections[:3]] == ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"]
    assert selections[0].endpoint == "responses"


def test_select_candidates_reasoning_ladder(monkeypatch):
    _clear_model_env(monkeypatch)
    router = OpenAIModelRouter()

    selections = router.select_candidates("normal_qa", "Debug this React Native stack trace: TypeError")

    models = [selection.model for selection in selections]
    assert "gpt-5-mini" in models
    assert "gpt-4.1-mini" in models
    assert "o4-mini" not in models


def test_openai_usage_log_records_model_and_estimated_cost(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-model")
    router = OpenAIModelRouter()
    selected = router.select_model("classification", "classify this")

    with SessionLocal() as session:
        row = record_openai_usage(
            session,
            user_id=123,
            request_id="usage-1",
            route="test",
            selection=selected,
            cache_hit=False,
        )
        assert row is not None
        stored = session.exec(select(OpenAIUsageLog)).one()
        assert stored.model_used == "cheap-model"
        assert stored.model_tier == "cheap"
        assert stored.estimated_cost_usd >= 0
        assert stored.user_id_hash != "123"


class _FakeMessage:
    content = "tracked answer"


class _FakeChoice:
    message = _FakeMessage()


class _FakeResponse:
    choices = [_FakeChoice()]
    usage = None


class _FakeUsage:
    prompt_tokens = 11
    completion_tokens = 7
    total_tokens = 18


class _FakeUsageResponse:
    choices = [_FakeChoice()]
    usage = _FakeUsage()


class _FakeCompletions:
    def __init__(self, response=None):
        self.calls = []
        self.response = response or _FakeResponse()

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class _FakeClient:
    def __init__(self, response=None):
        self.completions = _FakeCompletions(response=response)
        self.chat = type("Chat", (), {"completions": self.completions})()
        self.embeddings = _FakeEmbeddings()


class _FakeEmbeddingItem:
    embedding = [0.1, 0.2, 0.3]


class _FakeEmbeddingResponse:
    data = [_FakeEmbeddingItem()]


class _FakeEmbeddings:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeEmbeddingResponse()


def test_tracked_chat_completion_uses_router_and_writes_usage(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-tracked")
    client = _FakeClient()

    with SessionLocal() as session:
        response = tracked_chat_completion(
            client,
            session=session,
            user_id=123,
            request_id="tracked-1",
            task="json",
            route="unit_test_route",
            messages=[{"role": "user", "content": "classify this"}],
            response_format={"type": "json_object"},
            max_tokens=50,
        )

        assert response.choices[0].message.content == "tracked answer"
        assert client.completions.calls[0]["model"] == "cheap-tracked"
        assert client.completions.calls[0]["max_tokens"] <= 50
        stored = session.exec(select(OpenAIUsageLog)).one()
        assert stored.route == "unit_test_route"
        assert stored.model_used == "cheap-tracked"
        assert stored.model_tier == "cheap"
        assert stored.estimated_output_tokens <= 50


def test_tracked_chat_completion_exposes_actual_model_metadata_and_usage(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-actual")
    monkeypatch.setenv("OPENAI_PRICE_CHEAP_ACTUAL_INPUT_PER_1M", "1")
    monkeypatch.setenv("OPENAI_PRICE_CHEAP_ACTUAL_OUTPUT_PER_1M", "2")
    client = _FakeClient(response=_FakeUsageResponse())

    with SessionLocal() as session:
        response = tracked_chat_completion(
            client,
            session=session,
            user_id=123,
            request_id="tracked-actual",
            task="json",
            route="unit_test_route",
            messages=[{"role": "user", "content": "classify this"}],
            max_tokens=100,
        )

        metadata = get_tracked_chat_completion_metadata(response)
        assert client.completions.calls[0]["model"] == "cheap-actual"
        assert metadata["model_used"] == "cheap-actual"
        assert metadata["model_tier"] == "cheap"
        assert metadata["actual_input_tokens"] == 11
        assert metadata["actual_output_tokens"] == 7
        assert metadata["actual_cost_usd"] == (11 / 1_000_000) + (7 / 1_000_000) * 2

        stored = session.exec(select(OpenAIUsageLog)).one()
        assert stored.actual_input_tokens == 11
        assert stored.actual_output_tokens == 7
        assert stored.actual_cost_usd == metadata["actual_cost_usd"]
        assert get_today_estimated_openai_spend(session) == metadata["actual_cost_usd"]


def test_daily_budget_blocks_tracked_openai_call(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-budget")
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "0.000001")
    client = _FakeClient()

    with SessionLocal() as session:
        record_openai_usage(
            session,
            user_id=123,
            request_id="spent",
            route="test",
            model_used="cheap-budget",
            model_tier="cheap",
            estimated_cost_usd=1.0,
        )
        assert get_today_estimated_openai_spend(session) >= 1.0

        try:
            tracked_chat_completion(
                client,
                session=session,
                user_id=123,
                task="normal_qa",
                route="budgeted_route",
                messages=[{"role": "user", "content": "What is a compiler?"}],
            )
            raised = False
        except OpenAIBudgetExceededError:
            raised = True

        assert raised is True
        assert client.completions.calls == []


def test_daily_budget_blocks_call_that_would_cross_budget(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-budget")
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "0.000001")
    client = _FakeClient()

    with SessionLocal() as session:
        try:
            tracked_chat_completion(
                client,
                session=session,
                user_id=123,
                task="normal_qa",
                route="budget_crossing_route",
                messages=[{"role": "user", "content": "What is a compiler?"}],
            )
            raised = False
        except OpenAIBudgetExceededError:
            raised = True

        assert raised is True
        assert client.completions.calls == []
        assert session.exec(select(OpenAIUsageLog)).all() == []


def test_daily_budget_safety_margin_blocks_near_limit_call(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-budget")
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "0.00029")
    monkeypatch.setenv("OPENAI_BUDGET_SAFETY_MARGIN_RATIO", "0.10")
    client = _FakeClient()

    with SessionLocal() as session:
        try:
            tracked_chat_completion(
                client,
                session=session,
                user_id=123,
                task="normal_qa",
                route="budget_margin_route",
                messages=[{"role": "user", "content": "What is a compiler?"}],
            )
            raised = False
        except OpenAIBudgetExceededError:
            raised = True

        assert raised is True
        assert client.completions.calls == []


def test_tracked_chat_completion_forwards_route_to_high_model_allowlist(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP", "cheap-model")
    monkeypatch.setenv("OPENAI_MODEL_STANDARD", "standard-model")
    monkeypatch.setenv("OPENAI_MODEL_REASONING", "reasoning-model")
    monkeypatch.setenv("OPENAI_MODEL_HIGH", "high-model")
    monkeypatch.setenv("OPENAI_DISABLE_HIGHEST_MODEL", "false")
    monkeypatch.setenv("OPENAI_HIGH_MODEL_ALLOWLIST", "review_route")
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "10")
    client = _FakeClient()

    with SessionLocal() as session:
        tracked_chat_completion(
            client,
            session=session,
            user_id=123,
            task="high",
            route="review_route",
            messages=[{"role": "user", "content": "Use the high model for this review."}],
            max_tokens=20,
        )

        assert client.completions.calls[0]["model"] == "high-model"
        stored = session.exec(select(OpenAIUsageLog)).one()
        assert stored.route == "review_route"
        assert stored.model_tier == "high"


def test_tracked_embedding_writes_usage_and_respects_budget(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_MODEL", "embedding-model")
    monkeypatch.delenv("OPENAI_DAILY_BUDGET_USD", raising=False)
    client = _FakeClient()

    with SessionLocal() as session:
        response = tracked_embedding(
            client,
            session=session,
            user_id=123,
            route="rag_embedding",
            input=["hello world"],
        )

        assert response.data[0].embedding == [0.1, 0.2, 0.3]
        assert client.embeddings.calls[0]["model"] == "embedding-model"
        stored = session.exec(select(OpenAIUsageLog)).one()
        assert stored.route == "rag_embedding"
        assert stored.model_tier == "embedding"

    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "0.0000001")
    blocked_client = _FakeClient()
    with SessionLocal() as session:
        try:
            tracked_embedding(
                blocked_client,
                session=session,
                user_id=123,
                route="rag_embedding",
                input=["hello world"],
            )
            raised = False
        except OpenAIBudgetExceededError:
            raised = True

        assert raised is True
        assert blocked_client.embeddings.calls == []


def test_tracked_embedding_reuses_duplicate_request_text(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_MODEL", "embedding-model")
    monkeypatch.delenv("OPENAI_DAILY_BUDGET_USD", raising=False)
    client = _FakeClient()

    first = tracked_embedding(
        client,
        route="rag_embedding",
        request_id="same-turn",
        input=["hello world"],
    )
    second = tracked_embedding(
        client,
        route="rag_embedding",
        request_id="same-turn",
        input=["hello world"],
    )

    assert first is second
    assert len(client.embeddings.calls) == 1
