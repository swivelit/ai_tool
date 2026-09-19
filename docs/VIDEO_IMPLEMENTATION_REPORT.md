# Website video corrective implementation evidence — 2026-09-18

## ZIP43 follow-up — current implementation checkout

This follow-up starts from `8f8d615d480e0786b084bce13bf1e1f5ee4e2b1a`; the
published CLI remains 0.2.9 and the deployed database head remains
`20260918_website_video`. It adds no migration and does not claim the supplied
operator Mac has passed native inference or quality acceptance.

The separate FaceFusion checkout now has one bounded read-only status contract
used by bootstrap, doctor and model audit. It distinguishes missing,
non-repository, wrong revision, tracked changes and untracked changes without
printing the private home path. Explicit `engine recover --recreate` holds the
worker lock, refuses a loaded LaunchAgent, fetches the pinned commit privately,
archives the old checkout and preserves the worker token/configuration,
templates, rights and model bytes. A failed fetch does not destroy the old
checkout.

Bootstrap checks that status before locked dependency installation. Service
status separately reports LaunchAgent loaded/running, local liveness, native
readiness, backend health and `serving_ready`; installing or starting a service
is not readiness evidence.

Website admission now serializes control-before-job on checkout admission, so
owner recovery remains possible while fresh admission is paused. Unpaid photo
preflight admission reports capacity and refuses a new upload when an accepted
validation/render already occupies the single native machine; this avoids
creating a ten-minute unpaid hold that is predictably likely to expire. The
configured unlimited account bypasses only the six-preflights/hour product cap;
active-request, queue and machine limits remain enforced.

The website retries its initial capability/history load, refreshes owned
capabilities on focus/online and job changes, coalesces status polling while a
request is in flight, validates zero-byte/unsupported MIME selections, and
exposes the strict supported `swap`/`enhance`/printable-ASCII `caption`
instruction field. The backend remains authoritative and rejects non-ASCII
caption control input as well.

Actual local evidence for this follow-up is recorded below after execution.

## Local rights/provenance onboarding hardening — this pass

The production worker already has imported masters and the deployed schema is
already `20260918_website_video`; no migration is added or changed here. This pass
adds local-only operator tooling rather than asking a novice to edit
`models.json` or a template manifest:

- `models evidence status/add` copies genuine evidence into private mode-0600
  storage, hashes the copied bytes, creates a private timestamped backup and
  atomically updates the manifest. Symlinks, special files, path escapes, trivial
  and oversized documents are rejected. The tool never interprets a licence or
  creates a legal grant.
- FaceFusion's pinned model implementation uses adjacent fixed `.hash` release
  sidecars. The legacy sidecar contract is CRC32 (for example `a948738e`), while
  any full SHA-256 is labelled separately. `models provenance status` is
  local/read-only by default; `--fetch` retrieves only bounded HTTPS sidecars
  from the fixed GitHub path, and `provenance record --confirm-technical-hash`
  records technical provenance without downloading ONNX bytes or granting
  commercial permission. Independently reviewed full-model SHA-256 evidence is
  recorded only through the explicit `--model-file` (or already reviewed
  `--sha256`) route with reviewer/date metadata.
- `templates rights status/add` supports only `couple-01` and `couple-02`, requires
  genuine licence/permission evidence and explicit video-modification,
  resulting-video-distribution and audio-rights assertions. It invalidates
  approval/calibration atomically without changing `master.mp4`.
- `models audit` now reports bounded reason codes and next steps without absolute
  private paths. The website capabilities response separates configured paid
  checkout from effective paid availability, and the release checker reports
  prerequisites, rollout safety, configured flags, release state and blockers.

These changes do not publish templates, install restricted weights, charge, email,
call a provider, change Render configuration or change weekly credits.

## Follow-up workflow hardening — actual checkout `1a6297f1`

This follow-up preserves the deployed `20260918_website_video` schema and adds no
migration. The exact fixed FaceFusion sidecar is now read as algorithm-labelled
technical provenance: the legacy eight-hex CRC32 value cannot be padded or used
as a model SHA-256, while a complete independently reviewed model SHA-256 has a
separate explicit recording route. Fixed GitHub release redirects are bounded to
HTTPS GitHub release hosts; model bytes are never downloaded by status commands.

The website now exposes the effective paid-availability distinction, resumes the
same unexpired checkout order, closes expired holds without making another order,
keeps owner control during admission pauses, polls only active/short-lived
refund/email settlement, and renders supported edit instructions as plain
language. Local track correction commands use feature-assisted continuity with
an ambiguity stop and invalidate old review/calibration. Refund bookkeeping uses
the PaymentOrder → VideoJob → VideoOutbox lock order.

Final local evidence for this checkout: the full worker suite was 195 passed;
the full backend suite was 2237 passed, 13 skipped; the full web suite was 595
passed; targeted web tests were 12 passed; the affected backend video/release
suite was 55 passed, 4 skipped; and the canonical public web build passed with
non-secret CI fixture values. No native Intel inference, model installation,
real Razorpay capture/refund, SMTP delivery, or production database/cache test
was performed in this environment.

