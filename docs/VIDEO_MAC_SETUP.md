# Intel Mac video worker — MacPorts and production-hardening runbook

This is the existing Mac + existing Render API/website/PostgreSQL/Valkey architecture.
No new service, cache, cron, GPU, public Mac port or tunnel. Do not enable paid video
until [VIDEO_ACCEPTANCE.md](VIDEO_ACCEPTANCE.md) is complete. The migration is
ALREADY deployed at `20260918_website_video`; do not downgrade, stamp or reset.

## Render NOW (operator only; no deployment was performed)

Open Render → existing API service → Environment. Set BOTH:
```dotenv
SWICO_VIDEO_ENABLED=false
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
```

Save using your normal authorized deployment procedure. Do not change the existing
database, Valkey URL, Razorpay keys, SMTP, CLI, subscriptions, Chat/Voice or weekly
tester-credit settings. No Mac inference package belongs on Render.

Preserve these existing application ceilings (not achieved-throughput evidence):
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

`SWICO_VIDEO_WORKER_TOKEN_SHA256` must match the digest from THIS Mac's init.
Pairing a different token invalidates an old worker: stop/drain an old worker first,
then explicitly authorize copying the new digest. Never rotate credentials to debug.
No raw token in Render, website variables, command arguments, plist or emails.

## 1. Existing Intel video Mac: prerequisites

