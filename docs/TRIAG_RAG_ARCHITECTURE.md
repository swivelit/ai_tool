# TRIAG-RAG architecture

## Phase 0–6 scope

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

Revision `d6f1a8c3e9b4` descends from that Phase 1 revision and adds
`web_code_repository`, `web_code_file`, `web_code_symbol`, and
`web_code_edge`. These tables contain owner/version/expiry state, hashes,
normalized locators, signatures, and dependency edges only. Repository bodies
and generated files remain temporary request/cache data.

Phase 1 shadow planning can insert one idempotent `web_retrieval_trace` per
owner/request/policy. Stored JSON is fail-closed and allowlisted. It includes
only bounded enums, reason codes, flags, counts, byte counts, and token-count
allocations. It cannot contain raw messages, memory/profile text, attachment
excerpts, generated code, secrets, tokens, credentials, environment values, or
provider/model names.

## Phase 4 repository boundary

Phase 4 adds a dedicated temporary repository snapshot contract, deterministic
Python AST and TypeScript/JavaScript token parsing, symbol/dependency retrieval,
and a separately authenticated validator process. The validator never accepts
command strings. Executable checks use server-owned argument templates and
remain disabled unless startup positively proves non-root, process and
outbound-network isolation. Static-only validation never produces a
repository-verified label when executable policy checks are required.

Phase 4 does not add triplets, hierarchy, persistent knowledge, arbitrary
commands, production activation, or AgentRuntime routing.

## Phase 5 persistent knowledge

Revision `f2a7c9e4b1d6`, descending from `d6f1a8c3e9b4`, adds
`web_knowledge_document`, `web_knowledge_chunk`, `web_knowledge_triplet`, and
`web_knowledge_node`. Every row is owner- and source-version-scoped. Raw chunks
may enter PostgreSQL only through the explicit approval service; the temporary
upload path remains Valkey-only and never calls that service automatically.

Raw chunks are authoritative evidence. PostgreSQL `to_tsvector` retrieval has
a deterministic lexical fallback. Accounted dense requests may use pgvector
casts; missing vector support, reservation, embedding budget, or provider falls
back to lexical retrieval. Triplets store Condition, Proof, Conclusion and the
exact raw chunk ID. Hierarchy summaries route retrieval, but evidence receives
anchored raw chunks rather than summaries alone.

The retrieval registry admits persistent, triplet, and hierarchy retrievers
only when both the immutable plan and central tier policy allow them. Lite has
no persistent retrieval; Standard permits bounded raw/hierarchy retrieval; Pro
additionally permits triplets. The shared evidence cap remains authoritative.

The versioned job types are `web_knowledge_ingest`,
`web_embedding_backfill`, `web_triplet_extract`, and
`web_hierarchy_build`. Their payloads contain owner/document/version
identifiers only. They are idempotent and cancellable. The shared worker does
not construct an embedding provider: a later dedicated worker must inject one
only after an authoritative reservation and `web_usage_stage` exist.

Phase 5.1 exposes the foundation through authenticated
`/api/web/knowledge` endpoints. Approval accepts an existing temporary upload
only when the caller supplies an explicit true confirmation. An owner-scoped
Valkey marker is checked before the raw upload value is read; missing,
cross-owner, and expired identifiers all fail closed. List, document-status
and job-status responses contain only safe titles, lifecycle states, counts
and timestamps. They do not contain chunks, hashes, embeddings, model/provider
details, or internal job identifiers. Delete removes the approved source and
invalidates owner cache state; re-indexing resets derived data and queues the
existing idempotent ingest job.

The authenticated bootstrap adds only `features.web_knowledge_library`. It is
true only when the existing persistent-knowledge runtime gate is live. The
website settings UI uses temporary upload display metadata already in memory,
requires “Save to my Knowledge Library”, and writes no repository text or
knowledge identifiers to browser storage.

## Phase 6A server-authoritative rollout

`backend/app/web_ai/rollout.py` defines the immutable rollout policy and one
immutable request decision for four independently controlled features:
TRIAG/hybrid chat, the Knowledge Library, repository chat, and Answer Guard
with verified streaming. Each control has exactly four modes: `disabled`,
`internal_accounts`, `percentage`, and `all_eligible`.

Internal membership reuses the existing verified
`SWICO_INTERNAL_TEST_EMAILS` path: the Firebase token email must be verified
and must exactly match the owned database account before it is compared with
the configured cohort. Percentage assignment is a stable SHA-256 bucket over
owner user ID, feature key, and rollout policy version. Raw email never enters
the rollout policy, decision, logs, or metadata.

Global Phase 0–5 flags remain hard kill switches. The authenticated router
resolves the policy once, creates request-scoped effective settings, and
passes that frozen pair through preparation, execution, streaming, cache
eligibility, and content-free telemetry. A controlled live path does not use
the global answer cache. Bootstrap and Knowledge Library/repository endpoints
apply the same resolver. Disabled users keep the existing website fallback.

Phase 6A is controlled readiness, not activation. All production rollout modes
and Phase 0–5 global flags remain disabled until owner-isolation, privacy,
billing, cancellation, cache, quality, and rollback gates pass in staging. No
website request uses `AgentRuntime`, no production validator points to
staging, and no persistent knowledge enters the global answer cache.
