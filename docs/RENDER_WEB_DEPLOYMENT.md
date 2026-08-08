# Render deployment for the standalone web app

Do not create a Blueprint for the existing production resources. They were created manually; update them in the Render dashboard.

## New isolated staging project — beginner setup

`render.staging.yaml` is only for six new resources:
`swico-api-staging`, `swico-web-staging`, `swico-postgres-staging`,
`swico-upload-cache-staging`, `swico-code-validator-staging`, and
`swico-knowledge-worker-staging`. It puts the API, worker, and database in the
same region, wires each `DATABASE_URL` only through the staging `fromDatabase`
reference, and defines no environment group. Never attach a production
environment group or copy a production credential.

1. In Render, create or select a project named **Swico Staging** and an
   environment named **Staging**. Do not place existing production resources in
   it.
2. Open **Blueprints → New Blueprint Instance**, connect this repository and
   branch, select **Use a custom Blueprint path**, and enter
   `render.staging.yaml`. Review that the plan contains only the six staging
   resource names before applying it.
3. In the initial Blueprint form, provide every `sync:false` value. On the API,
   set `CORS_ALLOW_ORIGINS` to the exact staging web HTTPS origin; provide a
   staging OpenAI key, matching Razorpay Test Mode key ID/secret/webhook secret,
   and optional staging Sentry DSN. Never enter a Live key or production value.
4. On the static site, provide `VITE_API_BASE_URL` with the staging API HTTPS
   origin and all five Firebase Web app values:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, and
   `VITE_FIREBASE_MESSAGING_SENDER_ID`. These are public build values, not Admin
   credentials. Rebuild after any change.
5. In `swico-api-staging` open **Environment → Secret Files**, upload the
   staging Firebase Admin service-account JSON with the exact filename
   `firebase-admin-staging.json`. The Blueprint already sets
   `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin-staging.json`.
   Do not add `FIREBASE_CREDENTIALS_JSON` or reuse the production file.
6. In Firebase Authentication open **Settings → Authorized domains** and add
   the staging static-site hostname without scheme or path. If the browser key
   is website-restricted, allow both the staging origin and its `/*` form.
7. In the staging Firebase project create one dedicated email/password account
   used only by deployed staging E2E. Store its credentials only in the GitHub
   staging Environment described below.
8. Keep `BILLING_CHECKOUT_ENABLED=false` initially. After a second operator
   verifies `RAZORPAY_MODE=test`, matching `rzp_test_` credentials, webhook,
   staging domain, and visible **Test Mode** badge, temporarily enable checkout
   in staging and fund the dedicated account with one supervised Razorpay Test
   Mode transaction. Disable checkout again unless a specifically approved
   staging exercise needs it. Another staging-only funding mechanism requires
   explicit operational approval. Never automate payment in Playwright.
9. Confirm `GET /api/web/health` returns success. This endpoint performs a
   database query, so the Render health check also proves the isolated staging
   database is reachable.
10. Open `swico-upload-cache-staging` and confirm region **Singapore**,
    Persistence **Off**, eviction policy **allkeys-lru**, and no public IP allow
    list. Confirm `swico-api-staging` receives its internal connection string as
    `WEB_UPLOAD_CACHE_URL`; never copy it into the static site.
11. Open `swico-knowledge-worker-staging` and confirm region **Singapore**,
    start command `cd backend && python -m app.knowledge_worker`, and
    `WEB_KNOWLEDGE_WORKER_ENABLED=false`. Its only secret/provider connections
    are its staging `DATABASE_URL` and staging `OPENAI_API_KEY`. Confirm it has
    no Firebase Admin file or credential, Razorpay/webhook, SMTP,
    download-token, validator token/URL, Valkey, or production environment
    group.

The file has been checked by repository tests and parsed as YAML. A Render CLI
or API validation must be run by the operator when authenticated tooling is
available; a repository YAML parse is not a claim that Render accepted or
created the Blueprint.

## Existing API service — exact settings

- Root Directory: **blank**
- Build Command:
  `python -m pip install --upgrade pip && pip install -r backend/requirements.txt`
- Pre-deploy Command:
  `cd backend && python -m alembic -c alembic.ini upgrade head`
- Start Command:
  `python backend/start_render.py`
- Health Check Path: `/health`
- Instance: paid, always running
- Region: the same region as PostgreSQL

The root must remain blank. `backend/config.py` and `backend/app/agentic_service.py` still have repository-root runtime reads involving `mobile/data/`.

Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, `LOG_CHAT_CONTENT=false`, `AUTH_ALLOW_DEV_TOKENS=false`, `AUTO_CREATE_TABLES=false`, `RUN_MIGRATIONS_ON_STARTUP=false`, `REQUIRE_MIGRATIONS_BEFORE_STARTUP=false`, `BILLING_CHECKOUT_ENABLED=false`, and `CORS_ALLOW_ORIGINS=https://<web-domain>`. Production requires the checkout switch to be explicit. The pre-deploy command is the only production migration owner. Keep the existing database, Firebase Admin, provider, email, and operational variables. Add all billing and Swico tier variables documented in `backend/.env.example`, including Razorpay key ID/secret/webhook secret, limits/packages, credit/reserve/markup configuration, provider pricing, FX rate/buffer, and webhook size. Secrets must be Render secret environment variables.

Exact environment delta for this release:

Production should initially enable adaptive same-thread continuity with
`WEB_SAME_THREAD_CONTEXT_MODE=adaptive`, the optimizer enabled, the two-turn /
900-character bounds, one provider call and one provider attempt, and prompt
token breakdown telemetry as shown below.

The Web Turn Optimizer values below belong directly on the existing **ai_tool**
API service. Do not add them to a shared environment group, the static site,
`swico-web`, `web/.env.example`, any `VITE_*` variable, the PostgreSQL service,
the Valkey service, or billing cron jobs. Phase 4 initially adds only the
staging private validator declared in `render.staging.yaml`; the direct-GA
procedure below is the authorization path for a production private validator.
Phase 6A adds no Render resource and no `VITE_*` value. Add its nine
backend-only rollout variables directly to the API service. Keep every mode
`disabled` and every percentage `0` until a separately approved staged gate.
Phase 6B likewise adds no resource or public variable. Add its four
backend-only reporting variables with reporting disabled; enable it only for a
bounded staging admin/Render Shell acceptance review.

Do not activate live TRIAG during the initial Phase 6 staging deploy. Apply the
backend-only environment changes to the existing API service in this order:

1. Deploy the safe block below unchanged: TRIAG false, shadow true, every
   rollout disabled/zero, reporting false and every live feature false.
2. For an approved internal shadow observation, configure verified owned
   `SWICO_INTERNAL_TEST_EMAILS`, then set `WEB_TRIAG_ENABLED=true` and
   `WEB_ROLLOUT_TRIAG_MODE=internal_accounts` only. Keep shadow true,
   TRIAG percent zero, other modes disabled, and hybrid/dense/knowledge/
   repository/Answer Guard switches false.
3. Verify included `shadow` and excluded `fallback` report groups and prove
   cache, serialized prompt, provider route/calls, billing, answer, SSE and the
   static frontend are unchanged. Optionally enable the report flag for this
   bounded review; it is not an activation flag.
4. Only after explicit approval, set `WEB_TRIAG_SHADOW_MODE=false` and
   `WEB_RAG_HYBRID_ENABLED=true` for the same internal cohort. This is the first
   live stage and must show `rollout_execution=live` plus global-cache
   suppression before any additional feature is enabled.
