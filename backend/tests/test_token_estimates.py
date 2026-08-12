from datetime import datetime, timezone

from app.billing.token_estimates import micros_for_blended_tokens, token_estimate


def test_zero_and_negative_token_estimates_are_safe(monkeypatch):
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    for value in (0, -1, -5_000_000):
        estimate = token_estimate(value, now=now)
        assert estimate["estimated_blended_tokens"] == 0
        assert estimate["range_min_tokens"] == 0
        assert estimate["estimate_available"] is True
        assert estimate["pricing_as_of"] == now
        assert estimate["tier"] == "lite"
        assert "reference_model" not in estimate
        assert "pricing_snapshot" not in estimate


def test_positive_estimate_uses_integer_pricing_and_round_trip(monkeypatch):
    monkeypatch.setenv("SWICO_LITE_MODEL_PRIMARY", "gpt-5.4-mini")
    monkeypatch.setenv("SWICO_LITE_MODEL_FALLBACKS", "gpt-5.4-nano")
    estimate = token_estimate(5_000_000, tier="lite")
    assert estimate["estimated_blended_tokens"] > 0
    assert estimate["range_min_tokens"] <= estimate["estimated_blended_tokens"]
    assert estimate["estimated_blended_tokens"] <= estimate["range_max_tokens"]
    assert micros_for_blended_tokens(100_000, tier="lite") > 0
    assert token_estimate(micros_for_blended_tokens(100_000))["estimated_blended_tokens"] >= 100_000


def test_estimates_change_with_public_tier_without_exposing_internal_pricing(monkeypatch):
    monkeypatch.setenv("SWICO_PRO_ENABLED", "true")
    lite = token_estimate(5_000_000, tier="lite")
    pro = token_estimate(5_000_000, tier="pro")
    assert lite["estimated_blended_tokens"] > pro["estimated_blended_tokens"]
    assert lite["tier_label"] == "Swico Lite"
    assert pro["tier_label"] == "Swico Pro"
    for estimate in (lite, pro):
        assert "provider" not in str(estimate).lower()
        assert "model" not in str(estimate).lower()
        assert "pricing_snapshot" not in estimate


def test_unconfigured_reference_returns_unavailable_without_raising(monkeypatch):
    monkeypatch.setenv("SWICO_LITE_MODEL_PRIMARY", "not-a-real-model")
    estimate = token_estimate(5_000_000)
    assert estimate["estimated_blended_tokens"] is None
    assert estimate["estimate_available"] is False
    assert estimate["availability"] == "unavailable"
    assert estimate["range_min_tokens"] is None
    assert estimate["range_max_tokens"] is None
    assert "pricing_snapshot" not in estimate


def test_free_selected_tier_uses_paid_display_basis(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    estimate = token_estimate(7_500_000, tier="free")
    assert estimate["selected_tier"] == "free"
    assert estimate["display_tier"] != "free"
    assert estimate["estimate_available"] is True
    assert estimate["estimated_blended_tokens"] > 0
