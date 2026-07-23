#!/usr/bin/env python3
"""Non-charging Razorpay Live readiness checks with secret-safe output."""

from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = ROOT / "backend" / ".env.example"
LEGAL_CHECKER = ROOT / "scripts" / "check-legal-publication.py"
WEB_APP = ROOT / "web" / "src" / "App.tsx"
WEB_ROUTER = ROOT / "backend" / "app" / "web_api" / "router.py"
RAZORPAY_DOC = ROOT / "docs" / "RENDER_WEB_DEPLOYMENT.md"
MIGRATIONS = ROOT / "backend" / "alembic" / "versions"
CANONICAL_WEBHOOK_PATH = "/api/web/billing/razorpay/webhook"
REQUIRED_EVENTS = ("payment.captured", "order.paid", "refund.processed", "refund.failed")
REQUIRED_POLICY_SLUGS = ("terms", "privacy", "refunds", "contact", "ai", "delivery", "pricing")
PRICES = {
    "GPT_5_4_MINI": ("0.75", "0.075", "4.50"),
    "GPT_5_4_NANO": ("0.20", "0.02", "1.25"),
    "GPT_5_5": ("5.00", "0.50", "30.00"),
    "GPT_5_6_TERRA": ("2.50", "0.25", "15.00"),
    "GPT_5_6_SOL": ("5.00", "0.50", "30.00"),
}


def _load_legal_findings() -> list[str]:
    spec = importlib.util.spec_from_file_location("swico_legal_checker", LEGAL_CHECKER)
    if spec is None or spec.loader is None:
        return ["legal publication checker could not be loaded"]
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.findings())


def _dotenv_values() -> dict[str, str]:
    result: dict[str, str] = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        result[name.strip()] = value.strip()
    return result


def _known_alembic_head() -> str | None:
    revisions: set[str] = set()
    parents: set[str] = set()
    for path in MIGRATIONS.glob("*.py"):
        source = path.read_text(encoding="utf-8")
        revision = re.search(r'^revision:\s*str\s*=\s*["\']([^"\']+)', source, re.MULTILINE)
        down = re.search(r'^down_revision:.*=\s*["\']([^"\']+)', source, re.MULTILINE)
        if revision:
            revisions.add(revision.group(1))
        if down:
            parents.add(down.group(1))
    heads = revisions - parents
    return next(iter(heads)) if len(heads) == 1 else None


def _idempotency_tests_pass() -> bool:
    local_python = ROOT / "backend" / ".venv" / "bin" / "python"
    python = str(local_python) if local_python.is_file() else sys.executable
    with tempfile.TemporaryDirectory(prefix="swico-readiness-") as temp_dir:
        env = dict(os.environ)
        env["TEST_DATABASE_URL"] = f"sqlite:///{Path(temp_dir) / 'readiness.sqlite3'}"
        completed = subprocess.run(
            [
                python, "-m", "pytest", "-q", "tests/test_web_billing.py",
                "-k", "credit_and_duplicate_are_idempotent or duplicate_and_out_of_order_paid_webhooks_credit_once or duplicate_verify_does_not_double_credit or same_refund_id_under_a_new_event_id_is_idempotent",
            ],
            cwd=ROOT / "backend", env=env, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, check=False,
        )
    return completed.returncode == 0


def _positive_decimal(value: str) -> bool:
    try:
        return float(value) > 0
    except (TypeError, ValueError):
        return False


