# Video release checklist and evidence classes

## Current local onboarding commands

The worker's model and template evidence is local-only and must be added through
the bounded commands below; never edit `models.json` or a template manifest by
hand. `models provenance status` is offline by default. Its optional `--fetch`
mode retrieves only fixed, small FaceFusion sidecars and labels legacy CRC32
separately from a full-model SHA-256. A technical hash never supplies a licence
or commercial permission.

```bash
.venv-video/bin/python -m swico_video_node models evidence status
.venv-video/bin/python -m swico_video_node models provenance status
.venv-video/bin/python -m swico_video_node templates rights status --id couple-01
.venv-video/bin/python -m swico_video_node templates tracks status --id couple-01
```

After a real reviewer has selected genuine documents with Finder, use
`models evidence add` and `templates rights add` with their actual paths and
the explicit assertions. For an independently checked complete model file,
record its exact 64-hex SHA-256 with `models provenance record --sha256`; do not
replace it with a CRC32 sidecar or a guessed value. Track corrections use the
`templates tracks reassign|exclude|split` commands and invalidate approval and
calibration, so review and benchmark must be repeated.

Implementation is not permission to deploy. No templates, weights, role labels,
commercial grants or measured clip timings are supplied by this repository.
Do not turn on paid checkout based on mocks or a schema check alone.

## First-run operator checkpoints

- [ ] On the actual Intel Mac, run the dependency-free
  `bash swico_video_node/scripts/setup_macos.sh --check` before bootstrap.
  Missing prerequisites must stop normal setup, without sudo or state changes.
- [ ] If using MacPorts, complete the guarded, checksum-verified **installation**
  in [VIDEO_MAC_SETUP.md](VIDEO_MAC_SETUP.md#2-actually-install-macports-operator-video-mac-only).
  Require `/opt/local/bin/port version` before selfupdate or package commands.
  An already supported native alternative is valid; MacPorts is not mandatory.
- [ ] Verify Python 3.12, pip, FFmpeg AND ffprobe, then ordinary bootstrap.
  Synthetic codec/import success is not native model inference or calibration.
- [ ] Init preserves the token; independently require doctor API authentication.
  Configured digest alone is not pairing. Overall readiness may remain false
  until assets/calibration and first worker heartbeat; do not create a startup loop.

These checkpoints do not authorize template publication, feature enablement,
provider calls or legal approval. Keep both video flags false during provisioning;
unchanged Render values do not need another save/deploy. Current CLI is 0.2.9;
no new migration is needed beyond already-deployed `20260918_website_video`.

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

- [ ] Both local masters pass `templates inspect`; unequal header rates alone
  are not a rejection when bounded PTS cadence proves CFR. Genuine VFR remains
  rejected. Explicit optional normalize produces a new file without overwrite;
  inspect/play that output before importing. No automatic trim/resize/retiming.
- [ ] Import copied/hash-bound media only, without partial template state, rights
  approval or inference claims. Complete real rights → model install/audit →
  prepare/frame review → benchmark → metadata publication → foreground →
  LaunchAgent acceptance before authorizing complimentary and then paid acceptance.
- [ ] All model/engine assets have independently checked source, exact digest and
  genuine commercial-permission/licence evidence; full dependency chain reviewed.
- [ ] Model evidence was imported with `models evidence add`, technical `.hash`
  provenance was explicitly reviewed/recorded, and `models audit` reports every
  blocker with no manual edits to `models.json`. Technical hash evidence is not
  commercial authorization.
- [ ] Both real templates and audio have commercial modification/distribution rights.
- [ ] Both imported manifests use `templates rights add` with genuine licence and
  permission documents plus explicit video-modification, resulting-video-
  distribution and audio-rights confirmations. Rights updates invalidated old
  approval/calibration and `master.mp4` remained unchanged.
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

## Legal publication release gate

The owner must use the local publication helper, not manual edits to
`legalContent.json` or the attestation:

```bash
python scripts/publish-video-legal.py --owner-attestation \
  --approver-role "REAL ACCOUNTABLE OWNER ROLE" --approval-date "YYYY-MM-DD" --dry-run
```

Only after the exact candidate is reviewed and real rights/takedown operations
exist may the owner repeat it with the three confirmation flags. Run the legal
publication checker and `python scripts/swico_video_release_check.py --pretty`
afterward. A configured `paid_enabled` flag is not effective availability when
the legal, worker, template, rights, cache or native gates are closed; keep the
feature and paid checkout disabled until the checker reports a safe rollout.

Consent attestations in the browser are not legal advice or a substitute for
documentary adult/source-face, movie, performer or audio rights. Mock payment,
mock email, synthetic media and configured hashes are not production evidence.
