# TRIAG-RAG rollout

## Safe defaults

Configure these only on the backend API service:

```text
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
WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=false
WEB_RAG_TRIPLET_ENABLED=false
WEB_RAG_HIERARCHY_ENABLED=false
WEB_KNOWLEDGE_JOB_BATCH_SIZE=50
WEB_KNOWLEDGE_WORKER_ENABLED=false
WEB_KNOWLEDGE_WORKER_POLL_SECONDS=2
WEB_KNOWLEDGE_WORKER_MAX_CONCURRENCY=1
WEB_ANSWER_GUARD_ENABLED=false
WEB_VERIFIED_STREAMING_ENABLED=false
WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED=false
WEB_ANSWER_GUARD_REPAIR_ENABLED=false
```

Do not add them to the static site, any `VITE_*` configuration, PostgreSQL,
Valkey, a shared environment group, or billing jobs. Disabled is a healthy
optional state.

The only allowed rollout modes are `disabled`, `internal_accounts`,
`percentage`, and `all_eligible`; percentages are integers from `0` through
`100` only in `percentage` mode. Every other mode requires percentage `0`.
Increment `WEB_ROLLOUT_POLICY_VERSION` only for an intentional cohort
reshuffle. The stable percentage input is owner user ID, feature key, and that
version. A rollout mode never overrides a false global feature flag.

## Phase 2 deployment

1. Deploy the code with `WEB_TRIAG_ENABLED=false`.
2. Run `python -m alembic -c backend/alembic.ini upgrade head` through the
   existing Render pre-deploy migration owner. The single head must be
   `f2a7c9e4b1d6`.
3. Verify `/api/web/health`, authentication, a deterministic zero-charge turn,
   a provider-backed turn, reservation/settlement, cache behavior, and SSE.
4. Leave production disabled. Shadow observation, if later approved, requires
   `WEB_TRIAG_ENABLED=true`, `WEB_TRIAG_SHADOW_MODE=true`, and an included
   cohort selected by `WEB_ROLLOUT_TRIAG_MODE`; the mode is not allowed to
   bypass the `WEB_TRIAG_ENABLED` hard kill switch.
5. A separately approved staging experiment may set shadow false and hybrid
   true. Dense additionally requires `WEB_RAG_DENSE_ENABLED=true`, a working
   upload Valkey, and embedding accounting. Enable the evaluator separately.
6. Enable Answer Guard separately. Keep the model verifier and repair disabled
   until stage reservation/settlement is validated. Verified streaming must not
   be enabled without Answer Guard.

Phase 4 adds a staging-only private validator service and the authenticated
`/api/web/repositories` route. No static-site variable or production validator
is required. The API flags remain false in the staging blueprint.

Phase 4.1 requires no additional Render resource or public `VITE_*` variable.
Once the existing backend flags are intentionally enabled, authenticated web
clients discover repository upload/chat/validation through
`/api/web/bootstrap`. Keep those flags false until the staged repository
lifecycle and validator capability have been verified.

Phase 5.1 likewise requires no new Render resource or public `VITE_*`
variable. Deploy its API and settings UI with
`WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=false`. In an approved staging gate,
enable the existing TRIAG, non-shadow hybrid, attachments and persistent
knowledge flags together; then verify bootstrap advertises
`web_knowledge_library`, explicit confirmation, owner rejection, expiry,
idempotent approval, cancellation, removal and re-indexing. Do not enable the
flag in production merely because the UI is deployed.

## Rollback

Set `WEB_RAG_HYBRID_ENABLED=false` (or `WEB_TRIAG_ENABLED=false`) and restart
the API. This restores the existing coordinator/lexical path. The
additive tables may remain. Do not downgrade a production database merely to
disable the feature.

## Phase 4 rollout boundary

Enable `WEB_REPOSITORY_UPLOAD_ENABLED`, then
`WEB_RAG_REPOSITORY_INDEX_ENABLED`, and only then consider
`WEB_PRO_CODE_VALIDATION_ENABLED` in staging. The validator reports
`static_only` unless every isolation capability is proven. Arbitrary commands,
triplets, hierarchy, persistent knowledge, and production rollout remain out
of scope. Repository-aware chat additionally requires Answer Guard and
verified streaming; otherwise the API reports the optional repository chat
capability as disabled and retains the existing path.

