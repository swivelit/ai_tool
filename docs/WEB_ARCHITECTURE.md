# Swico standalone web architecture

## Boundaries

`web/` is a standalone React, Vite, and TypeScript application. It has no imports from `mobile/` and no Expo, React Native, downloadable model, llama.cpp, local agent, or Qwen runtime dependency. Firebase Web Auth produces the bearer token used by the existing backend authentication dependency.

The existing FastAPI process conditionally mounts `backend/app/web_api/router.py` at `/api/web` when `WEB_APP_ENABLED=true`. Existing `/api/chat` and `/api/chat/stream` routes are unchanged. The web chat service uses the shared `AIProviderRouter`, `OpenAIProvider`, and `SarvamProvider`; it does not enter the mobile local-RAG or local-model pipeline.

## Request flow

1. Firebase verifies the user in the browser; the API verifies the bearer token with Firebase Admin and resolves the existing `User` row.
2. The browser submits a UUID `request_id`. The API persists the user message and selects a cloud route.
3. The API estimates the complete prompt and maximum output, locks the wallet row, and commits a conservative reservation before provider I/O.
4. OpenAI or Sarvam streams output. A final actual usage record is preferred; an estimate is labelled when Sarvam does not report usage.
5. A short database transaction settles the debit, releases the reservation, persists the assistant response and emits final SSE usage/wallet events.
6. Provider failure releases the reservation and leaves a retryable message. Request and ledger uniqueness keys prevent duplicate provider billing after completion.

OpenAI streaming uses provider deltas and the final usage event. Sarvam streaming is used when supported by the installed SDK; otherwise the service emits the completed response as one `delta` and marks estimated usage where needed.

## Storage

The Alembic revision `6d4f2a9c8b71` adds wallet accounts, append-only ledger entries, payment orders, webhook deduplication, usage charges, web threads/messages, and database-backed rate-limit windows. Money is never stored as float: Razorpay values use integer paise, wallet values use integer micro-INR, and provider cost/rates use `Numeric`/`Decimal`.

## Security and privacy

- Ownership is derived only from the verified Firebase token; browser user IDs are not accepted.
- The browser never receives backend/provider secrets.
- Webhooks preserve and authenticate the raw body before JSON parsing, enforce a size limit, and deduplicate event IDs.
- Production CORS rejects wildcard configuration.
- Chat content, raw webhook bodies, Firebase tokens, signatures, API keys, and payment contact data are not logged by the web modules.
- Fixed-window rate-limit counters are stored in PostgreSQL so limits work across API instances.

The legal routes in the client are explicitly marked placeholders and must be replaced by reviewed content before launch.