The video Mac is `admin@Admins-MacBook-Pro`, macOS Tahoe v26, native Intel x86_64.
It is NOT the developer test machine. Use the official
[MacPorts Tahoe installer](https://www.macports.org/install.php); verify its official
checksum/signature. Do not retry the now ARM-only Homebrew installer, install
Rosetta, change system Python, disable Gatekeeper/SIP or enable auto-login.

```bash
open "https://www.macports.org/install.php"
# In the browser select the official macOS Tahoe v26 package; run its installer.
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
sudo /opt/local/bin/port selfupdate
sudo /opt/local/bin/port install python312 py312-pip ffmpeg
uname -m
sw_vers
xcode-select -p
```

Official port definitions: [python312](https://ports.macports.org/port/python312/),
[py312-pip](https://ports.macports.org/port/py312-pip/),
[ffmpeg](https://ports.macports.org/port/ffmpeg/).
If Command Line Tools are missing, use Apple's `xcode-select --install`.

## 2. Existing checkout, isolated environment, tooling

```bash
cd /Users/admin/Documents/swico_server/ai_tool
git status --short
# ONLY when clean, after the operator has pushed/reviewed the completed correction:
git pull --ff-only
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
bash swico_video_node/scripts/setup_macos.sh
source .venv-video/bin/activate
```

An already installed alternative native interpreter may be selected explicitly:
```bash
bash swico_video_node/scripts/setup_macos.sh --python /absolute/path/to/python3.12
```

Setup checks Darwin/x86_64 and Rosetta, actual interpreter ABI, FFmpeg/ffprobe
native slices, versions, hashes and linked non-system libraries. It performs an
innocuous libx264 encode + ffprobe + decode, NOT face inference. It creates a
pip-less `.venv-video`, then uses installed `py312-pip`'s supported
`--python .venv-video/bin/python` management if venv pip is absent. No sudo pip or
get-pip script. It downloads only locked binary wheels, installs offline from that
resolved set, runs pip check and imports the complete used headless FaceFusion path.
Failure names the missing wheel/import; there is no source-build/ARM/latest fallback.

A matching existing venv is reused. An incompatible/partial venv or dirty/wrong
engine checkout is refused without deletion/reset. Explicitly stop the worker and
inspect/archive the exact old directory yourself before recreating. An empty,
interrupted engine init/fetch can resume. Source remains pinned at
`03d49d0c7de095a41628a74d94a146214f82837a`, including upstream notices.
No model downloads occur in setup or paid-job handling.

Non-secret reviewed tool configuration is stored in `runtime-tools.json` below.
Foreground, LaunchAgent, benchmark, template analysis and the sanitized rendering
child use the SAME absolute tools. Interactive PATH alone is insufficient.

```bash
.venv-video/bin/python -m swico_video_node tools status
# Only after explicitly stopping the worker, when deliberately selecting/reviewing tools:
.venv-video/bin/python -m swico_video_node tools configure --ffmpeg /opt/local/bin/ffmpeg --ffprobe /opt/local/bin/ffprobe
```

Tool replacement fails closed. Changed binaries/libraries/Python/package identity
requires genuine re-calibration; do not edit old benchmark hashes. Moving identical
verified tool bytes and libraries without changing identity does not invalidate it.

## 3. Init and independent authentication

```bash
.venv-video/bin/python -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
.venv-video/bin/python -m swico_video_node doctor --check-api
```

Init stdout is ONLY the SHA-256 digest. It reuses existing protected credentials.
Copy that digest, not the raw token, into the existing backend-only variable.
Local state: `~/Library/Application Support/SwicoVideo`, private directory 0700,
`worker.token` 0600. Optional `SWICO_VIDEO_DATA_DIR` selects isolated test storage;
never accidentally point a test or a second worker at production credentials.

Doctor attempts read-only authenticated `/api/video-worker/v1/health` EVEN with
missing models/templates. It distinguishes local configuration, DNS, TLS, timeout,
connect failure, 401 mismatch, 403 forbidden, 404 not deployed and contract errors.
No redirects or insecure TLS. It separates schema present, control initialized,
worker active, matching published templates and local runtime/calibration. A missing
control row is not a missing table. Remain disabled and investigate initialization;
do not stamp/downgrade. A configured Render digest alone is NOT authentication proof.

An overall false doctor result is expected until local AND backend gates pass.
No paid request or SMTP send is used as a health probe.

## 4. Genuine rights and complete model inventory

```bash
.venv-video/bin/python -m swico_video_node models audit
```

The report names `models.json`, `rights/`, code review and ALL nine assets with
missing fields/files. Edit that local manifest, not repository assets. For each
asset and code review supply genuine reviewer/date and documents:
`reviewer`, `reviewed_at` (YYYY-MM-DD), `licence_file`, `licence_sha256`,
`permission_file`, `permission_sha256`. Document paths are relative to `rights/`.
Supply actual independently verified model `sha256`; fixed provenance URLs cannot
be substituted. `shasum -a 256 /absolute/path/to/document` hashes an actual document;
it does not grant rights.

For genuinely permissive components an applicable licence with its conditions may
serve as the permission basis: explicitly set `permission_basis=applicable_licence`
and retain reviewer/date/licence document/hash. This is NOT accepted for the three
restricted InsightFace pretrained swapper/embedding/detector assets; those require
actual right-holder commercial permission. A code MIT licence or owner attestation
cannot grant restricted weights. Review conversion, distribution and service-use
conditions for every remaining model; no grant is supplied by this repository.

Inventory: inswapper_128, arcface_w600k_r50, retinaface_10g, 2dfan4, fan_68_5,
dfl_xseg, bisenet_resnet_34, gfpgan_1.4, open_nsfw (all .onnx).
Imported classifier modules are not invoked or loaded; no demographic classifier.

After actual permissions and hashes have been supplied:
```bash
.venv-video/bin/python -m swico_video_node models install --profile quality-cpu
.venv-video/bin/python -m swico_video_node models audit
```
Audit must pass. Restricted assets/documents stay local and out of Git.

## 5. Both real templates and human track review

Replace paths with your licensed original clips (not bundled examples):
```bash
.venv-video/bin/python -m swico_video_node templates import --id couple-01 --file /path/to/first.mp4 --title "Couple scene 1"
.venv-video/bin/python -m swico_video_node templates import --id couple-02 --file /path/to/second.mp4 --title "Couple scene 2"
.venv-video/bin/python -m swico_video_node templates prepare --id couple-01
.venv-video/bin/python -m swico_video_node templates prepare --id couple-02
```

Initial masters: CFR, even 64–1920px, 1–30sec, 1–60fps. Caption: printable ASCII,
100 characters. Unsupported input/options are rejected before checkout.

In each `templates/couple-0N/manifest.json`, fill the `rights` object with the same
genuine document fields above covering VIDEO modification/distribution AND AUDIO.
Inspect ALL numbered images under `review/` locally; correct/split erroneous
associations in `tracks.json` before approval. Human roles male/female/exclude are
not identity/gender predictions. Both maps are required; jobs may select only one.
Background faces remain excluded. Never upload original clips/frames/embeddings.

```bash
.venv-video/bin/python -m swico_video_node templates review --id couple-01
.venv-video/bin/python -m swico_video_node templates review --id couple-02
```
Approve only after inspecting every cut, hands/cups, occlusion, eyes/mouth,
background exclusion and audio rights. Changes invalidate approvals. Software
cannot replace that inspection or prove legal sufficiency.

## 6. Actual benchmark, output review and capacity

```bash
.venv-video/bin/python -m swico_video_node benchmark --all-templates --interactive-sources --runs 3
```

This asks for actual consenting adult local source paths and consent. It performs
**16 full renders**: two templates × two enhancement variants × (one first-render +
three measured warm samples). One Engine is initialized and its real model-load
duration is measured separately; sessions are reused. Later first-render samples
are NOT fresh-process cold starts. Legacy API `cold_seconds` carries first-render
samples, not a claim of disk-cache-cold inference. Watch each full output before
typing QA-PASS. Verify separate identities, male-only, female-only, both, off/natural,
caption, temporal stability, occlusion, cuts, unchanged background and audio sync.

No example timings are approvals. Schema 2 binds model/code/template/tracks/rights,
Python patch/binary, locked package wheel RECORDs, Intel hardware/OS, encode/quality
settings and FFmpeg/ffprobe bytes/version/library hashes. Old schema, partial QA,
missing variants, <3 warm samples, nonfinite/negative timings or changed identity
require real reruns; publication/readiness refuse stale evidence.

Scratch uses private UUID directories under `benchmarks/`: removed on normal
completion/cancel and next locked startup after crash. Only owned scratch is
removed; permanent approved clips and unrelated user files are never swept.

Publication bounds each (sample + startup) × 1.3 by (max job age − 600sec preflight
reserve) / queue capacity. With six jobs/four hours it may REFUSE a slow template.
Shorten/prepare an acceptable licensed clip or explicitly review reducing queue
capacity to at least one and validate throughput again. Do not arbitrarily inflate
retention/deadlines or silently reduce quality. Paid queue claims precede queued
preflights; a current non-preemptible preflight is included in uncertainty estimates.

## 7. Publish bounded metadata, then foreground worker

```bash
.venv-video/bin/python -m swico_video_node models audit
.venv-video/bin/python -m swico_video_node templates publish --all
.venv-video/bin/python -m swico_video_node doctor --check-api
caffeinate -is "$PWD/.venv-video/bin/python" -m swico_video_node run
```

Both feature flags may stay false. Publish transmits metadata/hashes/actual timings
only; not masters, faces, rights documents or arbitrary files. Doctor backend-active
is false before heartbeat. In another terminal run doctor again. A fresh heartbeat
must match both exact published runtime/QA identities. Stale accepted profiles
settle through existing failure/refund/allowance recovery, never render on new code
under old approval. Existing heartbeat/cancel/settlement is not blocked by flags.

## 8. Managed service (explicitly stop foreground first)

After Ctrl+C and confirmed drain/exit:
```bash
.venv-video/bin/python -m swico_video_node service install
.venv-video/bin/python -m swico_video_node service status
.venv-video/bin/python -m swico_video_node doctor --check-api
# Stop before changing Python, packages, tools, templates or service configuration:
.venv-video/bin/python -m swico_video_node service stop
# Optional removal, preserves credentials/templates:
.venv-video/bin/python -m swico_video_node service uninstall
```

Install records the absolute venv Python, fixed repository working directory,
minimal non-secret environment including /opt/local/bin, and caffeinate.
Repeated identical install is idempotent; changing a loaded service/runtime requires
explicit stop first. Never overwrite an active worker's environment.

Status separates loaded, launchd state, running/PID, last exit, fresh local liveness,
and authenticated backend readiness. Loaded alone is not healthy. Private logs:
`logs/worker.log` (1MiB × 4), bounded classified native error JSON,
`startup.stdout.log` and `startup.stderr.log` (rotated at 256KiB on startup,
one prior copy). Startup commands emit bounded diagnostics; customer media, prompts,
emails, tokens and headers are not logged. Parent-death pipe, inherited flock and
owned process-group termination remain active under the service.

Run the same authorized fixture job under the service, not just in Terminal.
LaunchAgent starts after USER LOGIN, not before login/FileVault or after shutdown
without login. caffeinate reduces idle sleep on AC; it cannot promise service while
the lid is closed, the machine shuts down or the network is offline.

## 9. Existing Render checks and release authorization

After an operator-authorized deployment, existing API Render Shell:
```bash
cd /opt/render/project/src/backend
python -m alembic -c alembic.ini current
python -m alembic -c alembic.ini heads
python -m scripts.swico_video_release_check --pretty
python scripts/weekly_tester_credit_check.py --pretty
python scripts/swico_cli_release_check.py --pretty --public
```

Both Alembic results must remain `20260918_website_video`. Keep existing predeploy
migration owner/build/start commands. No migration or Mac inference installation
is required by this fix.

Release check is read-only. SMTP/Razorpay/configured digest booleans are configuration,
not delivered mail/provider acceptance/pairing. It validates technical gates with
both flags false. Legal publication, rights, actual Intel full-clip QA, current
calibration/metadata, CI, isolated provider TEST capture/refund, authorized SMTP,
expiry/cache policy and capacity acceptance must all be separately recorded.
Then the operator may explicitly enable complimentary video, verify those flows,
and separately authorize paid checkout. Never enable checkout to make readiness pass.

Rollback: set both flags false; retain the video-aware payment dispatcher, database,
worker authentication and maintenance to drain/settle accepted work/refunds. Wait
for the immutable output windows, then stop the Mac if appropriate. No downgrade,
stamp, old dispatcher rollback, credential rotation or refund replay.
