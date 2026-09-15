from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.testclient import TestClient

from app.production_config import (
    ProductionConfigurationError,
    production_configuration_errors,
    validate_production_configuration,
)
from app.ai.provider_pool import ALIAS_DEFAULTS
from app.cors_config import (
    configured_cors_origins,
    effective_cors_origins,
    exact_local_dev_origin,
)


def valid_environment() -> dict[str, str]:
    return {
        "APP_ENV": "production",
        "LOG_CHAT_CONTENT": "false",
        "AUTH_ALLOW_DEV_TOKENS": "false",
        "WEB_APP_ENABLED": "true",
        "WEB_SIMPLE_TURN_TIER_DOWNSHIFT_ENABLED": "false",
        "WEB_REALTIME_VOICE_ENABLED": "false",
        "WEB_SEPARATE_VOICE_CREDITS_ENABLED": "false",
        "WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS": "60",
        "WEB_REALTIME_VOICE_MAX_SESSION_SECONDS": "900",
        "WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS": "60",
        "WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER": "1",
        "WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE": "5",
        "BILLING_CHECKOUT_ENABLED": "false",
        "DATABASE_URL": "postgresql+psycopg://configured",
        "FIREBASE_CREDENTIALS_JSON": "configured",
        "OPENAI_API_KEY": "configured",
        "SARVAM_API_KEY": "configured",
        "AI_PROVIDER_ROUTING_MODE": "cost_optimized",
        "RAZORPAY_MODE": "test",
        "RAZORPAY_KEY_ID": "rzp_test_configured",
        "RAZORPAY_KEY_SECRET": "checkout-configured",
        "RAZORPAY_WEBHOOK_SECRET": "webhook-configured",
        "BILLING_CREDIT_PERCENT": "50",
        "BILLING_MIN_TOPUP_PAISE": "1500",
        "BILLING_MAX_TOPUP_PAISE": "50000",
        "BILLING_TOPUP_PACKAGES_PAISE": "1500,29900",
        "BILLING_ENFORCE_TOPUP_PACKAGES": "false",
        "CORS_ALLOW_ORIGINS": "https://swico-web.onrender.com",
        "AUTO_CREATE_TABLES": "false",
        "RUN_MIGRATIONS_ON_STARTUP": "false",
        "REQUIRE_MIGRATIONS_BEFORE_STARTUP": "false",
        "EMAIL_OTP_DEV_RETURN_CODE": "false",
        "GLOBAL_QA_REAL_EMBEDDINGS_ENABLED": "false",
        "OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK": "false",
        "SWICO_DEFAULT_TIER": "lite",
        "SWICO_TIER_SELECTION_ENABLED": "true",
        "SWICO_PRO_ENABLED": "false",
        "SWICO_LITE_MODEL_PRIMARY": "gpt-5.4-mini",
        "SWICO_LITE_MODEL_FALLBACKS": "gpt-5.4-nano",
        "SWICO_STANDARD_MODEL_PRIMARY": "gpt-5.6-terra",
        "SWICO_STANDARD_MODEL_FALLBACKS": "gpt-5.5",
        "SWICO_PRO_MODEL_PRIMARY": "gpt-5.6-sol",
        "SWICO_PRO_MODEL_FALLBACKS": "gpt-5.6-terra",
        "OPENAI_PRICING_AS_OF": "2026-07-17",
        "OPENAI_PRICE_GPT_5_4_MINI_INPUT_PER_1M": "0.75",
        "OPENAI_PRICE_GPT_5_4_MINI_CACHED_INPUT_PER_1M": "0.075",
        "OPENAI_PRICE_GPT_5_4_MINI_OUTPUT_PER_1M": "4.50",
        "OPENAI_PRICE_GPT_5_4_NANO_INPUT_PER_1M": "0.20",
        "OPENAI_PRICE_GPT_5_4_NANO_CACHED_INPUT_PER_1M": "0.02",
        "OPENAI_PRICE_GPT_5_4_NANO_OUTPUT_PER_1M": "1.25",
        "OPENAI_PRICE_GPT_5_5_INPUT_PER_1M": "5.00",
        "OPENAI_PRICE_GPT_5_5_CACHED_INPUT_PER_1M": "0.50",
        "OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M": "30.00",
        "OPENAI_PRICE_GPT_5_6_TERRA_INPUT_PER_1M": "2.50",
        "OPENAI_PRICE_GPT_5_6_TERRA_CACHED_INPUT_PER_1M": "0.25",
        "OPENAI_PRICE_GPT_5_6_TERRA_OUTPUT_PER_1M": "15.00",
        "OPENAI_PRICE_GPT_5_6_SOL_INPUT_PER_1M": "5.00",
        "OPENAI_PRICE_GPT_5_6_SOL_CACHED_INPUT_PER_1M": "0.50",
        "OPENAI_PRICE_GPT_5_6_SOL_OUTPUT_PER_1M": "30.00",
    }