5. Gate dense retrieval, persistent knowledge, repository chat and Answer
   Guard separately. Do not move to percentage or `all_eligible` until the
   corresponding report and rollback gates pass.

Rollback the cohort first with `WEB_ROLLOUT_TRIAG_MODE=disabled`; use
`WEB_TRIAG_ENABLED=false` as the hard kill. No Render service, migration,
static-site variable, provider call, frontend feature or route change belongs
to this sequence.

For every rollout feature, `disabled`, `internal_accounts`, and `all_eligible`
require the matching percentage to be `0`. Only `percentage` mode accepts a
non-zero percentage. Invalid combinations fail production configuration by
environment-variable name only; no configured value is emitted.

## Direct production all-eligible general availability

Production is already at all-eligible general availability. Do not create
another percentage stage, validator, worker, web service, or staged rollout.
The existing same-region validator and knowledge worker remain the only
production resources for this path.

The existing validator **Private Service** uses:

```text
Build Command: python -m pip install --upgrade pip && pip install -r backend/requirements.txt
Start Command: uvicorn app.code_validator.main:app --app-dir backend --host 0.0.0.0 --port 10001
```

Give it only a generated `CODE_VALIDATOR_AUTH_TOKEN` plus:

```dotenv
CODE_VALIDATOR_ISOLATION_PROOF=static-only
CODE_VALIDATOR_NETWORK_ISOLATED=false
CODE_VALIDATOR_TIMEOUT_SECONDS=90
CODE_VALIDATOR_MAX_OUTPUT_BYTES=65536
```

On the API, link that generated token as
`WEB_CODE_VALIDATOR_AUTH_TOKEN`, set
`WEB_CODE_VALIDATOR_URL=http://<production-private-validator-name>:10001`, and
set `WEB_CODE_VALIDATOR_TIMEOUT_SECONDS=90`. Do not attach database, Firebase,
provider, Razorpay, SMTP, Valkey or download-token secrets. With the values
above the capability is intentionally `static_only`; it cannot claim executable
verification.

The existing **Background Worker** uses:

```text
Build Command: python -m pip install --upgrade pip && pip install -r backend/requirements.txt
Start Command: cd backend && python -m app.knowledge_worker
```

Its only secrets are the production database's private `DATABASE_URL` and the
provider key. Copy the non-secret worker, embedding, provider-budget, embedding
price, FX, markup and reservation bounds from the reviewed staging worker.
Never give it Firebase, Razorpay, SMTP, download-token, validator-token, Valkey
or public-site variables. The current GA worker and API both keep
`WEB_KNOWLEDGE_WORKER_ENABLED=true`; do not change only one side.

The database is already at Alembic head/current `7b4c9e1a2d6f`. No migration is
required for the acceptance endpoint. Keep the deployed GA settings below and
correct any non-zero rollout percentages to `0` in one reviewed update to the
existing API service:

```dotenv
WEB_TRIAG_ENABLED=true
WEB_TRIAG_SHADOW_MODE=false
WEB_TRIAG_RELEASE_STATE=general_availability
WEB_RAG_HYBRID_ENABLED=true
WEB_ROLLOUT_TRIAG_MODE=all_eligible
WEB_ROLLOUT_TRIAG_PERCENT=0
WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=true
WEB_ROLLOUT_KNOWLEDGE_MODE=all_eligible
WEB_ROLLOUT_KNOWLEDGE_PERCENT=0
WEB_REPOSITORY_UPLOAD_ENABLED=true
WEB_RAG_REPOSITORY_INDEX_ENABLED=true
WEB_ROLLOUT_REPOSITORY_MODE=all_eligible
WEB_ROLLOUT_REPOSITORY_PERCENT=0
WEB_ANSWER_GUARD_ENABLED=true
WEB_VERIFIED_STREAMING_ENABLED=true
WEB_ROLLOUT_ANSWER_GUARD_MODE=all_eligible
WEB_ROLLOUT_ANSWER_GUARD_PERCENT=0
WEB_TRIAG_ROLLOUT_REPORT_ENABLED=true
WEB_KNOWLEDGE_WORKER_ENABLED=true
```

Keep all four percentages `0`. Any optional global feature left false must keep
its rollout mode `disabled`; do not use `internal_accounts` or `percentage` in
the direct-GA configuration. Keep the worker flag enabled on the worker and API
together so only the dedicated worker claims knowledge jobs.

From the deployed Render Shell, run exactly:

```text
cd backend
python scripts/triag_release_check.py --pretty
python scripts/triag_rollout_report.py --window-hours 24 --pretty
```

Do not release if the first command exits non-zero. Then verify health,
authenticated bootstrap, public cache candidate-to-approved promotion, private
cache exclusion, exact settlement, cancellation, edit/regenerate/continue,
temporary TTL and SSE.

### Manual production TRIAG acceptance workflow

The dedicated account must be an email-verified Firebase email/password
account whose token email exactly matches the owned database email. Add it to
both backend-only `ADMIN_EMAILS` and `SWICO_INTERNAL_TEST_EMAILS`. Reserve this
account for the suite, enable Swico Pro for it, and do not use it concurrently.
Internal status prevents wallet debit; admin status grants the verified-admin
content-free request audit. Neither status may be supplied by the browser.

Immediately before a production-TRIAG run, open the standalone production web
origin in a new Incognito/private window, manually sign in as the dedicated
account, verify that the workspace and message composer open, sign out, and
close the window. Keep credentials, browser errors, authorization values,
bootstrap bodies, and complete URLs out of GitHub and Render artifacts.

Create the GitHub Environment `production-triag`, optionally protect it with
required reviewers, and add these Environment secrets:

```text
PLAYWRIGHT_BASE_URL=https://<standalone-web-origin>
E2E_TEST_EMAIL=<dedicated-account-email>
E2E_TEST_PASSWORD=<dedicated-account-password>
```

No Render API key is needed or permitted. Open **GitHub Actions → Deployed web
smoke → Run workflow**, choose `production-triag`, and enter the exact input
`I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION`. The job runs only Chromium desktop,
with one worker and the `production-triag-acceptance` concurrency lock. The
workflow has no push or pull-request trigger.

The suite masks sensitive UI in its named screenshots and uploads only those
screenshots, a content-free JSON summary, and a redacted failure trace. These
schema-v2 artifacts contain request UUIDs and bounded preflight,
scenario, and cleanup states, never
credentials, authorization headers, messages, answers, document text,
filenames, provider/model names, or wallet identifiers. Retention is seven
days. Native Playwright traces are intentionally disabled for this writable
mode because they capture bearer headers and DOM/network content.

The production Playwright test and production-only command are each bounded at
20 minutes; the GitHub job remains bounded at 30 minutes. Staging and
production-readonly retain their existing timeouts. Before mutation, a
90-second preflight reports one of `login_form_unavailable`,
`firebase_login_rejected`, `bootstrap_not_observed`, `bootstrap_http_401`,
`bootstrap_http_403`, `bootstrap_http_5xx`,
`authenticated_request_header_missing`, `workspace_shell_not_ready`,
`workspace_capability_missing`, `attachments_capability_missing`,
`knowledge_library_capability_missing`, `repository_upload_capability_missing`,
`repository_chat_capability_missing`, `validator_capability_missing`,
`assistant_tier_missing`, `internal_account_required`,
`admin_audit_access_denied`, or
`preflight_passed`. It requires a visible workspace,
using the visible, enabled `Message Swico` textbox and visible composer rather
than the conditional Send/Voice action. The check enters no text and makes no
mutation. It then requires `wallet.billing_exempt=true` and the expected
privacy-safe 404 from the admin audit for a fixed unknown UUID. A 401/403 is
denied. No production resource is created before this passes.

