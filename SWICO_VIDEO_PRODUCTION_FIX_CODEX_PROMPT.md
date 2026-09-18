# Swico website videos — Intel Mac bootstrap, Windows CI, and production hardening

## Execution instruction

Work from the existing repository root. Inspect the current checkout and its AGENTS.md instructions before editing. Implement this entire corrective change, including code, tests, diagnostics and operator documentation, in one integrated implementation. Do not stop at a plan, a scaffold, a mock UI, or a list of future development phases.

The website-video feature already exists. Extend and repair it; do not implement a second video subsystem. Missing operator-owned model permissions or sample assets must not prevent completion of the software work. However, do not fabricate those prerequisites or claim native inference, payment-provider acceptance, legal approval, or production readiness without real evidence.

Do not deploy, push, publish an npm package, enable live checkout, rotate an existing credential, send customer emails, charge/refund real customers, or overwrite a user's existing environment automatically. Report the exact authorized operator actions after the code is finished. Ordinary source edits and isolated tests are the task.

## 1. Ground truth and current state

The reviewed input was `ai_tool-main(36).zip`. Compare this against the current checkout; preserve newer legitimate changes rather than blindly applying an old patch.

Relevant public commit and actual CI evidence:

- Commit: `04cca915041da9968aaff60a2d897c44703d713c`.
- Commit subject: `feat(video): add paid template face swaps with an Intel Mac worker`.
- CI run: `35336613862`.
- Windows CLI job: `105572804370`.
- Run URL: `https://github.com/swivelit/ai_tool/actions/runs/35336613862`.
- Backend, PostgreSQL lifecycle, web, Ubuntu CLI and macOS CLI jobs succeeded.
- Windows CLI failed during `npm test`, after dependency installation, typecheck, lint and build succeeded.
- The dependent canonical CLI artifact job was skipped.
- Windows runner used Node 22.23.2. It reported 147 passed, 1 failed and 2 skipped tests.

Exact failing test:

```text
installed launcher preflight rejects a wrong version
cli/test/installed_agent_harness.test.mjs:27:1

Expected: /version mismatch/
Actual: Error: installed launcher is not executable:
C:\Users\runneradmin\AppData\Local\Temp\swico-launcher-preflight-...\prefix\lib\swico.js

cli/scripts/accept-installed-agent.mjs:56:46
```

Render has already deployed the video migration. The user's production output was:

```text
python -m alembic -c alembic.ini current
20260918_website_video (head)

python -m alembic -c alembic.ini heads
20260918_website_video (head)
```

The user's video release check was:

```json
{
  "ready": false,
  "checks": {
    "configuration": true,
    "current_legal_publication_approved": false,
    "feature_enabled": true,
    "paid_checkout_enabled": false,
    "worker_token_digest_configured": true,
    "schema": true,
    "worker_current_native_calibration": false,
    "two_templates_published": false,
    "cache_headroom": true,
    "smtp": true,
    "razorpay_configured": true
  }
}
```

The native VIDEO MAC is a different machine from the developer's Mac. Do not confuse their environments:

```text
admin@Admins-MacBook-Pro
/Users/admin/Documents/swico_server/ai_tool
macOS 26.7, build 25G229
x86_64
2.3 GHz quad-core Intel i7, Intel Iris Plus, 32 GB RAM
Command Line Tools: /Library/Developer/CommandLineTools
Git checkout: clean main
Homebrew: not installed
python: command not found
```

The current official Homebrew installer rejected this Intel machine with:

```text
Homebrew on macOS is only supported on Apple Silicon processors!
```

Do not tell this operator to repeat that installer, run `/usr/local/bin/brew`, downgrade macOS, install Rosetta, or replace system Python. The supported provisioning approach for this task is the official MacPorts installer for **macOS Tahoe v26**, then `python312`, `py312-pip`, and `ffmpeg`.

The independent review reran only `python -m pytest swico_video_node/tests -q` in an isolated Linux/Python 3.13.5 environment: 26 passed. This is process/contract test evidence, not Intel Python 3.12 model inference. Do not re-label it as native acceptance.

## 2. Non-negotiable scope and business behavior

Keep the existing architecture:

- Existing Render API and existing `swico-web` static website.
- Existing PostgreSQL and existing `WEB_UPLOAD_CACHE_URL` Valkey instance.
- Existing Windows Swico Free node, unchanged.
- This additional Intel Mac, initiating outbound HTTPS requests to Render.
- No new Render service, cloud GPU, external video provider, tunnel, public Mac port, object-storage service, database, cache, or dedicated new cron.
- Installing a local package manager on the existing Mac is not a new hosted architectural component.

