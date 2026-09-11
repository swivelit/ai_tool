from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest
import openai
from sqlmodel import select

from app.ai.agents.web_search_agent import (
    LiveSearchConfigurationError, WebSearchAgent, WebSearchResult,
    live_search_config,
)
from app.ai.freshness import validate_current_evidence
from app.ai.types import AIProviderResponse
from app.billing.pricing import calculate_topup
from app.billing.errors import InsufficientCreditError
from app.billing.service import credit_payment_once
from app.database import SessionLocal
from app.models import PaymentOrder, UsageCharge, WebChatMessage, WebUsagePreferences
from app.web_api.chat_service import execute_web_turn, prepare_web_turn

from tests.conftest import auth_headers, create_test_user


def _fund(user_id: int) -> None:
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id, receipt=f"paid-search-{user_id}",
            provider_order_id=f"paid-search-order-{user_id}",
            gross_amount_paise=1000, credited_amount_micros=credit,
            platform_share_paise=platform, status="captured",
        )
        session.add(order)
        session.flush()
        credit_payment_once(session, order)
        session.commit()


class _Responses:
    def __init__(self, response):
        self.response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class _SearchClient:
    def __init__(self, response):
        self.responses = _Responses(response)


def _search_response(
    *, completed: bool = True, with_source: bool = True, with_annotation: bool = False,
):
    source = {
        "url": "https://example.test/tamil-nadu-directory",
        "title": "Tamil Nadu official directory",
    }
    action = type("Action", (), {
        "type": "search",
        "sources": [source] if with_source else [],
    })()
    call = type("Call", (), {
        "type": "web_search_call",
        "status": "completed" if completed else "in_progress",
        "action": action,
    })()
    usage = type("Usage", (), {"input_tokens": 21, "output_tokens": 17})()
    annotation = type("Annotation", (), {
        "type": "url_citation",
        "url": source["url"],
        "title": source["title"],
    })()
    message = type("Message", (), {
        "type": "message",
        "annotations": [annotation] if with_annotation else [],
    })()
    return type("Response", (), {
        "output": [call, message] if with_annotation else [call],
        "output_text": "Example Person is the Chief Minister of Tamil Nadu.",
        "usage": usage,
    })()


def test_paid_adapter_requires_completed_search_and_normalizes_citations(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    client = _SearchClient(_search_response())
    result = WebSearchAgent(client=client, clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )

    assert result.reason == "openai_responses_web_search"
    assert result.usage == {"input_tokens": 21, "output_tokens": 17, "search_calls": 1}
    call = client.responses.calls[0]
    assert call["model"] == "gpt-4.1-mini"
    assert call["tools"] == [{"type": "web_search", "external_web_access": True}]
    assert call["tool_choice"] == "required"
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True
    annotation_result = WebSearchAgent(
        client=_SearchClient(_search_response(with_source=False, with_annotation=True)),
        clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert annotation_result.reason == "openai_responses_web_search"
    assert annotation_result.results[0]["sources"]

    no_search = WebSearchAgent(
        client=_SearchClient(_search_response(completed=False)), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert no_search.reason == "search_tool_not_completed"
    assert no_search.results == []


@pytest.mark.parametrize(
    "answer",
    (
        "Example Person is the Chief Minister of Tamil Nadu.",
        "Example Person is the Chief Minister of Tamil Nadu. The office coordinates the state government.",
        "Example Person is the Chief Minister of Tamil Nadu. [Official directory](https://example.test/office.v1).",
        "A. B. Example is the Chief Minister of Tamil Nadu. See https://example.test/office.v1.",
    ),
)
def test_paid_adapter_extracts_concise_cited_claim_from_realistic_synthesis(monkeypatch, answer):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    source = {
        "url": "https://example.test/office.v1",
        "title": "Tamil Nadu official directory",
        "snippet": (
            "A. B. Example is the Chief Minister of Tamil Nadu."
            if answer.startswith("A. B.")
            else "Example Person is the Chief Minister of Tamil Nadu."
        ),
    }
    annotation = type("Annotation", (), {
        "type": "url_citation", "url": source["url"], "title": source["title"],
        "start_index": 0, "end_index": 12,
    })()
    action = type("Action", (), {"sources": [source]})()
    call = type("Call", (), {"type": "web_search_call", "status": "completed", "action": action})()
    message = type("Message", (), {
        "type": "message", "content": [type("Text", (), {"type": "output_text", "text": answer, "annotations": [annotation]})()],
    })()
    response = type("Response", (), {
        "output": [call, message], "output_text": answer,
        "usage": type("Usage", (), {"input_tokens": 8570, "output_tokens": 235})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results[0]["synthesis"] == " ".join(answer.split())[:4000]
    assert result.results[0]["answer_value"] in {"Example Person", "A. B. Example"}
    assert result.results[0]["claim"]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True


@pytest.mark.parametrize(
    "answer",
    (
        "In 2021, Example Person was the Chief Minister of Tamil Nadu.",
        "Example Person is not the current Chief Minister of Tamil Nadu.",
    ),
)
def test_paid_adapter_rejects_historical_or_negated_current_claim(monkeypatch, answer):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    source = {"url": "https://example.test/office", "title": "Official directory"}
    response = type("Response", (), {
        "output": [type("Call", (), {
            "type": "web_search_call", "status": "completed",
            "action": type("Action", (), {"sources": [source]})(),
        })()],
        "output_text": answer,
        "usage": type("Usage", (), {"input_tokens": 10, "output_tokens": 10})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results == []
    assert result.reason == "search_claim_not_extractable"


def test_paid_adapter_binds_claim_to_nested_citation_not_first_consulted_source(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    unrelated = {"url": "https://example.test/weather", "title": "Weather page"}
    supporting = {
        "url": "https://example.test/official-office",
        "title": "Tamil Nadu official directory",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
    }
    nested = type("Annotation", (), {
        "type": "url_citation",
        "url_citation": type("Citation", (), {
            "url": supporting["url"], "title": supporting["title"],
            "start_index": 0, "end_index": 60,
        })(),
    })()
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [unrelated, supporting]})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text",
                    "text": "Example Person is the Chief Minister of Tamil Nadu.",
                    "annotations": [nested],
                })()],
            })(),
        ],
        "output_text": "Example Person is the Chief Minister of Tamil Nadu.",
        "usage": type("Usage", (), {"input_tokens": 12, "output_tokens": 8})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results[0]["url"] == supporting["url"]
    assert [source["url"] for source in result.results[0]["claim_sources"]] == [supporting["url"]]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True