Cleanup runs after preserving the primary bounded failure. It restores the
account's original Swico tier only when the tier changed and deletes only
recorded generated thread, Knowledge, repository, and upload IDs. It never
deletes or modifies pre-existing resources, `UsageCharge`, wallet-ledger, or
other historical billing records. Cleanup is `not_required` when preflight or
initial snapshots fail before mutation, `complete` when every applicable action
passes, and `incomplete` with bounded reason codes on a real cleanup failure.
Logout failure is separate and cannot hide the primary failure. The GitHub job
summary displays the safe preflight reason, cleanup state/reasons, and scenario
request IDs.

The validator's current `static_only` capability with
`executable_checks=false` is expected. The repository scenario must not report
executable or repository verification; grounded or unverified is acceptable.

The GitHub job summary prints request IDs under **Render log request IDs**. In
the existing production API service, open **Logs** and search one exact UUID at
a time to correlate safe stream-terminal, retrieval, cancellation and billing
events. Never search for or copy the test prompts, answers, uploaded content,
account credentials, or authorization header.

If authentication fails, correct the dedicated Firebase credential or
email-verification state, verify that the same normalized email remains in both
`ADMIN_EMAILS` and `SWICO_INTERNAL_TEST_EMAILS`, repeat the Incognito check,
sign out, then manually rerun `production-triag` with
`I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION`. Do not bypass preflight.

No Render service, environment-variable, rollout, migration, or public API
change is required for this acceptance-harness fix. The existing
`ADMIN_EMAILS`, `SWICO_INTERNAL_TEST_EMAILS`, GA rollout, worker, database, and
validator prerequisites remain unchanged; no Render API key or additional
service is needed.

Rollback values are:

```dotenv
WEB_TRIAG_RELEASE_STATE=controlled
WEB_ROLLOUT_TRIAG_MODE=disabled
WEB_ROLLOUT_KNOWLEDGE_MODE=disabled
WEB_ROLLOUT_REPOSITORY_MODE=disabled
WEB_ROLLOUT_ANSWER_GUARD_MODE=disabled
WEB_TRIAG_ENABLED=false
WEB_KNOWLEDGE_WORKER_ENABLED=false
WEB_RAG_HYBRID_ENABLED=false
WEB_RAG_DENSE_ENABLED=false
WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=false
WEB_RAG_TRIPLET_ENABLED=false
WEB_RAG_HIERARCHY_ENABLED=false
WEB_REPOSITORY_UPLOAD_ENABLED=false
WEB_RAG_REPOSITORY_INDEX_ENABLED=false
WEB_PRO_CODE_VALIDATION_ENABLED=false
WEB_ANSWER_GUARD_ENABLED=false
WEB_VERIFIED_STREAMING_ENABLED=false
WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED=false
WEB_ANSWER_GUARD_REPAIR_ENABLED=false
```

Apply the API rollback before stopping the worker. Keep the additive database
head and private validator; do not downgrade the database or expose either
private service publicly.
The dedicated knowledge-indexing patch initially adds only the private staging
worker declared in `render.staging.yaml`. Keep production API and worker flags
false until the staging billing, claim-isolation, cancellation, and restart
gates pass; the direct-GA procedure below then covers the separately created
production worker. Neither service adds a public variable.
The single Alembic head `7b4c9e1a2d6f` (which descends from
`d6f1a8c3e9b4`, `b4e8c1d6a2f9` and includes revisions `3a7d9c2e5f10` and
`f9c2d7a4e1b6`) must run before deploying this release.
The historical `f9c2d7a4e1b6` requirement still applies before enabling message editing or
cross-thread memory:

```text
WEB_TURN_OPTIMIZER_ENABLED=true
WEB_TRIAG_ENABLED=false
WEB_TRIAG_SHADOW_MODE=true
WEB_TRIAG_POLICY_VERSION=v1
WEB_TRIAG_RELEASE_STATE=controlled
WEB_ROLLOUT_POLICY_VERSION=v1
WEB_ROLLOUT_TRIAG_MODE=disabled
WEB_ROLLOUT_TRIAG_PERCENT=0
WEB_ROLLOUT_KNOWLEDGE_MODE=disabled
WEB_ROLLOUT_KNOWLEDGE_PERCENT=0
WEB_ROLLOUT_REPOSITORY_MODE=disabled
WEB_ROLLOUT_REPOSITORY_PERCENT=0
WEB_ROLLOUT_ANSWER_GUARD_MODE=disabled
WEB_ROLLOUT_ANSWER_GUARD_PERCENT=0
WEB_TRIAG_ROLLOUT_REPORT_ENABLED=false
WEB_TRIAG_ROLLOUT_REPORT_DEFAULT_WINDOW_HOURS=24
WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS=168
WEB_TRIAG_ROLLOUT_ACCEPTANCE_MIN_SAMPLE=20
WEB_RAG_HYBRID_ENABLED=false
WEB_RAG_DENSE_ENABLED=false
WEB_RAG_RETRIEVAL_EVALUATOR_ENABLED=false
WEB_RAG_MAX_CORRECTIVE_ROUNDS=1
WEB_RAG_QUERY_EMBEDDING_CACHE_TTL_SECONDS=86400
WEB_RAG_EMBEDDING_MODEL=text-embedding-3-small
WEB_RAG_EMBEDDING_DIMENSIONS=1536
WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=false
WEB_RAG_TRIPLET_ENABLED=false
WEB_RAG_HIERARCHY_ENABLED=false
WEB_KNOWLEDGE_JOB_BATCH_SIZE=50
WEB_KNOWLEDGE_WORKER_ENABLED=false
WEB_KNOWLEDGE_WORKER_POLL_SECONDS=2
WEB_KNOWLEDGE_WORKER_MAX_CONCURRENCY=1
WEB_RAG_LITE_CANDIDATE_LIMIT=12
WEB_RAG_LITE_EVIDENCE_ITEM_LIMIT=4
WEB_RAG_LITE_EVIDENCE_TOKEN_CAP=1200
WEB_RAG_STANDARD_CANDIDATE_LIMIT=30
WEB_RAG_STANDARD_EVIDENCE_ITEM_LIMIT=7
WEB_RAG_STANDARD_EVIDENCE_TOKEN_CAP=3200
WEB_RAG_PRO_CANDIDATE_LIMIT=60
WEB_RAG_PRO_EVIDENCE_ITEM_LIMIT=12
WEB_RAG_PRO_EVIDENCE_TOKEN_CAP=6000
WEB_ANSWER_GUARD_ENABLED=false
WEB_VERIFIED_STREAMING_ENABLED=false
WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED=false
WEB_ANSWER_GUARD_REPAIR_ENABLED=false
WEB_ANSWER_GUARD_MAX_BUFFER_CHARACTERS=200000
WEB_REPOSITORY_UPLOAD_ENABLED=false
WEB_REPOSITORY_TTL_SECONDS=3600
WEB_REPOSITORY_MAX_ARCHIVE_BYTES=26214400
WEB_REPOSITORY_MAX_UNCOMPRESSED_BYTES=104857600
WEB_REPOSITORY_MAX_FILES=5000
WEB_REPOSITORY_MAX_COMPRESSION_RATIO=100
WEB_REPOSITORY_RATE_LIMIT_PER_MINUTE=3
WEB_RAG_REPOSITORY_INDEX_ENABLED=false
WEB_PRO_CODE_VALIDATION_ENABLED=false
WEB_CODE_VALIDATOR_URL=
WEB_CODE_VALIDATOR_TIMEOUT_SECONDS=90
WEB_SAME_THREAD_CONTEXT_MODE=adaptive
WEB_SWICO_BRAND_GUARD_ENABLED=true
WEB_CONTEXT_MAX_TURNS=2
WEB_CONTEXT_MAX_CHARS=900
WEB_PROFILE_PROMPT_MAX_CHARS=500
WEB_ATTACHMENT_PROMPT_MAX_CHARS=6000
WEB_SIMPLE_MAX_OUTPUT_TOKENS=220
WEB_NORMAL_MAX_OUTPUT_TOKENS=420
WEB_DETAILED_MAX_OUTPUT_TOKENS=1800
WEB_LONG_FORM_MAX_OUTPUT_TOKENS=6000
OPENAI_MAX_OUTPUT_TOKENS_HARD=6000
OPENAI_REASONING_EFFORT_SIMPLE=none
OPENAI_REASONING_EFFORT_NORMAL=low
OPENAI_REASONING_EFFORT_DETAILED=low
OPENAI_REASONING_EFFORT_LONG_FORM=low
WEB_PROVIDER_CALLS_PER_TURN_MAX=1
WEB_PROMPT_TOKEN_BREAKDOWN_ENABLED=true
WEB_CACHE_BEFORE_BILLING_ENABLED=true
WEB_PROMPT_CACHE_ENABLED=false
WEB_PROMPT_CACHE_VERSION=v1
WEB_MAX_PROVIDER_ATTEMPTS=1
WEB_MESSAGE_EDIT_ENABLED=false
WEB_CROSS_THREAD_MEMORY_ENABLED=false
WEB_MEMORY_MAX_ITEMS=2
WEB_MEMORY_MAX_CHARS=1200
WEB_MEMORY_LLM_SUMMARIZATION_ENABLED=false
WEB_LONG_INPUT_ENABLED=false
WEB_LONG_INPUT_INLINE_THRESHOLD_CHARS=12000
WEB_LONG_INPUT_MAX_CHARS=64000
WEB_DOCUMENT_OCR_ENABLED=false
WEB_LEGACY_DOC_CONVERSION_ENABLED=false
```

