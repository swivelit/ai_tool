# TRIAG-RAG architecture

## Phase 0–3 scope

The Phase 0/1 implementation is a provider-free planning foundation under
`backend/app/web_ai/`. It defines immutable execution, tier, retrieval,
evidence, answer-check, allocation, settings, and telemetry contracts.

The production website path remains:

```text
web/src/pages/ChatPage.tsx
  -> web/src/api/client.ts streamChat()
  -> POST /api/web/chat/stream
  -> backend/app/web_api/router.py
  -> backend/app/web_api/chat_service.py
  -> backend/app/web_api/request_coordinator.py
  -> backend/app/ai/router.py
  -> provider
  -> SSE
```

Neither `backend/app/ai/orchestrator.py` nor `AgentRuntime` is part of this
website flow.

## Deterministic planning

`triage.py` reuses the existing lexical intent classifier, turn optimizer,
same-thread continuity decision, attachment metadata, and selected Swico tier.
It makes no LLM, embedding, retrieval, or provider call. Identical input and
configuration produce the same `ExecutionPlan`.

`DynamicTokenAllocator` applies validated tier ceilings and can assign zero to
history, cross-thread memory, profile, and documents independently. Its output
is observational while TRIAG is disabled or shadow-only.

## Phase 2 temporary-document retrieval

The enabled-only runtime adapts `select_attachment_context()` and its lexical
ranker, optionally adds dense retrieval, uses deterministic reciprocal-rank
fusion, near-duplicate removal, marginal-value-per-token selection, and builds
a capped evidence pack with stable S1/S2 identifiers. Document content is
always wrapped as untrusted data. Evidence status is `sufficient`, `ambiguous`,
`insufficient`, or `contradictory`; at most one deterministic corrective
lexical round is allowed by the central tier policy.

Temporary chunk and query embeddings use the existing `WEB_UPLOAD_CACHE_URL`.
Keys are owner/upload/content/model/schema scoped and expire no later than the
upload. PostgreSQL receives provenance and safe locators only. Every embedding
stage must be reserved and linked to `UsageCharge` before provider execution.

## Phase 3 verified generation

Answer Guard reuses the existing completion-structure checks, then runs empty,
repetition, duplicate-section, citation validity/coverage, deterministic
evidence-support, contradiction-warning and task-completeness checks. An
optional tier-gated model verifier and one bounded repair are disabled by
default. Repair sees only the current answer, failed-check summaries, required
evidence, and the minimum task contract.

Verified-buffered mode emits no answer delta until verification finishes.
Every generation, verifier, and repair provider stage is idempotently linked to
the parent `UsageCharge`; settlement still occurs exactly once at the parent.

## Safe persistence

Revision `b4e8c1d6a2f9` adds:

- `web_retrieval_trace`
- `web_evidence_item`
- `web_answer_check`
- `web_usage_stage`

Rows are owner-scoped and include request, status, safe-metadata, and
idempotency fields. `web_usage_stage` cannot replace or alter `UsageCharge`;
the latter remains authoritative for reservation and settlement.

Phase 1 shadow planning can insert one idempotent `web_retrieval_trace` per
owner/request/policy. Stored JSON is fail-closed and allowlisted. It includes
only bounded enums, reason codes, flags, counts, byte counts, and token-count
allocations. It cannot contain raw messages, memory/profile text, attachment
excerpts, generated code, secrets, tokens, credentials, environment values, or
provider/model names.

## Non-goals / Phase 4 boundary

Phase 3 does not execute or validate repository code and never claims
repository verification. It does not add arbitrary commands, an isolated
validator, repository indexing, triplets, hierarchy, persistent knowledge, or
AgentRuntime routing.
