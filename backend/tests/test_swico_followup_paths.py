from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from app.ai.freshness import resolve_freshness, validate_current_evidence
from app.ai.language import explicit_web_reply_language, resolve_web_reply_language
from app.ai.types import AIProviderResponse
from app.billing.pricing import calculate_topup
from app.billing.service import credit_payment_once
from app.database import SessionLocal
from app.models import PaymentOrder
from app.web_ai.telemetry.metadata import sanitize_metadata
from app.web_ai.generation.models import AnswerQualityResult, QualityCheck
from app.web_ai.persistence import persist_answer_quality
from app.web_api.chat_service import execute_web_turn, prepare_web_turn
from app.ai.agents.web_search_agent import WebSearchResult
from tests.conftest import auth_headers, create_test_user


def _fund(user_id: int) -> None:
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id,
            receipt=f"follow-up-{user_id}",
            provider_order_id=f"follow-up-order-{user_id}",
            gross_amount_paise=1000,
            credited_amount_micros=credit,
            platform_share_paise=platform,
            status="captured",
        )
        session.add(order)
        session.flush()
        credit_payment_once(session, order)
        session.commit()


def _sse_text(response) -> str:
    return "\n".join(
        json.loads(line.removeprefix("data: ")).get("text", "")
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"text"' in line
    )


def test_temporal_decision_handles_roles_dates_and_timedless_now():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert resolve_freshness("CM of Tamil Nadu", now=clock).requires_fresh_evidence
    assert resolve_freshness("Who is the CM of Tamilnadu?", now=clock).scope == "current"
    assert resolve_freshness("Who was appointed Chief Minister today?", now=clock).scope == "current"
    timeless = resolve_freshness("Explain how the word now is used in grammar.", now=clock)
    assert timeless.scope == "unspecified" and not timeless.requires_fresh_evidence
    historical = resolve_freshness("Who was CM as of 2020-01-02?", now=clock)
    assert historical.scope == "historical" and historical.as_of == "2020-01-02"


def test_language_resolution_ignores_quotes_negation_and_subject_names():
    assert explicit_web_reply_language("Translate it to English") == "en"
    assert explicit_web_reply_language("Do not reply in Tamil; reply in English") == "en"
    assert explicit_web_reply_language('Discuss "reply in English" and English grammar') is None
    assert resolve_web_reply_language("ta", "Answer in English about Tamil Nadu") == "en"
    assert resolve_web_reply_language("ta", "Translate it to English") == "en"


def test_checked_quality_survives_strict_metadata_sanitization():
    assert sanitize_metadata({"quality_outcome": "checked"})["quality_outcome"] == "checked"


def test_checked_quality_persists_as_passed_for_history_and_audit_consumers():
    user = create_test_user("checked-quality", "checked-quality@example.com")
    result = AnswerQualityResult(
        status="checked", checks=(QualityCheck("format", "passed"),),
    )
    with SessionLocal() as session:
        row = persist_answer_quality(
            session, user_id=int(user.id), thread_id=None,
            request_id="checked-quality-request", assistant_message_id=None,
            result=result,
        )
        session.commit()
        assert row.status == "passed"
        assert json.loads(row.safe_metadata_json)["quality_outcome"] == "checked"


def test_current_request_is_gated_in_real_web_stream_before_provider(monkeypatch, client):
    user = create_test_user("freshness-disabled", "freshness-disabled@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    calls = {"provider": 0}

    def provider(*_args, **_kwargs):
        calls["provider"] += 1
        raise AssertionError("current factual request must not guess without retrieval")

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", provider)
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("freshness-disabled", "freshness-disabled@example.com"),
        json={"request_id": str(uuid4()), "message": "Who is the CM of Tamilnadu?"},
    )
    assert response.status_code == 200
    assert calls["provider"] == 0
    assert "will not guess" in _sse_text(response)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Who is the CM of Tamilnadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en",
    )
    assert prepared.optimization is not None and prepared.optimization.cache_eligible is False


def test_current_endpoint_requires_temporally_supported_evidence(monkeypatch, client):
    user = create_test_user("freshness-stale", "freshness-stale@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    provider_calls = {"count": 0}

    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(
            enabled=True,
            results=[{
                "title": "Tamil Nadu Chief Minister",
                "snippet": "An old summary without present-day confirmation.",
                "source": "wikipedia_summary",
                "url": "https://example.test/old-summary",
                "retrieved_at": "2026-09-10T10:00:00+00:00",
                "temporal_support": False,
            }],
            reason="mock_stale_retrieval",
        ),
    )
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *_args, **_kwargs: provider_calls.__setitem__("count", provider_calls["count"] + 1),
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("freshness-stale", "freshness-stale@example.com"),
        json={"request_id": str(uuid4()), "message": "Who is the CM of Tamil Nadu?"},
    )
    assert response.status_code == 200
    assert provider_calls["count"] == 0
    assert "will not guess" in _sse_text(response)
    assert validate_current_evidence("Who is the CM of Tamil Nadu?", {
        "title": "old", "snippet": "old", "url": "https://example.test/old",
        "retrieved_at": "2020-01-01T00:00:00Z", "source": "old", "temporal_support": False,
    })[0] is False


def test_current_request_uses_validated_retrieval_in_prepared_turn(monkeypatch):
    user = create_test_user("freshness-enabled", "freshness-enabled@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    captured = {}

    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(
            enabled=True,
            results=[{
                "title": "Tamil Nadu Chief Minister",
                "snippet": "The current chief minister is supported by a dated official source.",
                "source": "official-government",
                "provenance": "official-government",
                "url": "https://example.test/tamil-nadu-chief-minister",
                "retrieved_at": "2026-09-10T10:00:00+00:00",
                "temporal_support": True,
                "relevant": True,
            }],
            reason="mock_retrieval",
        ),
    )

    def provider(_self, request, route, on_delta):
        captured.update(request.metadata)
        answer = "The current officeholder is stated by the retrieved source."
        on_delta(answer)
        return AIProviderResponse(
            text=answer, provider="openai", model=route.model, route=route.route,
            reason=route.reason, language="en", intent=route.intent,
            input_tokens=10, output_tokens=10,
            raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
        )

    def complete(_self, request, route):
        return provider(_self, request, route, lambda _text: None)

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", provider)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Who is the CM of Tamilnadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en",
    )
    assert prepared.retrieval_context is not None
    assert prepared.retrieval_context.retrieval_status == "sufficient"
    execute_web_turn(prepared, providers={"openai": type("Provider", (), {"complete": complete})()})
    assert "freshness_evidence_prompt" in captured
    assert prepared.ai_request.metadata["freshness_source_url"].startswith("https://")