Keep prompt caching disabled by default while rollout billing telemetry is
reviewed. The guarded implementation uses a PII-free stable cache key and
accounts for both cache-read and cache-write tokens.

Add the intelligence variables below directly to the existing `ai_tool` Render
service, not the shared environment group, static site, PostgreSQL, Valkey, or
billing cron services. Do not expose them as `VITE_*` variables.

```dotenv
GLOBAL_QA_SEMANTIC_ENABLED=false
GLOBAL_QA_EMBEDDING_BACKFILL_BATCH_SIZE=50
GLOBAL_QA_CONFIDENCE_FLOOR=0.35
GLOBAL_QA_CONFIDENCE_MAX=1.0
WEB_MEMORY_FACT_RANKING_ENABLED=false
WEB_MEMORY_FACT_MIN_SIMILARITY=0.35
WEB_MEMORY_MAX_ITEMS=2
WEB_DETERMINISTIC_TOOLS_ENABLED=false
WEB_MODEL_LADDER_DOWNGRADE_ENABLED=false
WEB_DETAILED_MIN_TIER=standard
WEB_POST_TURN_DISTILLATION_ENABLED=false
WEB_PROMPT_PREFIX_STABLE_ENABLED=false
WEB_PROMPT_CACHE_ENABLED=false
WEB_PROMPT_CACHE_VERSION=v1
WEB_MAX_PROMPT_TOKENS=6000
WEB_CONTEXT_RELEVANCE_RANKING_ENABLED=false
WEB_CONTEXT_CANDIDATE_TURNS=80
WEB_MEMORY_LLM_SUMMARIZATION_ENABLED=false
```
The normal continuity rollback is configuration-only: set
`WEB_SAME_THREAD_CONTEXT_MODE=explicit_only` and redeploy the API. Do not disable
the entire optimizer as the normal rollback.
The narrower Swico Brand Guard rollback is
`WEB_SWICO_BRAND_GUARD_ENABLED=false`; it restores the previous provider path
for public product questions while retaining the vendor-neutral public prompt.

For the temporary production intelligence rollback, set exactly these values
directly on the existing `ai_tool` service:

```dotenv
AI_ROUTER_GLOBAL_CACHE_RECORD_ENABLED=false
GLOBAL_QA_SEMANTIC_ENABLED=false
WEB_POST_TURN_DISTILLATION_ENABLED=false
WEB_CROSS_THREAD_MEMORY_ENABLED=false
WEB_MEMORY_FACT_RANKING_ENABLED=false
WEB_MESSAGE_EDIT_ENABLED=false
```

Do not put these flags on `swico-web`, in `VITE_*` variables, in the
`swico-backend-production` environment group, or on PostgreSQL, Valkey, or
Razorpay cron jobs. Re-enable in this order: (1) message editing/regeneration,
(2) memory ranking and distillation, then (3) semantic cache and global cache
recording. Verify each stage before enabling the next. Keep
`WEB_MEMORY_MAX_ITEMS=2`, `WEB_MEMORY_LLM_SUMMARIZATION_ENABLED=false`, and
`WEB_PROMPT_CACHE_ENABLED=false`.

After the migration and staging verification, enable high-impact features one
at a time on the API service only: `WEB_MESSAGE_EDIT_ENABLED=true`, then
`WEB_CROSS_THREAD_MEMORY_ENABLED=true` (users still opt in individually), then
`WEB_LONG_INPUT_ENABLED=true`. Leave `WEB_DOCUMENT_OCR_ENABLED=false` and
`WEB_LEGACY_DOC_CONVERSION_ENABLED=false`: this release does not deploy an
isolated OCR or legacy Office converter worker. Scanned PDFs are reported as
likely scanned, and `.doc` uploads instruct the user to save as DOCX.

- Add API variable `BILLING_CHECKOUT_ENABLED=false` (backend-only, explicit in production).
- Add these backend-only variables with the shown safe defaults:

  ```dotenv
  WEB_REALTIME_VOICE_ENABLED=false
  WEB_REALTIME_VOICE_PLAYBACK_MODE=pcm_stream
  WEB_REALTIME_VOICE_BACKCHANNEL_ENABLED=false
  SARVAM_TTS_STREAM_OUTPUT_CODEC=mp3
  SARVAM_TTS_STREAM_SAMPLE_RATE=24000
  WEB_SEPARATE_VOICE_CREDITS_ENABLED=false
  WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS=60
  WEB_REALTIME_VOICE_MAX_SESSION_SECONDS=900
  WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS=60
  WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER=1
  WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE=5
  WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED=true
  WEB_REALTIME_VOICE_END_SILENCE_MS=1100
  WEB_REALTIME_VOICE_UNFINISHED_GRACE_MS=900
  WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS=2600
  WEB_REALTIME_VOICE_MIN_SPEECH_MS=250
  WEB_REALTIME_VOICE_MAX_UTTERANCE_MS=30000
  WEB_REALTIME_VOICE_BARGE_IN_MIN_MS=180
  WEB_REALTIME_VOICE_PREROLL_MS=320
  SARVAM_STT_STREAM_MESSAGE_ENCODING=audio/wav
  RAZORPAY_READ_RETRY_ATTEMPTS=3
  RAZORPAY_READ_RETRY_BASE_MS=500
  RAZORPAY_READ_RETRY_MAX_MS=4000
  RAZORPAY_HTTP_TIMEOUT_SECONDS=15
  ```

  Keep both feature flags false through migration and financial verification.
  Do not create public Vite equivalents or a Vite WebSocket URL. The browser
  derives `wss://` from an HTTPS API origin (and `ws://` from localhost), and
  the authenticated bootstrap is authoritative.
