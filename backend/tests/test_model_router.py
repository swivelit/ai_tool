from __future__ import annotations

from sqlmodel import select

from app.database import SessionLocal
from app.models import OpenAIUsageLog
from app.openai_model_router import OpenAIModelRouter, get_today_estimated_openai_spend, record_openai_usage
from app.openai_tracked import OpenAIBudgetExceededError, tracked_chat_completion


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

    assert selected.model in {"cheap-model", "standard-model"}
    assert selected.tier in {"cheap", "standard"}


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


class _FakeCompletions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeResponse()


class _FakeClient:
    def __init__(self):
        self.completions = _FakeCompletions()
        self.chat = type("Chat", (), {"completions": self.completions})()


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
