# TRIAG-RAG operations

## Runtime status

Startup validates the two booleans, bounded policy version, and built-in tier
ceilings. Runtime status is one of:

- `disabled`: optional component is off and healthy.
- `shadow`: content-free planning is enabled.
- `configured_inactive`: live mode was requested, but Phase 1 does not activate it.

Invalid configuration reports variable names only and never includes values.
Because TRIAG is optional in Phase 1, its configuration error is visible in
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

`web_usage_stage` is reserved for later phases. A Phase 1 deployment should
not create stage rows during ordinary chat. `usage_charge` remains the
authoritative billing table.

## Incident response

If shadow metadata appears unsafe, set `WEB_TRIAG_ENABLED=false`, restart the
API, preserve the affected trace IDs for investigation, and follow the normal
privacy incident process. If route, billing, cache, answer, or SSE behavior
changes, treat it as a release-blocking invariant violation and disable TRIAG.