- Set API variable `BILLING_TOPUP_PACKAGES_PAISE=1000,29900`.
- Set API variable `BILLING_ENFORCE_TOPUP_PACKAGES=false`.
- Set API variable `BILLING_MIN_TOPUP_PAISE=1000`.
- Set API variable `BILLING_MAX_TOPUP_PAISE=50000`.
- Add backend-only `SWICO_DEFAULT_TIER=lite`, `SWICO_TIER_SELECTION_ENABLED=true`, and `SWICO_PRO_ENABLED=false`.
- Add backend-only `SWICO_LITE_MODEL_PRIMARY`, `SWICO_LITE_MODEL_FALLBACKS`, `SWICO_STANDARD_MODEL_PRIMARY`, `SWICO_STANDARD_MODEL_FALLBACKS`, `SWICO_PRO_MODEL_PRIMARY`, and `SWICO_PRO_MODEL_FALLBACKS`. Production validation requires explicit allowlisted values; use the reviewed production mappings and pricing overrides.
- Add `OPENAI_PRICING_AS_OF=2026-07-17` and every explicit input, cached-input, and output price variable used by the enabled Swico ladders.
- Optionally add `SWICO_INTERNAL_TEST_EMAILS=<dedicated-test-email>` only on the backend for the verified internal capability-test account. Never put its password in Git, Render logs, screenshots, or frontend variables.
- Keep Pro disabled until account access, reservation pricing, fallback, cancellation settlement, and reconciliation have passed in staging.
- Keep `BILLING_CREDIT_PERCENT=50`; do not change it.
- Add `SENTRY_DSN` only as a backend/Cron secret when an alert project is ready;
  set `SENTRY_TRACES_SAMPLE_RATE=0.05` and `SENTRY_PROFILES_SAMPLE_RATE=0`.
- Keep `RAZORPAY_MODE=test` plus matching `rzp_test_` ID/secret/webhook secret. Do not add Live credentials.
- Remove no `VITE_*` variables. Do not add model IDs, provider routing, Swico tier mappings, Razorpay secrets, or checkout flags to the static-site environment.
- Add the temporary attachment/voice variables shown in `backend/.env.example`
  directly to the API service. `WEB_UPLOAD_CACHE_URL` must be the dedicated Key
  Value internal connection string and must not reuse `REDIS_URL`.

For Firebase Admin, configure exactly one credential method. The recommended
Render setup is a secret file named `firebase-admin.json` plus
`GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin.json`. Remove
`FIREBASE_CREDENTIALS_JSON` when using that secret file. Production startup
rejects both methods together and rejects neither method; it never logs their
values or credential paths.

All four billing amounts above are integer paise: `1000` is ₹10 and `29900` is ₹299. The preset list is exactly those two values; custom whole-rupee top-ups are accepted only from the configured 1,000-paise minimum through the configured maximum. The API remains authoritative. Do not hardcode or remove the 50,000-paise maximum in the static site, and treat any future maximum change as a deliberate operator review. This release does not change Razorpay keys, mode, webhook URL, subscribed events, or webhook secrets.

For the controlled release, set `RAZORPAY_MODE=test` and prove that `RAZORPAY_KEY_ID` starts with `rzp_test_`. Do not add Live credentials yet. Production startup validates these combinations without logging values and exits before serving if they are unsafe.

Run the pre-deploy migration before enabling website traffic. The current single
head is `7b4c9e1a2d6f`. Historical revision `b4e8c1d6a2f9` adds the
content-free Phase 1 TRIAG-RAG telemetry tables; the Phase 4 head adds
temporary repository index metadata
and includes the earlier additive message revision, per-user memory,
feedback, and billing audit migrations without changing settled amounts. The earlier
bucket migration backfills every historical wallet, ledger entry, payment order,
and usage charge as Chat without changing an amount. Voice wallets are created
idempotently with zero balance; existing funds are never copied. The Alembic
pre-deploy command must succeed before the new API starts. Verify
`/api/web/health`, authenticated bootstrap/assistant/profile/usage contracts,
both wallet balances, each enabled tier's contained fallback behavior,
existing-credit chat while checkout is disabled, then Test Mode Chat and Voice
checkout, duplicate webhook replay, reconciliation, audit, and same-bucket
refunds after intentionally enabling the switch there.

This release uses the existing API service, PostgreSQL database, and private
Valkey at `WEB_UPLOAD_CACHE_URL`. Staging has one private validator and one
private knowledge worker in the same region. Neither links a production
environment group. The validator receives only its dedicated token and
non-secret limits. The knowledge worker receives only the staging database,
provider key, embedding pricing/budget settings, and knowledge-worker flags;
it receives no Firebase, Razorpay webhook, SMTP, download-token, validator, or
Valkey secret. Create production counterparts only through the direct-GA
procedure above, with the same secret isolation and port `10001`; no new
database, Valkey, Cron Job, disk, object storage, or stored-audio facility is
required. The staging Blueprint declares six resources total: API,
private Valkey, private validator, private knowledge worker, static website,
and PostgreSQL. Phase 5.1 remains API/UI only and adds no public `VITE_*`
value. Keep
`WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=false` in production until the explicit
approval, owner-marker, deletion, re-index and cancellation staging gates pass.
Keep `WEB_KNOWLEDGE_WORKER_ENABLED=false` until the production worker exists,
is healthy and is enabled together with API claim separation. Defaults remain
disabled/controlled until the direct-GA change is explicitly approved.

## Production temporary uploads and voice — exact dashboard steps

1. Reuse the existing private Key Value service used for temporary web uploads;
   this release does not require a new Render service. Keep persistence off,
   `allkeys-lru` configured, and external/public access disabled. Do not add a
   persistent disk.
2. Open that existing Key Value service's **Connect** page and use its current
   private/internal connection string. On **ai_tool → Environment**, keep that
   value directly in the secret `WEB_UPLOAD_CACHE_URL`. Do not use `REDIS_URL`,
   rotate the working internal URL merely for this release, put it in the static
   site, or put it in an environment group shared with unrelated services.
