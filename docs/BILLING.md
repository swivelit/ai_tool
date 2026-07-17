# Token-credit billing

## Units and allocation

Razorpay orders/refunds use integer paise and the financial ledger uses integer micro-INR (`1 INR = 1,000,000 micro-INR`). Customers see **Token credits** as model-dependent token estimates. The product never claims that one credit equals one provider token and never displays internal capacity as cash. Model, provider, cached-input, input, and output rates affect actual usage.

`BILLING_CREDIT_PERCENT` remains exactly `50`. User-credit paise are floored; every fractional-paise remainder goes to the platform.

- ₹10 / 1,000 paise creates exactly 5,000,000 internal micro-INR and 500 paise of platform allocation.
- ₹100 / 10,000 paise creates exactly 50,000,000 internal micro-INR and 5,000 paise of platform allocation.

The customer UI shows the gross amount paid only after payment receipt is authoritative; estimated tokens added and the 50% service allocation appear only after the ledger credit is authoritative. An unfinished checkout never appears as paid. The UI never shows the credited micro-INR, a rupee equivalent, or a decimal credit balance.

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

Payment-order states have deliberately different meanings:

- `creating`: the local order is being prepared; no provider order is confirmed.
- `created`: checkout was opened, but no payment attempt or receipt is established. An old `created` row is an informational abandoned checkout, not evidence of captured money.
- `attempted`: the provider saw an attempt, but payment capture is not established locally; a long-lived attempt is a warning until provider reconciliation proves capture or a mismatch.
- `captured`: exact provider order ID, INR currency, amount, and captured state were verified, but the append-only payment-credit ledger entry may still be pending.
- `credited`: the idempotent `payment_credit` ledger entry has been applied. A `credited` row without that entry is a high-severity inconsistency.

`GET /api/web/billing/payments` preserves its legacy fields and adds `updated_at`, `paid_at`, `refunded_at`, `payment_received`, and `credit_applied`. `payment_received` comes from verified server state. `credit_applied` comes from one page-batched ledger lookup, never from the requested credit amount or status label alone. The shared web presentation labels states as **Preparing checkout**, **Checkout not completed**, **Payment attempted — confirmation pending**, **Payment received — token confirmation pending**, **Payment completed**, **Partially refunded**, **Refunded**, or **Checkout failed**. Completed-payment time uses `paid_at`; `created_at` is identified only as checkout creation time.

## Financial monitoring

The database-only audit is read-only. Its severities and actions are:

| Finding | Severity | Actionable |
| --- | --- | --- |
| Old local `created` checkout | info | no |
| Long-lived local `attempted` order | warning | no, until provider reconciliation finds capture or mismatch |
| Captured payment without credit ledger | high | yes |
| Credited order without credit ledger | high | yes |
| Negative wallet, invalid reservation, duplicate financial credit reference, failed refund, impossible refund totals, or payment-state inconsistency | high | yes |

Read-only audit Cron (recommended every five minutes):

```bash
cd backend && python -m scripts.billing_maintenance audit \
  --captured-uncredited-age-seconds 900 \
  --fail-on-findings
```

Dry-run provider reconciliation:

```bash
cd backend && python -m scripts.billing_maintenance razorpay \
  --age-seconds 900 \
  --fail-on-findings
```

Target one internal order without embedding an ID in source or configuration:

```bash
cd backend && python -m scripts.billing_maintenance razorpay \
  --internal-order-id <uuid> \
  --age-seconds 900 \
  --fail-on-findings
```

Provider reconciliation remains necessary because the financial audit intentionally does not call Razorpay. Dry-run results distinguish an unattempted checkout (info), a long-lived attempt (warning), a verified captured payment requiring credit (high/actionable), a provider mismatch (high/actionable), and an already credited order (info). Exact amount, INR currency, provider order ID, and captured state are checked before any credit. Provider mismatches are never applied automatically.

Never schedule `--apply`. A mutating run is a separately reviewed, one-off operator action; dry-run is always the scheduled form. Exit `0` covers clean, informational-only, and warning-only reports. With `--fail-on-findings`, exit `3` occurs only when a result is both high severity and actionable. Configuration errors use `78`. Audit output contains categories, counts, safe internal IDs, age, and status only. It excludes names, emails, prompts/responses, signatures, raw provider payloads, credentials, and database URLs. With `SENTRY_DSN` set, only actionable high-severity categories/counts use the existing PII-disabled Sentry integration. Recommended settings:

```dotenv
SENTRY_DSN=
SENTRY_TRACES_SAMPLE_RATE=0.05
SENTRY_PROFILES_SAMPLE_RATE=0
```

Configure Render failure notifications on both non-zero Cron Jobs. Never edit ledger history during support; use an approved compensating entry.

## Pricing verification snapshot

The 2026-07-16 snapshot used official OpenAI model/pricing pages and Sarvam pricing documentation. GPT-5 nano/mini, GPT-4.1 nano/mini, GPT-4o mini, and o4-mini defaults include cached-input rates. Deprecated `gpt-3.5-turbo-0125` remains disabled. Sarvam defaults are ₹2.5/₹1.5/₹10 per million for 30B input/cached/output and ₹4/₹2.5/₹16 for 105B. Update Render overrides deliberately; never rewrite historical usage snapshots.
