from datetime import datetime, timezone

from app.billing.token_estimates import micros_for_blended_tokens, token_estimate


def test_zero_and_negative_token_estimates_are_safe(monkeypatch):
    monkeypatch.setenv("USAGE_ESTIMATE_REFERENCE_PROVIDER", "sarvam")
    monkeypatch.setenv("USAGE_ESTIMATE_REFERENCE_MODEL", "sarvam-30b")
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    for value in (0, -1, -5_000_000):
        estimate = token_estimate(value, now=now)
        assert estimate["estimated_input_only_tokens"] == 0
        assert estimate["estimated_output_only_tokens"] == 0
        assert estimate["estimated_blended_tokens"] == 0
        assert estimate["range_min_tokens"] == 0
        assert estimate["pricing_as_of"] == now


def test_positive_estimate_uses_integer_pricing_and_round_trip(monkeypatch):
    monkeypatch.setenv("USAGE_ESTIMATE_REFERENCE_PROVIDER", "sarvam")
    monkeypatch.setenv("USAGE_ESTIMATE_REFERENCE_MODEL", "sarvam-30b")
    monkeypatch.setenv("SARVAM_PRICE_30B_INPUT_INR_PER_1M", "2.5")
    monkeypatch.setenv("SARVAM_PRICE_30B_OUTPUT_INR_PER_1M", "10")
    estimate = token_estimate(5_000_000)
    assert estimate["estimated_input_only_tokens"] == 2_000_000
    assert estimate["estimated_output_only_tokens"] == 500_000
    assert estimate["estimated_blended_tokens"] == 1_052_631
    assert estimate["range_min_tokens"] == 500_000
    assert estimate["range_max_tokens"] == 2_000_000
    assert micros_for_blended_tokens(100_000) == 475_000
    assert token_estimate(micros_for_blended_tokens(100_000))["estimated_blended_tokens"] >= 100_000


def test_unconfigured_reference_returns_unavailable_without_raising(monkeypatch):
    monkeypatch.setenv("USAGE_ESTIMATE_REFERENCE_PROVIDER", "unconfigured")
    monkeypatch.setenv("USAGE_ESTIMATE_REFERENCE_MODEL", "not-a-real-model")
    estimate = token_estimate(5_000_000)
    assert estimate["estimated_blended_tokens"] is None
    assert estimate["pricing_snapshot"]["input"]["zero_charge"] is True