3. On **ai_tool → Environment**, add these API-only values exactly:

   ```dotenv
   WEB_ATTACHMENTS_ENABLED=true
   WEB_VOICE_RECORDING_ENABLED=true
   WEB_VOICE_BILLING_ENABLED=true
   WEB_VOICE_REPLY_ENABLED=true
   WEB_UPLOAD_TTL_SECONDS=3600
   WEB_UPLOAD_MAX_FILE_BYTES=10485760
   WEB_UPLOAD_MAX_FILES_PER_MESSAGE=5
   WEB_UPLOAD_MAX_TOTAL_BYTES=26214400
   WEB_UPLOAD_MAX_EXTRACTED_CHARS=100000
   WEB_ATTACHMENT_PROMPT_MAX_CHARS=6000
   WEB_AUDIO_MAX_SECONDS=300
   WEB_TTS_MAX_CHARACTERS=5000
   WEB_UPLOAD_RATE_LIMIT_PER_MINUTE=10
   WEB_STT_RATE_LIMIT_PER_MINUTE=10
   WEB_TTS_RATE_LIMIT_PER_MINUTE=10
   WEB_UPLOAD_STORE_RAW=false
   WEB_REALTIME_VOICE_ENABLED=false
   WEB_REALTIME_VOICE_PLAYBACK_MODE=pcm_stream
   WEB_REALTIME_VOICE_BACKCHANNEL_ENABLED=false
   SARVAM_TTS_STREAM_OUTPUT_CODEC=mp3
   SARVAM_TTS_STREAM_SAMPLE_RATE=24000
   WEB_SEPARATE_VOICE_CREDITS_ENABLED=false
   WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS=60
   WEB_REALTIME_VOICE_MAX_SESSION_SECONDS=900
   WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS=60
   WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER=1
   WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE=5
   WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED=true
   WEB_REALTIME_VOICE_END_SILENCE_MS=1100
   WEB_REALTIME_VOICE_UNFINISHED_GRACE_MS=900
   WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS=2600
   WEB_REALTIME_VOICE_MIN_SPEECH_MS=250
   WEB_REALTIME_VOICE_MAX_UTTERANCE_MS=30000
   WEB_REALTIME_VOICE_BARGE_IN_MIN_MS=180
   WEB_REALTIME_VOICE_PREROLL_MS=320
   SARVAM_STT_STREAM_MESSAGE_ENCODING=audio/wav
   RAZORPAY_READ_RETRY_ATTEMPTS=3
   RAZORPAY_READ_RETRY_BASE_MS=500
   RAZORPAY_READ_RETRY_MAX_MS=4000
   RAZORPAY_HTTP_TIMEOUT_SECONDS=15
   ```

4. Add the voice flags and limits directly to the existing **ai_tool** API
   service. Do **not** add `WEB_UPLOAD_CACHE_URL`, provider secrets, or any
   `WEB_*` voice/billing flag to **swico-backend-production**, billing Cron Jobs,
   the static site, or a shared billing environment group. Do not create public
   `VITE_*` voice flags. Bootstrap is authoritative. No new Render service,
   disk, object-storage bucket, upload-cleanup Cron Job, or voice Cron Job is
   required; keep using the existing Key Value internal URL.
5. Open **swico-web → Settings → Headers**. Replace the existing
   `Permissions-Policy` value with
   `camera=(), geolocation=(), microphone=(self)`. The header name is entered
   separately; do **not** put `Permissions-Policy:` inside the value. Replace the existing CSP with
   the exact value in `web/public/_headers`, including
   `media-src 'self' blob:`. Save the header changes.
6. Run the API pre-deploy migration, deploy **ai_tool**, and run all three
   existing financial job commands against the migrated schema before the
   static site. Keep `BILLING_CHECKOUT_ENABLED=false` throughout. Verify authenticated `/api/web/bootstrap` reports
   `web_attachments: true`, `web_voice_recording: true`, and
   `web_voice_billing: true`, `web_voice_reply: true`, and `uploads.available:
   true`; smoke one document upload, one paid transcription, one voice-originated
   text answer, and its paid voice reply. Provider secrets stay API-only.
   Only then select **Save, rebuild, and deploy** on **swico-web**. This order
   prevents the browser from exposing controls before the authoritative API is
   ready.
7. Only after Chat/Voice audit totals, reconciliation, stale-reservation
   cleanup, ticket security, and existing mobile contracts pass should an
   operator enable `WEB_SEPARATE_VOICE_CREDITS_ENABLED`; enable
   `WEB_REALTIME_VOICE_ENABLED` as a separate reviewed step. This does not
   authorize checkout or a live provider/payment request.

## Voice patch deployment and rollback order

This correction has no migration, new environment variable, or new Render
resource. Deploy API-first and static-site-second in this exact order:

1. Deploy the staging API.
2. Verify `WEB_VOICE_RECORDING_ENABLED=true`,
   `WEB_VOICE_BILLING_ENABLED=true`,
   `WEB_SEPARATE_VOICE_CREDITS_ENABLED=true`, and
   `WEB_REALTIME_VOICE_ENABLED=true` on the staging API.
3. Test Voice-only, Chat-only, and both-funded staging accounts. Confirm typed
   Chat touches only Chat, realtime STT/LLM/TTS touch only Voice, Voice-only can
   complete a turn, Chat-only receives the Voice 402, cancellation/failure
   release Voice reservations, and usage totals classify Voice LLM under Voice.
4. Deploy the staging static site.
5. Verify the subtle always-visible character counter at zero, ordinary, near,
   exact-limit, and over-limit input on desktop/mobile; verify Voice Mode offers
   only **Add Voice credits** and a Voice 402 opens the Voice tab.
6. Deploy the production API.
7. Deploy the production static site only after the production API is healthy.
8. To roll back realtime Voice, set `WEB_REALTIME_VOICE_ENABLED=false` on the
   existing API and deploy that configuration. Never disable separate Voice
   credits as the normal rollback.

Retain the normal pre-deploy `upgrade head` safety command, but this patch adds
no revision. Do not move balances, rewrite or reclassify historical usage or
ledger rows, add a `VITE_*` billing setting, or create a service, database,
Valkey, worker, queue, Cron Job, disk, or object store.

## Financial Cron Jobs

All three Cron Jobs use branch `main`, region **Virginia**, and a blank Root
Directory. Render evaluates Cron schedules in UTC. Configure these schedules:

- `billing-stale-reservations`: `*/10 * * * *`
- `razorpay-reconciliation`: `*/15 * * * *`
- `billing-financial-audit`: `*/5 * * * *`

Configure `billing-stale-reservations` with this command:

```bash
cd backend && python -m scripts.billing_maintenance stale-reservations --age-seconds 1800
```

Configure `billing-financial-audit` with this read-only command:

```bash
cd backend && python -m scripts.billing_maintenance audit \
  --captured-uncredited-age-seconds 900 \
  --fail-on-findings
```

Every financial Cron Job requires:

```bash
APP_ENV=production
DATABASE_URL=<Render PostgreSQL internal URL>
AUTO_CREATE_TABLES=false
RUN_MIGRATIONS_ON_STARTUP=false
REQUIRE_MIGRATIONS_BEFORE_STARTUP=false
```

Razorpay reconciliation additionally requires `RAZORPAY_MODE`,
`RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET` in Test Mode:

```bash
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=<matching rzp_test_ key>
RAZORPAY_KEY_SECRET=<matching Test Mode secret>
```

Its initial dry-run command is:

```bash
cd backend && python -m scripts.billing_maintenance razorpay \
  --age-seconds 900 \
  --fail-on-findings
```

For a one-order dry-run investigation, obtain the internal UUID from approved
operational evidence and run:

```bash
cd backend && python -m scripts.billing_maintenance razorpay \
  --internal-order-id <uuid> \
  --age-seconds 900 \
  --fail-on-findings
```

Dry-run is the default. Create and retain the Cron Job without `--apply`.
Never schedule `--apply`; any mutating reconciliation is a separately reviewed,
one-off operator action. Never enable Live Mode as part of Cron setup. Maintenance
configuration errors exit with status `78` before database-engine or
Razorpay-client creation and never print supplied values.

