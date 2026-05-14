from __future__ import annotations

from sqlmodel import select

from app.database import SessionLocal
from app.models import OpenAIUsageLog
from app.openai_model_router import OpenAIModelRouter, record_openai_usage


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