## Current stable-CFR / template diagnostics correction

Starting clean HEAD: `c429bab41b3471282a4cad637558630dda1210cf`.
CLI remains **@swiveltechnologies/swico 0.2.9** in both manifests. No applicable
AGENTS.md found. Inspected the worker, tool resolver, state/locking, rights/profile
hashing, tests, CI and operational documentation before editing. The operator's
now-successful Tahoe/MacPorts/Python3.12 setup is supplied evidence, not a developer
installation. Its HTTP 401 is a Render digest-pairing issue, not a protocol bug.
No credential or authentication code changed.

### Root cause and implementation

Reproduced with controlled ffprobe metadata: 496×368, 301 frames, duration 10.034,
nominal 30/1, average 150500/5017. Old probe raised its generic CFR ValueError
after ONE ffprobe call: it never read timestamps. The CLI then hid the explanatory
message behind ValueError/signals=[], with a misleading generic log instruction.
No copyrighted operator source was copied into the repository or used for testing.

- Shared media validator behind `engine.probe()` uses exact rational decoded PTS,
  preferring integer PTS × time_base. Retains nominal FPS only when all timestamps
  support it. Tolerance = min(time_base, 1ms) + 1us, checked for every adjacent
  interval, cumulative phase error and phase-error range. Ordinary 33/34ms cadence
  and 30000/1001 pass; equal headers cannot excuse VFR/drift/duplicates/reversal.
  Nonfinite/invalid rates, existing geometry/duration/frame bounds, nonzero video
  offsets beyond tolerance and incomplete/inconsistent frame counts fail closed.
  Small variation indistinguishable from time-base quantization is explicitly
  bounded, not claimed to be physically distinguishable from sub-resolution VFR.
- Local `templates inspect --file` is read-only (no lock/state write/API), emits
  bounded numeric/cadence data and allowlisted reasons/actions without private paths.
- Explicit `templates normalize --file --output` snapshots locally, validates
  cadence before encoding, uses reviewed absolute tools/file-only protocols and
  passthrough with inverse-FPS encoder time base. No fps filter/-r or implicit
  import conversion; CRF18/slow/H264/yuv420p/faststart, stripped source metadata,
  one compatible audio stream copied. It verifies production probe, same frame
  count/rate/geometry, bounded durations/audio offsets and full decode before an
  atomic no-replace hard-link publication. Failure/interrupt removes its private
  incomplete staging, never source or a concurrent output. Codec interruption
  kills the subprocess before temporary-directory cleanup.
- Import validates the exact bounded private copy, then publishes master/manifest
  together under the existing worker lock. Existing partial or complete template
  directories are refused. No rights/approval/calibration is inherited or asserted.
  Hard-kill residue is hidden staging, not a published template; documentation
  specifies explicit owned-residue inspection rather than deleting unrelated files.
- Added safe TemplateError codes and actual operator actions; no fictitious logs.
  New media/error modules join the existing implementation hash. Real earlier
  template approval/calibration, if present, must be renewed after code changes;
  all original model permission/download gates remain intact.

### Actual tests in this pass

Developer environment: Darwin/x86_64, Python **3.14.7**, existing native FFmpeg
**7.1.1**. NOT the operator's Python3.12.14/MacPorts FFmpeg9.0.1 environment.

| Exact command (repository root unless specified) | Actual result |
|---|---|
| `backend/.venv/bin/python -m pytest swico_video_node/tests/test_template_media.py -q` | **63 passed**, 1.11s; mocked ffprobe/codec contracts and real CLI help |
| `backend/.venv/bin/python -m pytest swico_video_node/tests -q` | **171 passed**, 10.96s; no skips; includes existing real POSIX process-control tests |
| `backend/.venv/bin/python -m pytest swico_video_node/tests/acceptance_media.py -q` | **4 passed**, 39.80s; real validated native codec subprocesses, synthetic pattern/sine inputs only |
| `backend/.venv/bin/python -m compileall -q swico_video_node` | PASS |
| `backend/.venv/bin/python scripts/check-tracked-secrets.py` and same scanner including untracked files | PASS |
| `backend/.venv/bin/python scripts/check-web-product-language.py` | PASS |
| `backend/.venv/bin/python scripts/check-legal-publication.py` | PASS for existing publication metadata, NOT video approval |
| `git diff --check` | PASS |
| 35 Mac runbook shell blocks parsed with Bash and Zsh | PASS; not executed |
| `cd backend; .venv/bin/python -m alembic -c alembic.ini heads` | `20260918_website_video (head)`; source-only, no DB connection |

