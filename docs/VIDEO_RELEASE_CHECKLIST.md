# Video release checklist and evidence classes

Implementation is not permission to deploy. No templates, weights, role labels,
commercial grants or measured clip timings are supplied by this repository.
Do not turn on paid checkout based on mocks or a schema check alone.

## Automated local evidence

Run from the repository root (the backend virtual environment is separate from
the Mac model environment):

```bash
cd backend
.venv/bin/python -m pytest tests/test_website_video.py tests/test_web_billing.py tests/test_weekly_tester_credit.py tests/test_startup_migrations.py -q
.venv/bin/python -m pytest -q
cd ..
backend/.venv/bin/python -m pytest swico_video_node/tests -q
cd web
npm ci
npm run lint
npm run typecheck
npm run test -- --run
npm run build
```

Production-style web build requires the existing public Firebase/API settings;
the CI workflow has explicitly fake public fixture values for a local test build.
Never read a production secret to fill a test fixture.

For actual PostgreSQL concurrency use a **disposable localhost database** with
the API migration through `20260918_website_video`, then set `TEST_DATABASE_URL`
explicitly for `tests/test_video_postgres.py`, `tests/test_website_video.py` and
`tests/test_cli_postgres_lifecycle.py`. Never point these tests at production.
Test fresh and upgrade from `20260917_cli_cloud_artifacts`, including existing
non-video money rows. Concurrent quota/claims must use real PostgreSQL locks.
SQLite tests are not PostgreSQL concurrency evidence.

`tests/test_video_valkey.py` starts its OWN ephemeral Unix-socket cache with no
TCP port or persistence. Set `SWICO_TEST_VALKEY_SERVER` to a local reviewed
valkey-server/redis-server executable (or have it on PATH). It never connects to
`WEB_UPLOAD_CACHE_URL` and never flushes a shared cache. CI installs the executable
for these tests; absence is reported as NOT RUN, not a cache pass.

The backend media fixture is intentionally structural dummy MP4 data, and model
functions are not invoked by API tests. SMTP/Razorpay test doubles do not establish
provider acceptance or deliverability. The worker tests cover commands, token
permissions, rights-integrity denial, path confinement and real POSIX process-group
termination. These are NOT native face inference or likeness acceptance.

## Required operator evidence before enabling

- [ ] All model/engine assets have independently checked source, exact digest and
  genuine commercial-permission/licence evidence; full dependency chain reviewed.
- [ ] Both real templates and audio have commercial modification/distribution rights.
- [ ] Current website legal/pricing/privacy/refund text has fresh accountable
  publication approval. `videoLegalDraft.json` is intentionally `unreviewed`, with
  no approval record. The currently released `legalContent.json` and its existing
  approval remain unchanged. Video admission requires publishing the reviewed
  proposal's pages with fresh valid approval; the old hash cannot authorize them.
- [ ] Existing Valkey maxmemory/headroom/persistence/backup/eviction policy inspected.
  Real Redis atomic reserve/pin/retry/expiry and cache-loss tests pass on isolated
  test resources without evicting/altering ordinary 300-second Chat uploads.
- [ ] Intel x86_64 Python ABI/wheels, all model imports/opsets and CPU inference pass.
  No claimed CUDA/MPS/CoreML acceleration. Record OS/CPU/dependency versions.
- [ ] Both template track maps reviewed frame-by-frame; all background people excluded.
  Test one role and both independently, cuts, profile views and cup/hand occlusion.
- [ ] At least three actual warm full-clip trials per template/enhancement variant
  plus first-render and separately measured Engine-load duration; inspect likeness,
  mouth/eyes/flicker and A/V synchronization. First-render is NOT a fresh-process
  cold-cache claim. Schema-2 evidence must match the current Python, packages,
  tools/libraries, hardware, policy, model and reviewed template identity. No
  invented p90 or sample timings. Missing/stale template stays disabled.
- [ ] Real worker lease loss/cancel/restart kills descendants; no stale completion;
  failed/dropped media transfer cannot create READY; process lock rejects duplicate run.
- [ ] Provider TEST credentials explicitly supplied for fixed-price orders,
  unauthorized/captured states, duplicate webhook/callback, order.paid without payment,
  late capture, refund.processed/refund.failed, ambiguous timeout reconciliation,
  original-source refund and no wallet/subscription/referral changes.
- [ ] Authorized operator-only SMTP test: recipient, stable Message-ID, link login
  return, timezone and exact expiry. No automatic real-customer test email.
- [ ] Browser flow with approved photos: preflight/consent, allowance/checkout,
  progress, reload, second-device chat card, private playback/download, cancelled/
  failed/refund states, expiry and object URL revocation. No token URLs or public media.
- [ ] `python scripts/swico_video_release_check.py --pretty` passes with actual
  worker/template/cache/SMTP configuration, followed by ordinary public Chat, CLI,
  Voice, subscription and weekly tester regression checks.

## Production switch/rollback rules

Preserve existing production settings. Default `SWICO_VIDEO_ENABLED=false` and
`SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false`. Only operator action enables the website
after the relevant rights/safety/native checks. Paid enablement is a separate later
action after provider/storage/delivery acceptance. No new infrastructure is authorized.

Drain with both flags false while keeping worker authentication and maintenance
active. Do not delete unresolved refund intents. Do not downgrade/stamp production
or roll back to a payment dispatcher without the video branch. Additive financial
history must survive a code rollback; ordinary unrelated product configuration
does not need to change.
