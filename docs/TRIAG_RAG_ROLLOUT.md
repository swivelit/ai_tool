# TRIAG-RAG rollout

## Safe defaults

Configure these only on the backend API service:

```text
WEB_TRIAG_ENABLED=false
WEB_TRIAG_SHADOW_MODE=true
WEB_TRIAG_POLICY_VERSION=v1
```

Do not add them to the static site, any `VITE_*` configuration, PostgreSQL,
Valkey, a shared environment group, or billing jobs. Disabled is a healthy
optional state.

## Phase 1 deployment

1. Deploy the code with `WEB_TRIAG_ENABLED=false`.
2. Run `python -m alembic -c backend/alembic.ini upgrade head` through the
   existing Render pre-deploy migration owner. The single head must be
   `b4e8c1d6a2f9`.
3. Verify `/api/web/health`, authentication, a deterministic zero-charge turn,
   a provider-backed turn, reservation/settlement, cache behavior, and SSE.
4. Leave production disabled. Shadow observation, if later approved, requires
   both `WEB_TRIAG_ENABLED=true` and `WEB_TRIAG_SHADOW_MODE=true`.

No new Render resource, route, static-site variable, or frontend deployment
behavior is required. The staging blueprint records the safe disabled defaults.

## Rollback

Set `WEB_TRIAG_ENABLED=false` and restart the API. This stops planning and trace
writes without affecting the existing coordinator or billing path. The
additive tables may remain. Do not downgrade a production database merely to
disable the feature.

## Phase boundary

Do not set `WEB_TRIAG_SHADOW_MODE=false` to activate a live runtime. In Phase 1
that state is reported as `configured_inactive`; there is no live integration.
Retrieval execution, evidence injection, answer checking, stage billing, and
runtime cutover require a separately reviewed Phase 2+ implementation.