The first enclosed-suite run hit the host restriction on `ps` in the unchanged
descendant-cleanup test (160 passed/1 host failure). Authorized reruns passed;
no skip or assertion was weakened. Initial real codec tests exposed conflicting
`-r`/passthrough options and a filter-induced last-frame-duration loss; the encoder
path was corrected, not the validation limits. Final real tests run actual public
inspect/normalize/import commands for 301-frame millisecond 30fps, 30000/1001 and
silent video. AAC packet hashes/PTS/durations compare IDENTICALLY before/after.
An additional real synthetic variable-cadence source is rejected by all three
public commands with `template_vfr_unsupported`; no output/import remains.

NOT RUN: operator-source clip, face/model inference, both real-template QA,
operator-Mac FFmpeg9.0.1 acceptance, provider capture/refund, SMTP, deployed-cache
acceptance, new hosted CI or full backend/web/CLI suites. No backend/web/CLI or
workflow files changed. Synthetic codec success is not rights or model acceptance.

### Paths and production impact

- `swico_video_node/{media,template_errors}.py` (new)
- `swico_video_node/{engine,templates,__main__,runtime,models}.py`
- `swico_video_node/tests/{test_template_media,acceptance_media}.py` (new)
- `docs/{VIDEO_MAC_SETUP,VIDEO_ACCEPTANCE,VIDEO_RELEASE_CHECKLIST,VIDEO_IMPLEMENTATION_REPORT}.md`

No migration added, edited or executed: deployed/source head remains
`20260918_website_video`. No commit, push, deploy, API call, template publication,
model download, email, charge/refund, credential rotation or feature enablement.
No price/retention/allowance, chat/voice/subscription/weekly credit, Android,
Windows Free or ordinary CLI change.

Render: keep both video flags false; operator pairs ONLY the existing Mac init
digest in `SWICO_VIDEO_WORKER_TOKEN_SHA256`, applying that actual environment
change normally. No new service or backend code deployment is required for local
media commands. Do not rerun init to replace a token or weaken a 401.

Required release evidence remains genuine model/template/audio rights, exact-content
legal approval, actual full-clip review/calibration, foreground and managed-service
acceptance, complimentary flow, authorized provider TEST/SMTP and cache/expiry
checks. The runbook now orders inspect → optional normalize → inspect → import →
genuine rights/model install/audit → prepare/review → benchmark → metadata →
foreground/LaunchAgent → authorized complimentary/paid acceptance. No automatic
publication/enablement. Retain disabled-admission drain/settlement and financial
history on rollback; never stamp/downgrade the database.

Suggested commit: `fix(video): accept stable CFR templates and improve import diagnostics`

---

## Historical first-run correction (c429bab4, not this pass)

Starting HEAD: `d5e35f8c2cd5f4951cc4830848541f076687e47f`, automated CLI
release **0.2.9**, parent `4e755ff50ffeed4864e7cfa2194bb5fa0a6056a0`.
Both CLI manifests remain 0.2.9. Read the first-run prompt and operator review
completely; no applicable AGENTS.md was found. The supplied prompt/review remain
unmodified user files. No backend, web, CLI, workflow, runtime calibration or
migration change is needed for this scoped fix.

Root cause: the operator opened MacPorts' website but never downloaded/installed
its package. `/opt/local/bin/port` therefore does not exist. PATH and selfupdate
cannot install it. This is independent of model rights, token pairing and DB state.

Implemented a dependency-free Bash 3.2 prerequisite helper and `setup_macos.sh
--check`. It independently reports host/CLT/MacPorts/Python/FFmpeg/ffprobe, handles
native alternative tools and paths with spaces, preserves reviewed tool config,
and stops bootstrap when prerequisites fail. Check-only reads no credential,
imports no worker, and makes no state/host/network change. Ordinary setup keeps
its existing venv/wheel/engine/codec safeguards and never invokes sudo.

The runbook now downloads the exact Tahoe v26 package over HTTPS, verifies the
official release-asset SHA-256 BEFORE explicit operator sudo, installs it and
requires `port version`. Installer control flow is fixture-tested. The full
sequence covers tool setup, preserving init, independent pairing, genuine rights,
both imports/reviews, real benchmarks with second-terminal playback, metadata,
foreground then LaunchAgent acceptance, isolated providers and unchanged rollback.
Nothing runs a privileged installer automatically.

### Evidence from this first-run pass only

Developer host: Darwin 26.6.2/x86_64, existing backend test Python 3.14.7. This is
NOT the operator's Tahoe 26.7/Python 3.12 worker. Shell tests use fixture host facts;
actual process-control tests use disposable local children.

- `backend/.venv/bin/python -m pytest swico_video_node/tests -q`:
  **108 passed in 9.88s**, including 33 new first-run tests. No skips.
  An initial enclosing-sandbox run had 106 pass/1 failure because `ps` was denied
  in an existing process cleanup test; it was rerun with authorization, not skipped.
  One additional relative-state test was added before the final run.
- Focused final rerun: `backend/.venv/bin/python -m pytest
  swico_video_node/tests/test_first_run.py -q`: **33 passed in 2.44s**.
