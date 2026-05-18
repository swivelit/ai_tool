import pytest
from fastapi import HTTPException

from app.ai.budget import enforce_free_text_quota, enforce_free_voice_quota, enforce_provider_budget
from app.ai.orchestrator import run_text_turn
from app.ai.types import AIProviderResponse, AIRequest
from app.ai.usage import record_ai_usage_event
from app.database import SessionLocal


class _ExplodingProvider:
    def complete(self, *_args, **_kwargs):
        raise AssertionError("deterministic tool workflow must not call providers")


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


def test_free_daily_voice_quota_counts_audio_seconds(monkeypatch):
    monkeypatch.setenv("FREE_DAILY_VOICE_SECONDS", "1")
    with SessionLocal() as session:
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="voice",
                provider="sarvam",
                model="saaras:v3",
                route="sarvam_stt",
                reason="test",
                language="en-IN",
                intent="stt",
                audio_seconds=1.0,
            ),
            user_id=123,
        )

        with pytest.raises(HTTPException) as exc:
            enforce_free_voice_quota(session, 123, additional_seconds=1.0)

    assert exc.value.status_code == 429
    assert "Daily free voice limit" in exc.value.detail


@pytest.mark.parametrize(
    "message",
    [
        "client follow up note save பண்ணு",
        "office meeting task add பண்ணு",
        "அம்மா medicine நாளைக்கு காலை remind பண்ணு",
        "இந்த meeting points எல்லாம் PDF ஆக்கி Work Folder ல வை",
        "நேத்து சொன்ன business notes open பண்ணு",
    ],
)
def test_backend_tool_workflows_have_zero_provider_cost_after_stt(message):
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            AIRequest(
                user_id=123,
                message=message,
                reply_language="ta",
                channel="voice",
                request_id="budget-tool-test",
                metadata={},
            ),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )

    assert response.provider == "backend_tool"
    assert response.estimated_cost_amount == 0
    assert response.estimated_cost_currency == ""
