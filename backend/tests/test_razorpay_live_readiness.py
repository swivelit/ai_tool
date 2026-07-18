from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check-razorpay-live-readiness.py"


def _module():
    spec = importlib.util.spec_from_file_location("razorpay_live_readiness", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_environment_validation_never_returns_secret_values():
    module = _module()
    environment = {
        "RAZORPAY_MODE": "live",
        "RAZORPAY_KEY_ID": "rzp_live_sensitive_identifier",
        "RAZORPAY_KEY_SECRET": "sensitive-key-secret",
        "RAZORPAY_WEBHOOK_SECRET": "sensitive-webhook-secret",
        "BILLING_CHECKOUT_ENABLED": "false",
        "DATABASE_URL": "postgresql://sensitive-database-url",
        "BILLING_TOPUP_PACKAGES_PAISE": "1000,5000",
        "OPENAI_PRICING_AS_OF": "2026-07-17",
    }
    for key, rates in module.PRICES.items():
        for suffix, value in zip(("INPUT", "CACHED_INPUT", "OUTPUT"), rates):
            environment[f"OPENAI_PRICE_{key}_{suffix}_PER_1M"] = value
    checks = module.environment_checks(environment)
    rendered = repr(checks)
    assert all(passed for _name, passed in checks)
    assert "sensitive-key-secret" not in rendered
    assert "sensitive-webhook-secret" not in rendered
    assert "sensitive-database-url" not in rendered


def test_repository_mode_accepts_complete_owner_attested_publication(monkeypatch):
    module = _module()
    monkeypatch.setattr(module, "_idempotency_tests_pass", lambda: True)
    checks = dict(module.repository_checks())
    assert checks["legal publication approved and complete"] is True
    assert checks["canonical Razorpay webhook endpoint is implemented"] is True
    assert checks["one Alembic head is known"] is True