- `bash swico_video_node/scripts/setup_macos.sh --check`: expected exit **1** on
  this developer host; native Intel/CLT and existing FFmpeg/ffprobe detected,
  MacPorts and Python 3.12 missing. No bootstrap/host install/API call followed.
- Both shell entrypoints pass `bash -n`; all **29** runbook Bash blocks pass
  syntax parsing under both `/bin/bash` and `/bin/zsh` (no installation performed).
  `scripts/check-tracked-secrets.py` passes, as does the same scanner over tracked
  plus untracked files. `scripts/check-web-product-language.py`,
  `scripts/check-legal-publication.py` and `git diff --check` pass. The publication
  check validates existing Chat-policy metadata, NOT approval of the video draft.
  All **5** unchanged workflow YAML files parse; actionlint is not installed.
- `cd backend; .venv/bin/python -m alembic -c alembic.ini heads`:
  **20260918_website_video (head)**, source-only check, no database connection.
- Official MacPorts install/port definitions/release-asset metadata rechecked.
  Asset `529636707`, 2.12.6 Tahoe v26 SHA-256
  `ddd90723ba470a688296bb520335e1c7c08835d82df4141e6807b411bc8b78e8`.
  Metadata verification is NOT downloading/installing that package.
- Full backend/CLI/web suites, new hosted CI, native Python 3.12 imports,
  synthetic codec execution, model inference, template QA, provider TEST and SMTP
  delivery were **NOT RUN in this pass**. Prior counts below are historical only.

Supplied hosted main CI **35346729754** passed all seven jobs for the correction
parent, including native Windows/ConPTY. Separate Agent Native Isolation
**35346729719** failed installed Linux coding-agent acceptance after hostile
isolation passed. No workflow was disabled/changed; no new hosted result is claimed.

No migration added/edited/executed; source head remains
`20260918_website_video` (production head from supplied evidence, not queried).
No deploy, commit, push, publish, template upload, credential rotation, provider
charge/refund, customer email, model download or host installation performed.
Pricing, 600-second retention, owner/tester allowances, chat credits, subscriptions,
Android and Windows Swico Free remain unchanged.

Render now: no changes if both video flags already false. Pair only the real
worker digest after preserving init; save/deploy only an actual authorized value
change. No new service or migration. Real rights/publication approval, native
full-clip calibration, foreground/managed rendering, provider/SMTP and cache
acceptance remain release prerequisites. Configurations and hashes cannot supply
them. Retain authenticated drain/settlement for rollback; never downgrade/stamp.

Changed paths: `swico_video_node/scripts/{setup_macos,prerequisites_macos}.sh`,
`swico_video_node/tests/{test_first_run,test_hardening}.py`,
`docs/{VIDEO_MAC_SETUP,VIDEO_ACCEPTANCE,VIDEO_RELEASE_CHECKLIST,VIDEO_IMPLEMENTATION_REPORT}.md`.

Suggested commit: `fix(video): clarify first-run Mac installation and prerequisite checks`

---

## Historical corrective parent (4e755ff5, not this first-run pass)

The 0.2.8 version, test counts, changed paths and then-pending hosted Windows run
below describe that earlier implementation. Current checkout is 0.2.9 and the
subsequent supplied main CI run passed as recorded above.

Starting HEAD: `04cca915041da9968aaff60a2d897c44703d713c`,
`feat(video): add paid template face swaps with an Intel Mac worker`.
CLI package remains `@swiveltechnologies/swico` **0.2.8** in both manifests.
Read `SWICO_VIDEO_PRODUCTION_FIX_CODEX_PROMPT.md` and the independent review in
full. No applicable AGENTS.md was present. Preserved the user's pre-existing
deleted original prompt and untracked correction/review documents.

No deployment, push, publication, customer email, provider charge/refund,
credential rotation, template publication, weight download or production DB
access occurred. Android, Windows inference, CLI runtime, subscriptions,
Chat/Voice/weekly billing, ₹25 video price and 600-second READY retention were
not changed. CLI changes are confined to its developer launcher-preflight harness
and regression tests. Existing CI/artifact/provenance dependencies stay intact.

### Root causes and software corrections

1. Windows preflight rejected a `.js` target using Unix execute bits before its
   version assertion, and its fixture did not represent a Windows launcher.
   Windows now validates the public `.cmd` shim and confined JS target, invokes
   the existing reviewed `cmd.exe` quoting helper, checks exact version and real
   help. POSIX execute/symlink checks remain. Tests include spaces and `&`.
   Actual Windows rerun remains required; this developer Mac is not Windows CI.
2. Mac bootstrap assumed unavailable Homebrew/global Python. It now supports
   MacPorts Python 3.12 (or explicit absolute native interpreter), pip-less venv
   management through py312-pip, binary-only locked wheels, safe reuse/refusal
   of existing environments, resumable pinned engine checkout and full used
   headless dependency-import smoke. It never downloads weights automatically.
