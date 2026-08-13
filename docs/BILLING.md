# Token-credit billing

## Website subscriptions and referrals

Website subscriptions are prepaid Razorpay Orders (never recurring mandates or automatic renewals). The backend is authoritative for the 1m/6m/1y prices, Chat/Voice bucket, calendar-month expiry, ₹125 complete-week allowance (`125000000` micro-INR), lazy seven-day windows, final partial-window floor proration, and no rollover. Subscription allowance is held in entitlement/window tables, never in `WalletAccount` or `WalletLedger`. A request is reserved entirely from its active subscription window or entirely from the matching wallet when the user has enabled that bucket's pay-as-you-go fallback; funding sources never switch during expansion or settlement.

Referral codes are random and unique. Attribution is one-time and must happen before the referred user's first successful subscription. Only that first captured and fulfilled subscription can create one referrer-only reward: 1m = one week, 6m = three weeks, 1y = two calendar months, in the purchased bucket. Rewards are entitlements, not cash or wallet credit. Payment verification, webhooks, and reconciliation share idempotent fulfillment and reward constraints. Full subscription refunds cancel unused/future entitlement and unstarted reward; partial refunds are manual-review records and do not use top-up wallet reversal.

Backend configuration (website only): `WEB_SUBSCRIPTIONS_ENABLED`, `WEB_REFERRALS_ENABLED`, `WEB_SUBSCRIPTION_1M_PRICE_PAISE`, `WEB_SUBSCRIPTION_6M_PRICE_PAISE`, `WEB_SUBSCRIPTION_1Y_PRICE_PAISE`, `WEB_SUBSCRIPTION_WEEKLY_ALLOWANCE_MICROS`, `WEB_SUBSCRIPTION_PRORATE_FINAL_PARTIAL_WEEK`, `WEB_SUBSCRIPTION_PAYG_FALLBACK_DEFAULT`, `WEB_REFERRAL_REWARD_1M_WEEKS`, `WEB_REFERRAL_REWARD_6M_WEEKS`, and `WEB_REFERRAL_REWARD_1Y_MONTHS`. Safe defaults are in `backend/.env.example`; no `VITE_*` subscription variables are used.

## Production website/API deployment check

Before enabling subscriptions or referrals, deploy `ai_tool` and `swico-web` from the same Git commit and verify that the backend release check reports repository and database head `b8f2c7d1e4a9`. If the backend is updated but the website still shows old billing text, deploy `swico-web → Manual Deploy → Clear build cache & deploy`, then verify the frontend release again. This does not add a Render service or environment variable.

## Units and allocation

Razorpay orders/refunds use integer paise and the financial ledger uses integer micro-INR (`1 INR = 1,000,000 micro-INR`). Customers see **Token credits** as model-dependent token estimates. The product never claims that one credit equals one provider token and never displays internal capacity as cash. Model, provider, cached-input, input, and output rates affect actual usage.

`BILLING_CREDIT_PERCENT` remains exactly `50`. User-credit paise are floored; every fractional-paise remainder goes to the platform.

- ₹10 / 1,000 paise creates exactly 5,000,000 internal micro-INR and 500 paise of platform allocation.
- ₹299 / 29,900 paise creates exactly 149,500,000 internal micro-INR and 14,950 paise of platform allocation.
- A custom ₹75 / 7,500 paise top-up creates exactly 37,500,000 internal micro-INR and 3,750 paise of platform allocation.

The customer UI shows the gross amount paid only after payment receipt is authoritative and shows estimated tokens added only after the ledger credit is authoritative. The 50% service allocation remains internal billing/audit data and is not displayed in the checkout or payment-history UI. An unfinished checkout never appears as paid. The UI never shows the credited micro-INR, a rupee equivalent, or a decimal credit balance.

Rupees remain visible only for actual money: gross payments, refunds, receipts/invoices, and Razorpay Checkout. Balance, grants, reversals, usage, limits, and message details use token estimates/counts. Legacy financial JSON fields remain for mobile/API compatibility.

## Estimates and usage visibility

`app/billing/token_estimates.py` is the shared internal estimate service and uses current configured pricing with integer arithmetic. Public billing projections expose only the selected Swico tier/label, blended estimate, and range. They never expose provider names, model IDs, internal rates, secrets, or platform allocation. Zero/negative values are safe; an unavailable price produces an unavailable estimate, never a guaranteed quota.