def test_failed_paid_search_with_usage_persists_zero_customer_charge_and_replays(
    monkeypatch, client,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    user = create_test_user("paid-search-fallback", "paid-search-fallback@example.com")
    _fund(int(user.id))
    request_id = str(uuid4())
    search_calls = 0

    def failed_search(_self, _query):
        nonlocal search_calls
        search_calls += 1
        return WebSearchResult(
            enabled=True,
            reason="openai_responses_web_search",
            usage={"input_tokens": 8570, "output_tokens": 235, "search_calls": 1},
            results=[{
                "title": "Tamil Nadu travel guide",
                "snippet": "Tamil Nadu has many historic temples and beaches.",
                "claim": "Example Person is the Governor of Kerala.",
                "answer_value": "Example Person",
                "url": "https://example.test/unrelated",
                "source": "openai_responses_web_search",
                "provenance": "openai_responses_web_search",
                "retrieved_at": "2026-09-10T12:00:00+00:00",
                "temporal_as_of": "2026-09-10",
                "temporal_support": "completed_live_search",
                "search_call_completed": True,
                "relevant": True,
            }],
        )

    monkeypatch.setattr("app.web_api.chat_service.WebSearchAgent.search", failed_search)
    generation_calls = []
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *args, **kwargs: generation_calls.append((args, kwargs))
        or (_ for _ in ()).throw(AssertionError("unavailable search must not generate")),
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("paid-search-fallback", "paid-search-fallback@example.com"),
        json={"request_id": request_id, "message": "Who is the CM of Tamil Nadu?", "reply_language": "en"},
    )
    assert response.status_code == 200
    assert 'event: done' in response.text
    assert 'event: error' not in response.text
    assert "I couldn’t verify the current answer" in response.text
    assert not generation_calls
    with SessionLocal() as session:
        charge = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).one()
        assert charge.status == "settled"
        assert charge.usage_kind == "chat"
        assert charge.provider_cost_micros > 0
        assert charge.debited_micros == 0
        assert charge.reserved_micros == 0
        assistant = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).one()
        assert assistant.status == "complete"
        assert "couldn’t verify" in assistant.content
    replay = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("paid-search-fallback", "paid-search-fallback@example.com"),
        json={"request_id": request_id, "message": "Who is the CM of Tamil Nadu?", "reply_language": "en"},
    )
    assert replay.status_code == 200
    assert search_calls == 1


