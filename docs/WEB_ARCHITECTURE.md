# Swico standalone web architecture

## Boundaries

`web/` is a standalone React, Vite, and TypeScript application. It has no imports from `mobile/` and no Expo, React Native, downloadable model, llama.cpp, local agent, or Qwen runtime dependency. Firebase Web Auth produces the bearer token used by the existing backend authentication dependency.

The existing FastAPI process conditionally mounts `backend/app/web_api/router.py` at `/api/web` when `WEB_APP_ENABLED=true`. Existing `/api/chat` and `/api/chat/stream` routes are unchanged. The web chat service uses the shared `AIProviderRouter`, `OpenAIProvider`, and `SarvamProvider`; it does not enter the mobile local-RAG or local-model pipeline.

## Request flow

1. Firebase verifies the user in the browser; the API verifies the bearer token with Firebase Admin and resolves the existing `User` row.
2. The browser submits a UUID `request_id`. The API persists the user message and selects a cloud route.
3. The API estimates the complete prompt and maximum output, locks the wallet row and the user's local-calendar monthly period row, checks settled usage plus active reservations against an optional user cap, and commits a conservative reservation before provider I/O.
4. OpenAI or Sarvam streams output. A final actual usage record is preferred; an estimate is labelled when Sarvam does not report usage.
5. A short database transaction settles the debit, releases the reservation, persists the assistant response and emits final SSE usage/wallet events. Each wallet event includes a fresh token estimate, so bootstrap, settlement, payment credit, and explicit refresh need no polling.
6. Provider failure releases the reservation and leaves a retryable message. Request and ledger uniqueness keys prevent duplicate provider billing after completion.

OpenAI streaming uses provider deltas and the final usage event. Sarvam streaming is used when supported by the installed SDK; otherwise the service emits the completed response as one `delta` and marks estimated usage where needed.

## Storage

The Alembic revision `6d4f2a9c8b71` adds wallet accounts, append-only ledger entries, payment orders, webhook deduplication, usage charges, web threads/messages, and database-backed rate-limit windows. Additive revision `8c1f4e7b2a90` adds owner-scoped web usage preferences and per-user/month serialization rows. The serialization table stores no financial total: `UsageCharge` remains authoritative. Money is never stored as float: Razorpay values use integer paise, wallet values use integer micro-INR, and provider cost/rates use `Numeric`/`Decimal`.

## Settings and usage contracts

- `GET /api/web/usage/summary?period=current_month|30d|all` aggregates only settled, debited `UsageCharge` rows owned by the authenticated user. Daily buckets use the user's validated IANA timezone; comparisons and stored boundaries remain UTC.
- `GET|PATCH /api/web/settings/profile` reads and updates name, place, timezone, assistant name, and reply language. Email is read-only.
- `GET|PATCH /api/web/settings/usage` manages the optional monthly integer-micro-INR hard limit, warning threshold, and notification preference.
- `app/billing/token_estimates.py` derives input-only, output-only, and documented 70/30 blended values from the named reference provider/model with integer arithmetic. Wallets, packages, payment/refund history, and monthly limits reuse it. These are estimates, never quotas.

The web Settings dialog is responsive, keyboard trapped, escape-closeable, and restores focus. It exposes reviewed legal-content routes without adding invented legal terms or an unsafe account-deletion control.

### Request and response shapes

`PATCH /api/web/settings/profile` accepts any subset of `name`, `place`,
`timezone`, `assistant_name`, and `reply_language` (`en` or `ta`). Its response
adds read-only `email` and `email_editable: false`. Unknown fields, including
`user_id` and `email`, are rejected.

`PATCH /api/web/settings/usage` accepts:

```json
{
  "period": "monthly",
  "hard_limit_micros": 2500000,
  "warning_threshold_percent": 80,
  "notify_at_threshold": true
}
```

`hard_limit_micros` may be `null` for unlimited; non-integer JSON numbers and
non-positive integers are rejected. The response includes current use,
remaining amount, warning state, timezone, and `next_reset_at`. A rejected chat
reservation returns:

```json
{
  "error": {
    "code": "usage_limit_reached",
    "current_usage_micros": 2500000,
    "configured_limit_micros": 2500000,
    "remaining_micros": 0,
    "reset_at": "<UTC timestamp>"
  }
}
```

The usage-summary response includes period metadata; request, input, cached
input, output, and total token counts; actual/estimated counts; legacy internal
compatibility fields; daily/provider/model series; and both `token_estimate` and
the legacy `estimated_tokens_remaining` alias with its reference provider/model, pricing
timestamp/snapshot, input-only/output-only/blended estimates, range, and caveat.

## Security and privacy

- Ownership is derived only from the verified Firebase token; browser user IDs are not accepted.
- The browser never receives backend/provider secrets.
- Webhooks preserve and authenticate the raw body before JSON parsing, enforce a size limit, and deduplicate event IDs.
- Production CORS rejects wildcard configuration.
- Chat content, raw webhook bodies, Firebase tokens, signatures, API keys, and payment contact data are not logged by the web modules.
- Fixed-window rate-limit counters are stored in PostgreSQL so limits work across API instances.

The legal routes load a structured publication module, including digital-delivery and pricing/top-up pages. `python scripts/check-legal-publication.py` blocks Live launch until reviewed copy, identity/contact metadata, effective dates, and versions are supplied.
