# Prepaid AI credit billing

## Units and allocation

Razorpay orders and refunds are stored in paise. Consumable AI credit is stored in micro-INR (`1 INR = 1,000,000 micro-INR`). `BILLING_CREDIT_PERCENT` defaults to 50. The user-credit paise are floored deterministically; an odd-paise remainder belongs to the platform.

Example: ₹10 is 1,000 paise. At 50%, the account receives 500 paise, or 5,000,000 micro-INR. The platform allocation is 500 paise. `USAGE_MARKUP_MULTIPLIER` defaults to 1.0 because the allocation already supplies margin.

## Charging

Reservations use the selected model pricing, all provider messages/instructions, estimated input tokens, maximum output tokens, and `BILLING_RESERVE_MULTIPLIER`. Wallet mutations use `SELECT ... FOR UPDATE` and do not span external provider calls. Final micro-INR charges round upward.

OpenAI USD costs use `USD_TO_INR_BILLING_RATE` and `OPENAI_FX_BUFFER_PERCENT`. Sarvam uses configured INR-per-million rates, including cached input rates. Each `UsageCharge` stores the exact pricing snapshot and whether usage was actual or estimated. Cache/safety/deterministic responses are free.

The ledger is append-only. Corrections and refunds add compensating entries. Partial refund reversal is proportional to cumulative refunded paise. A refund can make a wallet negative after credit was consumed; new AI requests remain blocked until available balance becomes positive.

## Razorpay state and idempotency

The server creates its `PaymentOrder` before calling Razorpay. Checkout verification signs the server-stored provider order ID, fetches payment state, and requires the exact amount, INR, and capture. Both verification and `payment.captured`/`order.paid` webhooks call the same idempotent payment-credit function.

Webhook HMAC uses the raw body and `RAZORPAY_WEBHOOK_SECRET`. `x-razorpay-event-id` and ledger idempotency keys stop replay. `refund.processed` reverses credit; `refund.failed` is recorded without reversal. Events can arrive out of order without double credit.

## Operations

- Reconcile `PaymentOrder` captured/credited states against Razorpay daily.
- Alert on long-lived `reserved` usage charges, failed webhook rates, negative wallets, and repeated provider mismatches.
- Update provider pricing and FX rate deliberately; historical pricing snapshots remain unchanged.
- Never edit or delete ledger history during routine support. Use an audited `manual_adjustment` compensating entry.