3. Both launchd and the sanitized rendering child omitted MacPorts. One reviewed
   absolute-tool resolver now serves foreground, service, templates, benchmark
   and render paths. It checks native slices, executability, versions, binary/
   linked-library hashes and real synthetic libx264 encode/probe/decode. Parent
   secrets are not inherited. Replacement requires explicit review/recalibration.
4. Doctor formerly stopped at missing assets before testing authentication.
   Authenticated read-only health now runs independently with classified errors.
   Backend table presence, singleton initialization, active worker and matching
   templates are independent. LaunchAgent loaded/running/PID/last-exit/liveness
   and backend state are separate; exact full configuration changes require stop.
5. Calibration was not bound to the current execution runtime. Schema 2 binds
   model/code/template/tracks/rights, native host, Python patch/binary, locked
   package RECORD identities, encode policy and reviewed tools/libraries.
   Stale/old/malformed/nonfinite/unreviewed records fail before publication.
   Both templates are validated before any metadata POST. Worker heartbeat and
   backend admission/release checks compare exact profile/runtime/QA identities.
   Already accepted stale attempts settle via existing allowance/refund handling.
6. Rights audit now reports code plus all nine assets and exact local paths;
   genuine permissive licence grants are distinct from restricted-model commercial
   permissions. No approvals supplied. Benchmarks record initial load separately
   from first-render and warm measurements, and private owned scratch is cleaned
   on exit/cancel/next startup. Queue estimates include non-preemptible preflight
   time and publication reserves its bounded share of the deadline.
7. Website validated-job purchase controls now respect worker availability after
   reload. Legal comparison is read-only; published pages/approval stay unchanged.

### Exact actual checks

Developer host: **Darwin 26.6.2 / x86_64**, backend test Python **3.14.7**, Node
**20.19.6**. This is NOT the operator's Intel MacPorts/Python 3.12 video machine.

