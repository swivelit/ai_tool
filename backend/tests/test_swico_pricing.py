from __future__ import annotations

import json
from decimal import Decimal

import pytest

from app.ai.openai_catalog import (
    LONG_CONTEXT_THRESHOLD_TOKENS, OpenAIPricingConfigurationError, get_model_spec,
)
from app.billing.pricing import MILLION, openai_price, reserve_price, snapshot_json
from app.billing.service import (
    create_usage_reservation, credit_payment_once, settle_usage_reservation,
)
from app.database import SessionLocal
from app.models import PaymentOrder
from app.production_config import ProductionConfigurationError, validate_production_configuration
from tests.conftest import create_test_user
from tests.test_production_config import valid_environment


RATES = {
    "gpt-5.4-mini": (Decimal("0.75"), Decimal("0.075"), Decimal("4.50")),
    "gpt-5.4-nano": (Decimal("0.20"), Decimal("0.02"), Decimal("1.25")),
    "gpt-5.5": (Decimal("5.00"), Decimal("0.50"), Decimal("30.00")),
    "gpt-5.6-terra": (Decimal("2.50"), Decimal("0.25"), Decimal("15.00")),
    "gpt-5.6-sol": (Decimal("5.00"), Decimal("0.50"), Decimal("30.00")),
}


@pytest.mark.parametrize(("model", "rates"), RATES.items())
def test_exact_swico_normal_and_cached_prices(monkeypatch, model, rates):
    for name in (
        f"OPENAI_PRICE_{model.upper().replace('-', '_').replace('.', '_')}_INPUT_PER_1M",
        f"OPENAI_PRICE_{model.upper().replace('-', '_').replace('.', '_')}_CACHED_INPUT_PER_1M",
        f"OPENAI_PRICE_{model.upper().replace('-', '_').replace('.', '_')}_OUTPUT_PER_1M",
    ):
        monkeypatch.delenv(name, raising=False)
    spec = get_model_spec(model)
    assert (
        Decimal(str(spec.input_price_per_1m)),
        Decimal(str(spec.cached_input_price_per_1m)),
        Decimal(str(spec.output_price_per_1m)),
    ) == rates
    normal = openai_price(model, 100_000, 100_000)
    cached = openai_price(model, 100_000, 0, 100_000)
    assert normal.amount == (rates[0] + rates[2]) / Decimal("10")
    assert cached.amount == rates[1] / Decimal("10")
    assert normal.snapshot["pricing_rule"] == "standard_context"


@pytest.mark.parametrize("model", ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-sol"])
def test_long_context_boundary_and_full_request_multipliers(model):
    spec = get_model_spec(model)
    at_boundary = openai_price(model, LONG_CONTEXT_THRESHOLD_TOKENS, 100)
    over_boundary = openai_price(model, LONG_CONTEXT_THRESHOLD_TOKENS + 1, 100)
    expected_boundary = (
        Decimal(LONG_CONTEXT_THRESHOLD_TOKENS) * Decimal(str(spec.input_price_per_1m))
        + Decimal(100) * Decimal(str(spec.output_price_per_1m))
    ) / MILLION
    expected_over = (
        Decimal(LONG_CONTEXT_THRESHOLD_TOKENS + 1)
        * Decimal(str(spec.input_price_per_1m)) * Decimal("2")
        + Decimal(100) * Decimal(str(spec.output_price_per_1m)) * Decimal("1.5")
    ) / MILLION
    assert at_boundary.amount == expected_boundary
    assert over_boundary.amount == expected_over
    assert at_boundary.snapshot["pricing_rule"] == "standard_context"
    assert over_boundary.snapshot["pricing_rule"] == "long_context_over_272000"
    assert over_boundary.snapshot["input_price_multiplier"] == "2.0"
    assert over_boundary.snapshot["output_price_multiplier"] == "1.5"


def test_long_context_cached_input_is_multiplied_once():
    result = openai_price(
        "gpt-5.5", LONG_CONTEXT_THRESHOLD_TOKENS + 1, 10,
        cached_input_tokens=100_000,
    )
    expected = (
        Decimal(172_001) * Decimal("5.00") * Decimal("2")
        + Decimal(100_000) * Decimal("0.50") * Decimal("2")
        + Decimal(10) * Decimal("30.00") * Decimal("1.5")
    ) / MILLION
    assert result.amount == expected


def test_reservation_and_settlement_share_long_context_pricing(monkeypatch):
    monkeypatch.setenv("BILLING_RESERVE_MULTIPLIER", "1")
    user = create_test_user("pricing-user", "pricing@example.test")
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=int(user.id), receipt="pricing-fund", gross_amount_paise=100_000,
            credited_amount_micros=500_000_000,
            platform_share_paise=50_000, status="captured",
        )
        session.add(order); session.flush(); credit_payment_once(session, order)
        priced = openai_price("gpt-5.5", 272_001, 500, 50_000)
        reserved = reserve_price("openai", "gpt-5.5", 272_001, 500)
        charge = create_usage_reservation(
            session, request_id="pricing-long-context", user_id=int(user.id),
            thread_id=None, provider="openai", model="gpt-5.5",
            reserved_micros=reserved.micros,
            pricing_snapshot_json=snapshot_json(reserved.snapshot),
            swico_tier="standard",
        )
        settled = settle_usage_reservation(
            session, request_id=charge.request_id,
            provider_cost_amount=priced.amount, provider_cost_currency="USD",
            provider_cost_micros=priced.micros, input_tokens=272_001,
            cached_input_tokens=50_000, output_tokens=500,
            usage_source="actual", pricing_snapshot_json=snapshot_json(priced.snapshot),
        )
        snapshot = json.loads(settled.pricing_snapshot_json)
    assert snapshot["pricing_rule"] == "long_context_over_272000"
    assert snapshot["reservation"]["pricing_snapshot"]["pricing_rule"] == "long_context_over_272000"
    assert settled.provider_cost_micros == priced.micros


def test_production_requires_explicit_enabled_tier_prices_but_development_uses_defaults(monkeypatch):
    env = valid_environment()
    env.pop("OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M")
    with pytest.raises(ProductionConfigurationError) as caught:
        validate_production_configuration(env)
    assert "OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M" in str(caught.value)
    assert "30.00" not in str(caught.value)

    stale = valid_environment()
    stale["OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M"] = "10.00"
    with pytest.raises(ProductionConfigurationError) as stale_error:
        validate_production_configuration(stale)
    assert "OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M" in str(stale_error.value)
    assert "10.00" not in str(stale_error.value)

    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.delenv("OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M", raising=False)
    assert get_model_spec("gpt-5.5").output_price_per_1m == 30.0


def test_catalog_never_uses_a_stale_explicit_production_rate(monkeypatch):
    for name, value in valid_environment().items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M", "10.00")
    with pytest.raises(OpenAIPricingConfigurationError) as caught:
        get_model_spec("gpt-5.5")
    assert "OPENAI_PRICE_GPT_5_5_OUTPUT_PER_1M" in str(caught.value)
    assert "10.00" not in str(caught.value)