def test_valid_test_mode_production_configuration_passes() -> None:
    assert production_configuration_errors(valid_environment()) == []
    validate_production_configuration(valid_environment())


def test_weekly_tester_credit_configuration_is_validated_without_exposing_values() -> None:
    environment = {
        **valid_environment(),
        "SWICO_WEEKLY_TESTER_CREDITS_ENABLED": "true",
        "SWICO_WEEKLY_TESTER_EMAILS": "tester@example.com",
        "SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES": "40.25",
    }
    assert production_configuration_errors(environment) == []
    malformed = {
        **environment,
        "SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES": "not-a-decimal",
    }
    errors = production_configuration_errors(malformed)
    assert any("SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES" in error for error in errors)
    assert "tester@example.com" not in " ".join(errors)


def test_production_https_origins_and_explicit_local_origins_pass() -> None:
    environment = {
        **valid_environment(),
        "CORS_ALLOW_ORIGINS": (
            "https://swico-web.onrender.com,https://swico.in,https://www.swico.in"
        ),
        "CORS_ALLOW_LOCAL_DEV_ORIGINS": (
            "http://localhost:5173,http://127.0.0.1:5173"
        ),
    }
    assert production_configuration_errors(environment) == []
    validate_production_configuration(environment)
    assert effective_cors_origins(environment, production=True) == (
        "https://swico-web.onrender.com",
        "https://swico.in",
        "https://www.swico.in",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )


def test_http_local_origin_remains_invalid_in_production_cors_allow_origins() -> None:
    errors = production_configuration_errors({
        **valid_environment(),
        "CORS_ALLOW_ORIGINS": "https://swico.in,http://localhost:5173",
    })
    assert any("CORS_ALLOW_ORIGINS" in error for error in errors)


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.com:5173",
        "http://localhost.evil.com:5173",
        "http://127.0.0.1.evil.com:5173",
        "http://localhost:5173/",
        "http://localhost:5173/test",
        "http://localhost:5173?x=1",
        "http://localhost:5173#fragment",
        "http://user:password@localhost:5173",
        "*",
        "http://localhost",
        "http://localhost:bad",
    ],
)
def test_local_dev_origin_validation_is_loopback_exact_and_strict(origin: str) -> None:
    assert not exact_local_dev_origin(origin)
    errors = production_configuration_errors({
        **valid_environment(),
        "CORS_ALLOW_LOCAL_DEV_ORIGINS": origin,
    })
    assert any("CORS_ALLOW_LOCAL_DEV_ORIGINS" in error for error in errors)


def test_duplicate_cors_origins_are_rejected_and_effective_order_is_deterministic() -> None:
    environment = {
        **valid_environment(),
        "CORS_ALLOW_ORIGINS": "https://swico.in,https://swico.in",
        "CORS_ALLOW_LOCAL_DEV_ORIGINS": (
            "http://localhost:5173,http://localhost:5173"
        ),
    }
    errors = production_configuration_errors(environment)
    assert any("CORS_ALLOW_ORIGINS" in error for error in errors)
    assert any("CORS_ALLOW_LOCAL_DEV_ORIGINS" in error for error in errors)
    assert configured_cors_origins(environment).effective == (
        "https://swico.in", "http://localhost:5173",
    )