| Command / environment | Result |
|---|---|
| `cd backend; SWICO_TEST_VALKEY_SERVER=/tmp/swico-video-valkey.aCmjXU/valkey-8.0.2/src/valkey-server .venv/bin/python -m pytest -q` | **2,229 passed, 10 skipped**, 189.87s |
| Same environment, `pytest tests/test_website_video.py tests/test_video_valkey.py tests/test_startup_migrations.py -q` | **58 passed**, 33.97s |
| `TEST_DATABASE_URL=postgresql+psycopg://hari@127.0.0.1:55483/swico_video_test APP_ENV=test .venv/bin/python -m pytest tests/test_video_postgres.py tests/test_website_video.py tests/test_cli_postgres_lifecycle.py -q` (backend) | **56 passed**, 9.26s, actual disposable Postgres |
| `backend/.venv/bin/python -m pytest swico_video_node/tests -q` (root) | **75 passed**, 7.66s, contract mocks plus actual POSIX supervisor/descendant tests |
| `bash -n swico_video_node/scripts/setup_macos.sh` | PASS |
| CLI: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | PASS; **152 tests passed**, zero failures/skips |
| CLI: `npm run release:check -- --keep-artifact` | PASS, canonical clean-prefix installed artifact |
| Web: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test -- --run` | PASS; **592 tests / 45 files** |
| Web: `npx playwright test e2e/videos.spec.ts --project=chromium` | **4 passed**, 11s; real Chromium, mocked API/auth |
| Web: `npm run build` with existing CI public Firebase/API fixtures | PASS |
| Tracked AND untracked secret scan, product-language, legal-publication, 5 workflow YAML parses, `git diff --check` | PASS; actionlint unavailable |

Existing full-suite skips were not turned into passes; actual Postgres cases ran
separately above. Initial sandbox-restricted attempts could not bind fixture
sockets/start disposable Valkey; they were rerun with permission, not skipped or
weakened. The local disposable PostgreSQL server was stopped after the final
head check; its disposable files were preserved. No migration commands were run
against production. Provider and SMTP responses in these suites are
controlled doubles, not provider TEST acceptance or delivered messages.

Canonical artifact: `cli/swiveltechnologies-swico-0.2.8.tgz`.
SHA-256: `9108fe8855f4aa5411ea54c1689cc3a4f2b7e855b86dc402734ef9631c9b34f1`.
Nothing was published. The required GitHub Windows job must rerun on this change;
local artifact success does not assert its result or enable any agent feature.

**Actual local codec evidence:** existing developer Intel FFmpeg 7.1.1 performed
synthetic libx264 encode, ffprobe and full decode through `configure_tools()` in
temporary private storage. FFmpeg binary SHA-256:
`bb47a7e9d1133462d7810f90c92437f1489da3de90cd703090ce0baa3242c2b9`.
This used the developer's existing `/usr/local/Cellar` tool, NOT an installed
MacPorts worker, and is NOT face-model inference. No lasting runtime config made.

**Dependency evidence:** inspected detached FaceFusion
`03d49d0c7de095a41628a74d94a146214f82837a` and direct/transitive headless API use.
`pip download --only-binary=:all: --platform macosx_14_0_x86_64 --python-version 3.12 --implementation cp --abi cp312 -r swico_video_node/requirements-intel.lock`
resolved **16 locked wheels** into a temporary directory. Availability is not
native installation/import/ONNX acceptance. No lock pins or weights changed.

### Migration and operator release status

**No migration added or modified.** Already-deployed head remains
`20260918_website_video`. `alembic heads` and `current` agreed on the disposable
database; fresh/upgrade migration regressions passed. Never downgrade/stamp/reset
the deployed revision. Retain the video-aware payment dispatcher for rollback.

**IMPLEMENTED / TESTED**, but **NOT production-ready**. NOT RUN: native Windows
CI rerun, full native Intel/Python 3.12 MacPorts setup/imports/ONNX inference,
both licensed templates with single/both-role full-clip QA and genuine measured
calibration, foreground/LaunchAgent real-job parity, Razorpay TEST capture/refund,
authorized inbox delivery and deployed-cache policy/load acceptance. Genuine
model/code/template/audio rights and fresh legal publication approval are also
operator prerequisites. No measurements, permissions or approvals were invented.

Exact novice MacPorts/setup/init/rights/templates/benchmark/service commands,
all existing Render values, read-only release checks and rollback:
[VIDEO_MAC_SETUP.md](VIDEO_MAC_SETUP.md). Independent acceptance/evidence classes,
local provider TEST procedure and legal diff/approval workflow:
[VIDEO_ACCEPTANCE.md](VIDEO_ACCEPTANCE.md).

Render NOW: **`SWICO_VIDEO_ENABLED=false` and
`SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false`**; preserve all other product/billing/
weekly-credit values. No new service/cache/cron. Do not rotate credentials:
compare the actual Mac's `init` digest with backend-only configuration as an
explicit operator step. Re-enable only after the separately documented real
acceptance and approval gates. No change was deployed by this pass.

Rollback: disable both video admission flags, retain authenticated drain and
video-aware settlement/refund maintenance, wait out fixed retention, then stop
the Mac if appropriate. No DB downgrade, old payment dispatcher or refund replay.

### Paths changed in this corrective pass

- `cli/scripts/accept-installed-agent.mjs`, `cli/test/installed_agent_harness.test.mjs`
- `swico_video_node/{__main__,bootstrap,calibration,diagnostics,engine,models,runtime,service,storage,templates,worker}.py`
- `swico_video_node/scripts/setup_macos.sh`, `swico_video_node/tests/test_hardening.py`
- `backend/app/video/{router,service}.py`, `backend/scripts/swico_video_release_check.py`, `backend/tests/test_website_video.py`
- `web/src/pages/{VideosPage.tsx,VideosPage.test.tsx}`
- `scripts/video_legal_diff.py`
- `docs/{VIDEO_MAC_SETUP,VIDEO_ACCEPTANCE,VIDEO_RELEASE_CHECKLIST,VIDEO_IMPLEMENTATION_REPORT}.md`

Suggested commit: `fix(video): unblock Intel Mac setup and harden production readiness`

---

## Historical first implementation report (preceding commit, NOT this pass)

The following original counts/migration creation/path list describe the earlier
feature implementation only. The corrective pass and current evidence above
supersede them; no second migration or recreated subsystem was introduced.

## Baseline and outcome

Started at `2e00790859e43277b5c4a36d9033e5b6d189640f` (`fix(cli): correct installed agent launcher acceptance`).
CLI `@swiveltechnologies/swico` remains **0.2.8**, unchanged. The initial untracked
`SWICO_VIDEO_CODEX_PROMPT.md` was read completely and preserved. No applicable
AGENTS.md was present. Android/mobile, CLI, Windows inference, existing weekly
credit settings and subscriptions were not rewritten. No production deployment,
migration, payment, email, model download or template publication occurred.

IMPLEMENTED: website upload/preflight/confirmation/admission, standalone payment and
refund dispatch, independent daily allowances, fenced single-Mac queue, pinned CPU
adapter, explicit model/template review, local benchmarks, chat delivery/deep links,
SMTP outbox, private fixed-expiry media, cleanup, estimates and release checks.
The worker interfaces are runnable Python commands, not an external agent placeholder.

BLOCKED for production: native full-model/full-clip acceptance, actual commercial
rights and both operator templates/photos, fresh video legal publication approval,
provider test-mode acceptance, SMTP deliverability and deployed Valkey policy review.
Both video flags remain default false. No model/quality/timing evidence was invented.

## Migration

One new revision: `20260918_website_video`, directly after
`20260917_cli_cloud_artifacts`. Adds five metadata-only tables:
`video_control`, `video_template`, `video_quota`, `video_job`, `video_outbox`.
PaymentOrder permits the explicit zero-wallet-credit video product with its fixed
2500-paise constraint. No raw media column/table was added.

Fresh/upgrade migration tests passed on disposable SQLite; a fresh disposable
PostgreSQL cluster was migrated through the old head and upgraded to the new head.
`alembic current` on that PostgreSQL database reported
`20260918_website_video (head)`. It was stopped after tests. Production was not queried.
Never downgrade/stamp production or delete financial history for rollback.

## Actual validation

Backend commands run from `backend/`, using its existing `.venv` (Python 3.14.7):

- `SWICO_TEST_VALKEY_SERVER=/tmp/swico-video-valkey.aCmjXU/valkey-8.0.2/src/valkey-server .venv/bin/python -m pytest -q`:
  **2,217 passed, 10 skipped**, 177.96 seconds. Default suite uses disposable SQLite;
  PostgreSQL-only cases were run separately, not counted as passing SQLite cases.
- `TEST_DATABASE_URL=postgresql+psycopg://hari@127.0.0.1:55483/swico_video_test APP_ENV=test .venv/bin/python -m pytest tests/test_video_postgres.py tests/test_website_video.py tests/test_cli_postgres_lifecycle.py -q`:
  **44 passed**, 7.52 seconds, actual disposable PostgreSQL. Includes concurrent
  five-of-six quota grants, exclusive claims, duplicate completion, callback/webhook
  race, and existing CLI lifecycle regression.