Wallet/bootstrap/settlement events, package previews, payment/refund history, explicit wallet refresh, and monthly-limit responses reuse this service. `GET /api/web/usage/summary` retains legacy internal aliases and adds `token_estimate`; `estimated_tokens_remaining` remains as an alias. `PATCH /api/web/settings/usage` retains `hard_limit_micros` and also accepts the additive `hard_limit_estimated_tokens` representation.

Usage summaries count terminal provider-backed rows, including billing-exempt audit rows, and expose actual input, cached-input, output, and total tokens plus provider-reported versus estimated request counts. Debit totals still include only wallet charges. Released, failed, free cache, safety, and deterministic responses are excluded.

Allowlisted internal capability-test accounts are exempt only from prepaid-wallet billing. They create no wallet reservation, debit, credit, payment, or ledger entry. Provider-backed turns still create a terminal `billing_exempt` `UsageCharge` with the public Swico tier, internal provider/model, actual or estimated tokens, provider cost, zero reserved/debited micros, and the exemption reason. Provider budgets, authentication, rate limits, model health, tier availability, and safety controls remain active.

## Charging and invariants

Reservations include selected-model pricing, provider instructions/messages, estimated input, maximum output, and `BILLING_RESERVE_MULTIPLIER`. Wallet and monthly-period rows are locked; external provider calls happen outside those transactions. Final charges round upward. The ledger remains append-only, corrections/refunds are compensating entries, and cumulative partial-refund reversals floor proportionally. Idempotency, webhook replay protection, stale-reservation recovery, and reconciliation behavior are unchanged.

OpenAI USD costs use `USD_TO_INR_BILLING_RATE` and `OPENAI_FX_BUFFER_PERCENT`. Sarvam uses configured INR-per-million input/cached/output rates. Every `UsageCharge` stores its pricing snapshot and actual/estimated source.

## Razorpay

An internal order is durable before the provider call. Checkout verification uses the server-stored order, exact INR amount, captured status, and signature. Verification and captured/paid webhooks call the same idempotent credit function. Raw-body webhook HMAC and event IDs protect replay. Processed refunds reverse capacity; failed refunds are recorded without reversal.

Public config returns explicit `razorpay_mode`, `checkout_enabled`, `custom_topup_enabled`, configured bounds, and package token estimates. The preset collection is exactly 1,000 and 29,900 paise (₹10 and ₹299). Custom whole-rupee amounts are enabled only when `BILLING_ENFORCE_TOPUP_PACKAGES=false` and must remain within `BILLING_MIN_TOPUP_PAISE` and `BILLING_MAX_TOPUP_PAISE`. The backend is authoritative; the browser cannot widen these bounds or bypass package enforcement. `BILLING_CHECKOUT_ENABLED=false` blocks new orders only; existing token credits remain usable.

## Chat and Voice credit buckets

Wallets are keyed by `(user_id, credit_bucket)`, where the supported buckets
are `chat` and `voice`. Normal Chat LLM generation—including typed messages,
file/document questions, Continue response, edit, and regenerate—reserves and
debits Chat. Realtime Voice Mode LLM generation retains `usage_kind=chat` for
provider/audit semantics but reserves and debits Voice. STT and TTS operations
reserve and debit Voice when `WEB_SEPARATE_VOICE_CREDITS_ENABLED=true`; the
false default preserves legacy shared-Chat behavior during rollout. Dictation
transcription uses Voice; sending its normal composer draft uses Chat; a
separately requested spoken reply uses Voice. Cached and deterministic free
responses remain free. A realtime turn can therefore have three independent,
stable usage IDs: `realtime-stt:<session>:<turn>`,
`realtime-chat:<session>:<turn>`, and `realtime-tts:<session>:<turn>`.

The public `POST /api/web/chat/stream` route always supplies trusted
`billing_credit_bucket=chat`, regardless of client `input_mode`, voice-turn
metadata, or request JSON. Only the authenticated realtime Voice WebSocket
server path supplies `billing_credit_bucket=voice`. Clients cannot select a
billing bucket. Settlement, cancellation, provider failure, expansion, and
stale cleanup use the bucket already stored on `UsageCharge`.

