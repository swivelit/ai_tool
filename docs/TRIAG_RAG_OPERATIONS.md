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