## Phase 5/6 staged gates

Do not enable persistent knowledge merely because the migration is deployed.

1. Migrate to `f2a7c9e4b1d6` and verify one head.
2. Prove explicit approval and source-version invalidation.
   Exercise approval through `/api/web/knowledge`; verify the owner marker is
   checked before temporary content is fetched and API responses remain
   content-free.
3. Prove owner isolation and that temporary uploads expire without knowledge
   rows.
4. Enable persistent knowledge for a bounded staging cohort while triplets and
   hierarchy remain off.
5. Prove lexical fallback with pgvector/provider unavailable and prove private
   turns neither read nor write the global answer cache.
6. Validate reservation, idempotent stage accounting, exact settlement and
   cancellation before enabling an embedding worker.
7. Deploy the private staging knowledge worker with its flag false and only
   its minimum database, provider, pricing, budget and worker configuration.
   Confirm it has no Firebase, Razorpay webhook, SMTP, download-token or
   validator secrets.
8. Enable the worker and the API's claim-separation flag as one reviewed
   staging change. Confirm the API/shared worker no longer claims knowledge
   jobs, the dedicated worker never claims unrelated jobs, and provider
   construction remains behind wallet reservation.
9. Prove restart/reclaim idempotency, exact settlement, cancellation both
   before and after the provider response, source-version invalidation and
   lexical fallback. An indeterminate running provider stage must fail closed,
   not replay.
10. Enable hierarchy, then triplets, separately and compare evidence to raw
   chunk anchors.
11. Pass latency, retrieval-quality, privacy, billing, error-rate and rollback
   gates before any production flag changes.

Production retains all flags as `false` until approval. Production
`WEB_CODE_VALIDATOR_URL` must be blank unless a separately isolated production
validator is deliberately provisioned; it must never reference the staging
validator.

The worker is not a percentage-rollout mechanism. Job-type separation is a
service-wide operational switch, and the existing server-authoritative
Knowledge Library rollout still determines who may create work. Keep
`WEB_KNOWLEDGE_WORKER_ENABLED=false` in production and do not create a
production worker until the staging gates above are approved.

## Phase 6A cohort gates

Deploy Phase 6A with all four rollout modes set to `disabled`. For the first
approved staging exercise:

1. Deploy the code and reporting variables with every mode `disabled`, every
   percentage `0`, `WEB_TRIAG_ENABLED=false`, shadow mode `true`, and all live
   retrieval, knowledge, repository and Answer Guard flags false. Verify the
   fallback path before changing any staging flag.
2. Configure only verified, owned staging accounts in
   `SWICO_INTERNAL_TEST_EMAILS`. For shadow observation set exactly
   `WEB_TRIAG_ENABLED=true`, `WEB_TRIAG_SHADOW_MODE=true`, and
   `WEB_ROLLOUT_TRIAG_MODE=internal_accounts`; keep
   `WEB_ROLLOUT_TRIAG_PERCENT=0` and every other rollout mode and live feature
   switch disabled.
3. Verify included accounts create one idempotent execution plan and sanitized
   shadow trace with `rollout_execution=shadow`. Verify excluded accounts have
   `rollout_execution=fallback`, no plan, and the original fallback path.
   Across a matched request, prove cache lookup/write eligibility, serialized
   prompt, provider/model route and calls, reservation/debit/settlement, answer,
   SSE and frontend behavior are identical. Any difference blocks live staging.
4. Enable Phase 6B reporting only after the shadow invariants pass. Review the
   `shadow` and `fallback` execution groups separately; reporting does not
   activate a feature.
5. Only after explicit live approval, change the same bounded staging cohort
   to non-shadow TRIAG by setting `WEB_TRIAG_SHADOW_MODE=false` and
   `WEB_RAG_HYBRID_ENABLED=true` while retaining
   `WEB_ROLLOUT_TRIAG_MODE=internal_accounts`. Live controlled turns report
   `rollout_execution=live` and suppress global cache. Keep dense retrieval,
   persistent knowledge, repository chat and Answer Guard disabled until each
   receives its own reviewed gate.