Revision `e2b7c4d9a1f3` classifies every historical wallet, ledger entry,
payment, and usage charge as Chat. It preserves all integer-micro balances
exactly and does not reinterpret old speech charges. Voice starts at zero and
is created lazily and idempotently. A top-up applies
`BILLING_CREDIT_PERCENT=50` once, to the order's authoritative database bucket;
webhooks, verification, reconciliation and refunds cannot change it. Partial
refund proportional arithmetic uses `Decimal`/integer micros and reverses the
same bucket. There is no transfer operation between buckets. Settled historical
usage and ledger rows are not reclassified or rewritten by this application
change.

Usage Settings classifies wallet spending by `credit_bucket`, not just
`usage_kind`: Chat tier bars contain only Chat-bucket LLM rows, while Voice
totals contain Voice-bucket STT, LLM, and TTS rows. Voice LLM request and token
fields are additive. Overall terminal-usage totals and the account-level monthly
hard limit remain unchanged.

The legacy single `wallet` response remains the Chat wallet for mobile and old
web clients. New clients use `wallets: { chat, voice }`. Payment and ledger
history include `credit_bucket`; missing historical client fields display as
Chat.

The authenticated non-charging `GET /api/web/billing/estimate?gross_amount_paise=<integer>` endpoint applies the same whole-rupee, minimum, maximum, and package-enforcement checks as order creation. It calculates credited micro-INR with `calculate_topup`, estimates against the authenticated user's selected Swico tier, and creates no Razorpay order, `PaymentOrder`, wallet/ledger entry, or `UsageCharge`. It is rate limited and does not require checkout or Razorpay readiness.

Required production values are:

```dotenv
BILLING_MIN_TOPUP_PAISE=1000
BILLING_MAX_TOPUP_PAISE=50000
BILLING_TOPUP_PACKAGES_PAISE=1000,29900
BILLING_ENFORCE_TOPUP_PACKAGES=false
```

These are paise values: `1000` means ₹10 and `29900` means ₹299. The ₹500 maximum is configuration, not frontend code. Any maximum change requires deliberate operator review of payment risk, customer copy, tests, and approved legal/pricing publication. Razorpay credentials, webhook events/secrets, the 50/50 calculation, wallet arithmetic, refunds, verification, and idempotency do not change.

The currently approved Terms package description, Pricing **Gross top-up price** section, and owner publication attestation still name the old ₹10/₹50/₹100/₹500 package set. `scripts/check-legal-publication.py` intentionally blocks release until exact owner/counsel-approved replacement wording and a matching approval record are supplied. Do not deploy this pricing change while that blocker remains.

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

Razorpay GET reads retry connection/connect/read timeouts and HTTP
408/429/500/502/503/504. Backoff is exponential with bounded jitter and a
valid, bounded `Retry-After`; permanent 400/401/403/404 failures do not retry.
Order-creation POST is never blindly retried. Exhaustion raises a distinct
provider-unavailable error, rolls the reconciliation transaction back, and
makes the Cron process exit non-zero. No credit/refund mutation is reached
without its required provider read. A later successful run remains exactly
once through existing ledger idempotency keys.

```dotenv
RAZORPAY_READ_RETRY_ATTEMPTS=3
RAZORPAY_READ_RETRY_BASE_MS=500
RAZORPAY_READ_RETRY_MAX_MS=4000
RAZORPAY_HTTP_TIMEOUT_SECONDS=15
```

```dotenv
SENTRY_DSN=
SENTRY_TRACES_SAMPLE_RATE=0.05
SENTRY_PROFILES_SAMPLE_RATE=0
```

Configure Render failure notifications on both non-zero Cron Jobs. Never edit ledger history during support; use an approved compensating entry.

## Pricing verification snapshot

The Swico web-tier pricing snapshot is dated 2026-07-17. Production requires explicit input, cached-input, and output environment rates for every model referenced by each enabled tier ladder; built-in defaults are development/test safety values only. GPT-5.5 and GPT-5.6 requests over 272,000 input tokens apply 2x input and cached-input pricing plus 1.5x output pricing to the full request. The applied rule is retained in each internal pricing snapshot. Never rewrite historical usage snapshots.
