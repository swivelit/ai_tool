# Swico standalone web architecture

## Boundaries

`web/` is a standalone React, Vite, and TypeScript application. It has no imports from `mobile/` and no Expo, React Native, downloadable model, llama.cpp, local agent, or Qwen runtime dependency. Firebase Web Auth produces the bearer token used by the existing backend authentication dependency.

The existing FastAPI process conditionally mounts `backend/app/web_api/router.py` at `/api/web` when `WEB_APP_ENABLED=true`. Existing `/api/chat` and `/api/chat/stream` routes are unchanged. The web chat service uses the shared `AIProviderRouter`, `OpenAIProvider`, and `SarvamProvider`; it does not enter the mobile local-RAG or local-model pipeline.

Phase 0/1 TRIAG-RAG foundations, Phase 2 temporary-document retrieval, Phase 3
Answer Guard, the disabled-by-default Phase 4 repository path, and Phase 5
owner-approved persistent-knowledge foundations live under
`backend/app/web_ai/`. The package is not a new website runtime. With the
safe defaults `WEB_TRIAG_ENABLED=false`, `WEB_TRIAG_SHADOW_MODE=true`,
`WEB_RAG_HYBRID_ENABLED=false`, and `WEB_RAG_DENSE_ENABLED=false`, it is
disabled.
If deliberately enabled in shadow mode, `prepare_web_turn()` calculates a
tier-bounded plan and persists allowlisted counts, flags, and reason codes only.
It cannot change provider messages, routing, reservations, billing, cache
behavior, answers, or SSE events. `DynamicTokenAllocator` is not connected to
the active `_apply_prompt_budget` path.

When explicitly enabled outside shadow mode, Phase 2 reuses the coordinator and
existing lexical attachment selector, optionally retrieves from TTL-bound
temporary embeddings in `WEB_UPLOAD_CACHE_URL`, and constructs an untrusted,
tier-capped evidence pack. Each embedding stage must have an authoritative
`UsageCharge` reservation before provider I/O; otherwise dense retrieval is
skipped and lexical retrieval continues. Safe S1/S2 labels and locators are
emitted in `sources`; raw excerpts are never SSE or message metadata.

Phase 3 adds an opt-in Answer Guard after retrieval. Direct mode retains
ordinary low-risk streaming. Verified-buffered mode emits bounded status
events while holding the provider draft in memory, runs structural, citation,
evidence-support, contradiction and completeness checks, and emits only the
accepted answer. Persisted quality metadata contains check types and statuses
only. Answer Guard and verified streaming are disabled by default.

## Request flow

1. Firebase verifies the user in the browser; the API verifies the bearer token with Firebase Admin and resolves the existing `User` row.
2. The browser submits a UUID `request_id`. The API persists the user message and selects a cloud route.
3. The API estimates the complete prompt and maximum output, locks the wallet row and the user's local-calendar monthly period row, checks settled usage plus active reservations against an optional user cap, and commits a conservative reservation before provider I/O.
4. OpenAI or Sarvam streams output. A final actual usage record is preferred; an estimate is labelled when Sarvam does not report usage.
5. A short database transaction settles the debit, releases the reservation, persists the assistant response and emits final SSE usage/wallet events. Each wallet event includes a fresh token estimate, so bootstrap, settlement, payment credit, and explicit refresh need no polling.
6. Provider failure releases the reservation and leaves a retryable message. Request and ledger uniqueness keys prevent duplicate provider billing after completion.

### Web Turn Optimizer / Token Guardian

Website text turns pass through `backend/app/web_api/request_coordinator.py`
and its deterministic optimizer before wallet
reservation. Greetings, thanks, capability answers, safety blocks, unsupported
web-only tools, and approved cache hits use the existing persistence/SSE path
with zero provider calls and no reservation. Cache lookup uses the existing
privacy/live-data eligibility rules and deterministic token-hash lookup; it
does not add an embedding call.

The TRIAG-RAG persistence tables are additive:
`web_retrieval_trace`, `web_evidence_item`, `web_answer_check`, and
`web_usage_stage`. Phase 1 writes only a content-free `web_retrieval_trace` in
explicit shadow mode. Phase 2 uses the same tables for content-free evidence
provenance and idempotent embedding-stage linkage; `UsageCharge` remains the
authoritative reservation and settlement record. Phase 3 uses
`web_answer_check` for content-free quality results and `web_usage_stage` for
generation, verifier, and repair accounting.

Phase 4 adds a separate owner-scoped `POST /api/web/repositories` lifecycle.
It accepts bounded ZIP snapshots without changing the normal document-upload
allowlist. Raw source is held only in private Valkey until expiry. PostgreSQL
stores content-free repository, file, symbol, and dependency metadata. A
repository-aware request still enters `POST /api/web/chat/stream`, freezes its
final provider messages in `request_coordinator.py`, calls `ai/router.py`, and
returns the existing SSE stream. Repository-changing answers can be labelled
`verified` only if every centrally required repository check ran and passed.
Repository-aware chat requires the TRIAG, repository upload/index, Answer Guard,
and verified-streaming flags together; partial enablement remains disabled.

Phase 4.1 adds authenticated website usability around that lifecycle. Bootstrap
exposes only `web_repository_upload`, `web_repository_chat`,
`web_repository_validation`, bounded TTL/archive limits, and a `static_only` or
positively proven `executable` capability. The browser keeps repository metadata
in memory, binds the ID to one Firebase owner and one thread, and clears it on
account or thread changes. Repository source and IDs are not stored in browser
storage.