Clean, informational-only, and warning-only audit/reconciliation reports exit
`0`. With `--fail-on-findings`, only high-severity actionable results exit `3`.
Expected old abandoned checkouts appear as `abandoned_checkout_order`, severity
`info`, actionable `false`, while the command exits `0`. Captured-uncredited or
provider-mismatch results remain high/actionable and exit `3`. In the Render workspace,
open **Integrations → Notifications**, configure Email, Slack, or both, and set
**Default Service Notifications** to **Only failure notifications** (or **All
notifications**). On each Cron Job’s **Settings** page, scroll to
**Notifications** and retain the workspace default or explicitly select **Only
failure notifications**. Use **Trigger Run** on staging and retain evidence that
a deliberate non-zero run reaches the configured destination.

A clean audit has all five counts at zero and an empty list:

```json
{"audit":"financial_integrity","generated_at":"<ISO-8601 timestamp>","finding_count":0,"informational_finding_count":0,"warning_finding_count":0,"high_severity_count":0,"actionable_finding_count":0,"findings":[]}
```

An abandoned-checkout-only audit includes a safe internal ID/age/status item,
reports `informational_finding_count: 1`, keeps both high/actionable counts at
zero, and exits `0`. Timestamps and internal IDs vary; neither output includes
customer or provider payload data.

Financial Cron Jobs must use PostgreSQL and must not create tables or run
migrations. The backend service pre-deploy command remains the sole production
Alembic owner; Cron Jobs have no migration or pre-deploy command. Render
service-level variables override environment-group values, including a
service-level `DATABASE_URL`, so verify that each Cron Job uses the intended
internal database URL without logging it. Do not add a production Blueprint for
these manually managed resources.

The PostgreSQL credential exposed in the earlier screenshot must be rotated
manually in Render, then updated on the affected services. Never place real
credentials in screenshots, test output, Git history, or documentation.

After the OTP timestamp migration, verify PostgreSQL reports
`timestamp with time zone` for `email_otp_code.created_at`, `expires_at`, `consumed_at`, and
`last_sent_at` through `information_schema.columns`. Existing values are
converted with `AT TIME ZONE 'UTC'`; no OTP rows are deleted or recreated.

## Static site — exact settings

- Service type: Static Site
- Root Directory: `web`
- Build Command: `npm ci && npm run build`
- Publish Directory: `dist`
- Rewrite: `/*` to `/index.html`

Set the backend and static site to the same explicit Git branch. Authenticated
bootstrap exposes the API's short `RENDER_GIT_COMMIT`; Vite embeds the same
Render variable during the static build without a manual `VITE_*` release
setting. The internal Voice diagnostics panel shows both. Two unequal non-dev
SHAs block only billable Voice start and request a refresh; text chat continues.
Unavailable/dev metadata does not create a false mismatch. This repository
cannot prove the private dashboard selection; verify it in **Settings → Build
& Deploy → Branch** for both services.

Set only the public `VITE_*` values in `web/.env.example`: API base URL and Firebase Web app configuration. Do not place Firebase Admin credentials, model IDs, AI provider names, tier ladders, Razorpay secrets, webhook secrets, or database values in the static site. Customer-facing copy must use only Swico Lite, Swico, and Swico Pro.

Copy the Firebase browser configuration from **Firebase Console → Project settings → Your apps → Web app → SDK setup and configuration → Config**. Do not copy values from the Android `google-services.json`; the production Firebase app ID for this website must contain `:web:`. Set every required `VITE_*` value on the Render **static-site service**, then select **Save, rebuild, and deploy**. Vite embeds these variables at build time, so changing them without rebuilding does not update the deployed site. The production build validates the public configuration and stops with variable names—but never values—when required settings are missing or malformed.

Never put Firebase Admin service-account JSON or backend secrets in `VITE_*` variables. The Firebase Admin credentials on the backend service must belong to the same Firebase project as the frontend Web configuration.

For `https://swico-web.onrender.com`, complete these Firebase Console settings:

- Add `swico-web.onrender.com` to **Firebase Authentication → Settings → Authorized domains**.
- If the browser API key uses website restrictions, allow both `https://swico-web.onrender.com` and `https://swico-web.onrender.com/*`.
- If the browser API key uses API restrictions, permit **Identity Toolkit API** and **Token Service API**.

Render did not apply `web/public/_headers` to the audited static site automatically. Reproduce these exact name/value pairs from that file in the static-site dashboard/edge configuration:

- `Content-Security-Policy`: `default-src 'self'; script-src 'self' https://checkout.razorpay.com https://*.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self' https: wss:; frame-src https://*.firebaseapp.com https://*.razorpay.com https://api.razorpay.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`
- `Referrer-Policy`: `strict-origin-when-cross-origin`
- `X-Content-Type-Options`: `nosniff`
- `X-Frame-Options`: `DENY`
- `Permissions-Policy`: `camera=(), geolocation=(), microphone=(self)`
- `Strict-Transport-Security`: `max-age=31536000; includeSubDomains`

The response—not an HTML meta tag—must contain them. Run the network check only
when the deployed URL is explicitly configured:

```bash
DEPLOYED_WEB_URL=https://<web-domain>
python scripts/check-web-security-headers.py --url "$DEPLOYED_WEB_URL"
```

Point the desired web custom domain at the Render static site and complete Render certificate validation. Add the final origin (scheme and hostname, without a trailing slash) to API `CORS_ALLOW_ORIGINS` and add the hostname to Firebase Authentication authorized domains. Point the API custom domain at the existing API service and update `VITE_API_BASE_URL`; select **Save, rebuild, and deploy** because Vite variables are build-time values.

## Razorpay Test and Live setup

Create separate Test and Live webhooks targeting `https://<api-domain>/api/web/billing/razorpay/webhook`. Subscribe to `payment.captured`, `order.paid`, `refund.processed`, and `refund.failed`. Use a distinct webhook secret per mode. Test end-to-end in Test Mode, then replace all three API-side Razorpay values together for Live Mode. Never expose the key secret or webhook secret to the static site.

The API returns an explicit `razorpay_mode` enum and validates its public-key prefix. For a future cutover, keep checkout disabled, replace `RAZORPAY_MODE`, key ID, key secret, and webhook secret as one reviewed change, deploy/verify the API public config, then enable checkout as a separate reviewed change. Never mix Test and Live values.

Run the non-charging repository check with `python scripts/check-razorpay-live-readiness.py`. It validates the owner-attested legal publication and the other repository prerequisites. An authorized operator may additionally validate the current environment with `python scripts/check-razorpay-live-readiness.py --validate-environment`; the command prints check names only, never credential values.

For this package change the legal portion is expected to block: the approved Terms, Pricing, digital-delivery, AI-usage, privacy and refund text describes a single product called Token Credits and does not explain separate Chat and Voice balances, bucket-specific consumption, or same-bucket refund reversal. The approved Terms package description, Pricing **Gross top-up price** section, and owner attestation also still describe ₹10/₹50/₹100/₹500. Those owner/counsel-controlled policy bodies were intentionally not edited here. Do not deploy the purchasable product change, enable checkout, or proceed to Live cutover until exact owner/counsel-approved replacement text and a matching approval record make `python scripts/check-legal-publication.py` pass. Do not infer approval from product copy or code.

### Two-phase Live cutover

Phase one keeps checkout closed. Configure the Live key ID, Live key secret, and a separate Live webhook secret; set `RAZORPAY_MODE=live` and `BILLING_CHECKOUT_ENABLED=false`; deploy and verify the canonical webhook/public configuration; then run reconciliation and the financial audit. Test and Live credentials and webhooks are separate and must never be mixed.

