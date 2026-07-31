# TRIAG-RAG architecture

## Phase 0/1 scope

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
history, cross-thread memory, profile, and documents independently. Its Phase 1
output is observational. The existing `_apply_prompt_budget` remains
authoritative and unchanged.

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

## Non-goals

Phase 1 does not execute retrieval, construct evidence for generation, check
answers, split usage billing into stages, select a new route, alter cache
eligibility, change prompts, or emit new SSE events. Those are Phase 2 or later.