Phase 5 adds owner-scoped persistent documents, raw chunks, anchored
Condition/Proof/Conclusion triplets and document/section/raw hierarchy nodes.
Persistence is never inferred from an upload: a separate service call requires
explicit owner approval. PostgreSQL FTS and optional accounted pgvector
retrieval share the existing registry/evidence caps; lexical raw-chunk
retrieval survives vector, provider and budget failure. Private-source turns
disable the global cache. Phase 6 leaves this path and every earlier feature
flag off in production until staged gates pass.

The same optimizer contains a deterministic Swico Brand Guard. Explicit public
product and identity questions, plus a bounded follow-up based only on the
immediately previous completed assistant message's safe `topic=swico` metadata,
are answered from the canonical structured profile in
`backend/app/web_api/swico_brand.py`. The route runs before approved-cache lookup,
profile/history selection, wallet reservation, and provider I/O. It makes no
provider call, creates no usage reservation, is never written to the global
provider-answer cache, and preserves the normal persistence and SSE contract for
both website text and realtime voice turns. Set
`WEB_SWICO_BRAND_GUARD_ENABLED=false` to roll back only this route; it defaults to
true.

`WEB_SWICO_BRAND_GUARD_ENABLED` belongs directly on the `ai_tool` API service.
Do not place it on `swico-web`, in a shared environment group, on PostgreSQL or
Valkey, or on billing cron jobs.

Same-thread continuity is selected by the provider-free deterministic policy in
`backend/app/web_api/conversation_continuity.py`. In `adaptive` mode it honors
explicit topic resets, preserves the existing explicit-follow-up rules, and
uses referential language, elliptical questions, Unicode lexical topic overlap,
and a conservative short-message fallback. Clear self-contained new subjects
send no history. The selected latest one turn (or at most two for comparisons
and numbered continuations) is bounded to 900 raw history characters by
default. Invalid mode values normalize safely to `explicit_only`; `off` sends no
same-thread history, `explicit_only` retains the narrow legacy classifier, and
`always_last` is a diagnostic fallback that sends the latest complete turn
unless the message explicitly resets the topic. Profile and attachment blocks are
selective and bounded at 500 and 6,000 characters. Cross-thread memory is
retrieved only for explicit lexical memory requests, is owner-scoped, and is
bounded to four items / 1,200 characters. The exact provider messages
are built once and reused for model-cost ordering, the conservative wallet
reservation, provider budget guard, provider request, and telemetry. Simple
turns may reorder healthy candidates only inside the selected Swico tier by
complete-turn cost; detailed/coding/architecture turns retain configured
primary-first order.

A successful provider turn makes one network generation attempt. One fallback
is permitted only after a zero-output, zero-usage failure and only within
`WEB_PROVIDER_CALLS_PER_TURN_MAX`. The production-safe default is one.
Prompt-cache request parameters are disabled by
default because cache-write token pricing is not yet included in settlement.
Historical chat text stays in its original `user` and `assistant` provider
roles; it is never embedded in a system message. Sanitized continuity reasons,
confidence, counts, characters, and token estimates are stored in assistant
message metadata without raw conversation text. The
additive revision `f9c2d7a4e1b6` adds active message revisions and user-scoped
memory tables. Roll back the adaptive continuity policy with
`WEB_SAME_THREAD_CONTEXT_MODE=explicit_only`; disabling the whole optimizer is
not the normal continuity rollback.

OpenAI streaming uses provider deltas and the final usage event. Sarvam streaming is used when supported by the installed SDK; otherwise the service emits the completed response as one `delta` and marks estimated usage where needed.

## Completion, revisions, and memory

Provider completion status is normalized to `finish_reason`, `truncated`, and
`completion_status` on the assistant message and SSE `done` event. The browser
offers Continue only for a completed truncated answer. Continue is a new billed
request and sends only a bounded tail of the interrupted answer.

With `WEB_MESSAGE_EDIT_ENABLED=true`, only the latest active user message can be
edited. The original user/assistant rows are marked superseded and the new user
row links back with an incremented revision number. Normal history/context reads
exclude superseded rows. Usage charges and wallet ledger rows are append-only
and are never edited during regeneration.

Cross-thread memory requires both the deployment flag and user opt-in. Explicit
memory requests use deterministic owner-scoped lexical ranking over at most four
facts/summaries and 1,200 formatted characters. The deterministic writer stores
only explicit durable preferences/projects and bounded project/roadmap summaries;
it skips recognized sensitive statements. It makes no embedding or LLM call.

## Documents and large pasted text

Temporary uploads are extension-allowlisted and content-signature/container
validated. Text PDFs use `pypdf`; likely scanned PDFs return an explicit warning
that OCR was not performed. DOCX extraction includes paragraphs, tables,
headers, footers, and supported Word XML text boxes. The API does not bundle an
OCR or legacy `.doc` converter worker, so those flags remain false and `.doc`
asks the user to save as DOCX. Extracted text expires after 3,600 seconds by
default (maximum 24 hours); raw upload retention remains disabled.

When enabled, pasted input above 12,000 characters is stored as a temporary
virtual text attachment and chunked instead of being sent inline. Question
answering uses bounded lexical chunk retrieval. Whole-document summarize,
analyze, rewrite, or translate operations that exceed the 6,000-character
attachment prompt budget return `full_document_confirmation_required`; no text
is silently truncated into a misleading complete operation.

## Realtime voice

The existing AudioWorklet/STT/model/TTS pipeline remains concurrent. Adaptive
endpointing combines transcript completion/stability, pause length, utterance
duration, and local prosody evidence; partial transcripts never start model
generation. First-clause TTS runs before model completion, and provider-confirmed
speech start atomically cancels generation and audio. Optional local deterministic
backchannel audio is rate-limited, makes no provider call, and defaults off.
Telemetry records first STT partial, final transcript, first model delta, first
TTS audio, and barge-in stop latency without logging audio or transcript text.

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