- Final video/cache/migration focused rerun:
  `SWICO_TEST_VALKEY_SERVER=/tmp/swico-video-valkey.aCmjXU/valkey-8.0.2/src/valkey-server .venv/bin/python -m pytest tests/test_website_video.py tests/test_video_valkey.py tests/test_startup_migrations.py -q`:
  **46 passed**, 35.40 seconds.
- Real Valkey cache tests: **3 passed** separately, also included above. Official
  Valkey 8.0.2 source was built under /tmp only. Each test starts/stops an ephemeral
  Unix-socket process with no TCP port or persistence; it never connects to the
  existing application cache. Atomic reservation/promotion, binary retries,
  namespace isolation, byte limits and fixed expiry were exercised.
- Signed Razorpay events and SMTP use controlled doubles. They are NOT provider
  test-mode, live payment or inbox-delivery evidence. Structural MP4 fixtures are
  NOT real inference or decoded-quality evidence.

From the repository root:
`backend/.venv/bin/python -m pytest swico_video_node/tests -q`:
**26 passed**, 5.56 seconds. Actual local POSIX tests exercised termination escalation,
descendant cleanup, inherited lock ownership and supervisor-death containment.
Other tests cover command routing, private token rotation, provenance tamper denial,
path escapes, caption handling and runtime-ABI refusal. No weights were loaded.

Web commands from `web/`:
- `npm ci`: passed; existing dependency audit reported 8 findings (4 moderate,
  4 high). No unrelated dependency upgrades/audit fixes were applied.
- `npm run typecheck`, `npm run lint`: passed.
- `npm run test -- --run`: **591 passed, 45 files**, 18.21 seconds.
- `npx playwright test e2e/videos.spec.ts --project=chromium`: **4 passed**,
  9.3 seconds. Actual Chromium, local mocked API/auth—not real customer checkout
  or rendered media. Tests cover login destination, reload/expiry and role-photo
  consent/preflight/admission ordering. Additional ChatPage tests prove owner-job
  deep links consume persisted video cards without chat generation and cannot
  override a newer user navigation.
- Production-style `npm run build`: passed with the existing CI public fixture:
  `VITE_API_BASE_URL=https://api.example.test VITE_FIREBASE_API_KEY=ci-public-test-key VITE_FIREBASE_AUTH_DOMAIN=swico-ci.firebaseapp.com VITE_FIREBASE_PROJECT_ID=swico-ci VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef123456 VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890 npm run build`.
  The first build without Firebase variables correctly refused missing config.

Repository: `git diff --check`, tracked AND new-file high-confidence secret scan,
`check-web-product-language.py`, `check-legal-publication.py`, five workflow YAML
parses and `bash -n swico_video_node/scripts/setup_macos.sh` passed.
Actionlint was unavailable. Existing shared legal policies/approval were restored
unchanged after regression tests exposed that making them unreviewed would unpublish
Chat policies; assertions were not weakened. New amendments are solely in
`videoLegalDraft.json`, explicitly unapproved. The video-only runtime/release gate
requires those pages to receive fresh valid publication approval.

The local video release checker returned **ready=false / exit 1** as required:
schema present, but no approved video policy, configured worker, templates or cache.
No production configuration was used to fill these prerequisites.

## Native/provider evidence and operator prerequisites

Current host diagnostic: Intel x86_64, macOS **26.6.2**, Python **3.14.7**.
`backend/.venv/bin/python -m swico_video_node doctor` correctly returned nonzero:
the separate native Python **3.12** environment is required.

NOT RUN: FaceFusion/ONNX native model imports and full inference, both-template
likeness/temporal/occlusion/audio QA, real warm/cold timings, launchd serving,
real worker/API transfer under interrupted native inference, Razorpay test/live
capture/refund, actual SMTP and deployed Valkey backup/eviction validation.
No commercial grants, source photos, template approvals or benchmark timings supplied.