def _integer(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _package_values(value: str) -> list[int] | None:
    try:
        return [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError:
        return None


def _custom_topup_checks(values: dict[str, str]) -> list[tuple[str, bool]]:
    packages = _package_values(values.get("BILLING_TOPUP_PACKAGES_PAISE", ""))
    minimum = _integer(values.get("BILLING_MIN_TOPUP_PAISE", ""))
    maximum = _integer(values.get("BILLING_MAX_TOPUP_PAISE", ""))
    enforcement = values.get("BILLING_ENFORCE_TOPUP_PACKAGES", "").strip().lower()
    return [
        ("configured packages are exactly INR 15 and INR 299", packages is not None and len(packages) == 2 and set(packages) == {1500, 29900}),
        ("BILLING_ENFORCE_TOPUP_PACKAGES is false", enforcement == "false"),
        ("BILLING_MIN_TOPUP_PAISE is 1500", minimum == 1500),
        ("BILLING_MAX_TOPUP_PAISE is valid and allows INR 299", maximum is not None and maximum >= 29900 and maximum % 100 == 0),
        ("custom top-ups remain bounded", minimum is not None and maximum is not None and 0 < minimum <= maximum),
    ]


def repository_checks() -> list[tuple[str, bool]]:
    values = _dotenv_values()
    app_source = WEB_APP.read_text(encoding="utf-8")
    router_source = WEB_ROUTER.read_text(encoding="utf-8")
    docs = RAZORPAY_DOC.read_text(encoding="utf-8")
    legal_findings = _load_legal_findings()
    checks: list[tuple[str, bool]] = [
        ("legal publication approved and complete", not legal_findings),
        ("all required policy routes are supported", all(
            slug in app_source or '/legal/:page' in app_source for slug in REQUIRED_POLICY_SLUGS
        )),
        ("canonical Razorpay webhook endpoint is implemented", (
            'APIRouter(prefix="/api/web"' in router_source
            and '@router.post("/billing/razorpay/webhook")' in router_source
        )),
        ("required Razorpay webhook events are documented", all(event in docs for event in REQUIRED_EVENTS)),
        ("phase-one checkout default is disabled", values.get("BILLING_CHECKOUT_ENABLED") == "false"),
        ("billing allocation remains 50 percent", values.get("BILLING_CREDIT_PERCENT") == "50"),
        ("pricing snapshot date is explicit", values.get("OPENAI_PRICING_AS_OF") == "2026-07-17"),
        ("production database guard requires PostgreSQL", "is_postgres_database_url" in (
            ROOT / "backend" / "app" / "production_config.py"
        ).read_text(encoding="utf-8")),
        ("one Alembic head is known", _known_alembic_head() is not None),
    ]
    checks.extend(_custom_topup_checks(values))
    for key, expected in PRICES.items():
        names = (
            f"OPENAI_PRICE_{key}_INPUT_PER_1M",
            f"OPENAI_PRICE_{key}_CACHED_INPUT_PER_1M",
            f"OPENAI_PRICE_{key}_OUTPUT_PER_1M",
        )
        checks.append((f"explicit pricing is valid for {key}", all(
            _positive_decimal(values.get(name, ""))
            and float(values[name]) == float(expected[index])
            for index, name in enumerate(names)
        )))
    checks.append(("checkout and webhook idempotency tests pass", _idempotency_tests_pass()))
    return checks


def environment_checks(environ: dict[str, str]) -> list[tuple[str, bool]]:
    get = lambda name: str(environ.get(name, "") or "").strip()
    key_secret = get("RAZORPAY_KEY_SECRET")
    webhook_secret = get("RAZORPAY_WEBHOOK_SECRET")
    checks = [
        ("RAZORPAY_MODE is live", get("RAZORPAY_MODE").lower() == "live"),
        ("RAZORPAY_KEY_ID uses the live prefix", get("RAZORPAY_KEY_ID").startswith("rzp_live_")),
        ("RAZORPAY_KEY_SECRET is set", bool(key_secret)),
        ("RAZORPAY_WEBHOOK_SECRET is set", bool(webhook_secret)),
        ("Razorpay key and webhook secrets are distinct", bool(key_secret and webhook_secret and key_secret != webhook_secret)),
        ("BILLING_CHECKOUT_ENABLED remains false for phase one", get("BILLING_CHECKOUT_ENABLED").lower() == "false"),
        ("DATABASE_URL uses PostgreSQL", get("DATABASE_URL").split(":", 1)[0] in {
            "postgres", "postgresql", "postgresql+psycopg", "postgresql+psycopg2",
        }),
        ("OPENAI_PRICING_AS_OF is current", get("OPENAI_PRICING_AS_OF") == "2026-07-17"),
    ]
    checks.extend(_custom_topup_checks({
        name: get(name) for name in (
            "BILLING_TOPUP_PACKAGES_PAISE", "BILLING_ENFORCE_TOPUP_PACKAGES",
            "BILLING_MIN_TOPUP_PAISE", "BILLING_MAX_TOPUP_PAISE",
        )
    }))
    for key, expected in PRICES.items():
        checks.append((f"environment pricing is explicit for {key}", all(
            _positive_decimal(get(f"OPENAI_PRICE_{key}_{suffix}_PER_1M"))
            and float(get(f"OPENAI_PRICE_{key}_{suffix}_PER_1M")) == float(expected[index])
            for index, suffix in enumerate(("INPUT", "CACHED_INPUT", "OUTPUT"))
        )))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--validate-environment", action="store_true",
        help="also validate an authorized operator's current Live environment",
    )
    args = parser.parse_args()
    checks = repository_checks()
    if args.validate_environment:
        checks.extend(environment_checks(dict(os.environ)))
    failed = 0
    for name, passed in checks:
        print(f"{'PASS' if passed else 'BLOCKED'}: {name}")
        failed += int(not passed)
    print(f"Razorpay Live readiness {'passed' if failed == 0 else 'blocked'}; {failed} blocker(s).")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
