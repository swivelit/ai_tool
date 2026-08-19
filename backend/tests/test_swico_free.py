from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlmodel import select

from app.ai.providers.swico_free_provider import (
    SwicoFreeBusyError, SwicoFreeProvider, SwicoFreeTimeoutError,
    SwicoFreeUnavailableError,
)
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest, AIRoute
from app.billing.service import (
    create_swico_free_usage, get_wallet_summary, settle_swico_free_usage,
)
from app.database import SessionLocal
from app.models import UsageCharge, WalletLedger, WebUsagePreferences
from app.web_ai.tier_policy import tier_policy_for, validated_tier_policies
from app.web_api.chat_service import _phase2_embedding_vectors
from app.web_api.router import _enforce_swico_free_limits, SwicoFreeLimitError
from tests.conftest import auth_headers, create_test_user


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))


def test_free_is_canonical_but_not_in_the_paid_model_ladder(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    request = AIRequest(
        user_id=1, message="Explain this simply", reply_language="en",
        channel="text", request_id="free-route", metadata={
            "client_surface": "web", "swico_tier": "free", "user_tier": "paid",
        },
    )
    route = AIProviderRouter().select_route(request)
    assert route.provider == "swico_free"
    assert route.model is None
    assert tier_policy_for("free").max_output_tokens == 512
    assert tier_policy_for("free").persistent_knowledge_allowed is False
    assert tier_policy_for("free").repository_validation_allowed is False
    assert [policy.tier_id for policy in validated_tier_policies()] == ["free", "lite", "standard", "pro"]


def test_disabled_free_is_not_accepted_as_a_route(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "false")
    request = AIRequest(
        user_id=1, message="Explain quantum mechanics", reply_language="en", channel="text",
        request_id="disabled-free", metadata={"client_surface": "web", "swico_tier": "free"},
    )
    with pytest.raises(RuntimeError):
        AIProviderRouter().select_route(request)


def test_free_provider_never_uses_paid_provider_fallback(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    route = AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32)
    request = AIRequest(1, "hello", "en", "text", "free-provider", {}, [])
    provider = SwicoFreeProvider()
    assert provider is not None
    monkeypatch.setattr(provider, "_post", lambda *_args, **_kwargs: (_ for _ in ()).throw(SwicoFreeUnavailableError()))
    with pytest.raises(SwicoFreeUnavailableError) as error:
        provider.complete(request, route)
    assert error.value.code == "swico_free_unavailable"


def test_free_provider_authenticates_backend_to_backend_without_logging_secrets(monkeypatch, caplog):
    token = "free-node-secret-" + ("x" * 32)
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", token)
    captured: dict[str, object] = {}

    def fake_transport(*, retries):
        captured["retries"] = retries

        def handle(request):
            captured.update({
                "url": str(request.url), "headers": request.headers,
                "json": json.loads(request.content),
            })
            return httpx.Response(
                200,
                json={"text": "safe response", "usage": {"input_tokens": 3, "output_tokens": 2}},
                request=request,
            )

        return httpx.MockTransport(handle)

    monkeypatch.setattr(httpx, "HTTPTransport", fake_transport)
    response = SwicoFreeProvider().complete(
        AIRequest(1, "private prompt", "en", "text", "auth-test", {}, []),
        AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
    )
    assert captured["url"] == "https://free.example/v1/generate"
    assert captured["headers"]["Authorization"] == f"Bearer {token}"
    assert captured["retries"] == 2
    assert response.provider == "swico_free"
    assert token not in caplog.text
    assert "private prompt" not in caplog.text


def test_free_provider_retries_only_bounded_connection_failures(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    monkeypatch.setenv("SWICO_FREE_CONNECT_RETRIES", "2")
    attempts = 0

    class FakeTransport:
        def __init__(self, *, retries):
            self.retries = retries

    class FakeClient:
        def __init__(self, *, transport, **_kwargs):
            self.retries = transport.retries

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, endpoint, **_kwargs):
            nonlocal attempts
            for attempt in range(self.retries + 1):
                attempts += 1
                if attempt == 0:
                    _connection_error = httpx.ConnectError(
                        "handshake failed", request=httpx.Request("POST", f"https://free.example{endpoint}"),
                    )
                    continue
                return httpx.Response(
                    200, json={"text": "safe", "usage": {"input_tokens": 1, "output_tokens": 1}},
                    request=httpx.Request("POST", f"https://free.example{endpoint}"),
                )
            raise AssertionError("unreachable")

    monkeypatch.setattr(httpx, "HTTPTransport", FakeTransport)
    monkeypatch.setattr(httpx, "Client", FakeClient)
    response = SwicoFreeProvider().complete(
        AIRequest(1, "prompt", "en", "text", "retry", {}, []),
        AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
    )
    assert response.text == "safe"
    assert attempts == 2


def test_free_provider_exhausted_connection_retries_are_unavailable(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    monkeypatch.setenv("SWICO_FREE_CONNECT_RETRIES", "2")
    attempts = 0

    class FakeTransport:
        def __init__(self, *, retries):
            self.retries = retries

    class FakeClient:
        def __init__(self, *, transport, **_kwargs):
            self.retries = transport.retries

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, endpoint, **_kwargs):
            nonlocal attempts
            for _attempt in range(self.retries + 1):
                attempts += 1
                _connection_error = httpx.ConnectError(
                    "handshake failed", request=httpx.Request("POST", f"https://free.example{endpoint}"),
                )
            raise _connection_error
            raise AssertionError("unreachable")

    monkeypatch.setattr(httpx, "HTTPTransport", FakeTransport)
    monkeypatch.setattr(httpx, "Client", FakeClient)
    with pytest.raises(SwicoFreeUnavailableError) as error:
        SwicoFreeProvider().complete(
            AIRequest(1, "prompt", "en", "text", "retry-exhausted", {}, []),
            AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
        )
    assert error.value.code == "swico_free_unavailable"
    assert attempts == 3


def test_free_provider_does_not_retry_http_busy_response(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    request = httpx.Request("POST", "https://free.example/v1/generate")
    response = httpx.Response(429, request=request)
    calls = 0

    def handle(_request):
        nonlocal calls
        calls += 1
        return response

    monkeypatch.setattr(httpx, "HTTPTransport", lambda *, retries: httpx.MockTransport(handle))
    with pytest.raises(SwicoFreeBusyError) as error:
        SwicoFreeProvider().complete(
            AIRequest(1, "prompt", "en", "text", "busy", {}, []),
            AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
        )
    assert error.value.code == "swico_free_busy"
    assert calls == 1


def test_free_provider_preserves_length_finish_and_truncation(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)

    def fake_post(_self, url, _payload):
        return httpx.Response(
            200,
            json={
                "text": "truncated answer", "finish_reason": "length", "truncated": True,
                "usage": {"input_tokens": 4, "output_tokens": 32},
            }, request=httpx.Request("POST", f"https://free.example{url}"),
        )

    monkeypatch.setattr(SwicoFreeProvider, "_post", fake_post)
    response = SwicoFreeProvider().complete(
        AIRequest(1, "prompt", "en", "text", "finish-length", {}, []),
        AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 512),
    )
    assert response.raw["finish_reason"] == "length"
    assert response.raw["truncated"] is True


def test_free_route_uses_server_output_ceiling_without_affecting_paid_route(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_MAX_OUTPUT_TOKENS", "256")
    free_request = AIRequest(
        1, "Write a detailed explanation", "en", "text", "ceiling-free", {
            "client_surface": "web", "swico_tier": "free",
            "swico_free_max_output_tokens": 512,
        }, [],
    )
    free_route = AIProviderRouter().select_route(free_request)
    assert free_route.max_output_tokens <= 256
    paid_request = AIRequest(
        1, "Write a detailed explanation", "en", "text", "ceiling-paid", {
            "client_surface": "web", "swico_tier": "lite",
        }, [],
    )
    paid_route = AIProviderRouter().select_route(paid_request)
    assert paid_route.provider == "openai"


def test_free_provider_stream_preserves_length_finish_and_truncation(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)

    def fake_transport(*, retries):
        assert retries == 2
        return httpx.MockTransport(lambda request: httpx.Response(
            200,
            content=(
                b'data: {"delta":"partial"}\n'
                b'data: {"usage":{"input_tokens":3,"output_tokens":32,"finish_reason":"length","truncated":true}}\n'
                b'data: [DONE]\n'
            ),
            request=request,
        ))

    monkeypatch.setattr(httpx, "HTTPTransport", fake_transport)
    response = SwicoFreeProvider().stream_complete(
        AIRequest(1, "prompt", "en", "text", "stream-length", {
            "cancellation_signal": None,
        }, []),
        AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 512),
        lambda _delta: None,
    )
    assert response.raw["finish_reason"] == "length"
    assert response.raw["truncated"] is True


def test_free_provider_retries_stream_connection_before_output(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    monkeypatch.setenv("SWICO_FREE_CONNECT_RETRIES", "2")
    stream_attempts = 0

    class FakeTransport:
        def __init__(self, *, retries):
            self.retries = retries

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def iter_lines(self):
            return iter(['data: {"delta":"retried"}', 'data: [DONE]'])

    class FakeClient:
        def __init__(self, *, transport, **_kwargs):
            self.retries = transport.retries

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def stream(self, _method, endpoint, **_kwargs):
            nonlocal stream_attempts
            for attempt in range(self.retries + 1):
                stream_attempts += 1
                if attempt == 0:
                    continue
                return Response()
            raise httpx.ConnectError(
                "stream handshake failed", request=httpx.Request("POST", f"https://free.example{endpoint}"),
            )

    monkeypatch.setattr(httpx, "HTTPTransport", FakeTransport)
    monkeypatch.setattr(httpx, "Client", FakeClient)
    chunks: list[str] = []
    response = SwicoFreeProvider().stream_complete(
        AIRequest(1, "prompt", "en", "text", "stream-retry", {}, []),
        AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
        chunks.append,
    )
    assert response.text == "retried"
    assert chunks == ["retried"]
    assert stream_attempts == 2


def test_free_provider_does_not_replay_after_stream_output(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    stream_calls = 0

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def iter_lines(self):
            yield 'data: {"delta":"visible"}'
            raise httpx.ConnectError(
                "stream read failed", request=httpx.Request("POST", "https://free.example/v1/generate/stream"),
            )

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def stream(self, *_args, **_kwargs):
            nonlocal stream_calls
            stream_calls += 1
            return Response()

    monkeypatch.setattr(httpx, "Client", FakeClient)
    chunks: list[str] = []
    with pytest.raises(SwicoFreeUnavailableError):
        SwicoFreeProvider().stream_complete(
            AIRequest(1, "prompt", "en", "text", "stream-no-replay", {}, []),
            AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
            chunks.append,
        )
    assert chunks == ["visible"]
    assert stream_calls == 1


def test_free_embedding_path_uses_remote_e5_and_not_openai(monkeypatch):
    calls: list[tuple[list[str], str]] = []
    monkeypatch.setattr(
        SwicoFreeProvider, "embed",
        lambda _self, values, mode="passage": calls.append((list(values), mode))
        or [[0.0] * 384 for _ in values],
    )
    prepared = SimpleNamespace(swico_tier="free", embedding_accounted=True)
    counters = {"attempted_calls": 0, "successful_calls": 0, "input_tokens": 0, "attempted_input_tokens": 0}
    embed = _phase2_embedding_vectors(prepared, SimpleNamespace(embedding_model="unused"), {}, counters)
    assert len(embed(["document"], mode="passage")[0]) == 384
    assert len(embed(["question"], mode="query")[0]) == 384
    assert calls == [(["document"], "passage"), (["question"], "query")]


def test_free_usage_is_zero_charge_and_does_not_create_wallet_ledger():
    user = create_test_user()
    with SessionLocal() as session:
        charge = create_swico_free_usage(
            session, request_id="free-zero", user_id=int(user.id), thread_id=None,
            pricing_snapshot_json="{}", swico_tier="free",
        )
        session.commit()
        settle_swico_free_usage(
            session, request_id="free-zero", input_tokens=11,
            cached_input_tokens=2, output_tokens=7, usage_source="actual",
            pricing_snapshot_json="{}",
        )
        session.commit()
        row = session.exec(select(UsageCharge).where(UsageCharge.request_id == "free-zero")).one()
        wallet = get_wallet_summary(session, int(user.id), swico_tier="free")
        assert row.status == "free"
        assert (row.reserved_micros, row.provider_cost_micros, row.debited_micros) == (0, 0, 0)
        assert (row.input_tokens, row.cached_input_tokens, row.output_tokens) == (11, 2, 7)
        assert wallet["balance_micros"] == 0
        assert session.exec(select(WalletLedger)).all() == []


def test_free_voice_session_is_rejected_before_voice_provider(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("WEB_REALTIME_VOICE_ENABLED", "true")
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    create_test_user()
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=1, assistant_tier="free"))
        session.commit()
    response = client.post("/api/web/voice/sessions", headers=auth_headers("test-uid"), json={})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "swico_free_text_only"


def test_free_feature_flag_keeps_existing_selection_behavior(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "false")
    create_test_user()
    response = client.patch(
        "/api/web/settings/assistant", headers=auth_headers("test-uid"),
        json={"tier": "free"},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "tier_unavailable"


def test_free_rollout_zero_blocks_normal_users_in_bootstrap_and_settings(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_ROLLOUT_PERCENT", "0")
    create_test_user("rollout-normal", "rollout-normal@example.com")
    headers = auth_headers("rollout-normal", "rollout-normal@example.com")
    settings = client.get("/api/web/settings/assistant", headers=headers).json()
    bootstrap = client.get("/api/web/bootstrap", headers=headers).json()
    assert next(item for item in settings["tiers"] if item["id"] == "free")["available"] is False
    assert next(item for item in bootstrap["assistant"]["tiers"] if item["id"] == "free")["available"] is False
    response = client.patch(
        "/api/web/settings/assistant", headers=headers, json={"tier": "free"},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "tier_unavailable"


def test_verified_internal_test_user_can_use_free_at_rollout_zero(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_ROLLOUT_PERCENT", "0")
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "internal-free@example.com")
    create_test_user("internal-free", "internal-free@example.com")
    headers = auth_headers("internal-free", "internal-free@example.com")
    response = client.patch(
        "/api/web/settings/assistant", headers=headers, json={"tier": "free"},
    )
    assert response.status_code == 200
    assert response.json()["tier"] == "free"
    assert next(item for item in response.json()["tiers"] if item["id"] == "free")["available"] is True


def test_rollout_one_hundred_enables_ordinary_users(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_ROLLOUT_PERCENT", "100")
    create_test_user("rollout-all", "rollout-all@example.com")
    response = client.patch(
        "/api/web/settings/assistant",
        headers=auth_headers("rollout-all", "rollout-all@example.com"),
        json={"tier": "free"},
    )
    assert response.status_code == 200
    assert response.json()["tier"] == "free"


def test_master_switch_blocks_even_internal_users(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "false")
    monkeypatch.setenv("SWICO_FREE_ROLLOUT_PERCENT", "100")
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "disabled-free@example.com")
    create_test_user("disabled-free", "disabled-free@example.com")
    response = client.patch(
        "/api/web/settings/assistant",
        headers=auth_headers("disabled-free", "disabled-free@example.com"),
        json={"tier": "free"},
    )
    assert response.status_code == 422


def test_manual_database_free_selection_cannot_bypass_rollout(monkeypatch, client):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_ROLLOUT_PERCENT", "0")
    user = create_test_user("manual-free", "manual-free@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier="free"))
        session.commit()
    headers = auth_headers("manual-free", "manual-free@example.com")
    settings = client.get("/api/web/settings/assistant", headers=headers).json()
    assert settings["tier"] == "lite"
    response = client.post(
        "/api/web/chat/stream", headers=headers,
        json={"request_id": "a1000000-0000-4000-8000-000000000099", "message": "Explain this."},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "tier_unavailable"


def test_free_limits_are_isolated_from_paid_chat_rate_limits(monkeypatch):
    user = create_test_user("free-limits", "free-limits@example.com")
    from app.web_api.router import _rate_limit
    monkeypatch.setenv("SWICO_FREE_RATE_LIMIT_PER_MINUTE", "1")
    monkeypatch.setenv("SWICO_FREE_DAILY_MESSAGE_LIMIT", "10")
    _enforce_swico_free_limits(int(user.id))
    with pytest.raises(SwicoFreeLimitError) as error:
        _enforce_swico_free_limits(int(user.id))
    assert error.value.code == "swico_free_rate_limited"
    with SessionLocal() as session:
        _rate_limit(session, user_id=int(user.id), action="web_chat", limit=2)
        _rate_limit(session, user_id=int(user.id), action="web_chat", limit=2)


def test_free_daily_limit_is_isolated_from_paid_chat_rate_limits(monkeypatch):
    user = create_test_user("free-daily", "free-daily@example.com")
    from app.web_api.router import _rate_limit
    monkeypatch.setenv("SWICO_FREE_RATE_LIMIT_PER_MINUTE", "10")
    monkeypatch.setenv("SWICO_FREE_DAILY_MESSAGE_LIMIT", "1")
    _enforce_swico_free_limits(int(user.id))
    with SessionLocal() as session:
        create_swico_free_usage(
            session, request_id="free-daily-completed", user_id=int(user.id),
            thread_id=None, pricing_snapshot_json="{}",
        )
        settle_swico_free_usage(
            session, request_id="free-daily-completed", input_tokens=2,
            cached_input_tokens=0, output_tokens=3, usage_source="actual",
            pricing_snapshot_json="{}",
        )
        session.commit()
    with pytest.raises(SwicoFreeLimitError) as error:
        _enforce_swico_free_limits(int(user.id))
    assert error.value.code == "swico_free_daily_limit"
    with SessionLocal() as session:
        _rate_limit(session, user_id=int(user.id), action="web_chat", limit=2)
        _rate_limit(session, user_id=int(user.id), action="web_chat", limit=2)


def test_free_daily_limit_retry_after_is_until_next_utc_day(monkeypatch):
    user = create_test_user("free-daily-retry-after", "free-daily-retry-after@example.com")
    monkeypatch.setenv("SWICO_FREE_RATE_LIMIT_PER_MINUTE", "10")
    monkeypatch.setenv("SWICO_FREE_DAILY_MESSAGE_LIMIT", "1")
    monkeypatch.setattr(
        "app.web_api.router.utc_now",
        lambda: datetime(2031, 11, 17, 23, 59, 30, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        "app.billing.service.utc_now",
        lambda: datetime(2031, 11, 17, 23, 59, 30, tzinfo=timezone.utc),
    )
    with SessionLocal() as session:
        create_swico_free_usage(
            session, request_id="free-daily-retry-completed", user_id=int(user.id),
            thread_id=None, pricing_snapshot_json="{}",
        )
        settle_swico_free_usage(
            session, request_id="free-daily-retry-completed", input_tokens=2,
            cached_input_tokens=0, output_tokens=3, usage_source="actual",
            pricing_snapshot_json="{}",
        )
        session.commit()
    with pytest.raises(SwicoFreeLimitError) as error:
        _enforce_swico_free_limits(int(user.id))
    assert error.value.code == "swico_free_daily_limit"
    assert error.value.retry_after_seconds == 30


def test_failed_free_generation_does_not_consume_completed_daily_allowance(monkeypatch):
    user = create_test_user("free-daily-failure", "free-daily-failure@example.com")
    monkeypatch.setenv("SWICO_FREE_RATE_LIMIT_PER_MINUTE", "10")
    monkeypatch.setenv("SWICO_FREE_DAILY_MESSAGE_LIMIT", "1")
    with SessionLocal() as session:
        create_swico_free_usage(
            session, request_id="free-daily-failed", user_id=int(user.id),
            thread_id=None, pricing_snapshot_json="{}",
        )
        session.commit()
    _enforce_swico_free_limits(int(user.id))
    with SessionLocal() as session:
        from app.billing.service import release_swico_free_usage
        release_swico_free_usage(session, "free-daily-failed")
        session.commit()
    _enforce_swico_free_limits(int(user.id))


def test_unavailable_provider_error_is_safe_and_never_logs_prompt(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    request = httpx.Request("POST", "https://free.example/v1/generate")
    def fake_transport(*, retries):
        assert retries == 2
        return httpx.MockTransport(lambda _request: (_ for _ in ()).throw(
            httpx.ConnectError("offline", request=request)
        ))

    monkeypatch.setattr(httpx, "HTTPTransport", fake_transport)
    with pytest.raises(SwicoFreeUnavailableError) as error:
        SwicoFreeProvider().complete(
            AIRequest(1, "private prompt", "en", "text", "offline", {}, []),
            AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
        )
    assert error.value.code == "swico_free_unavailable"
    assert "private prompt" not in str(error.value)


def test_free_provider_maps_laptop_timeout_without_fallback(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    request = httpx.Request("POST", "https://free.example/v1/generate")
    response = httpx.Response(504, json={"detail": {"code": "swico_free_timeout"}}, request=request)
    monkeypatch.setattr(
        httpx, "HTTPTransport",
        lambda *, retries: httpx.MockTransport(lambda _request: response),
    )
    with pytest.raises(SwicoFreeTimeoutError) as error:
        SwicoFreeProvider().complete(
            AIRequest(1, "private prompt", "en", "text", "timeout", {}, []),
            AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
        )
    assert error.value.code == "swico_free_timeout"
    assert error.value.status_code == 504


def test_bounded_node_capacity_maps_queue_full_to_429():
    from swico_free_node.app import GenerationCapacity

    async def check():
        capacity = GenerationCapacity(1, 1)
        await capacity.acquire()
        waiting = asyncio.create_task(capacity.acquire())
        await asyncio.sleep(0)
        assert capacity.waiting_or_active == 2
        with pytest.raises(Exception) as error:
            await capacity.acquire()
        assert getattr(error.value, "status_code", None) == 429
        await capacity.release()
        await waiting
        await capacity.release()

    asyncio.run(check())


def test_generation_queue_wait_deadline_expires_without_starting_work():
    from swico_free_node.app import CapacityWaitExpired, GenerationCapacity

    async def check():
        capacity = GenerationCapacity(1, 1)
        await capacity.acquire()
        started = False
        with pytest.raises(CapacityWaitExpired):
            await capacity.acquire(timeout_seconds=0.01)
        assert capacity.waiting == 0
        assert started is False
        await capacity.release()

    asyncio.run(check())


def test_node_total_deadline_cancels_nonstream_generation(monkeypatch):
    import swico_free_node.app as node_app
    from swico_free_node.schemas import GenerateRequest

    cancelled = threading.Event()

    class Runtime:
        def generate(self, _messages, _max_output_tokens, cancellation=None):
            while cancellation is None or not cancellation.is_set():
                time.sleep(0.005)
            cancelled.set()
            raise RuntimeError("cancelled by test")

    monkeypatch.setattr(node_app, "config", SimpleNamespace(
        max_output_tokens=256, max_queue_wait_seconds=1,
        max_total_request_seconds=0.05,
    ))
    monkeypatch.setattr(node_app, "qwen", Runtime())
    monkeypatch.setattr(node_app, "e5", object())
    monkeypatch.setattr(node_app, "capacity", node_app.GenerationCapacity(1, 1))
    monkeypatch.setattr(node_app, "embedding_capacity", node_app.GenerationCapacity(1, 1))
    with pytest.raises(Exception) as error:
        asyncio.run(node_app.generate(
            GenerateRequest(messages=[{"role": "user", "content": "Answer"}], max_output_tokens=64),
            None,
        ))
    assert getattr(error.value, "status_code", None) == 504
    assert error.value.detail["code"] == "swico_free_timeout"
    assert cancelled.is_set()


def test_node_total_deadline_ends_stream_safely_after_visible_output(monkeypatch):
    import swico_free_node.app as node_app
    from swico_free_node.schemas import GenerateRequest

    class Runtime:
        def stream(self, _messages, _max_output_tokens, cancellation=None):
            yield "visible answer", {}
            while cancellation is None or not cancellation.is_set():
                time.sleep(0.005)

    class Request:
        async def is_disconnected(self):
            return False

    monkeypatch.setattr(node_app, "config", SimpleNamespace(
        max_output_tokens=256, max_queue_wait_seconds=1,
        max_total_request_seconds=0.05,
    ))
    monkeypatch.setattr(node_app, "qwen", Runtime())
    monkeypatch.setattr(node_app, "e5", object())
    monkeypatch.setattr(node_app, "capacity", node_app.GenerationCapacity(1, 1))
    monkeypatch.setattr(node_app, "embedding_capacity", node_app.GenerationCapacity(1, 1))
    async def consume():
        response = await node_app.generate_stream(
            Request(),
            GenerateRequest(messages=[{"role": "user", "content": "Answer"}], max_output_tokens=64),
            None,
        )
        return [chunk async for chunk in response.body_iterator]

    body = "".join(asyncio.run(consume()))
    assert "visible answer" in body
    assert '"finish_reason": "timeout"' in body
    assert '"truncated": true' in body
    assert '"completion_status": "incomplete"' in body
    assert "<think>" not in body


def test_node_cpu_defaults_are_conservative_and_configurable(monkeypatch, tmp_path):
    from swico_free_node.config import NodeConfig

    qwen_path = tmp_path / "custom.Q4.gguf"
    qwen_path.write_bytes(b"GGUF" + b"model")
    e5_path = tmp_path / "e5"
    e5_path.mkdir()
    monkeypatch.setenv("SWICO_FREE_NODE_TOKEN", "x" * 40)
    monkeypatch.setenv("SWICO_FREE_QWEN_GGUF_PATH", str(qwen_path))
    monkeypatch.setenv("SWICO_FREE_E5_MODEL_PATH", str(e5_path))
    config = NodeConfig.from_environment()
    assert (config.qwen_threads, config.qwen_batch_size, config.e5_threads) == (4, 128, 2)
    assert (config.max_concurrent_embeddings, config.max_embedding_queue_size) == (1, 4)
    assert config.max_output_tokens == 256


def test_node_health_reports_safe_capacity_metrics(monkeypatch):
    import swico_free_node.app as node_app

    class Runtime:
        def generate(self, _messages, _max_output_tokens, _cancellation=None):
            return "partial", {"finish_reason": "length", "truncated": True}

    monkeypatch.setattr(node_app, "config", SimpleNamespace(max_queue_size=10, max_embedding_queue_size=4))
    monkeypatch.setattr(node_app, "qwen", Runtime())
    monkeypatch.setattr(node_app, "e5", object())
    monkeypatch.setattr(node_app, "capacity", node_app.GenerationCapacity(1, 10))
    monkeypatch.setattr(node_app, "embedding_capacity", node_app.GenerationCapacity(1, 4))
    health = asyncio.run(node_app.health())
    assert health["generation_capacity"] == 1
    assert health["generation_queue_capacity"] == 10
    assert health["active_generations"] == 0
    assert health["waiting_generations"] == 0
    assert "model" not in " ".join(health.keys()).lower()


def test_node_nonstream_generation_propagates_length_finish(monkeypatch):
    import swico_free_node.app as node_app
    from swico_free_node.schemas import GenerateRequest

    class Runtime:
        def generate(self, _messages, _max_output_tokens, _cancellation=None):
            return "partial", {"finish_reason": "length", "truncated": True}

    monkeypatch.setattr(node_app, "config", SimpleNamespace(max_output_tokens=256))
    monkeypatch.setattr(node_app, "qwen", Runtime())
    monkeypatch.setattr(node_app, "e5", object())
    monkeypatch.setattr(node_app, "capacity", node_app.GenerationCapacity(1, 10))
    monkeypatch.setattr(node_app, "embedding_capacity", node_app.GenerationCapacity(1, 4))
    response = asyncio.run(node_app.generate(
        GenerateRequest(messages=[{"role": "user", "content": "Answer"}], max_output_tokens=256),
        None,
    ))
    assert response["finish_reason"] == "length"
    assert response["truncated"] is True


def _write_e5_transformer_artifacts(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text('{"hidden_size":384}', encoding="utf-8")
    (path / "tokenizer.json").write_text("{}", encoding="utf-8")
    (path / "model.safetensors").write_bytes(b"local")


def test_sentence_transformers_root_transformer_layout_is_resolved_without_network(tmp_path):
    from swico_free_node.e5_runtime import validate_e5_artifacts

    root = tmp_path / "multilingual-e5-small"
    _write_e5_transformer_artifacts(root)
    (root / "modules.json").write_text(
        '[{"idx":0,"name":"0","path":"","type":"sentence_transformers.models.Transformer"},'
        '{"idx":1,"name":"1","path":"1_Pooling","type":"sentence_transformers.models.Pooling"},'
        '{"idx":2,"name":"2","path":"2_Normalize","type":"sentence_transformers.models.Normalize"}]',
        encoding="utf-8",
    )
    assert validate_e5_artifacts(root) == root


def test_sentence_transformers_nested_transformer_layout_is_resolved_without_network(tmp_path):
    from swico_free_node.e5_runtime import validate_e5_artifacts

    root = tmp_path / "sentence-transformer"
    transformer = root / "0_Transformer"
    _write_e5_transformer_artifacts(transformer)
    (root / "modules.json").write_text(
        '[{"idx":0,"name":"0","path":"0_Transformer","type":"sentence_transformers.models.Transformer"},'
        '{"idx":1,"name":"1","path":"1_Pooling","type":"sentence_transformers.models.Pooling"}]',
        encoding="utf-8",
    )
    assert validate_e5_artifacts(root) == transformer


@pytest.mark.parametrize(
    "modules, expected",
    [
        ("[]", "no Transformer module"),
        ('[{"type":"sentence_transformers.models.Transformer"}]', "invalid path"),
        ('[{"path":"missing","type":"sentence_transformers.models.Transformer"}]', "does not exist"),
        ('[{"path":"../outside","type":"sentence_transformers.models.Transformer"}]', "stay inside"),
    ],
)
def test_sentence_transformers_malformed_transformer_layout_fails_safely(tmp_path, modules, expected):
    from swico_free_node.e5_runtime import resolve_e5_transformer_path

    root = tmp_path / "sentence-transformer"
    root.mkdir()
    (root / "modules.json").write_text(modules, encoding="utf-8")
    with pytest.raises(RuntimeError, match=expected):
        resolve_e5_transformer_path(root)


def test_qwen_stream_signals_abort_and_closes_stream():
    from swico_free_node.qwen_runtime import QwenRuntime

    class FakeStream:
        def __init__(self):
            self.index = 0
            self.closed = False

        def __iter__(self):
            return self

        def __next__(self):
            if self.index >= 2:
                raise StopIteration
            self.index += 1
            return {"choices": [{"delta": {"content": "x"}}]}

        def close(self):
            self.closed = True

    class FakeLlama:
        def __init__(self):
            self.callbacks = []
            self.stream_instance = FakeStream()

        def set_abort_callback(self, callback):
            self.callbacks.append(callback)

        def create_chat_completion(self, **_kwargs):
            return self.stream_instance

    runtime = object.__new__(QwenRuntime)
    runtime._llama = FakeLlama()
    cancellation = threading.Event()
    stream = runtime.stream([{"role": "user", "content": "x"}], 8, cancellation)
    assert next(stream) == ("x", {})
    cancellation.set()
    with pytest.raises(StopIteration):
        next(stream)
    assert runtime._llama.stream_instance.closed is True
    assert runtime._llama.callbacks[0] is not None
    assert runtime._llama.callbacks[-1] is None


def test_qwen_non_thinking_generation_filters_hidden_reasoning():
    from swico_free_node.qwen_runtime import QwenRuntime

    class FakeLlama:
        def __init__(self):
            self.calls = []

        def create_chat_completion(self, **kwargs):
            self.calls.append(kwargs)
            return {"choices": [{"message": {"content": "<think>secret</think>Visible answer"}}]}

    runtime = object.__new__(QwenRuntime)
    runtime._llama = FakeLlama()
    text, _usage = runtime.generate([{"role": "user", "content": "Answer"}], 8)
    assert text == "Visible answer"
    assert runtime._llama.calls[0]["chat_template_kwargs"] == {"enable_thinking": False}
    assert runtime._llama.calls[0]["messages"][-1]["content"].endswith("/no_think")


def test_qwen_stream_never_emits_thinking_or_reasoning_fields():
    from swico_free_node.qwen_runtime import QwenRuntime

    class FakeLlama:
        def create_chat_completion(self, **_kwargs):
            return iter([
                {"choices": [{"delta": {"reasoning_content": "secret"}}]},
                {"choices": [{"delta": {"content": "<thi"}}]},
                {"choices": [{"delta": {"content": "nk>hidden</think>Visible"}}]},
            ])

    runtime = object.__new__(QwenRuntime)
    runtime._llama = FakeLlama()
    chunks = [
        text for text, _usage in runtime.stream(
            [{"role": "user", "content": "Answer"}], 8,
        ) if text
    ]
    assert "".join(chunks) == "Visible"
    assert all("think" not in text.lower() and "hidden" not in text for text in chunks)


def test_qwen_runtime_preserves_length_finish_reason_for_generate_and_stream():
    from swico_free_node.qwen_runtime import QwenRuntime

    class FakeLlama:
        def create_chat_completion(self, **kwargs):
            if kwargs.get("stream"):
                return iter([
                    {"choices": [{"delta": {"content": "partial"}}]},
                    {"choices": [{"finish_reason": "length"}]},
                ])
            return {
                "choices": [{"message": {"content": "partial"}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 8},
            }

    runtime = object.__new__(QwenRuntime)
    runtime._llama = FakeLlama()
    _text, usage = runtime.generate([{"role": "user", "content": "Answer"}], 8)
    assert usage["finish_reason"] == "length"
    assert usage["truncated"] is True
    chunks = list(runtime.stream([{"role": "user", "content": "Answer"}], 8))
    assert chunks[-1][1]["finish_reason"] == "length"
    assert chunks[-1][1]["truncated"] is True
