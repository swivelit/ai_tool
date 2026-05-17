from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.ai.usage import (
    get_provider_daily_spend,
    get_user_daily_text_count,
    get_user_daily_voice_seconds,
    record_ai_usage_event,
)
from app.database import SessionLocal
from app.models import AIUsageEvent


def test_records_ai_usage_event_for_provider_call():
    with SessionLocal() as session:
        row = record_ai_usage_event(
            session,
            AIProviderResponse(
                text="answer",
                provider="openai",
                model="gpt-5-nano",
                route="openai_general",
                reason="test",
                language="en",
                intent="general",
                input_tokens=10,
                output_tokens=5,
                estimated_cost_amount=0.001,
                estimated_cost_currency="USD",
            ),
            user_id=123,
            request_id="usage-test",
            metadata={"cache": False},
        )

        stored = session.exec(select(AIUsageEvent)).one()

    assert row is not None
    assert stored.request_id == "usage-test"
    assert stored.user_id_hash != "123"
    assert stored.provider == "openai"
    assert stored.model == "gpt-5-nano"
    assert stored.estimated_cost_currency == "USD"


def test_daily_usage_helpers_count_text_voice_and_spend():
    with SessionLocal() as session:
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="tool answer",
                provider="backend_tool",
                model=None,
                route="backend_tool_reminder",
                reason="tool",
                language="en",
                intent="reminder",
            ),
            user_id=123,
        )
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="voice",
                provider="sarvam",
                model="saaras:v3",
                route="sarvam_stt",
                reason="stt",
                language="ta-IN",
                intent="stt",
                audio_seconds=12.5,
                estimated_cost_amount=0.1,
                estimated_cost_currency="INR",
            ),
            user_id=123,
        )

        assert get_user_daily_text_count(session, 123) == 1
        assert get_user_daily_voice_seconds(session, 123) == 12.5
        assert get_provider_daily_spend(session, "sarvam", "INR") == 0.1
