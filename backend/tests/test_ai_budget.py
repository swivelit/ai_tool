import pytest
from fastapi import HTTPException

from app.ai.budget import enforce_free_text_quota, enforce_provider_budget
from app.ai.types import AIProviderResponse
from app.ai.usage import record_ai_usage_event
from app.database import SessionLocal


def test_free_daily_text_quota_returns_429(monkeypatch):
    monkeypatch.setenv("FREE_DAILY_TEXT_LIMIT", "1")
    with SessionLocal() as session:
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="hello",
                provider="openai",
                model="gpt-5-nano",
                route="openai_general",
                reason="test",
                language="en",
                intent="general",
            ),
            user_id=123,
        )

        with pytest.raises(HTTPException) as exc:
            enforce_free_text_quota(session, 123)

    assert exc.value.status_code == 429
    assert "Daily free text limit" in exc.value.detail


def test_admin_allowlist_bypasses_free_text_quota(monkeypatch):
    monkeypatch.setenv("FREE_DAILY_TEXT_LIMIT", "0")
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    with SessionLocal() as session:
        enforce_free_text_quota(session, 123, admin_email="admin@example.com")


def test_provider_budget_returns_503(monkeypatch):
    monkeypatch.setenv("SARVAM_DAILY_BUDGET_INR", "1")
    with SessionLocal() as session:
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="வணக்கம்",
                provider="sarvam",
                model="sarvam-30b",
                route="sarvam_general",
                reason="test",
                language="ta",
                intent="general",
                estimated_cost_amount=1.0,
                estimated_cost_currency="INR",
            ),
            user_id=123,
        )

        with pytest.raises(HTTPException) as exc:
            enforce_provider_budget(session, "sarvam", currency="INR")

    assert exc.value.status_code == 503
    assert "Sarvam daily budget exceeded" in exc.value.detail