Phase two sets `BILLING_CHECKOUT_ENABLED=true` and deploys separately. Make one controlled ₹10 payment, verify exactly-once credit and webhook replay idempotency, then run reconciliation and the financial audit. Disable checkout immediately and investigate if any amount, credit, webhook, ledger, reconciliation, or audit result mismatches.

## Migration and rollback

This turn-based voice reply release requires additive revision `c5d8a2e9f4b1`.
It preserves existing charges and backfills them as `usage_kind=chat`, then adds
nullable voice-turn linkage plus integer STT milliseconds and TTS characters.
It does not modify wallet or payment balances. Recordings, transcripts, and
generated audio are not stored in the database or Key Value service.

1. Back up PostgreSQL and note the currently deployed image and Alembic revision.
2. Run `cd backend && python -m alembic -c alembic.ini upgrade head` as the pre-deploy step; confirm the repository-derived head `7b4c9e1a2d6f`.
3. Deploy the API first with `BILLING_CHECKOUT_ENABLED=false` and `SWICO_PRO_ENABLED=false`, smoke existing mobile endpoints and new web contracts, then deploy the static site. Never deploy the tier-aware static site before its API and migration.
4. For an application rollback, first disable checkout, then deploy the previous API/static versions. Leave additive billing/chat/settings tables intact so ledger/payment and user-setting history is preserved.
5. Database downgrade of `6d4f2a9c8b71` destroys financial/chat tables and is not a normal rollback. Downgrading `8c1f4e7b2a90` removes user preferences and serialization rows; downgrading `9d2f6a1c4b7e` removes tier audit fields; downgrading `a7c4e9d2f1b6` removes the billing-exemption reason; downgrading `c5d8a2e9f4b1` removes voice classification fields but preserves the pre-existing charge rows. Revision `e2b7c4d9a1f3` permits downgrade only before any Voice payment, usage, ledger entry, or non-zero Voice wallet exists; it refuses a lossy downgrade after Voice financial activity. In production, preserve additive tables and fix forward.

## Disposable recovery drill

On the original paid Postgres service open **Recovery**, scroll to
**Point-in-Time Recovery**, select **Restore Database**, supply a disposable
name and a time at least ten minutes in the past, choose whether to copy
settings, and select **Start Recovery** (or **Customize Recovery**, then start).
Wait for **Recovery In Progress → Creating → Available**. On the new database’s
**Info** page copy its connection URL only into the temporary verification
environment; do not update any API, Cron Job, or environment group.

```bash
cd backend
APP_ENV=staging RESTORE_DRILL_CONFIRMATION=disposable \
DATABASE_URL=<restored-database-url> python -m scripts.verify_restore
```

The verifier starts a PostgreSQL read-only transaction, compares the one current
Alembic head, checks required tables/row counts, wallet/uniqueness/foreign-key
invariants, and rolls back. Retain its safe JSON plus restore point, commit,
operator, and timestamp. Cleanup: confirm the recovery URL is not referenced by
services or environment groups, remove temporary shell/CI values, then delete
the disposable database from its **Settings** page. Never delete, suspend, or
repoint the primary during a drill.

## Deployed Playwright

Local mode keeps the Vite server, mock authentication, and intercepted backend.
Deployed modes start no local server, set no mock-auth variable, and use real
Firebase/API traffic.

```bash
cd web
PLAYWRIGHT_MODE=staging PLAYWRIGHT_BASE_URL=https://<staging-web-domain> \
E2E_TEST_EMAIL=<dedicated-test-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-smoke.spec.ts \
  --project=chromium --project=mobile-chromium

PLAYWRIGHT_MODE=production-readonly PLAYWRIGHT_BASE_URL=https://<production-web-domain> \
E2E_TEST_EMAIL=<dedicated-readonly-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-readonly.spec.ts \
  --project=chromium --project=mobile-chromium
```

For the current production verification, use `https://swico.in` as the base URL.
The production-readonly suite verifies Test Mode, disabled checkout, truthful
payment-history headings, legal routes, token-credit terminology, and logout
while rejecting all Swico API mutations and checkout/chat endpoints. Staging
deployment and staging Playwright are intentionally deferred for this release.

Create GitHub Environments named exactly **staging** and
**production-readonly** under **Repository Settings → Environments**. In each,
add Environment secrets named exactly `PLAYWRIGHT_BASE_URL`, `E2E_TEST_EMAIL`,
and `E2E_TEST_PASSWORD`; use a dedicated account and the matching
credential-free HTTPS origin. Restrict branches and reviewers as appropriate.
The workflow uses these as test-only environments and does not create
deployment records.

Open **Actions → Deployed web smoke → Run workflow**, select `staging` or
`production-readonly`, and run the intended commit. Runs for one environment
are serialized. Retain the run URL and safe Step Summary fields: mode, base
hostname, commit SHA, desktop/mobile result, and timestamp. Reports and traces
are private failure-only artifacts. Never copy the test account, Firebase token,
or API authorization header into logs or the summary.

Local mode continues to start Vite with mocked authentication. Deployed mode
starts no local server, enables no mock authentication, requires HTTPS, uses
real Firebase/API traffic, and runs desktop/mobile sequentially. The staging
test fails before mutations when token credits are unusable and instructs the
operator to perform the one supervised Test Mode funding transaction; it never
submits payment details. Do not claim a deployed pass without a real non-local
HTTPS run with real credentials.

A successful Render build is not proof that a Cron Job executed successfully.
For each financial staging job, open it in Render, select **Trigger Run**, inspect
the exit status and safe output, verify the intended database and Test Mode,
and retain evidence. Do this separately for stale reservations, Razorpay
reconciliation dry-run, and financial audit.

## Production launch checks

Run `python scripts/check-legal-publication.py`. The seven policy bodies retain
their tracked owner approval and have not been reviewed or approved by counsel,
but the checker now blocks because the approved package wording and attestation
do not match the ₹10/₹299/custom product. Exact owner/counsel-approved replacement
wording and a matching approval record are required; do not change publication
metadata or effective dates speculatively. The checker validates content and
accountable publication metadata; it is not legal advice or legal-compliance
certification. Verify provider prices/FX policy;
configure alerts/reconciliation; validate the refund/incident ownership
template; load-test PostgreSQL connections/rate limiting; and confirm edge
headers/CORS. Razorpay Live Mode and Live checkout remain blocked until every
separate release item is complete.

Never upload raw legal source or future private review documents to Render or
copy them into `web/public`, `web/src`, tracked docs, static assets, or build
output. Keep such private material under the ignored `private/legal-source/`
directory.

Run the local-only structural check from the repository root:

```bash
python scripts/check-legal-source-readiness.py \
  --source-dir private/legal-source
```

The source-readiness command is useful for a future review package, but a
structural pass is not legal approval. Keep `RAZORPAY_MODE=test`,
`BILLING_CHECKOUT_ENABLED=false`, and `BILLING_CREDIT_PERCENT=50` until the
separate authorized Live cutover. Owner attestation does not authorize Live
Mode.

## Controlled first Live payment plan (do not execute until every blocker is cleared)

After the legal publication gate passes, backup/restore and monitoring evidence exists, Test Mode payment/webhook/replay/refund has passed, and the owner explicitly authorizes Live Mode: deploy all three matching Live Razorpay values together, use one authorized owner-controlled account, make one ₹10 payment with owner-controlled payment details, verify one 5,000,000-micro-INR ledger credit and one provider usage debit, monitor webhook/reconciliation, and stop the pilot immediately on any mismatch. Never use customer data for this pilot. This plan is documentation only and is not authorization to enable Live Mode or make a payment.
