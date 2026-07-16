from __future__ import annotations

import pytest

from app.production_config import (
    ProductionConfigurationError,
    production_configuration_errors,
    validate_production_configuration,
)


def valid_environment() -> dict[str, str]:
    return {
        "APP_ENV": "production",
        "LOG_CHAT_CONTENT": "false",
        "AUTH_ALLOW_DEV_TOKENS": "false",
        "WEB_APP_ENABLED": "true",
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
        "BILLING_MIN_TOPUP_PAISE": "1000",
        "BILLING_MAX_TOPUP_PAISE": "50000",
        "BILLING_TOPUP_PACKAGES_PAISE": "1000,5000",
        "BILLING_ENFORCE_TOPUP_PACKAGES": "true",
        "CORS_ALLOW_ORIGINS": "https://swico-web.onrender.com",
        "AUTO_CREATE_TABLES": "false",
        "RUN_MIGRATIONS_ON_STARTUP": "false",
        "REQUIRE_MIGRATIONS_BEFORE_STARTUP": "false",
        "EMAIL_OTP_DEV_RETURN_CODE": "false",
        "GLOBAL_QA_REAL_EMBEDDINGS_ENABLED": "false",
        "OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK": "false",
    }


def test_valid_test_mode_production_configuration_passes() -> None:
    assert production_configuration_errors(valid_environment()) == []
    validate_production_configuration(valid_environment())


@pytest.mark.parametrize(
    ("updates", "expected"),
    [
        ({"LOG_CHAT_CONTENT": "true"}, "LOG_CHAT_CONTENT"),
        ({"AUTH_ALLOW_DEV_TOKENS": "true"}, "AUTH_ALLOW_DEV_TOKENS"),
        ({"AUTO_CREATE_TABLES": "true"}, "AUTO_CREATE_TABLES"),
        ({"RUN_MIGRATIONS_ON_STARTUP": "true"}, "RUN_MIGRATIONS_ON_STARTUP"),
        ({"OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK": "true"}, "deprecated"),
        ({"RAZORPAY_KEY_ID": "rzp_live_not_allowed"}, "rzp_test_"),
        ({"RAZORPAY_WEBHOOK_SECRET": "checkout-configured"}, "must be distinct"),
        ({"BILLING_CREDIT_PERCENT": "49"}, "BILLING_CREDIT_PERCENT"),
        ({"BILLING_MIN_TOPUP_PAISE": "1001"}, "must allow ₹10"),
        ({"BILLING_TOPUP_PACKAGES_PAISE": "5000"}, "must include ₹10"),
        ({"CORS_ALLOW_ORIGINS": "https://swico-web.onrender.com/"}, "CORS_ALLOW_ORIGINS"),
        ({"CORS_ALLOW_ORIGINS": "*"}, "CORS_ALLOW_ORIGINS"),
        ({"GLOBAL_QA_REAL_EMBEDDINGS_ENABLED": "true", "GLOBAL_QA_EMBEDDING_PROVIDER": "qwen"}, "local embedding"),
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
