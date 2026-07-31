# TRIAG-RAG operations

## Runtime status

Startup validates the two booleans, bounded policy version, and built-in tier
ceilings. Runtime status is one of:

- `disabled`: optional component is off and healthy.
- `shadow`: content-free planning is enabled.
- `configured_inactive`: TRIAG is non-shadow but hybrid retrieval is disabled.
- `hybrid`: the explicitly enabled Phase 2 hybrid path is active.

Invalid configuration reports variable names only and never includes values.
Because TRIAG-RAG is optional, its configuration error is visible in
debug runtime services but does not redirect traffic to another runtime.

## Shadow invariants

For the same request, compare the existing operational telemetry before and
after shadow enablement. These must remain identical:

- exact provider messages and prompt estimate;
- provider route and Swico tier behavior;
- provider-call count;
- reservation and settled debit;
- cache lookup/write behavior;
- final answer and visible SSE sequence.

Only one owner-scoped `web_retrieval_trace` row should be new. Its
`safe_metadata_json` must contain counts/flags/enums only.

## Database checks

```sql
select status, policy_version, tier_id, count(*)
from web_retrieval_trace
group by status, policy_version, tier_id;
```

Do not select or export user messages, memory facts, profile fields, temporary
attachment chunks, or provider prompts when operating shadow telemetry.

Phase 2 may create an `embedding` row in `web_usage_stage`. It must reference an
authoritative `usage_charge` reservation before any embedding call, then become
settled, released, or skipped. `usage_charge` remains authoritative.

Dense failures use content-free codes such as `dense_unavailable`,
`embedding_budget_unavailable`, `lexical_fallback`, and `upload_expired`.
Disabled optional components are healthy and report disabled.

## Incident response

If retrieval metadata appears unsafe, set `WEB_TRIAG_ENABLED=false`, restart the
API, preserve the affected trace IDs for investigation, and follow the normal
privacy incident process. If route, billing, cache, answer, or SSE behavior
changes, treat it as a release-blocking invariant violation and disable TRIAG.

For a Phase 3 incident, first disable repair, then the optional model verifier,
then verified streaming. Setting `WEB_ANSWER_GUARD_ENABLED=false` restores the
Phase 2 generation path. Inspect only the content-free `web_answer_check` and
`web_usage_stage` fields; provider prompts, evidence excerpts, and repair
prompts must never be stored there.

## Phase 4 repository operations

Repository snapshots use `POST /api/web/repositories`; general uploads retain
their document-only rules. A missing Valkey record makes the repository
unavailable even if content-free PostgreSQL index rows await expiry cleanup.
Delete marks the repository expired and removes the owner-scoped cache key.

Authenticated bootstrap publishes only repository feature booleans, TTL,
maximum archive bytes, and the validator capability (`static_only` or
`executable`). It never publishes validator connectivity or credentials.
`WEB_REPOSITORY_RATE_LIMIT_PER_MINUTE` has default `3`, bounds `1..60`, and
startup validation that reports the variable name without its value.
The validator process likewise validates its network-isolation boolean,
`CODE_VALIDATOR_TIMEOUT_SECONDS` (`1..300`), and
`CODE_VALIDATOR_MAX_OUTPUT_BYTES` (`1024..262144`) before serving requests.

The validator exposes only `/v1/isolation` and `/v1/validate`, protected by its
dedicated bearer token. It receives no API-provider, Firebase, database, email,
payment, or Razorpay secrets. `static_only` is a healthy bounded capability.
A 401, 403, 404, timeout, non-2xx or malformed response, or failed isolation
self-check is unavailable and never falls back to weak execution.

## Phase 5 knowledge operations

The current additive head is `f2a7c9e4b1d6`. Inspect content-free counts only:

```sql
select status, count(*) from web_knowledge_document group by status;
select embedding_status, count(*) from web_knowledge_chunk group by embedding_status;
select job_type, status, count(*) from job
where job_type in (
  'web_knowledge_ingest', 'web_embedding_backfill',
  'web_triplet_extract', 'web_hierarchy_build'
) group by job_type, status;
```

Do not export raw chunks, Condition/Proof/Conclusion bodies, summary bodies,
embedding JSON, or provider output. Source replacement invalidates chunks,
embeddings, triplets, hierarchy nodes and owner-cache rows. A private-source
turn has cache scope disabled and must never create a global cache entry.

Embedding backfill is lexical-only without an injected provider and
authoritative reservation. A paid attempt requires an owner/request-matched
`UsageCharge` in `reserved`, an idempotent `knowledge_embedding` stage, then
exact parent settlement. Disabled or failed derived work is healthy fallback.

Cancellation sets the owner-scoped job to `cancelled`; handlers recheck that
state between bounded units. Failed jobs persist only a static error code. A
future Render worker must use the same database, carry no raw payloads, and
remain disabled until accounting and cancellation gates pass.

Rollback is flag-only: disable hierarchy, triplets, then persistent knowledge,
or set `WEB_TRIAG_ENABLED=false`. Keep additive tables and fix forward.
