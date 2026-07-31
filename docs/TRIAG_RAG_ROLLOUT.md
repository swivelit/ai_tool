# TRIAG-RAG rollout

## Safe defaults

Configure these only on the backend API service:

```text
WEB_TRIAG_ENABLED=false
WEB_TRIAG_SHADOW_MODE=true
WEB_TRIAG_POLICY_VERSION=v1
WEB_RAG_HYBRID_ENABLED=false
WEB_RAG_DENSE_ENABLED=false
WEB_RAG_RETRIEVAL_EVALUATOR_ENABLED=false
WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED=false
WEB_RAG_TRIPLET_ENABLED=false
WEB_RAG_HIERARCHY_ENABLED=false
WEB_KNOWLEDGE_JOB_BATCH_SIZE=50
WEB_ANSWER_GUARD_ENABLED=false
WEB_VERIFIED_STREAMING_ENABLED=false
WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED=false
WEB_ANSWER_GUARD_REPAIR_ENABLED=false
```

Do not add them to the static site, any `VITE_*` configuration, PostgreSQL,
Valkey, a shared environment group, or billing jobs. Disabled is a healthy
optional state.

## Phase 2 deployment

1. Deploy the code with `WEB_TRIAG_ENABLED=false`.
2. Run `python -m alembic -c backend/alembic.ini upgrade head` through the
   existing Render pre-deploy migration owner. The single head must be
   `f2a7c9e4b1d6`.
3. Verify `/api/web/health`, authentication, a deterministic zero-charge turn,
   a provider-backed turn, reservation/settlement, cache behavior, and SSE.
4. Leave production disabled. Shadow observation, if later approved, requires
   both `WEB_TRIAG_ENABLED=true` and `WEB_TRIAG_SHADOW_MODE=true`.
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
7. Enable hierarchy, then triplets, separately and compare evidence to raw
   chunk anchors.
8. Pass latency, retrieval-quality, privacy, billing, error-rate and rollback
   gates before any production flag changes.

Production retains all flags as `false` until approval. Production
`WEB_CODE_VALIDATOR_URL` must be blank unless a separately isolated production
validator is deliberately provisioned; it must never reference the staging
validator.