6. If percentage rollout is approved, set one bounded percentage without
   changing the policy version during the observation period. Advance
   separately to `all_eligible` only after feature-specific gates pass.

Roll back immediately by setting the affected rollout mode to `disabled`;
then set `WEB_TRIAG_ENABLED=false` for the harder kill if required. Shadow
rollback must not be implemented by changing cache, prompts, billing, SSE, the
frontend, or the chat route. No database downgrade, static-site variable, new
service, or route change is needed.

## Phase 6B acceptance reporting

Deploy reporting disabled. In staging, an operator may set
`WEB_TRIAG_ROLLOUT_REPORT_ENABLED=true` without changing any rollout mode or
global feature switch. Only verified, owned accounts in `ADMIN_EMAILS` may use
the authenticated report endpoint. A Render Shell operator can run:

```text
cd backend
python scripts/triag_rollout_report.py --window-hours 24 --pretty
```

Review every feature/cohort/execution/release-state/tier group separately. The
bounded execution value is only `fallback`, `shadow`, or `live`, and release
state is only `controlled` or `general_availability`; neither contains
identity, content, provider/model value, or secret. A report is evidence for a
human rollout decision, never an activation mechanism. `pass` does not change
environment variables; `warning`, `fail` and `insufficient_sample` block
automatic interpretation. Keep production report access disabled until the
admin authorization and operational access review pass.

## Direct production general availability

This is a direct all-eligible release, not another percentage stage. The new
release switch defaults to `controlled`; controlled live cohorts retain the
Phase 6 blanket global-cache suppression. Set
`WEB_TRIAG_RELEASE_STATE=general_availability` only in the same reviewed
production change that makes every enabled TRIAG feature `all_eligible` and
keeps every percentage at `0`:

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

Dense retrieval, evaluator, hierarchy, triplet, model-verifier, repair and
code-validation flags may be true only if their existing acceptance gates have
passed. A globally disabled optional feature must keep its rollout mode
`disabled`; the release check rejects internal/percentage modes and non-zero
percentages.

Before the API change, create the production private validator and background
worker in the API/database region. Use these exact commands:

```text
# Private service
uvicorn app.code_validator.main:app --app-dir backend --host 0.0.0.0 --port 10001

# Background worker
cd backend && python -m app.knowledge_worker
```

The validator's only secret is its generated `CODE_VALIDATOR_AUTH_TOKEN`; set
`CODE_VALIDATOR_ISOLATION_PROOF=static-only`,
`CODE_VALIDATOR_NETWORK_ISOLATED=false`, timeout `90`, and maximum output
`65536`. Link the same token to the API and use the private URL on port `10001`.
This configuration truthfully reports `static_only`, never executable checks.
The worker's only secrets are the private `DATABASE_URL` and provider key; it
also needs the bounded worker, embedding, price, FX, budget, markup and reserve
settings already shown in `render.staging.yaml`. It must not receive Firebase,
Razorpay, SMTP, download-token, validator-token or Valkey secrets.

Deployment order is: create both services disabled; prove validator
reachability/capability; migrate to the single head; enable the worker and API
job-claim separation together; apply the all-eligible API values; run the
content-free release check; then verify health, reporting, billing,
cancellation, cache promotion and SSE. The Shell commands are:

```text
cd backend
python scripts/triag_release_check.py --pretty
python scripts/triag_rollout_report.py --window-hours 24 --pretty
```

Any non-zero release-check exit blocks release. Roll back without a database
downgrade by setting `WEB_TRIAG_RELEASE_STATE=controlled`, all four rollout
modes to `disabled`, `WEB_TRIAG_ENABLED=false`, and
`WEB_KNOWLEDGE_WORKER_ENABLED=false`; then disable knowledge, repository,
Answer Guard, dense/hierarchy/triplet and code-validation flags. Keep the
validator private and stop the worker after the API no longer claims or creates
knowledge work.