def test_endpoint_uses_real_adapter_normalization_and_emits_sources(
    monkeypatch, client,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    user = create_test_user("paid-search-adapter-endpoint", "paid-search-adapter-endpoint@example.com")
    _fund(int(user.id))
    response_fixture = _search_response(with_annotation=True)

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.responses = _Responses(response_fixture)

    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    answer = "Example Person is the Chief Minister of Tamil Nadu. [S1]"

    def provider(_self, request, route, on_delta):
        on_delta(answer)
        return AIProviderResponse(
            text=answer, provider="openai", model=route.model, route=route.route,
            reason="mocked_generation", language="en", intent=route.intent,
            input_tokens=20, output_tokens=12,
            raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
        )

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", provider)
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("paid-search-adapter-endpoint", "paid-search-adapter-endpoint@example.com"),
        json={
            "request_id": str(uuid4()),
            "message": "Who is the CM of Tamil Nadu?",
            "reply_language": "en",
        },
    )
    assert response.status_code == 200
    assert "event: sources" in response.text
    assert "https://example.test/tamil-nadu-directory" in response.text


def test_paid_adapter_reports_missing_sources_timeout_and_missing_key(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    no_sources = WebSearchAgent(
        client=_SearchClient(_search_response(with_source=False)),
        clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert no_sources.reason == "no_usable_sources"

    class TimeoutClient:
        class responses:
            @staticmethod
            def create(**_kwargs):
                raise TimeoutError("bounded search timeout")

    timeout = WebSearchAgent(client=TimeoutClient(), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert timeout.reason == "search_timeout"
    monkeypatch.delenv("OPENAI_API_KEY")
    missing_key = WebSearchAgent(client=_SearchClient(_search_response())).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert missing_key.reason == "missing_api_key"


@pytest.mark.parametrize(
    ("name", "value"),
    (("WEB_LIVE_SEARCH_PROVIDER", "not-openai"), ("WEB_LIVE_SEARCH_MAX_CALLS_PER_TURN", "2")),
)
def test_enabled_live_search_rejects_unsafe_configuration(monkeypatch, name, value):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv(name, value)
    with pytest.raises(LiveSearchConfigurationError):
        live_search_config(require_key=True)


def test_paid_prepared_turn_admits_lookup_after_reservation_and_keeps_evidence(
    monkeypatch,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    user = create_test_user("paid-live-search", "paid-live-search@example.com")
    _fund(int(user.id))
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    search = WebSearchResult(
        enabled=True,
        reason="mocked_responses_search",
        usage={"input_tokens": 21, "output_tokens": 17, "search_calls": 1},
        results=[{
            "title": "Tamil Nadu official directory",
            "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
            "claim": "Example Person is the Chief Minister of Tamil Nadu.",
            "officeholder": "Example Person",
            "source": "official-government",
            "provenance": "official-government",
            "url": "https://example.test/tamil-nadu-directory",
            "retrieved_at": fixed.isoformat(),
            "temporal_as_of": "2026-09-10",
            "temporal_support": True,
            "relevant": True,
        }],
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: search,
    )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Who is the CM of Tamil Nadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en", now=fixed,
    )
    assert prepared.route.provider == "openai"
    assert prepared.precomputed_response is None
    assert prepared.retrieval_context is not None
    assert prepared.ai_request.metadata["freshness_evidence_status"] == "grounded"
    assert "Chief Minister of Tamil Nadu" in str(
        prepared.ai_request.metadata["serialized_provider_prompt"]
    )

    class Provider:
        def complete(self, request, route):
            assert "freshness_evidence_prompt" in request.metadata
            text = "Example Person is the Chief Minister of Tamil Nadu. [S1]"
            return AIProviderResponse(
                text=text, provider="openai", model=route.model,
                route=route.route, reason="mocked", language="en", intent=route.intent,
                input_tokens=20, output_tokens=12,
                raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
            )

        def stream_complete(self, request, route, on_delta):
            assert "freshness_evidence_prompt" in request.metadata
            text = "Example Person is the Chief Minister of Tamil Nadu. [S1]"
            on_delta(text)
            return AIProviderResponse(
                text=text, provider="openai", model=route.model,
                route=route.route, reason="mocked", language="en", intent=route.intent,
                input_tokens=20, output_tokens=12,
                raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
            )

    completed = execute_web_turn(prepared, providers={"openai": Provider()})
    assert completed.message.sources
    assert completed.message.sources[0]["locator"].startswith("https://")
    assert completed.response.raw["cache_eligible"] is False
    assert completed.response.raw["web_search_usage"]["calls"] == 1


@pytest.mark.parametrize(
    ("tier", "message", "reply_language", "expected_provider", "provider_pool"),
    (
        ("lite", "Who is the CM of Tamil Nadu?", "en", "openai", False),
        ("standard", "தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் யார்?", "ta", "sarvam", True),
        ("pro", "Tamil Nadu la ippo CM yaaru?", "tanglish", "sarvam", True),
    ),
)
def test_each_paid_tier_and_answer_language_uses_validated_search_evidence(
    monkeypatch, tier, message, reply_language, expected_provider, provider_pool,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SWICO_PRO_ENABLED", "true")
    monkeypatch.setenv("WEB_MULTI_PROVIDER_ROUTING_ENABLED", str(provider_pool).lower())
    user = create_test_user(
        f"paid-{tier}-search", f"paid-{tier}-search@example.com",
    )
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier=tier))
        session.commit()
    _fund(int(user.id))
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(
            enabled=True,
            reason="mocked_responses_search",
            usage={"input_tokens": 21, "output_tokens": 17, "search_calls": 1},
            results=[{
                "title": "Tamil Nadu official directory",
                "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
                "claim": "Example Person is the Chief Minister of Tamil Nadu.",
                "officeholder": "Example Person",
                "source": "official-government",
                "provenance": "official-government",
                "url": "https://example.test/tamil-nadu-directory",
                "retrieved_at": fixed.isoformat(),
                "temporal_as_of": "2026-09-10",
                "temporal_support": True,
                "relevant": True,
            }],
        ),
    )

    prepared = prepare_web_turn(
        user_id=int(user.id), message=message, request_id=str(uuid4()),
        thread_id=None, reply_language=reply_language, now=fixed,
    )
    assert prepared.swico_tier == tier
    assert prepared.route.provider == expected_provider
    assert prepared.retrieval_context is not None

    class Provider:
        def complete(self, request, route):
            assert "freshness_evidence_prompt" in request.metadata
            answer = "Example Person is the Chief Minister of Tamil Nadu. [S1]"
            return AIProviderResponse(
                text=answer, provider=route.provider, model=route.model,
                route=route.route, reason="mocked", language=reply_language,
                intent=route.intent, input_tokens=20, output_tokens=12,
                raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
            )

    completed = execute_web_turn(
        prepared, providers={expected_provider: Provider()},
    )
    assert completed.message.sources
    assert completed.response.raw["cache_eligible"] is False


def test_free_current_turn_never_calls_paid_adapter(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    user = create_test_user("free-live-search", "free-live-search@example.com")
    called = False

    def fail(_self, _query):
        nonlocal called
        called = True
        raise AssertionError("Free must not call paid search")

    monkeypatch.setattr("app.web_api.chat_service.WebSearchAgent.search", fail)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Who is the CM of Tamil Nadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en",
        forced_swico_tier="free", swico_free_eligible=True,
    )
    assert prepared.precomputed_response is not None
    assert called is False


def test_insufficient_balance_admits_no_paid_search_call(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    user = create_test_user("no-paid-balance", "no-paid-balance@example.com")
    called = False

    def fail(_self, _query):
        nonlocal called
        called = True
        raise AssertionError("search must follow the normal balance reservation")

    monkeypatch.setattr("app.web_api.chat_service.WebSearchAgent.search", fail)
    with pytest.raises(InsufficientCreditError):
        prepare_web_turn(
            user_id=int(user.id), message="Who is the CM of Tamil Nadu?",
            request_id=str(uuid4()), thread_id=None, reply_language="en",
        )
    assert called is False


def test_evidence_validation_can_skip_irrelevant_first_result_but_reject_conflicting_supported_claims():
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    query = "Who is the CM of Tamil Nadu?"
    common = {
        "url": "https://example.test/source",
        "source": "official-government",
        "provenance": "official-government",
        "retrieved_at": fixed.isoformat(),
        "temporal_as_of": "2026-09-10",
        "temporal_support": True,
        "relevant": True,
    }
    irrelevant = {
        **common,
        "title": "Tamil Nadu tourism guide",
        "snippet": "Tamil Nadu has beaches and wildlife tourism.",
    }
    supported = {
        **common,
        "title": "Tamil Nadu official directory",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
        "claim": "Example Person is the Chief Minister of Tamil Nadu.",
        "officeholder": "Example Person",
    }
    accepted, _evidence, reason = validate_current_evidence(
        query, [irrelevant, supported], now=fixed,
    )
    assert accepted is True
    assert reason == "grounded_current_evidence"

    conflicting = {
        **supported,
        "url": "https://example.test/other",
        "snippet": "Another Person is the Chief Minister of Tamil Nadu.",
        "claim": "Another Person is the Chief Minister of Tamil Nadu.",
        "officeholder": "Another Person",
    }
    assert validate_current_evidence(
        query, [supported, conflicting], now=fixed,
    )[2] == "evidence_stale_or_conflicting"