Preserve:

- Website video purchases available to verified signed-in accounts, including Free, independent of CLI tier restrictions.
- Fixed ₹25 = 2500 paise per paid video generation.
- Standalone `video_template` payment product; never credit the chat wallet or alter subscriptions as a side effect.
- `harishajidasan@gmail.com` unlimited complimentary video generations, with normal operational concurrency and abuse limits.
- Existing weekly ₹40 tester cohort: five complimentary video attempts per day, separate from their weekly chat credits, reset using configured Asia/Kolkata timezone.
- A retry is not a new charge or allowance consumption. Infrastructure failures settle/refund or restore allowance exactly once according to the existing contract.
- One processing job at a time on this Mac; queue additional accepted requests.
- Templates remain permanently on the Mac. Publish only bounded approved metadata/icons and measured timings, not original clips or faces.
- Correct separate source identities; either one role or both; no averaging the identities, demographic inference, or changing unrelated background faces.
- User instructions affect only implemented options. Do not claim arbitrary text-to-video behavior.
- READY output availability is an immutable 600 seconds. Existing chat upload retention remains unchanged.
- Existing SMTP sends an authenticated website link and expiry; no video email attachment, raw token URL, or renewal of expiry on retries.
- Payment failure/refund handling remains durable through worker loss and process restart.
- Android/mobile, unrelated CLI runtime features, Windows inference, voice, chat billing and weekly tester credits remain unchanged.

The Windows CLI harness fix below is intentionally in scope because it is the actual failing required CI check. Do not expand it into a new CLI feature release.

## 3. Inspect these existing paths first

At minimum inspect:

```text
.github/workflows/ci.yml
cli/scripts/accept-installed-agent.mjs
cli/test/installed_agent_harness.test.mjs
cli/scripts/release-check.mjs
cli test/helper files for Windows launcher quoting and ConPTY
swico_video_node/scripts/setup_macos.sh
swico_video_node/requirements-intel.lock
swico_video_node/__main__.py
swico_video_node/storage.py
swico_video_node/models.py
swico_video_node/engine.py
swico_video_node/templates.py
swico_video_node/worker.py
swico_video_node/tests/test_node.py
backend/app/video/
backend/scripts/swico_video_release_check.py
backend video/payment/refund/cache tests
backend existing billing webhook, reconciliation and audit entrypoints
web video routes, forms and chat video components/tests
web/src/content/legalContent.json
web/src/content/videoLegalDraft.json
scripts/check-legal-publication.py
docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md
docs/VIDEO_MAC_SETUP.md
docs/VIDEO_IMPLEMENTATION_REPORT.md
```

Locate files rather than assuming a helper path exists. Inspect the exact FaceFusion revision referenced by the current lock/manifest. The reviewed pin is `03d49d0c7de095a41628a74d94a146214f82837a`.

## 4. Correct Windows launcher validation and its tests

The current validator checks `(targetStat.mode & 0o111) === 0` unconditionally. The fixture creates a POSIX-style shebang JavaScript target and symlink, including on Windows. This rejects before the wrong-version assertion is exercised.

Implement platform-appropriate validation and fixtures. Preserve a meaningful wrong-version rejection test on Windows as well as on POSIX. Do not simply weaken the expected regex to accept any exception, disable the job, or make it `continue-on-error`.

Requirements:

1. Retain path confinement to the intended installation prefix, regular-file/target checks, broken-target detection, exact version checks, and actual `--help` behavior.
2. Apply POSIX execute-bit/shebang launch requirements to the appropriate POSIX launcher. Do not emulate Unix executable permissions on Windows.
3. Use genuine Windows launcher/shim semantics where Windows is supported. Reuse the repository's already-reviewed safe Windows invocation/quoting helpers where applicable. Handle spaces and command-boundary characters safely.
4. Merely removing the mode check is insufficient: do not try to execute a raw `.js` file as a native Windows executable with `execFile`. A direct Node invocation may be used for a clearly labelled JS-target unit test, but is not proof that the installed public shim works.
5. Keep the Linux installed-agent/sandbox acceptance harness truthful about its supported platforms. Do not claim successful Windows sandbox-agent execution from these launcher tests.
6. Add passing-version/help tests and wrong-version/missing-target/path-escape tests for relevant platforms. Preserve POSIX non-executable and broken-symlink tests. Platform-specific skips are only for genuinely inapplicable semantics, not the failed version check itself.
7. Run CLI typecheck, lint, build and tests. Request or document the real Windows CI result if it cannot execute locally. Do not describe mocked `process.platform` as a native Windows pass.
8. Preserve canonical-artifact dependency gates and release identity. Do not publish or bump CLI 0.2.8 solely to fix an unshipped test/developer harness unless current release tooling explicitly requires a reviewed change.