@pytest.mark.parametrize(
    ("origin", "allowed"),
    [
        ("http://localhost:5173", True),
        ("https://swico.in", True),
        ("http://evil.example:5173", False),
    ],
)
def test_effective_origins_drive_exact_cors_preflight(origin: str, allowed: bool) -> None:
    environment = {
        **valid_environment(),
        "CORS_ALLOW_ORIGINS": "https://swico.in",
        "CORS_ALLOW_LOCAL_DEV_ORIGINS": "http://localhost:5173",
    }
    inner = FastAPI()

    @inner.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    cors_app = CORSMiddleware(
        inner,
        allow_origins=list(effective_cors_origins(environment, production=True)),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    with TestClient(cors_app) as test_client:
        response = test_client.get("/health", headers={"Origin": origin})
    if allowed:
        assert response.headers["access-control-allow-origin"] == origin
        assert response.headers["access-control-allow-credentials"] == "true"
    else:
        assert "access-control-allow-origin" not in response.headers


def test_production_validates_guest_session_limits() -> None:
    environment = {
        **valid_environment(),
        "SWICO_GUEST_SESSION_TTL_SECONDS": "899",
        "SWICO_GUEST_SESSION_CREATION_RATE_LIMIT_PER_HOUR": "0",
        "SWICO_TRUSTED_PROXY_HOPS": "11",
    }
    errors = production_configuration_errors(environment)
    assert "SWICO_GUEST_SESSION_TTL_SECONDS must be between 900 and 2592000" in errors
    assert "SWICO_GUEST_SESSION_CREATION_RATE_LIMIT_PER_HOUR must be between 1 and 1000" in errors
    assert "SWICO_TRUSTED_PROXY_HOPS must be between 0 and 10" in errors


def test_enabled_production_provider_pool_requires_explicit_aliases() -> None:
    errors = production_configuration_errors({
        **valid_environment(),
        "WEB_MULTI_PROVIDER_ROUTING_ENABLED": "true",
    })
    assert any(
        "SWICO_MODEL_ALIAS_LITE_FAST" in error
        for error in errors
    )


def test_enabled_production_provider_pool_accepts_all_explicit_aliases() -> None:
    env = {
        **valid_environment(),
        "WEB_MULTI_PROVIDER_ROUTING_ENABLED": "true",
        **{
            f"SWICO_MODEL_ALIAS_{name.upper()}": value
            for name, value in ALIAS_DEFAULTS.items()
        },
    }
    assert production_configuration_errors(env) == []


def test_production_requires_checkout_switch_to_be_explicit() -> None:
    env = valid_environment()
    env.pop("BILLING_CHECKOUT_ENABLED")
    with pytest.raises(ProductionConfigurationError, match="BILLING_CHECKOUT_ENABLED"):
        validate_production_configuration(env)
    validate_production_configuration({**valid_environment(), "BILLING_CHECKOUT_ENABLED": "true"})
    validate_production_configuration({**valid_environment(), "BILLING_CHECKOUT_ENABLED": "false"})


def test_production_rejects_free_default_when_free_is_disabled() -> None:
    errors = production_configuration_errors({
        **valid_environment(), "SWICO_DEFAULT_TIER": "free", "SWICO_FREE_ENABLED": "false",
    })
    assert "SWICO_DEFAULT_TIER cannot be free while SWICO_FREE_ENABLED is false" in errors
    validate_production_configuration({
        **valid_environment(), "SWICO_DEFAULT_TIER": "free", "SWICO_FREE_ENABLED": "true",
        "SWICO_FREE_INFERENCE_BASE_URL": "https://free.example",
        "SWICO_FREE_INFERENCE_TOKEN": "x" * 40,
    })


def test_production_requires_custom_topup_presets_and_bounds() -> None:
    validate_production_configuration(valid_environment())
    validate_production_configuration({
        **valid_environment(),
        "BILLING_TOPUP_PACKAGES_PAISE": "29900,1500",
    })
    with pytest.raises(ProductionConfigurationError, match="exactly ₹15 and ₹299"):
        validate_production_configuration({
            **valid_environment(),
            "BILLING_TOPUP_PACKAGES_PAISE": "1500,5000,29900",
        })
    with pytest.raises(ProductionConfigurationError, match="whole-rupee bound allowing ₹299"):
        validate_production_configuration({
            **valid_environment(),
            "BILLING_MAX_TOPUP_PAISE": "25000",
        })
    with pytest.raises(ProductionConfigurationError, match="exactly ₹15 and ₹299"):
        validate_production_configuration({
            **valid_environment(),
            "BILLING_TOPUP_PACKAGES_PAISE": "1500,29900,1500",
        })
    with pytest.raises(ProductionConfigurationError, match="whole-rupee bound"):
        validate_production_configuration({
            **valid_environment(),
            "BILLING_MAX_TOPUP_PAISE": "50001",
        })


@pytest.mark.parametrize(
    ("updates", "expected"),
    [
        ({"LOG_CHAT_CONTENT": "true"}, "LOG_CHAT_CONTENT"),
        ({"AUTH_ALLOW_DEV_TOKENS": "true"}, "AUTH_ALLOW_DEV_TOKENS"),
        ({"AUTO_CREATE_TABLES": "true"}, "AUTO_CREATE_TABLES"),
        ({"RUN_MIGRATIONS_ON_STARTUP": "true"}, "RUN_MIGRATIONS_ON_STARTUP"),
        ({"OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK": "true"}, "deprecated"),
        ({"SWICO_DEFAULT_TIER": "enterprise"}, "SWICO_DEFAULT_TIER"),
        ({"SWICO_FREE_ROLLOUT_PERCENT": "101"}, "between 0 and 100"),
        ({"SWICO_FREE_RATE_LIMIT_PER_MINUTE": "0"}, "SWICO_FREE_RATE_LIMIT_PER_MINUTE"),
        ({"SWICO_FREE_DAILY_MESSAGE_LIMIT": "0"}, "SWICO_FREE_DAILY_MESSAGE_LIMIT"),
        ({"SWICO_FREE_MAX_QUEUE_WAIT_SECONDS": "0"}, "between 1 and 60"),
        ({"SWICO_FREE_MAX_QUEUE_WAIT_SECONDS": "61"}, "between 1 and 60"),
        ({"SWICO_FREE_CONNECT_RETRIES": "-1"}, "SWICO_FREE_CONNECT_RETRIES"),
        ({"SWICO_FREE_CONNECT_RETRIES": "4"}, "SWICO_FREE_CONNECT_RETRIES"),
        ({"SWICO_FREE_CONNECT_RETRIES": "invalid"}, "SWICO_FREE_CONNECT_RETRIES"),
        ({"SWICO_FREE_MAX_TOTAL_REQUEST_SECONDS": "9"}, "between 10 and 90"),
        ({"SWICO_FREE_MAX_TOTAL_REQUEST_SECONDS": "91"}, "between 10 and 90"),
        ({"SWICO_FREE_MAX_OUTPUT_TOKENS": "63"}, "between 64 and 512"),
        ({"SWICO_FREE_MAX_OUTPUT_TOKENS": "513"}, "between 64 and 512"),
        ({"SWICO_TIER_SELECTION_ENABLED": "sometimes"}, "SWICO_TIER_SELECTION_ENABLED"),
        ({"SWICO_PRO_ENABLED": "true", "SWICO_PRO_MODEL_PRIMARY": "custom"}, "SWICO_PRO_MODEL_PRIMARY"),
        ({"WEB_VOICE_REPLY_ENABLED": "true", "WEB_VOICE_BILLING_ENABLED": "false"}, "requires WEB_VOICE_BILLING_ENABLED"),
        ({"WEB_VOICE_BILLING_ENABLED": "true", "WEB_VOICE_RECORDING_ENABLED": "false"}, "requires WEB_VOICE_RECORDING_ENABLED"),
        ({"WEB_TTS_MAX_CHARACTERS": "0"}, "WEB_TTS_MAX_CHARACTERS"),
        ({"WEB_AUDIO_MAX_SECONDS": "31"}, "WEB_AUDIO_MAX_SECONDS"),
        ({"WEB_STT_MODE": "unsupported"}, "WEB_STT_MODE"),
        ({"SARVAM_CHAT_MAX_TOKENS": "0"}, "SARVAM_CHAT_MAX_TOKENS"),
        ({"SARVAM_CHAT_MAX_TOKENS": "128001"}, "SARVAM_CHAT_MAX_TOKENS"),
        ({"WEB_STT_RATE_LIMIT_PER_MINUTE": "many"}, "WEB_STT_RATE_LIMIT_PER_MINUTE"),
        ({"WEB_REALTIME_VOICE_ENABLED": "sometimes"}, "WEB_REALTIME_VOICE_ENABLED"),
        ({"WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED": "sometimes"}, "WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED"),
        ({"WEB_SIMPLE_TURN_TIER_DOWNSHIFT_ENABLED": "sometimes"}, "WEB_SIMPLE_TURN_TIER_DOWNSHIFT_ENABLED"),
        ({"WEB_REALTIME_VOICE_ENABLED": "true"}, "requires WEB_SEPARATE_VOICE_CREDITS_ENABLED"),
        ({"WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER": "2"}, "must be 1"),
        ({"WEB_REALTIME_VOICE_END_SILENCE_MS": "0"}, "WEB_REALTIME_VOICE_END_SILENCE_MS"),
        ({"WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS": "500"}, "must be at least WEB_REALTIME_VOICE_END_SILENCE_MS"),
        ({"WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS": "10001"}, "must be at most 10000"),
        ({"WEB_REALTIME_VOICE_MAX_UTTERANCE_MS": "1800"}, "must be greater than WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS"),
        ({"WEB_REALTIME_VOICE_BARGE_IN_MIN_MS": "invalid"}, "WEB_REALTIME_VOICE_BARGE_IN_MIN_MS"),
        ({"SARVAM_STT_STREAM_MESSAGE_ENCODING": "mp3"}, "SARVAM_STT_STREAM_MESSAGE_ENCODING"),
        ({"WEB_REALTIME_VOICE_PLAYBACK_MODE": "progressive"}, "WEB_REALTIME_VOICE_PLAYBACK_MODE"),
        ({"SARVAM_TTS_STREAM_OUTPUT_CODEC": "pcm"}, "SARVAM_TTS_STREAM_OUTPUT_CODEC"),
        ({"SARVAM_TTS_STREAM_SAMPLE_RATE": "44100"}, "SARVAM_TTS_STREAM_SAMPLE_RATE"),
        ({"WEB_REALTIME_VOICE_PLAYBACK_MODE": "pcm_stream"}, "requires SARVAM_TTS_STREAM_OUTPUT_CODEC linear16"),
        ({"RAZORPAY_READ_RETRY_ATTEMPTS": "0"}, "RAZORPAY_READ_RETRY_ATTEMPTS"),
        ({"RAZORPAY_READ_RETRY_BASE_MS": "5000"}, "RAZORPAY_READ_RETRY_MAX_MS"),
        ({"SARVAM_PRICE_STT_INR_PER_HOUR": "0"}, "SARVAM_PRICE_STT_INR_PER_HOUR"),
        ({"SARVAM_PRICE_105B_INPUT_INR_PER_1M": "0"}, "SARVAM_PRICE_105B_INPUT_INR_PER_1M"),
        ({"SARVAM_PRICE_105B_CACHED_INPUT_INR_PER_1M": "-1"}, "SARVAM_PRICE_105B_CACHED_INPUT_INR_PER_1M"),
        ({"SARVAM_PRICE_105B_OUTPUT_INR_PER_1M": "not-a-price"}, "SARVAM_PRICE_105B_OUTPUT_INR_PER_1M"),
        ({"RAZORPAY_KEY_ID": "rzp_live_not_allowed"}, "rzp_test_"),
        ({"RAZORPAY_WEBHOOK_SECRET": "checkout-configured"}, "must be distinct"),
        ({"BILLING_CREDIT_PERCENT": "49"}, "BILLING_CREDIT_PERCENT"),
        ({"BILLING_MIN_TOPUP_PAISE": "1501"}, "must allow ₹15"),
        ({"BILLING_TOPUP_PACKAGES_PAISE": "5000"}, "must include ₹15"),
        ({"BILLING_ENFORCE_TOPUP_PACKAGES": "true"}, "must be false"),
        ({"CORS_ALLOW_ORIGINS": "https://swico-web.onrender.com/"}, "CORS_ALLOW_ORIGINS"),
        ({"CORS_ALLOW_ORIGINS": "*"}, "CORS_ALLOW_ORIGINS"),
        ({"GLOBAL_QA_REAL_EMBEDDINGS_ENABLED": "true", "GLOBAL_QA_EMBEDDING_PROVIDER": "qwen"}, "local embedding"),
        ({"WEB_ROLLOUT_TRIAG_MODE": "sometimes"}, "WEB_ROLLOUT_TRIAG_MODE"),
        (
            {"WEB_TRIAG_RELEASE_STATE": "sometimes"},
            "WEB_TRIAG_RELEASE_STATE",
        ),
        ({"WEB_ROLLOUT_KNOWLEDGE_PERCENT": "101"}, "WEB_ROLLOUT_KNOWLEDGE_PERCENT"),
        (
            {
                "WEB_ROLLOUT_KNOWLEDGE_MODE": "all_eligible",
                "WEB_ROLLOUT_KNOWLEDGE_PERCENT": "100",
            },
            "WEB_ROLLOUT_KNOWLEDGE_PERCENT",
        ),
        ({"WEB_TRIAG_ROLLOUT_REPORT_ENABLED": "sometimes"}, "WEB_TRIAG_ROLLOUT_REPORT_ENABLED"),
        ({"WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS": "0"}, "WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS"),
        (
            {
                "WEB_TRIAG_ROLLOUT_REPORT_DEFAULT_WINDOW_HOURS": "48",
                "WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS": "24",
            },
            "WEB_TRIAG_ROLLOUT_REPORT_DEFAULT_WINDOW_HOURS",
        ),
    ],
)
def test_dangerous_production_combinations_are_rejected(updates: dict[str, str], expected: str) -> None:
    env = {**valid_environment(), **updates}
    with pytest.raises(ProductionConfigurationError, match=expected):
        validate_production_configuration(env)


def test_intentionally_disabled_optional_provider_is_supported() -> None:
    openai_only = {**valid_environment(), "AI_PROVIDER_ROUTING_MODE": "openai_only", "SARVAM_API_KEY": ""}
    sarvam_only = {**valid_environment(), "AI_PROVIDER_ROUTING_MODE": "sarvam_only", "OPENAI_API_KEY": ""}
    validate_production_configuration(openai_only)
    validate_production_configuration(sarvam_only)


def test_errors_never_include_secret_values() -> None:
    env = valid_environment()
    env["RAZORPAY_KEY_SECRET"] = "same-sensitive-value"
    env["RAZORPAY_WEBHOOK_SECRET"] = "same-sensitive-value"
    with pytest.raises(ProductionConfigurationError) as caught:
        validate_production_configuration(env)
    assert "same-sensitive-value" not in str(caught.value)


@pytest.mark.parametrize(
    "firebase_updates",
    [
        {"FIREBASE_CREDENTIALS_JSON": "", "GOOGLE_APPLICATION_CREDENTIALS": ""},
        {
            "FIREBASE_CREDENTIALS_JSON": "sensitive-inline-json",
            "GOOGLE_APPLICATION_CREDENTIALS": "/sensitive/credential/path.json",
        },
    ],
)
def test_production_requires_exactly_one_firebase_credential_method(
    firebase_updates: dict[str, str],
) -> None:
    env = {**valid_environment(), **firebase_updates}

    with pytest.raises(ProductionConfigurationError) as caught:
        validate_production_configuration(env)

    message = str(caught.value)
    assert "FIREBASE_CREDENTIALS_JSON" in message
    assert "GOOGLE_APPLICATION_CREDENTIALS" in message
    assert "sensitive-inline-json" not in message
    assert "/sensitive/credential/path.json" not in message


def test_production_accepts_google_application_credentials_alone() -> None:
    env = {
        **valid_environment(),
        "FIREBASE_CREDENTIALS_JSON": "",
        "GOOGLE_APPLICATION_CREDENTIALS": "/etc/secrets/firebase-admin.json",
    }

    validate_production_configuration(env)
