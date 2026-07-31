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
   `b4e8c1d6a2f9`.
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

No new Render resource, route, static-site variable, or production activation
is required. The staging blueprint records the safe disabled defaults.

## Rollback

Set `WEB_RAG_HYBRID_ENABLED=false` (or `WEB_TRIAG_ENABLED=false`) and restart
the API. This restores the existing coordinator/lexical path. The
additive tables may remain. Do not downgrade a production database merely to
disable the feature.

## Phase boundary

Repository execution, an isolated validator service, arbitrary commands,
repository indexing, triplets, hierarchy, and persistent knowledge remain
Phase 4+ work.
