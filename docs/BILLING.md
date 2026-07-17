# Token-credit billing

## Units and allocation

Razorpay orders/refunds use integer paise and the financial ledger uses integer micro-INR (`1 INR = 1,000,000 micro-INR`). Customers see **Token credits** as model-dependent token estimates. The product never claims that one credit equals one provider token and never displays internal capacity as cash. Model, provider, cached-input, input, and output rates affect actual usage.

`BILLING_CREDIT_PERCENT` remains exactly `50`. User-credit paise are floored; every fractional-paise remainder goes to the platform.

- ₹10 / 1,000 paise creates exactly 5,000,000 internal micro-INR and 500 paise of platform allocation.
- ₹100 / 10,000 paise creates exactly 50,000,000 internal micro-INR and 5,000 paise of platform allocation.

The customer UI shows the gross amount paid, “50% converted to token credits,” a model-dependent token range, and “50% service and platform allocation.” It never shows the credited micro-INR, a rupee equivalent, or a decimal credit balance.

Rupees remain visible only for actual money: gross payments, refunds, receipts/invoices, and Razorpay Checkout. Balance, grants, reversals, usage, limits, and message details use token estimates/counts. Legacy financial JSON fields remain for mobile/API compatibility.

## Estimates and usage visibility

`app/billing/token_estimates.py` is the shared estimate service. It uses `USAGE_ESTIMATE_REFERENCE_PROVIDER`, `USAGE_ESTIMATE_REFERENCE_MODEL`, and current configured pricing with integer arithmetic. It returns the reference, pricing timestamp/snapshot, input-only/output-only/blended estimates, the 70/30 assumption, full range, and disclaimer. Zero/negative values are safe; an unavailable price produces an unavailable estimate, never a guaranteed quota.

Wallet/bootstrap/settlement events, package previews, payment/refund history, explicit wallet refresh, and monthly-limit responses reuse this service. `GET /api/web/usage/summary` retains legacy internal aliases and adds `token_estimate`; `estimated_tokens_remaining` remains as an alias. `PATCH /api/web/settings/usage` retains `hard_limit_micros` and also accepts the additive `hard_limit_estimated_tokens` representation.

Usage summaries count settled chargeable rows and expose actual input, cached-input, output, and total tokens plus provider-reported versus estimated request counts. Released, failed, free cache, safety, and deterministic responses are excluded.

## Charging and invariants

Reservations include selected-model pricing, provider instructions/messages, estimated input, maximum output, and `BILLING_RESERVE_MULTIPLIER`. Wallet and monthly-period rows are locked; external provider calls happen outside those transactions. Final charges round upward. The ledger remains append-only, corrections/refunds are compensating entries, and cumulative partial-refund reversals floor proportionally. Idempotency, webhook replay protection, stale-reservation recovery, and reconciliation behavior are unchanged.

OpenAI USD costs use `USD_TO_INR_BILLING_RATE` and `OPENAI_FX_BUFFER_PERCENT`. Sarvam uses configured INR-per-million input/cached/output rates. Every `UsageCharge` stores its pricing snapshot and actual/estimated source.

## Razorpay

An internal order is durable before the provider call. Checkout verification uses the server-stored order, exact INR amount, captured status, and signature. Verification and captured/paid webhooks call the same idempotent credit function. Raw-body webhook HMAC and event IDs protect replay. Processed refunds reverse capacity; failed refunds are recorded without reversal.

Public config returns explicit `razorpay_mode`, `checkout_enabled`, and package token estimates. `BILLING_CHECKOUT_ENABLED=false` blocks new orders only; existing token credits remain usable.

## Financial monitoring

Read-only audit Cron (recommended every five minutes):

```bash
cd backend && python -m scripts.billing_maintenance audit --captured-uncredited-age-seconds 900 --fail-on-findings
```

Dry-run provider reconciliation:

```bash
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 --fail-on-findings
```

The only mutating reconciliation form requires explicit approval:

```bash
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 --apply
```

Exit `3` means findings; configuration errors use `78`. Audit output contains categories, counts, safe internal IDs, age, and status only. It excludes names, emails, prompts/responses, signatures, webhook payloads, credentials, and database URLs. With `SENTRY_DSN` set, high-severity categories/counts use the existing PII-disabled Sentry integration. Recommended settings:

```dotenv
SENTRY_DSN=
SENTRY_TRACES_SAMPLE_RATE=0.05
SENTRY_PROFILES_SAMPLE_RATE=0
```

Configure Render failure notifications on both non-zero Cron Jobs. Never edit ledger history during support; use an approved compensating entry.

## Pricing verification snapshot

The 2026-07-16 snapshot used official OpenAI model/pricing pages and Sarvam pricing documentation. GPT-5 nano/mini, GPT-4.1 nano/mini, GPT-4o mini, and o4-mini defaults include cached-input rates. Deprecated `gpt-3.5-turbo-0125` remains disabled. Sarvam defaults are ₹2.5/₹1.5/₹10 per million for 30B input/cached/output and ₹4/₹2.5/₹16 for 105B. Update Render overrides deliberately; never rewrite historical usage snapshots.