## 5. Make Intel Mac bootstrap work without Homebrew

Repair `setup_macos.sh` and all related operational docs.

The operator should be able to install prerequisites using:

```bash
open "https://www.macports.org/install.php"
# Install the official macOS Tahoe v26 package through the macOS installer.
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
sudo /opt/local/bin/port selfupdate
sudo /opt/local/bin/port install python312 py312-pip ffmpeg
```

The setup script must support the native MacPorts Python at `/opt/local/bin/python3.12`, plus another explicitly selected verified native Python 3.12 if already installed. Keep the existing no-argument command operational after the MacPorts PATH export:

```bash
bash swico_video_node/scripts/setup_macos.sh
```

Provide explicit optional interpreter selection if useful, but implement and test any new argument before documenting it.

Requirements:

- Detect native Darwin/x86_64, Python major/minor 3.12, and distinguish an actual Intel host from a translated process where possible. Report architecture and interpreter path.
- Locate both FFmpeg and ffprobe. Check executability, version and the required `libx264` encode/decode functionality with an innocuous generated fixture. An import-only or `--version` test is not an encode test.
- Use the repository's isolated `.venv-video`; never install into the Render backend environment or system Python.
- Account for the package manager's venv/pip behavior. Verify `venv` and pip actually work. When a provider disables ensurepip, use a supported documented bootstrap with the already-installed `py312-pip`; do not tell users to run `sudo pip` or pipe an arbitrary bootstrap into Python.
- Detect an incompatible pre-existing `.venv-video` and explain it. Do not silently delete it or overwrite an active service's environment. Cleanly reuse a matching environment.
- Keep native compatible locked binary wheels. Verify the complete current dependency set for macOS x86_64/Python 3.12. Report missing wheels or incompatible pins precisely; do not silently pull ARM-only latest packages or rebuild the world from source.
- Inspect the full pinned headless FaceFusion import path for missing dependencies/API incompatibilities. The current setup only imports ONNX Runtime; improve the smoke checks without downloading models or asserting inference success.
- Preserve the pinned upstream code identity, upstream notices, local-only weights and checksum verification. No unreviewed floating master checkout.
- Make interrupted setup resumable without silently adopting a dirty/wrong engine checkout.
- Print clear categories: prerequisite installation, dependency import smoke, model files/permissions, template review, native calibration, API authentication. Never print all-ready after only dependency imports.
- No Homebrew auto-install, administrator Python package installation, global interpreter aliases, PATH contamination with the current directory, Gatekeeper/SIP disabling, or hidden system reconfiguration.

## 6. Fix executable discovery in BOTH service and rendering child

Two existing hardcoded PATHs omit MacPorts. Fix both, not just the terminal or plist:

```text
swico_video_node/__main__.py service install:
  PATH=/usr/local/bin:/usr/bin:/bin

swico_video_node/worker.py execute child environment:
  PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
```

Prefer a small shared, tested runtime-tool resolver with validated absolute FFmpeg/ffprobe paths. Store only non-secret runtime configuration, or deterministically rediscover approved native tool locations. Pass the chosen paths intentionally through the minimal worker/child configuration. Do not restore the entire parent environment to fix PATH.

Requirements:

- The foreground worker, `_process` child, template import/preparation, benchmark, and LaunchAgent must invoke the same reviewed tools under a minimal environment.
- `/opt/local/bin` must work even when launchd starts with only `/usr/bin:/bin` and no interactive shell configuration.
- Validate missing tools, wrong architecture, non-executable files, paths with spaces, and unexpected tool replacement. Reject untrusted relative locations.
- Keep provider/API/cloud/SSH/npm/SMTP secrets out of rendering children. The child receives local inputs and needed runtime configuration, not the worker's bearer token.
- Preserve owned-process-group termination, parent-death pipe supervision, inherited lock and descendant cleanup. No global `pkill` or broad process termination.
- Capture bounded, redacted local diagnostics for import, ONNX load, FFmpeg startup and encoding failures. Current blanket `render_failed`/DEVNULL behavior is not enough to troubleshoot a fresh machine.
- Do not log uploaded photos, face embeddings, raw tokens, full customer prompts, request headers or customer email addresses. Keep public error messages safe and useful.
- Record an absolute video Python executable in the LaunchAgent; do not depend on `python` existing globally.
- Make service install/update idempotent and preserve credentials/templates. Stop/drain an existing worker explicitly before changing its runtime.
- Expose loaded, running/PID, last exit, local liveness and backend authenticated/ready states separately. The existing `launchctl print` return code only proves the job is loaded; it must not be labelled healthy/running by itself.
- Add bounded startup stdout/stderr logs or equivalent diagnostics with private permissions and rotation, in addition to the running worker log.
- Explain user LaunchAgent login behavior and laptop sleep/offline behavior. Do not claim the process survives shutdown or starts before login.

## 7. Make doctor and credential pairing independently diagnosable

`init` currently creates protected local credentials and prints only their SHA-256 digest. Preserve its idempotent behavior. The operator's Render flag `worker_token_digest_configured=true` does not establish that the backend digest matches this new Mac.

The current `doctor --check-api` returns early when model/template prerequisites are missing, so it cannot diagnose credential pairing independently. Fix it.

The following must report useful independent results even with no weights or templates:

```bash
.venv-video/bin/python -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
.venv-video/bin/python -m swico_video_node doctor --check-api
```

Requirements:

- `init` stdout remains only the digest needed by Render; secret remains in mode-0600 local storage.
- `doctor --check-api` can make the bounded authenticated read-only worker `/health` request even if native readiness is false.
- Separate authentication success from worker active, schema/control-row initialization, missing assets and template calibration. An absent initial control row is not necessarily a missing SQL schema.
- Return structured checks, actionable blockers and overall false readiness until all required gates pass. No traceback/credential dump.
- Distinguish DNS/TLS/network timeout, 401/403 mismatch, 404 API not deployed, and response-contract errors.
- Preserve HTTPS, origin binding and redirect refusal. Never put the token in a query string, command line, frontend environment variable, or diagnostic output.
- Both feature flags may remain false while authentication, local preparation and metadata publication are checked. Do not use a paid customer job as a health probe.

## 8. Bind calibration to the runtime that will actually render

Inspect and fix the following gap before saying `native_inference_verified=true`:

- `templates.benchmark()` records runtime/OS/machine fields.
- `templates.approved(calibrated=True)` currently checks the approval hash and presence of off/natural variants but does not compare the recorded runtime against the current runtime.
- `worker.readiness()` separately validates some installed versions but does not enforce that the benchmark used the current Python patch/toolchain.
- FFmpeg/ffprobe identity is not presently part of the calibration binding.
- `templates.publish()` must not publish stale timing/QA records after a runtime change.

Implement a versioned, bounded calibration schema tied to relevant model and code hashes, template/tracks/rights, native architecture, Python/runtime package identity, execution/quality settings, and reviewed FFmpeg/ffprobe identity. Define precisely which changes invalidate calibration and which only change the location of equivalent verified files.

Do not merely update old records' hashes to match a new environment. Require genuine reruns and renewed output review when render-affecting identity changes. Invalidate old heartbeat readiness and reject new admission for stale profiles. Preserve compatible draining of already accepted jobs or settle them safely.

Validate calibration structure, positive finite durations, minimum actual sample counts, native platform identity and both supported enhancement variants. Reject missing, stale, malformed, NaN/infinite, or manually half-populated records. Record actual elapsed times only.

Check the backend readiness logic for matching current worker profile and template metadata, not just two template IDs existing. Keep server admission and release diagnostics consistent. Do not assert that a trusted worker's self-report constitutes independently observed scientific or legal proof.

Include regressions for Python/runtime/tool changes, old schema, missing variants, wrong template/model hash and stale backend metadata. Retain normal model/template approval integrity.

## 9. Make rights/template preparation usable without inventing approval

The current pipeline has nine model assets plus code provenance. Audit the actual dependency closure; do not assume clearing the swapper clears every other model.

The reviewed list was:

```text
inswapper_128.onnx
arcface_w600k_r50.onnx
retinaface_10g.onnx
2dfan4.onnx
fan_68_5.onnx
dfl_xseg.onnx
bisenet_resnet_34.onnx
gfpgan_1.4.onnx
open_nsfw.onnx
```

Preserve explicit, genuine permissions/checksums before installing restricted weights. Improve `models audit` so it lists all missing fields/assets and exact local manifest locations instead of making the operator discover one blocker at a time.

Add a usable local-only manifest help/report or interactive preparation command if necessary. Any new interface must be implemented, tested and documented. It may record documents supplied by the operator and hash actual files, but it may not manufacture permission letters, insert an approver's name/date, infer commercial permission from an MIT code license, or auto-approve video/audio rights.

For permissively licensed components, a genuine applicable license grant with its conditions may be adequate; do not invent a requirement to buy a separate grant for every asset. For restricted assets, clearly distinguish missing commercial permission from a missing technical download/checksum. An owner attestation is not a substitute for a right holder's required permission.

Keep restricted assets and original clips out of Git and out of hosted metadata/logs. Do not automatically download missing models while handling a paid request.

Review both actual operator-owned templates, including cuts, background faces, hands/cups/occlusions, eye/mouth stability and audio. Keep the existing role selection human-reviewed; improve local review usability and error messages where necessary. No automatic demographic role assignment.

Preserve optional single-role operation even though each two-person template has both role maps. Demonstrate no identity mixing and no unintended changes to excluded people. Validate enhancement and caption behavior against the actual pinned APIs and before payment.

The full benchmark is expensive: the reviewed implementation runs both off/natural variants, one preliminary full render plus `runs` warm renders each, for both templates. With `--runs 3`, that is 16 full render calls, not three total. Explain the actual command's work and maintain meaningful separate startup/cold/warm measurements. Verify those labels correspond to actual engine/process reuse; do not call a reused warmed session a fresh cold start without qualification.

Clean temporary benchmark outputs on normal exit, cancel and next startup after a crash using narrowly owned/private directories and a bounded retention policy. Do not sweep arbitrary user files or the permanent approved templates.

## 10. Preserve queue, payments, delivery, and honest readiness

Keep the existing fixed-price payment product and durable billing state. Add targeted regressions rather than rebuilding it.

Verify:

- Eligibility and source validation happen before payment.
- Cross-account access to photos, jobs, results and chat deep links is denied.
- Idempotent capture, webhook/callback replay, late capture, order/job association and amount/currency/product checks.
- No wallet top-up or subscription fulfillment for video purchases.
- Refund pending/processed/failed are truthful and retries cannot double-refund or double-restore allowances.
- Backend/offline cancellation preserves accepted-order settlement; disabling the UI does not discard accepted jobs/refunds.
- Verified owner exemption and five daily tester attempts, including concurrency and day rollover, do not affect chat-credit accounting.
- Busy preflight work uses the same Mac as paid rendering. Estimates/admission must not ignore that load or let preflights starve accepted paid jobs.
- Estimates use measured current-profile durations and show uncertainty; no hardcoded promises or silent quality downgrade.
- Worker stale/mismatch/full queue/no cache space disables new purchases rather than charging an impossible job.
- Calibrated maximum runtime, queue capacity and total job deadline are mutually consistent. The current publication code rejects timings exceeding its bounded-queue budget; explain actionable capacity adjustments after measurements, not arbitrary deadline inflation.
- Media cache namespace/TTL/budget, 600-second READY expiry, original fixed ready_at/expires_at, no download after expiry, no timer reset, bounded local cleanup and existing chat retention.
- Email goes to the verified signed-in account, links to authenticated job/chat, contains correct expiry and never attaches the MP4. Email delay/retry does not change the output deadline.
- Browser refreshing/resuming jobs and output expiration remain correct. Recoverable preflight/setup failures have useful user messaging.

The current release checker intentionally excludes `feature_enabled` and `paid_checkout_enabled` from its required readiness tuple. Preserve the ability to validate technical prerequisites with checkout disabled. Do not make switching on live payments a prerequisite for testing readiness.

Report configuration, observed technical checks and manual/provider acceptance separately. `smtp=true` means configured, not delivered; `razorpay_configured=true` is not a successful capture/refund; `cache_headroom=true` is not a persistence or load test; a digest being configured is not proof of authentication.

A read-only release check must not send emails, create payment orders/refunds, run face inference on customer photos, mutate approvals, or silently publish templates.

