# Prepaid AI credit billing

## Units and allocation

Razorpay orders and refunds are stored in paise. Consumable value is stored in micro-INR (`1 INR = 1,000,000 micro-INR`). The product-facing unit is **AI credits**: 1.00 AI credit represents ₹1 of consumable AI usage value. That conversion is presentation-only; no floating-point financial ledger was added. AI credits are non-transferable, non-withdrawable, and usable only for AI usage on Swico.

`BILLING_CREDIT_PERCENT` remains exactly 50. The user-credit paise are floored deterministically; an odd-paise remainder belongs to the platform.

Example: ₹10 is 1,000 paise. At 50%, the account receives 500 paise, or 5,000,000 micro-INR, displayed as **5.00 AI credits** and described as equivalent to ₹5 of consumable AI usage. The platform allocation is ₹5. `USAGE_MARKUP_MULTIPLIER` defaults to 1.0 because the allocation already supplies margin.

Payment history keeps gross amount paid, AI credits granted, platform allocation, refund amount, and credit reversal as separate fields. The ₹ symbol remains on payments, refunds, allocations, invoices, and usage-value equivalents, but never prefixes the AI-credit balance.

## Charging

Reservations use the selected model pricing, all provider messages/instructions, estimated input tokens, maximum output tokens, and `BILLING_RESERVE_MULTIPLIER`. Wallet mutations use `SELECT ... FOR UPDATE` and do not span external provider calls. Final micro-INR charges round upward.

OpenAI USD costs use `USD_TO_INR_BILLING_RATE` and `OPENAI_FX_BUFFER_PERCENT`. Sarvam uses configured INR-per-million rates, including cached input rates. Each `UsageCharge` stores the exact pricing snapshot and whether usage was actual or estimated. Cache/safety/deterministic responses are free.

The ledger is append-only. Corrections and refunds add compensating entries. Partial refund reversal is proportional to cumulative refunded paise. A refund can make a wallet negative after credit was consumed; new AI requests remain blocked until available balance becomes positive.

## Usage visibility and monthly limits

`GET /api/web/usage/summary` supports `current_month`, `30d`, and `all`. It counts only settled chargeable `UsageCharge` rows and returns request/token totals, actual versus estimated counts, debited/available micro-INR and AI-credit presentations, daily series, and provider/model breakdowns. Released, failed, free cache, safety, and deterministic responses are excluded; reservations are not double counted.

Current-month boundaries are calculated in the authenticated user's validated IANA timezone and converted to UTC for querying. The response names a reference provider/model and shows input-only/output-only token estimates plus an optional documented blend. Pricing and workload mix differ, so this is always labelled as an estimate and never a guaranteed token quota.

The prepaid wallet remains the global hard cap. `WebUsagePreferences` adds an optional monthly cap. Before provider I/O the service locks the wallet and a per-user/period serialization row, then checks settled debits plus every active reservation. Released/failed reservations stop counting. Settlement preserves room for concurrent reservations and records any provider overage absorbed by the platform. The stable limit response is HTTP 402 with `code=usage_limit_reached`, current usage, configured limit, remaining amount, and reset timestamp. Automatic recharge is not implemented.

## Razorpay state and idempotency

The server creates its `PaymentOrder` before calling Razorpay. Checkout verification signs the server-stored provider order ID, fetches payment state, and requires the exact amount, INR, and capture. Both verification and `payment.captured`/`order.paid` webhooks call the same idempotent payment-credit function.

Webhook HMAC uses the raw body and `RAZORPAY_WEBHOOK_SECRET`. `x-razorpay-event-id` and ledger idempotency keys stop replay. `refund.processed` reverses credit; `refund.failed` is recorded without reversal. Events can arrive out of order without double credit.

The public/authenticated billing config returns explicit `razorpay_mode: test|live` and `checkout_enabled`. Server-side key-prefix validation remains authoritative; the browser does not infer mode from the key. `BILLING_CHECKOUT_ENABLED=false` blocks only new order creation with `code=checkout_disabled`; existing AI credits and normal usage continue. Production requires this variable to be explicitly set.

## Operations

- Reconcile `PaymentOrder` captured/credited states against Razorpay daily.
- Alert on long-lived `reserved` usage charges, failed webhook rates, negative wallets, and repeated provider mismatches.
- Update provider pricing and FX rate deliberately; historical pricing snapshots remain unchanged.
- Never edit or delete ledger history during routine support. Use an audited `manual_adjustment` compensating entry.

## Pricing verification snapshot

Verified on 2026-07-16 against official provider documentation only:

- OpenAI configured defaults for GPT-5 nano, GPT-5 mini, GPT-4.1 nano,
  GPT-4.1 mini, GPT-4o mini, and o4-mini match their official model/pricing
  pages, including cached-input rates. The configured `gpt-3.5-turbo-0125`
  snapshot is marked deprecated, remains disabled by default, and production
  validation rejects enabling it. Sources: <https://developers.openai.com/api/docs/pricing>
  and the linked official model pages under
  <https://developers.openai.com/api/docs/models>.
- Sarvam `sarvam-30b` is ₹2.5 input / ₹1.5 cached input / ₹10 output per one
  million tokens; `sarvam-105b` is ₹4 / ₹2.5 / ₹16. Source:
  <https://docs.sarvam.ai/api-reference-docs/pricing>.

The previous Sarvam cached-input defaults were too high and are corrected in
code and `backend/.env.example`. Before the next Test Mode deployment, update
or remove the two corresponding Render overrides so runtime configuration does
not retain the old values. Historical usage snapshots must not be rewritten.
