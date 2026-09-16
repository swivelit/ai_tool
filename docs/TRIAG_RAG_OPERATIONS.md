# TRIAG-RAG operations

Release acceptance metadata is recorded in
[TRIAG_RAG_RELEASE_CLOSEOUT.md](TRIAG_RAG_RELEASE_CLOSEOUT.md).
The full-site capability baseline and validator-risk inventory are recorded in
[PRODUCTION_CAPABILITY_BASELINE.md](PRODUCTION_CAPABILITY_BASELINE.md).

## Production capability deployment parity

Before launching the production-capability benchmark, perform these Render
operator steps in order:

1. Deploy the `ai_tool` service from the latest commit on the `main` branch.
2. Deploy the `swico-web` service from the latest commit on the `main` branch.
3. Verify that `/api/version` reports the expected backend commit SHA.
4. Run `backend/scripts/triag_release_check.py` against the deployment.
5. Launch the `production-capability` mode only after those checks pass.

Configure the production acceptance Environment in GitHub before the run:

```text
GitHub Settings
-> Environments
-> production-triag

Environment secrets:
- E2E_TEST_EMAIL
- E2E_TEST_PASSWORD
- PLAYWRIGHT_BASE_URL

Optional owner-isolation Environment secrets:
- E2E_SECOND_TEST_EMAIL
- E2E_SECOND_TEST_PASSWORD

Environment variables:
- PLAYWRIGHT_API_BASE_URL=https://ai-tool-rrau.onrender.com
```

`PLAYWRIGHT_API_BASE_URL` is a public URL, not a credential. It identifies the
backend API origin independently of `PLAYWRIGHT_BASE_URL`, which remains the
website UI origin. The workflow prefers the Environment variable. A same-named
Environment secret remains a temporary compatibility fallback and produces a
non-failing migration warning; move it to Environment variables.

`E2E_SECOND_TEST_EMAIL` and `E2E_SECOND_TEST_PASSWORD` are optional **GitHub
Environment secrets**, not Render environment variables. With both absent, the
benchmark runs normally and records K-OWNER-ISOLATION as skipped. If either is
configured, both are required and the secondary email must differ from the
primary email. The two credential pairs must identify different dedicated
Firebase acceptance accounts, and both normalized account emails must be
present in the backend's existing `SWICO_INTERNAL_TEST_EMAILS` value so
bootstrap reports `wallet.billing_exempt=true` for each. Never print either
email or password in workflow logs or artifacts.

The benchmark compares the workflow's `GITHUB_SHA` with the public backend
release SHA before login or production state creation. It checks immediately,
then every 20 seconds for at most 10 minutes to allow bounded Render deployment
propagation. A persistent mismatch fails closed with
`backend_release_mismatch`; deploy the latest commit to the `ai_tool` Render
service, verify that its Render branch is `main`, and rerun after the backend
release matches. If no valid SHA can be read, it reports
`backend_release_unavailable` and directs the operator to verify the configured
API origin and public `/api/version` availability instead of redeploying. The
`app_release` response field is accepted only as compatibility fallback when
`backend_release_sha` is absent. The web deployment currently exposes no safe
build SHA, so frontend release parity remains an operator-verified prerequisite
rather than an automated assertion.

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

Phase 6A separately validates the rollout policy as the optional
`web_rollout` runtime service. Allowed modes are `disabled`,
`internal_accounts`, `percentage`, and `all_eligible`; all default disabled.
Percentages are bounded to `0..100`, and the policy version is a bounded
`v<number>` identifier. Production validation rejects malformed values by
variable name without echoing the value.

The percentage field is active only when its matching mode is `percentage`.
Modes `disabled`, `internal_accounts`, and `all_eligible` require percentage
`0`. This applies independently to TRIAG hybrid, Knowledge Library,
repository chat, and Answer Guard. A non-zero percentage in any other mode is
a startup/configuration error that names only the affected environment
variables; the configured value is never included.

`WEB_TRIAG_RELEASE_STATE` is independently validated as `controlled` or
`general_availability` and defaults to `controlled`. Invalid values report the
variable name only and the request path fails closed to controlled behavior.

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
`safe_metadata_json` must contain counts/flags/enums only. An included Phase 6
shadow request records `rollout_execution=shadow`; that label is observation,
not authorization for hybrid retrieval or cache suppression.

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