Model inventory and restrictions are in VIDEO_GENERATION.md. Every asset and engine
code review requires genuine documents and actual hashes. No pretrained asset is
declared commercially cleared by this implementation.

## Render/Mac handoff and rollback

**No Render changes required now; do not enable video.** Keep existing services,
CLI flags, Windows configuration, subscription/Chat/Voice billing, weekly testers
and cron schedules unchanged. Future operator-only steps, ALL exact variables,
secret placement, migration ownership and runnable Mac commands are in
[VIDEO_MAC_SETUP.md](VIDEO_MAC_SETUP.md). No new Render service/cache/cron required.

The new switches are `SWICO_VIDEO_ENABLED=false` and
`SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false` until the corresponding checklist passes.
The worker token is generated locally; only its printed SHA-256 goes to the API.
No backend/provider/database/SMTP secret goes to the Mac/browser.

Rollback is admission shutdown and drain: both flags false, keep the video-aware
API/Mac/authentication alive to settle work and refunds, retain metadata/migration,
wait for fixed output windows/cleanup, then stop the Mac service. Do not roll back
to the old payment dispatcher while video orders exist. No production downgrade,
stamp, deletion, payment retry or legal approval is authorized by this report.

Commit message:
`feat(video): add gated website template videos with Intel Mac rendering and durable billing`

## Changed paths

- `.github/workflows/ci.yml`
- `.gitignore`
- `backend/.env.example`
- `backend/alembic/versions/20260918_website_video.py`
- `backend/app/billing/audit.py`
- `backend/app/billing/razorpay_client.py`
- `backend/app/billing/reconciliation.py`
- `backend/app/billing/schema_readiness.py`
- `backend/app/billing/service.py`
- `backend/app/email_service.py`
- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/video/__init__.py`
- `backend/app/video/cache.py`
- `backend/app/video/config.py`
- `backend/app/video/maintenance.py`
- `backend/app/video/media.py`
- `backend/app/video/models.py`
- `backend/app/video/policy.py`
- `backend/app/video/router.py`
- `backend/app/video/service.py`
- `backend/app/video/transfers.py`
- `backend/app/web_api/chat_service.py`
- `backend/app/web_api/router.py`
- `backend/scripts/swico_video_release_check.py`
- `backend/tests/conftest.py`
- `backend/tests/test_startup_migrations.py`
- `backend/tests/test_video_postgres.py`
- `backend/tests/test_video_valkey.py`
- `backend/tests/test_website_video.py`
- `docs/RENDER_WEB_DEPLOYMENT.md`
- `docs/VIDEO_GENERATION.md`
- `docs/VIDEO_IMPLEMENTATION_REPORT.md`
- `docs/VIDEO_MAC_SETUP.md`
- `docs/VIDEO_RELEASE_CHECKLIST.md`
- `swico_video_node/__init__.py`
- `swico_video_node/__main__.py`
- `swico_video_node/engine.py`
- `swico_video_node/models.py`
- `swico_video_node/requirements-intel.lock`
- `swico_video_node/scripts/setup_macos.sh`
- `swico_video_node/storage.py`
- `swico_video_node/templates.py`
- `swico_video_node/tests/test_node.py`
- `swico_video_node/worker.py`
- `web/e2e/videos.spec.ts`
- `web/src/App.tsx`
- `web/src/billing/paymentPresentation.ts`
- `web/src/components/Conversation.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/src/components/Sidebar.tsx`
- `web/src/content/videoLegalDraft.json`
- `web/src/pages/ChatPage.test.tsx`
- `web/src/pages/ChatPage.tsx`
- `web/src/pages/VideosPage.test.tsx`
- `web/src/pages/VideosPage.tsx`
- `web/src/types/index.ts`
- `web/src/video/VideoCard.test.tsx`
- `web/src/video/VideoCard.tsx`
- `web/src/video/types.ts`
- `web/src/video/video.css`

## Legal publication implementation note

The final video legal candidate is intentionally separate from the already
published canonical Chat policy. `scripts/publish-video-legal.py` performs an
owner-attested, local-only publication: it preserves canonical business/contact
fields, copies only the reviewed video page set, calculates the exact page
SHA-256, validates the candidate with the existing checker, writes mode-0600
backups, and atomically replaces the page and private attestation only after
explicit confirmation. It never claims counsel approval or third-party rights.

The website requires eight explicit source/adult/synthetic-media attestations
under a versioned consent contract. The backend stores the versioned values in
the existing frozen job record and revalidates them at admission. The worker
requires a job-bound opaque provenance ID and disclosure header; the renderer
adds a high-contrast `AI-EDITED / SYNTHETIC MEDIA - SWICO` label and bounded
MP4 metadata. These controls do not replace genuine model, template, performer,
audio or source-face rights evidence.
