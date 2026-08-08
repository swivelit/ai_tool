from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlmodel import select

from app.ai.providers.swico_free_provider import (
    SwicoFreeProvider, SwicoFreeUnavailableError,
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

    def fake_post(url, *, headers, json, timeout):
        captured.update({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return httpx.Response(
            200,
            json={"text": "safe response", "usage": {"input_tokens": 3, "output_tokens": 2}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    response = SwicoFreeProvider().complete(
        AIRequest(1, "private prompt", "en", "text", "auth-test", {}, []),
        AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
    )
    assert captured["url"] == "https://free.example/v1/generate"
    assert captured["headers"]["Authorization"] == f"Bearer {token}"
    assert response.provider == "swico_free"
    assert token not in caplog.text
    assert "private prompt" not in caplog.text


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


def test_unavailable_provider_error_is_safe_and_never_logs_prompt(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://free.example")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    request = httpx.Request("POST", "https://free.example/v1/generate")
    monkeypatch.setattr(httpx, "post", lambda *_args, **_kwargs: (_ for _ in ()).throw(httpx.ConnectError("offline", request=request)))
    with pytest.raises(SwicoFreeUnavailableError) as error:
        SwicoFreeProvider().complete(
            AIRequest(1, "private prompt", "en", "text", "offline", {}, []),
            AIRoute("swico_free", None, "swico_free_general", "test", "en", "general", 32),
        )
    assert error.value.code == "swico_free_unavailable"
    assert "private prompt" not in str(error.value)


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


def test_sentence_transformers_e5_layout_is_resolved_without_network(tmp_path):
    from swico_free_node.e5_runtime import validate_e5_artifacts

    root = tmp_path / "sentence-transformer"
    transformer = root / "0_Transformer"
    transformer.mkdir(parents=True)
    (root / "modules.json").write_text("[]")
    (transformer / "config.json").write_text("{}")
    (transformer / "tokenizer.json").write_text("{}")
    (transformer / "model.safetensors").write_bytes(b"local")
    assert validate_e5_artifacts(root) == transformer


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