Production Answer Guard should set:

```text
WEB_TASK_REPAIR_SECOND_ATTEMPT_ENABLED=true
```

The setting defaults to `false` when absent. When enabled, it permits at most
one additional targeted repair after the first repair leaves only allowlisted,
deterministic task-semantic failures, or after a section-splice architecture
repair reduces but does not clear the missing-area set. Architecture attempt 2
replaces only the remaining accepted section. Output-only strict correction
keeps its existing bounded path. Safety, provider, retrieval, billing,
authentication and cancellation failures are never eligible. Both repair
attempts remain separately reserved by attempt identifier and are aggregated
into the single authoritative repair usage stage and parent charge.

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

These content-free knowledge-operation queries are retained from an earlier
schema snapshot. The current repository Alembic head is
`20260915_weekly_tester_credit`; inspect counts only:

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
state before and after the paid call. Failed jobs persist only a static error
code. The dedicated process is:

```text
cd backend
python -m app.knowledge_worker
```

Its settings are bounded at startup:

```text
WEB_KNOWLEDGE_WORKER_ENABLED=false
WEB_KNOWLEDGE_WORKER_POLL_SECONDS=2       # 0.25..60
WEB_KNOWLEDGE_WORKER_MAX_CONCURRENCY=1   # 1..8
```

False preserves the shared worker's earlier claim behavior. True makes the
shared worker exclude the four knowledge types and makes the dedicated process
the only claimant for them. Do not set true on the API until the private worker
is deployed, connected to the same PostgreSQL database, healthy, and still
disabled. Then enable the worker first and the API separation flag in one
reviewed staging change.

The chain order is ingest, embedding backfill, hierarchy, then triplet.
Persistent knowledge, dense retrieval, hierarchy/triplet flags, and the
selected tier policy independently gate later stages. A provider failure
completes as lexical fallback and may continue to enabled provider-free derived
stages; it never invalidates ready raw chunks. A provider response that arrives
after cancellation or source invalidation is charged exactly once but its
vectors are discarded.

For a content-free billing audit:

```sql
select s.status as stage_status, c.status as charge_status, count(*),
       sum(s.debited_micros) as stage_micros,
       sum(c.debited_micros) as charge_micros
from web_usage_stage s
join usage_charge c on c.id = s.usage_charge_id
where s.stage_name = 'knowledge_embedding'
group by s.status, c.status;
```

Do not select `job.payload_json`, chunk bodies, embeddings, provider output, or
ledger metadata during routine operations.

The Phase 5.1 owner operations are:

```text
POST   /api/web/knowledge
GET    /api/web/knowledge
GET    /api/web/knowledge/{document_id}
DELETE /api/web/knowledge/{document_id}
POST   /api/web/knowledge/{document_id}/reindex
GET    /api/web/knowledge/{document_id}/job
DELETE /api/web/knowledge/{document_id}/job
```

All require Firebase authentication and return `Cache-Control: no-store`.
Approval requires `confirm_persistence: true`; never retry by changing that
field server-side. A not-found approval may mean expired or non-owned upload
and must not be diagnosed using raw Valkey contents. Job APIs expose status,
not the internal job ID. Routine support may inspect content-free counts and
statuses only. Removal is authoritative and also clears the owner's private
answer cache; re-indexing clears derived embeddings/triplets/hierarchy before
the idempotent ingest job is queued.

Rollback is flag-only: disable hierarchy, triplets, then persistent knowledge,
or set `WEB_TRIAG_ENABLED=false`. Keep additive tables and fix forward.

## Phase 6A rollout operations

For a cohort audit, inspect only the content-free rollout records attached to
the owner-scoped request metadata. Every feature record contains exactly
feature key, cohort, policy version, and enabled/disabled decision. The sibling
`rollout_execution` enum is exactly `fallback`, `shadow`, or `live`; the
`rollout_release_state` enum is exactly `controlled` or
`general_availability`. Never export the surrounding message metadata or join
it to email, message, memory, document, or repository content.