Provide explicit test-mode acceptance helpers/runbooks for an isolated local backend/disposable resources using operator-authorized provider test credentials. Do not replace live Razorpay keys on the existing production service just to run tests. Keep mocked tests labelled as mocked. Do not create another hosted service for testing.

## 11. Legal publication and production migration handling

`backend/app/video/policy.py` currently requires the published legal pages to match `videoLegalDraft.json` and pass the existing content-bound approval validator. Existing Chat policies were intentionally left approved and unchanged.

Do not toggle a made-up `LEGAL_APPROVED=true` environment variable, reuse the old content fingerprint, fabricate legal approval, or replace the published pages with an unreviewed draft. Produce a readable change comparison and precise owner/counsel approval workflow based on the existing validator. Record fresh approval only when the user actually provides it for the exact new content. Preserve truthful owner-attested versus counsel-reviewed labels.

Model/template rights and legal-page publication approval are different prerequisites; neither substitutes for the other.

The deployed database is already at `20260918_website_video`. Do not edit that migration in place, downgrade, stamp, reset, or drop tables. Prefer no new migration for this hardening change. If a data-model change is genuinely required, add one safe forward migration, document the deployed baseline, test upgrades and preserve accepted jobs/payment records.

Do not revert to the pre-video payment dispatcher while video orders exist. Rollback instructions should disable new admission, drain/settle accepted work, then stop the Mac if appropriate, preserving the compatible backend.

## 12. Required tests and evidence

Add focused tests reproducing defects before fixing them, then run applicable suites:

- Windows/platform launcher fixture and validation tests; CLI typecheck/lint/build/full unit suite.
- Mac bootstrap shell validation and temporary-path fixtures: missing brew, only MacPorts tools, wrong Python minor/architecture, unusable pip, incompatible existing venv, paths with spaces, interrupted engine clone, unavailable wheels.
- Minimal-environment tool resolution for both LaunchAgent and actual rendering-child construction; missing ffmpeg versus missing ffprobe, required encoder smoke failure and no secret environment inheritance.
- LaunchAgent install/update/status/stop behavior; loaded-but-not-running classification; private log setup.
- Doctor authenticated read-only probe even when models/templates are absent; redaction and network/HTTP error classification.
- Model and calibration stale-identity/structure tests and backend profile-mismatch readiness/admission tests.
- Process supervision, cancellation, descendants and parent death; no regression from current real-process tests.
- Benchmark crash residue cleanup confined to owned files.
- Backend video, cache, migrations, billing, allowances, retention, legal/publication and existing regression suites.
- Real disposable PostgreSQL/Valkey tests where available; no production database mutation.
- Web typecheck/lint/unit/build and relevant browser acceptance for unavailable/setup states, admission, polling, output and expiry.
- Secret scans, product-language/legal-publication checks, workflow validation and `git diff --check`.

Use native macOS x86_64/Python 3.12 evidence only from that actual environment. A macos-latest CI label, mocked platform, CPUExecutionProvider listing, a synthetic ONNX graph, a Linux test or an ARM Mac is not proof of this full native pipeline.

Run a genuine face swap only when authorized local templates/photos and valid permissions are present. Otherwise finish all code, run all feasible non-inference tests, and report the exact remaining native commands and expected evidence without claiming success.

Do not silently skip a failing supported test, replace assertions with tautologies, self-sign approvals, invent timings, or manually set `native_inference_verified=true` to get a green check.

## 13. Operator runbook to deliver

Update `docs/VIDEO_MAC_SETUP.md`, `docs/VIDEO_IMPLEMENTATION_REPORT.md` and an appropriate acceptance/diagnostics document. Provide exact runnable commands for the implemented interfaces, labelled by machine and prerequisites.

Render now:

```dotenv
SWICO_VIDEO_ENABLED=false
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
```

Preserve all existing database, Valkey, Razorpay, SMTP, CLI, subscription and weekly chat-credit variables. Existing intended values remain:

```dotenv
SWICO_VIDEO_PRICE_PAISE=2500
SWICO_VIDEO_OUTPUT_TTL_SECONDS=600
SWICO_VIDEO_UNLIMITED_EMAILS=harishajidasan@gmail.com
SWICO_VIDEO_TESTER_DAILY_LIMIT=5
SWICO_VIDEO_DAILY_RESET_TIMEZONE=Asia/Kolkata
SWICO_VIDEO_WORKER_STALE_SECONDS=45
SWICO_VIDEO_MAX_INFLIGHT_JOBS=6
SWICO_VIDEO_MAX_ACTIVE_PER_USER=1
SWICO_VIDEO_MAX_JOB_AGE_SECONDS=14400
SWICO_VIDEO_MAX_OUTPUT_BYTES=16777216
SWICO_VIDEO_CACHE_BUDGET_BYTES=134217728
SWICO_VIDEO_PUBLIC_WEB_ORIGIN=https://swico.in
```

The digest must be copied from this Mac's actual `init` stdout to backend-only `SWICO_VIDEO_WORKER_TOKEN_SHA256`; never print/copy the raw token. Capacity/cache values are application ceilings, not proof of available RAM or achieved throughput.

Mac runbook starts at the existing checkout (no re-clone):

```bash
cd /Users/admin/Documents/swico_server/ai_tool
git status --short
# When clean and the completed fix has been pushed by the operator:
git pull --ff-only
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
bash swico_video_node/scripts/setup_macos.sh
source .venv-video/bin/activate
.venv-video/bin/python -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
.venv-video/bin/python -m swico_video_node doctor --check-api
```

Document genuine rights/model installation, both template imports, exact local manifest preparation, frame review, benchmark and publication commands with all intermediate stop conditions. Keep currently documented command names operational or provide a clear tested compatibility migration.

After real prerequisites are complete:

```bash
.venv-video/bin/python -m swico_video_node models audit
.venv-video/bin/python -m swico_video_node templates publish --all
.venv-video/bin/python -m swico_video_node doctor --check-api
caffeinate -is "$PWD/.venv-video/bin/python" -m swico_video_node run
```

Explain stopping the foreground worker before installing the LaunchAgent. Test the same actual job execution path under the managed service, not only in the interactive terminal.

Render checks after an operator-authorized deployment:

```bash
cd /opt/render/project/src/backend
python -m alembic -c alembic.ini current
python -m alembic -c alembic.ini heads
python -m scripts.swico_video_release_check --pretty
python scripts/weekly_tester_credit_check.py --pretty
python scripts/swico_cli_release_check.py --pretty --public
```

Check script arguments against the actual checkout before publishing the runbook. Preserve existing pre-deploy migration ownership and working build/start commands. Do not install the Mac inference requirements on Render.

Only after approved legal publication, rights, native full-clip QA/calibration, current worker/metadata, CI, provider test capture/refund, authorized email delivery and expiry/capacity acceptance should the operator enable the feature, verify authorized complimentary flows, then explicitly enable paid checkout. This is release authorization for one completed implementation, not staged feature development.

## 14. Primary references for verification

Check current primary sources before modifying platform/dependency instructions. Do not copy third-party installer commands or rely on stale recollection:

```text
https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh
https://www.macports.org/install.php
https://ports.macports.org/port/python312/
https://ports.macports.org/port/py312-pip/
https://ports.macports.org/port/ffmpeg/
https://nodejs.org/docs/latest-v22.x/api/fs.html
https://nodejs.org/docs/latest-v22.x/api/child_process.html
https://github.com/facefusion/facefusion/tree/03d49d0c7de095a41628a74d94a146214f82837a
https://github.com/deepinsight/insightface
https://render.com/docs/configure-environment-variables
```

Record source revisions/download fingerprints when relevant. Upstream code licenses and pretrained-weight permissions are not interchangeable.

## 15. Final response required from Codex

Provide:

1. Reproduced root causes and implemented corrections, with changed paths.
2. Exact test commands/results, operating systems/architectures/interpreters, and a clear distinction between mocked, real-process, disposable-service, native-model and provider acceptance evidence.
3. Migration impact relative to already-deployed `20260918_website_video`.
4. Exact Render settings to change now, settings to preserve, and gates for later authorized checkout.
5. Exact Intel Mac/MacPorts setup, digest pairing, model/template preparation, benchmark and service commands for the implemented code.
6. Every remaining operator prerequisite, with no fabricated approval or production-ready verdict.
7. A suggested commit message. Do not commit/push/publish/deploy unless separately authorized.

Suggested subject, adjust only to match actual changes:

```text
fix(video): unblock Intel Mac setup and harden production readiness
```

Finish the complete software correction. The final result should make it possible to provision, diagnose, validate and operate this existing Intel worker safely, while keeping paid production disabled until genuine acceptance is complete.
