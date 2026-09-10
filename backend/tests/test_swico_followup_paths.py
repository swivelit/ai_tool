from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from app.ai.freshness import resolve_freshness, validate_current_evidence
from app.ai.language import explicit_web_reply_language, resolve_web_reply_language
from app.ai.types import AIProviderResponse
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest
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


def test_prepared_language_contract_accepts_an_english_answer_about_tamil_nadu():
    user = create_test_user("language-contract", "language-contract@example.com")
    _fund(int(user.id))
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain Tamil Nadu in three simple sentences in English",
        request_id=str(uuid4()),
        thread_id=None,
        reply_language="ta",
    )
    assert prepared.reply_language == "en"
    contract = prepared.ai_request.metadata["output_contract"]
    assert contract["required_script"] is None
    checks = __import__(
        "app.web_ai.generation.output_contract",
        fromlist=["validate_output_contract", "OutputContract"],
    ).validate_output_contract(
        "Tamil Nadu is a state in southern India. It has a rich history. Its capital is Chennai.",
        __import__(
            "app.web_ai.generation.output_contract",
            fromlist=["OutputContract"],
        ).OutputContract.from_metadata(contract),
    )
    assert all(check.status == "passed" for check in checks)


def test_prepared_turn_sends_the_resolved_language_to_provider_and_validation():
    user = create_test_user("language-provider-path", "language-provider-path@example.com")
    _fund(int(user.id))
    captured = {}

    class Provider:
        def complete(self, request, route):
            captured.update({
                "reply_language": request.reply_language,
                "messages": request.metadata.get("provider_messages"),
                "contract": request.metadata.get("output_contract"),
            })
            return AIProviderResponse(
                text=(
                    "Tamil Nadu is a state in southern India. "
                    "It has a rich history. Its capital is Chennai."
                ),
                provider=route.provider, model=route.model, route=route.route,
                reason=route.reason, language="en", intent=route.intent,
                input_tokens=10, output_tokens=20,
                raw={
                    "usage_actual": True, "finish_reason": "stop",
                    "completion_status": "complete",
                    "quality": {"status": "checked", "retrieval_status": "insufficient", "checks": []},
                },
            )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain Tamil Nadu in three simple sentences in English",
        request_id=str(uuid4()), thread_id=None, reply_language="ta",
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()},
    )
    assert captured["reply_language"] == "en"
    assert any(
        "English" in str(item.get("content") or "")
        for item in captured["messages"]
        if isinstance(item, dict)
    )
    assert captured["contract"]["required_script"] is None
    assert completed.message.content.startswith("Tamil Nadu is a state")


def test_punctuation_scoped_negation_and_translation_rebuild_the_final_contract():
    assert resolve_web_reply_language(
        "ta", "Do not reply in Tamil. Reply in English.",
    ) == "en"
    user = create_test_user("language-punctuation", "language-punctuation@example.com")
    _fund(int(user.id))
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Translate this Tamil sentence to English",
        request_id=str(uuid4()),
        thread_id=None,
        reply_language="ta",
    )
    assert prepared.reply_language == "en"
    assert prepared.ai_request.metadata["output_contract"]["required_script"] is None


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


def test_freshness_resolves_as_of_today_as_historical_and_mixed_requests_as_current():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    as_of_today = resolve_freshness(
        "Who is the CM as of 2026-09-10?", now=clock,
    )
    assert as_of_today.scope == "historical"
    assert as_of_today.as_of == "2026-09-10"
    mixed = resolve_freshness(
        "Who is the current CM and who was the previous CM?", now=clock,
    )
    assert mixed.requires_fresh_evidence is True
    assert mixed.scope == "mixed"


def test_contextual_officeholder_followup_inherits_temporal_subject():
    decision = resolve_freshness(
        "Who holds it now?",
        context="User: Who is the Chief Minister of Tamil Nadu?\nAssistant: The current officeholder is...",
        now=datetime(2026, 9, 10, tzinfo=timezone.utc),
    )
    assert decision.requires_fresh_evidence is True


def test_weather_route_is_retrieval_gated_when_search_is_enabled(monkeypatch):
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    route = AIProviderRouter().select_route(AIRequest(
        user_id=1, message="What is the weather today in Chennai?", reply_language="en",
        channel="text", request_id="weather-route", metadata={
            "client_surface": "web", "swico_tier": "lite",
        },
    ))
    assert route.intent == "weather"
    assert route.metadata["freshness_required"] is True


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


def test_weather_endpoint_cannot_bypass_freshness_gate(monkeypatch, client):
    user = create_test_user("freshness-weather", "freshness-weather@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(enabled=True, results=[], reason="not_configured"),
    )
    provider_calls = {"count": 0}
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *_args, **_kwargs: provider_calls.__setitem__("count", provider_calls["count"] + 1),
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("freshness-weather", "freshness-weather@example.com"),
        json={"request_id": str(uuid4()), "message": "What is the weather today in Chennai?"},
    )
    assert response.status_code == 200
    assert provider_calls["count"] == 0
    assert "will not guess" in _sse_text(response)


def test_current_evidence_rejects_malformed_old_future_unrelated_and_conflicting_results():
    query = "Who is the CM of Tamil Nadu?"
    base = {
        "title": "Tamil Nadu Chief Minister",
        "snippet": "Tamil Nadu Chief Minister current officeholder",
        "url": "https://example.test/current",
        "source": "official-government",
        "provenance": "official-government",
        "temporal_support": True,
        "temporal_as_of": "2026-09-10",
        "relevant": True,
    }
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    assert validate_current_evidence(query, {**base, "retrieved_at": "not-a-date"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {**base, "retrieved_at": "2020-01-01T00:00:00Z"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {**base, "retrieved_at": "2026-09-11T00:00:00Z"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {**base, "retrieved_at": fixed.isoformat(), "relevant": False, "snippet": "weather in London"}, now=fixed)[0] is False
    assert validate_current_evidence(query, [
        {**base, "retrieved_at": fixed.isoformat(), "claim": "A"},
        {**base, "retrieved_at": fixed.isoformat(), "claim": "B"},
    ], now=fixed)[0] is False


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
                "temporal_as_of": "2026-09-10",
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
    completed = execute_web_turn(
        prepared, providers={"openai": type("Provider", (), {"complete": complete})()},
    )
    assert "freshness_evidence_prompt" in captured
    assert prepared.ai_request.metadata["freshness_source_url"].startswith("https://")
    assert completed.response.raw["cache_eligible"] is False