The authenticated request resolves one immutable decision. Bootstrap and each
gated endpoint resolve through the same policy; a chat request carries its
decision through preparation, execution, streaming, and telemetry even if
service configuration changes while it is running. Any live controlled
feature disables global answer-cache lookup/write for that turn. Shadow is
cohort-gated by `WEB_ROLLOUT_TRIAG_MODE` but still requires the hard switch
`WEB_TRIAG_ENABLED=true`; it builds and persists only the content-free plan.
It does not enable hybrid retrieval, Answer Guard, repository chat, persistent
knowledge or live generation, and it does not alter global-cache eligibility
or lookup. An excluded user keeps the existing fallback and cache policy.

Use `internal_accounts` only with verified, owned accounts in
`SWICO_INTERNAL_TEST_EMAILS`. An unverified or mismatched request email is not
internal. Percentage cohorts are stable until either the owner ID, feature key,
or `WEB_ROLLOUT_POLICY_VERSION` changes.

Use this exact staging order:

1. Start with every rollout mode disabled, every percentage zero,
   `WEB_TRIAG_ENABLED=false`, shadow true, and all live feature flags false.
2. Add verified owned internal accounts. Set only `WEB_TRIAG_ENABLED=true` and
   `WEB_ROLLOUT_TRIAG_MODE=internal_accounts`; leave shadow true and every live
   switch false.
3. Compare included shadow requests against fallback for cache lookup/write,
   prompt, route, calls, billing, answer and SSE. Confirm excluded requests do
   not plan. Review only content-free `shadow` and `fallback` report groups.
4. Enable reporting for a bounded review if approved; reporting never changes
   a decision.
5. After explicit live approval, set shadow false and hybrid true for the same
   internal cohort. Confirm `live` reporting and global-cache suppression.
6. Gate dense retrieval, knowledge, repository chat and Answer Guard
   independently. Percentage and `all_eligible` follow only after their
   feature-specific acceptance gates pass.

To stop one rollout, set its mode to `disabled` and restart the API. To apply
the hard kill switch, also turn off its existing global Phase 0–5 flag. The
Knowledge Library cancellation button calls the existing owner-scoped cancel
endpoint for pending/indexing documents; the UI displays status only and never
an internal job ID.

## Phase 6B reporting operations

The optional `web_rollout_report` startup service reports `disabled` as a
healthy state. Configuration bounds are:

- default window: `1..168` hours;
- maximum window: `1..720` hours;
- minimum acceptance sample: `1..10000`.

The default window must not exceed the maximum. Invalid configuration reports
variable names only. The admin endpoint returns `Cache-Control: no-store` and
requires a verified Firebase email, exact owned-email match and membership in
`ADMIN_EMAILS`. Unverified, mismatched and ordinary accounts receive the same
non-disclosing denial.

For Render Shell:

```text
cd backend
python scripts/triag_rollout_report.py --window-hours 24 --pretty
```

The endpoint and CLI call the same aggregator. Groups include the bounded
`fallback`/`shadow`/`live` execution enum and controlled/general-availability
release state, and otherwise contain bounded timestamps, enums, counts, rates,
token/cost totals and latency percentiles.
It contains no request/user identifiers, emails, content, filenames, source
excerpts, commands, provider/model names or raw failure details. The billing
gate flags unsettled final reservations, non-exempt debit/cost differences,
settlement exceeding reservation, and disagreement between recorded paid
stages and the authoritative parent cost.

Acceptance thresholds are deterministic: errors warn above 2% and fail above
5%; P95 latency warns above 8 seconds and fails above 15 seconds; poor
retrieval warns above 10% and fails above 25%; unverified/insufficient answers
warn above 5% and fail above 15%. Privacy, owner-isolation and settlement
mismatches fail immediately. Missing bounded samples report
`insufficient_sample`. Operators must still review the report and change
Render settings manually; reporting never activates or disables a cohort.

## Direct production general-availability operations

Do not use a percentage step for this release. In `controlled`, every live
rollout decision continues to suppress global answer-cache lookup and write.
In `general_availability`, only that blanket suppression is removed and the
existing deterministic policy resumes: public standalone answers may become
candidates and only the existing candidate-to-approved promotion process can
make them globally readable.

The final cache admission remains fail closed. It rejects turns using memory,
profile, temporary documents, persistent knowledge, repository evidence,
private sources, continuation control or explicit memory writes. It also
rejects cancelled or truncated responses, insufficient or unverified answers,
failed repairs and invalid citations. General availability does not bypass any
of those checks.

The production validator is already deployed as a same-region Render Private
Service. Do not create another service. Its reviewed commands remain:

```text
Build: python -m pip install --upgrade pip && pip install -r backend/requirements.txt
Start: uvicorn app.code_validator.main:app --app-dir backend --host 0.0.0.0 --port 10001
```

Its minimum environment is a generated `CODE_VALIDATOR_AUTH_TOKEN`,
`CODE_VALIDATOR_ISOLATION_PROOF=static-only`,
`CODE_VALIDATOR_NETWORK_ISOLATED=false`,
`CODE_VALIDATOR_TIMEOUT_SECONDS=90`, and
`CODE_VALIDATOR_MAX_OUTPUT_BYTES=65536`. The API uses the linked token,
`WEB_CODE_VALIDATOR_URL=http://<private-service-name>:10001`, and timeout `90`.
No database, Firebase, provider, payment, SMTP, Valkey or download secret
belongs on the validator. Static-only is a truthful limitation: executable
validation remains disabled until every isolation proof is positively met.

The production knowledge worker is likewise already deployed. Do not create
another worker. Its reviewed commands remain:

```text
Build: python -m pip install --upgrade pip && pip install -r backend/requirements.txt
Start: cd backend && python -m app.knowledge_worker
```

Its only secrets are the private production `DATABASE_URL` and provider key.
Copy only the bounded knowledge worker, embedding model/dimensions, provider
budget, embedding price, FX, markup and reservation settings from the reviewed
staging worker. Never add Firebase, Razorpay, SMTP, download-token, validator
or Valkey secrets. The current GA worker and API both keep
`WEB_KNOWLEDGE_WORKER_ENABLED=true` so only the dedicated worker claims these
jobs. Do not toggle one without the other.

Run after the single-head migration and before declaring production ready:

```text
cd backend
python scripts/triag_release_check.py --pretty
python scripts/triag_rollout_report.py --window-hours 24 --pretty
```

The release check emits only bounded configuration states, counts and
capabilities. It validates production configuration, TRIAG/release/rollout
state, report configuration, one matching Alembic head/current, database and
required tables, validator isolation, and knowledge-job counts. A non-zero exit
is a release blocker. Do not paste raw database, validator or provider errors
into release artifacts.

For the current deployed GA runtime, validate the existing services and keep
worker ownership enabled. Every `all_eligible` rollout must have percent `0`;
the release check returns a bounded `reason_code` on rollout failure. Run both
commands and verify `/api/web/health`, cache
candidate promotion, exact settlement, cancellation and SSE. Roll back in this
order: set all rollout modes `disabled`, set
`WEB_TRIAG_RELEASE_STATE=controlled`, set `WEB_TRIAG_ENABLED=false`, disable
worker ownership and all knowledge/repository/Answer Guard/dense derived flags,
then stop the worker. Do not downgrade the database.

## Production TRIAG acceptance

`POST /api/web/admin/triag-request-audit` is the only per-request acceptance
endpoint. It accepts one to twelve unique request UUIDs and requires the
existing verified-admin authorization: verified Firebase email, exact match to
the owned database email, and membership in `ADMIN_EMAILS`. Unknown IDs and
unauthorized users receive the same 404 response. Results contain only bounded
counts, status enums, micro-INR totals, source-kind counts, settlement and
cancellation indicators. They never include identities, provider/model names,
prompts, messages, answers, filenames, locators, source text, code, metadata,
exceptions, or secrets.

Use one dedicated production acceptance account. Its Firebase email/password
account must be email-verified; its token email must exactly match its owned
database user; and the same normalized email must be listed in both
`ADMIN_EMAILS` and `SWICO_INTERNAL_TEST_EMAILS`. Do not use a personal or
customer account. The internal allowlist makes Chat billing-exempt while still
recording provider cost, and the admin allowlist grants only the content-free
audit. The account must have Swico Pro available and all four GA features. Do
not run other tests or manual chats on it concurrently.

Before starting the GitHub workflow, open the standalone production website in
a new Incognito/private window and manually sign in with the dedicated account.
Confirm that the workspace opens and the message composer is available, then
sign out and close the private window. Do not paste browser errors, credentials,
tokens, bootstrap bodies, or URLs into an issue or workflow artifact. This
manual check catches Firebase credential, email-verification, and deployed
login problems before enabling the writable run.

In GitHub create an Environment named `production-triag`, add any required
reviewers, and configure exactly these Environment secrets:

```text
PLAYWRIGHT_BASE_URL=https://<standalone-web-origin>
E2E_TEST_EMAIL=<dedicated-account-email>
E2E_TEST_PASSWORD=<dedicated-account-password>
```

Do not configure a Render API key. To run the suite, open **Actions → Deployed
web smoke → Run workflow**, choose `production-triag`, enter exactly
`I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION` in the confirmation input, and run the
workflow. This mode is manual only, Chromium desktop only, uses one worker, and
is protected by the production-specific concurrency lock. It never runs on a
push or pull request.

The six scenarios create temporary chats, one PDF upload, one approved
Knowledge Library document, and one repository snapshot. Cleanup restores the
previous Swico tier only when the suite actually changed it and deletes only
generated IDs recorded after the initial account snapshot. Thread discovery
and verification run only after a scenario could create a thread. The suite
never deletes pre-existing resources or changes historical billing records.
Cleanup is `not_required` when authentication or initial snapshots fail before
mutation, `complete` when all applicable cleanup passes, and `incomplete` only
when a bounded cleanup reason is recorded. Logout failure is reported
separately and never replaces the primary setup/scenario failure.

The production test has a 20-minute Playwright timeout; the production GitHub
command repeats that explicit timeout while the job remains bounded at 30
minutes. Staging and production-readonly timeouts are unchanged. Screenshots
mask messages, answers, filenames, account UI and thread titles. The uploaded
schema-versioned JSON summary and redacted failure trace contain only bounded
preflight/scenario/cleanup enums and request UUIDs; retention is seven days.

Safe preflight reason codes are:

```text
login_form_unavailable
firebase_login_rejected
bootstrap_not_observed
bootstrap_http_401
bootstrap_http_403
bootstrap_http_5xx
authenticated_request_header_missing
workspace_shell_not_ready
workspace_capability_missing
attachments_capability_missing
knowledge_library_capability_missing
repository_upload_capability_missing
repository_chat_capability_missing
validator_capability_missing
assistant_tier_missing
internal_account_required
admin_audit_access_denied
preflight_passed
```

The preflight waits at most 90 seconds and treats the visible, enabled
`Message Swico` textbox inside the visible composer as the stable authenticated
workspace marker. It does not depend on the conditional Send or Voice Mode
button and does not type or mutate data. It then requires each scenario
capability, `wallet.billing_exempt=true`, and sends a fixed unknown request UUID
to the content-free admin audit. Its expected privacy-safe 404 proves that the admin
check was reached; 401/403 and all other statuses fail with
`admin_audit_access_denied`. No chat, upload, repository, or Knowledge Library
item is created until `preflight_passed`. Scenario failure codes are
`deterministic_greeting_failed`, `supported_pdf_failed`,
`unsupported_pdf_failed`, `knowledge_library_failed`,
`repository_pro_failed`, and `cancellation_settlement_failed`. Cleanup reason
codes are `thread_discovery_failed`, `thread_delete_failed`,
`thread_verification_failed`, `knowledge_delete_failed`,
`repository_delete_failed`, `upload_delete_failed`, `tier_restore_failed`, and
`logout_failed`. Snapshot setup failures are `thread_snapshot_failed` and
`knowledge_snapshot_failed`. Raw exception text is never written to the
production-safe summary.

After an authentication failure, correct the dedicated Firebase credential or
verification state, confirm that its normalized email still appears in both
`ADMIN_EMAILS` and `SWICO_INTERNAL_TEST_EMAILS`, repeat the Incognito sign-in
check, sign out, and manually rerun the same `production-triag` workflow with
the exact write confirmation. Do not reuse a failed job or bypass preflight.
This harness fix requires no Render service, Render configuration, database
migration, or public API change.

The existing validator currently reports `static_only` with
`executable_checks=false`. That is healthy for this suite. Repository results
may be `grounded` or `unverified`; they must never be labeled
executable-verified or repository-verified.

After the workflow, copy request IDs from the **Render log request IDs** section
of the GitHub job summary. Open the existing production API service in Render,
choose **Logs**, and search each exact UUID. Use those IDs to correlate safe
terminal, cancellation, retrieval, and settlement events. Do not paste
messages, uploaded content, credentials, or raw database rows into the search
or into GitHub artifacts.
