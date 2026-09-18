# Intel Mac video worker — first installation through serving acceptance

This is the existing Mac + existing Render API/website/PostgreSQL/Valkey architecture.
No new service, cache, cron, GPU, public Mac port or tunnel. Do not enable paid video
until [VIDEO_ACCEPTANCE.md](VIDEO_ACCEPTANCE.md) is complete. The migration is
ALREADY deployed at `20260918_website_video`; do not downgrade, stamp or reset.

## Render NOW (operator only; no deployment was performed)

The supplied production logs already show BOTH flags false. **No Render deploy
is needed to install MacPorts or run the new shell check.** In Render → existing
API service → Environment, confirm (do not repeatedly save unchanged values):
```dotenv
SWICO_VIDEO_ENABLED=false
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
```

Only if a value actually needs correction, use the normal authorized save/deploy
procedure. Do not change the existing
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

## 1. Existing checkout and a dependency-free check (Mac Terminal)

The video Mac is `admin@Admins-MacBook-Pro`, macOS Tahoe **26.7 / x86_64**.
It is NOT the developer test machine. Current inspected main is `d5e35f8c`, CLI
**0.2.9**; the old report's 0.2.8 is historical. Do not re-clone/reset or downgrade.

```bash
cd /Users/admin/Documents/swico_server/ai_tool
git status --short
git log -1 --oneline
```

**Checkpoint:** `git status --short` has no unexpected changes. If dirty, stop and
review them; do not reset. Once the operator has made the reviewed correction
available upstream, a clean checkout may use `git pull --ff-only`. No push is
performed by this task. Installing MacPorts itself does **not** require waiting
for this code update; step 2 works with the already-existing video implementation.

After obtaining the new check, run without Python/venv activation:

```bash
bash swico_video_node/scripts/setup_macos.sh --check
```

**Expected on the current unprovisioned Mac:** `platform=native_intel`,
`macos_major=26`, `macports=missing_or_incomplete`, missing Python/codecs,
`prerequisites=blocked`, exit 1. This is actionable, not an application crash.
It examines prerequisites independently, reads no token, imports no worker, and
does not use sudo/downloads/API calls, create a venv or modify shell configuration.
Pip/venv usability and synthetic codec execution are later bootstrap checks.

**The immediate root cause:** opening an installation webpage only opens the
browser; it does NOT download or install MacPorts. Exporting PATH does NOT install
a program. `port selfupdate` is NOT a first-install command. Do not run `port`
until `/opt/local/bin/port version` succeeds.

If native Python 3.12 and supported tools are **already** deliberately installed
through another route, MacPorts is not mandatory:

```bash
bash swico_video_node/scripts/setup_macos.sh --check --python /absolute/path/to/python3.12
```

Replace the path with that actual installation; do not paste a nonexistent example.
Existing reviewed `runtime-tools.json` paths, including spaces, are respected;
otherwise the supported `/opt/local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
locations are checked. No silent fallback from a broken reviewed configuration.
If `prerequisites=present`, proceed to step 4 with the same interpreter, skipping
MacPorts installation. This is prerequisite presence, NOT video readiness.

## 2. Actually install MacPorts (operator video Mac ONLY)

Do not retry the rejected Homebrew installer, install Rosetta, change system Python,
disable Gatekeeper/SIP or enable auto-login. First verify the machine and CLT:

```bash
/usr/bin/uname -m
/usr/bin/sw_vers
/usr/bin/xcode-select -p
```

**Checkpoint:** `x86_64`, macOS `26.x`, and a valid CLT/Xcode directory. If CLT is
missing, explicitly run `xcode-select --install`, finish Apple's installer and
repeat the checkpoint. Do not install the Tahoe package on macOS 15 or 27.

Verified 2026-09-18 from the [official install page](https://www.macports.org/install.php),
[2.12.6 release](https://github.com/macports/macports-base/releases/tag/v2.12.6)
and [official asset 529636707 metadata](https://api.github.com/repos/macports/macports-base/releases/assets/529636707):
`MacPorts-2.12.6-26-Tahoe.pkg`, SHA-256
`ddd90723ba470a688296bb520335e1c7c08835d82df4141e6807b411bc8b78e8`.
This is the INSTALLER checksum, **never** the worker-token digest or Render value.
Metadata was rechecked; the package was not installed by this task.

The following is a separate **explicit host installation**, not something setup
or `--check` runs. Read it before pasting. It stops on any guard/download/hash/
installer failure and asks for the administrator password only after verification.
The new private Downloads subdirectory is retained for inspection (including on
failure); no existing download is overwritten. macOS password typing is invisible.

<!-- macports-tahoe-install:begin -->
```bash
(
  set -eu
  [ "$(/usr/bin/uname -s)" = Darwin ]
  [ "$(/usr/bin/uname -m)" = x86_64 ]
  video_macos_version="$(/usr/bin/sw_vers -productVersion)"
  [ "${video_macos_version%%.*}" = 26 ]
  [ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true)" != 1 ]
  /usr/bin/xcode-select -p >/dev/null
  if [ -x /opt/local/bin/port ]; then
    /opt/local/bin/port version
    exit 0
  fi
  umask 077
  /bin/mkdir -p "$HOME/Downloads"
  video_download_dir="$(/usr/bin/mktemp -d "$HOME/Downloads/swico-macports.XXXXXX")"
  cd "$video_download_dir"
  video_pkg="MacPorts-2.12.6-26-Tahoe.pkg"
  /usr/bin/curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 --output "$video_pkg" \
    'https://github.com/macports/macports-base/releases/download/v2.12.6/MacPorts-2.12.6-26-Tahoe.pkg'
  printf '%s  %s\n' 'ddd90723ba470a688296bb520335e1c7c08835d82df4141e6807b411bc8b78e8' "$video_pkg" \
    | /usr/bin/shasum -a 256 -c -
  /usr/bin/sudo /usr/sbin/installer -pkg "$video_download_dir/$video_pkg" -target /
  [ -x /opt/local/bin/port ]
  /opt/local/bin/port version
)
```
<!-- macports-tahoe-install:end -->

**Checkpoint:** checksum prints `...pkg: OK`, Installer reports success, then
`Version: 2.12.6` (or the already-installed MacPorts version). If any step fails,
STOP. Do not run the installer separately to bypass a failed hash/TLS check,
change the checksum, choose the newest OS package or disable macOS protections.
On an interrupted installation, inspect the Installer's error; complete the same
verified installer explicitly and re-run `/opt/local/bin/port version` before
continuing. An existing valid `port` skips installation entirely.

## 3. Install Python/pip and FFmpeg (only AFTER port version works)

This block deliberately installs host packages and is operator-invoked only:

```bash
(
  set -eu
  /opt/local/bin/port version
  export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
  sudo /opt/local/bin/port selfupdate
  sudo /opt/local/bin/port install python312 py312-pip ffmpeg
  /opt/local/bin/python3.12 --version
  /opt/local/bin/python3.12 -m pip --version
  /opt/local/bin/ffmpeg -version
  /opt/local/bin/ffprobe -version
)
```

**Checkpoint:** every command exits 0; Python is `3.12.x`, pip and BOTH multimedia
tools report versions. If not, stop at the exact failing package; do not run
`sudo pip`, `port select`, global aliases, a source-build fallback or a new provider
stack. Official definitions: [python312](https://ports.macports.org/port/python312/),
[py312-pip](https://ports.macports.org/port/py312-pip/),
[ffmpeg](https://ports.macports.org/port/ffmpeg/). Version output is NOT codec or
model acceptance. Re-run `setup_macos.sh --check`; require `prerequisites=present`.

## 4. Existing isolated video bootstrap and tooling (Mac repo root)

```bash
cd /Users/admin/Documents/swico_server/ai_tool
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
bash swico_video_node/scripts/setup_macos.sh --python /opt/local/bin/python3.12
```

The no-argument `bash swico_video_node/scripts/setup_macos.sh` remains supported.
For an existing alternative native installation use its verified absolute path
instead. Ordinary setup never installs a host package or invokes sudo.

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

**Checkpoint:** exit 0 and `dependency_import_smoke: true` with
`native_model_inference: not_run`; only then activate with
`source .venv-video/bin/activate`. On failure stop: missing Python/FFmpeg/ffprobe
are distinct shell results; codec startup/`libx264` encode/probe/decode failure is
not model-rights failure. Pip/venv, wheel and import failures have their own
bootstrap diagnostics. Fix that stage, then rerun; never overwrite a foreign venv.

Non-secret reviewed tool configuration is stored in `runtime-tools.json` below.
Foreground, LaunchAgent, benchmark, template analysis and the sanitized rendering
child use the SAME absolute tools. Interactive PATH alone is insufficient.

```bash
.venv-video/bin/python -m swico_video_node tools status
```

**Checkpoint:** both absolute paths and reviewed identities are present. Ordinary
setup already performed the synthetic codec smoke. Only when deliberately
selecting/reviewing tools, after explicitly stopping any worker, run
`.venv-video/bin/python -m swico_video_node tools configure --ffmpeg /opt/local/bin/ffmpeg --ffprobe /opt/local/bin/ffprobe`.
Its `encode_decode_smoke: true` is synthetic color-frame evidence, NOT face inference.

Tool replacement fails closed. Changed binaries/libraries/Python/package identity
requires genuine re-calibration; do not edit old benchmark hashes. Moving identical
verified tool bytes and libraries without changing identity does not invalidate it.

## 5. Init, digest pairing and independent authentication

```bash
.venv-video/bin/python -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
```

Init stdout is ONLY the SHA-256 digest. It reuses existing protected credentials.
Copy that digest, not the raw token, into the existing backend-only variable.
Local state: `~/Library/Application Support/SwicoVideo`, private directory 0700,
`worker.token` 0600. Optional `SWICO_VIDEO_DATA_DIR` selects isolated test storage;
never accidentally point a test or a second worker at production credentials.

**Checkpoint:** init exits 0 and prints one 64-character digest. In Render → the
EXISTING API service → Environment, compare/set `SWICO_VIDEO_WORKER_TOKEN_SHA256`
to ONLY this digest. If it is already identical, no save/deploy is needed. If it
differs, explicitly authorize replacing that configured digest (drain/stop any old
worker first), save and deploy the environment change, wait until the API is live.
This pairs existing credentials; **do not run rotate-token**. Do not change any
other setting or paste the MacPorts installer checksum here.

Then on the Mac:
```bash
.venv-video/bin/python -m swico_video_node doctor --check-api
```

Doctor attempts read-only authenticated `/api/video-worker/v1/health` EVEN with
missing models/templates. It distinguishes local configuration, DNS, TLS, timeout,
connect failure, 401 mismatch, 403 forbidden, 404 not deployed and contract errors.
No redirects or insecure TLS. It separates schema present, control initialized,
worker active, matching published templates and local runtime/calibration. A missing
control row is not a missing table. Remain disabled and investigate initialization;
do not stamp/downgrade. A configured Render digest alone is NOT authentication proof.

An overall false doctor result is expected until local AND backend gates pass.
No paid request or SMTP send is used as a health probe.

**Checkpoint now:** `checks.api.authenticated=true`; overall `ready=false` is
normal before models/calibration/heartbeat. On 401 compare the digest and completed
Render deployment; on DNS/TLS/timeout repair connectivity without bypassing TLS.
Do not require a running worker to advance to local preparation. On a fresh DB,
`schema_ready=true` with `control_initialized=false` can precede first metadata
publication/heartbeat; no migration stamp/reset is needed to create the singleton.

## 6. Genuine rights and complete model inventory

```bash
.venv-video/bin/python -m swico_video_node models audit
```

The report names `models.json`, `rights/`, code review and ALL nine assets with
missing fields/files. A blocked report is expected now. Default private manifest:
`~/Library/Application Support/SwicoVideo/models.json`; documents:
`~/Library/Application Support/SwicoVideo/rights/`. Respect `SWICO_VIDEO_DATA_DIR`
if deliberately customized. Edit that local manifest, not repository assets. For each
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
```
**Checkpoint:** install exits 0 after checking genuine evidence and exact bytes.
On a rights/checksum/download error, stop and fix the identified asset; do not
substitute another model or infer permission. Then:
```bash
.venv-video/bin/python -m swico_video_node models audit
```
**Checkpoint:** `ready=true`, all nine model assets plus code review accepted.
Audit proves document/file integrity, not the legal sufficiency of permission.
Restricted assets/documents stay local and out of Git.

## 7. Both real templates and human track review

On the Mac, in the repo root, choose the first **actually licensed** original clip
using the native file picker. Cancel exits without importing. This is a local
copy, not a metadata publication or rights approval:

```bash
(
  set -eu
  video_source_clip="$(/usr/bin/osascript -e 'POSIX path of (choose file with prompt "Select the licensed couple-01 master" of type {"public.movie"})')"
  [ -f "$video_source_clip" ]
  .venv-video/bin/python -m swico_video_node templates import --id couple-01 --file "$video_source_clip" --title "Couple scene 1"
)
```
**Checkpoint:** exit 0, `templates/couple-01/master.mp4` and `manifest.json` exist
under the PRIVATE video state directory, not Git. If already imported, inspect
that existing template instead of overwriting or deleting it. Then choose the second:

```bash
(
  set -eu
  video_source_clip="$(/usr/bin/osascript -e 'POSIX path of (choose file with prompt "Select the licensed couple-02 master" of type {"public.movie"})')"
  [ -f "$video_source_clip" ]
  .venv-video/bin/python -m swico_video_node templates import --id couple-02 --file "$video_source_clip" --title "Couple scene 2"
)
```
**Checkpoint:** the equivalent `couple-02` files exist and import exits 0. A rejected
duration/format/codec is not permission to bypass validation; prepare a compliant
licensed master locally. Do not source shell commands from filenames.

Once both imports and rights records below are complete, prepare each separately:
```bash
.venv-video/bin/python -m swico_video_node templates prepare --id couple-01
```
**Checkpoint:** exit 0 with frame count and local review directory. On an import,
model, safety or frame-count failure, stop; this is real native processing, not
guaranteed by resolved wheels. Only after success run:
```bash
.venv-video/bin/python -m swico_video_node templates prepare --id couple-02
```
Require the same checkpoint for the second template before reviewing either.

Initial masters: CFR, even 64–1920px, 1–30sec, 1–60fps. Caption: printable ASCII,
100 characters. Unsupported input/options are rejected before checkout.

In each `templates/couple-0N/manifest.json`, fill the `rights` object with the same
genuine document fields above covering VIDEO modification/distribution AND AUDIO.
Open the local review folders from Mac Terminal:
```bash
open "${SWICO_VIDEO_DATA_DIR:-$HOME/Library/Application Support/SwicoVideo}/templates/couple-01/review"
open "${SWICO_VIDEO_DATA_DIR:-$HOME/Library/Application Support/SwicoVideo}/templates/couple-02/review"
```
Inspect ALL numbered images under `review/` locally; correct/split erroneous
associations in `tracks.json` before approval. Human roles male/female/exclude are
not identity/gender predictions. Both maps are required; jobs may select only one.
Background faces remain excluded. Never upload original clips/frames/embeddings.

```bash
.venv-video/bin/python -m swico_video_node templates review --id couple-01
```
**Checkpoint:** manually entered roles/exclusions, genuine rights accepted and
approval saved after viewing every frame. On refusal, correct the tracks/rights
and repeat actual review, not a hash-only edit. Then:
```bash
.venv-video/bin/python -m swico_video_node templates review --id couple-02
```
Approve only after inspecting every cut, hands/cups, occlusion, eyes/mouth,
background exclusion and audio rights. Changes invalidate approvals. Software
cannot replace that inspection or prove legal sufficiency.
**Checkpoint:** both manifests have matching review evidence; unrelated/background
tracks remain excluded. Final single/both-identity likeness and temporal acceptance
still require actual generated outputs; track metadata alone does not prove them.

## 8. Actual benchmark, output review and capacity

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

The benchmark itself exercises BOTH roles; additionally exercise single-role
requests during the later authorized foreground/managed acceptance, not by
claiming the benchmark rendered combinations it does not run.

**How to review while the command waits:** keep Terminal 1 open at the QA prompt.
Open Terminal 2 (Shell → New Window), and run:
```bash
open "${SWICO_VIDEO_DATA_DIR:-$HOME/Library/Application Support/SwicoVideo}/benchmarks"
```
In Finder open the UUID directory matching the path printed in Terminal 1 and
play `review.mp4` locally. Watch the entire clip, then return to Terminal 1. Type
`QA-PASS` **yourself only if it actually passed**. Do not paste that token into a
script, pipe yes, or send it before watching. On failure use Ctrl+C, keep a private
redacted description of the failure and repeat only after correction. Scratch
output is intentionally deleted on exit; no failed output becomes approved.
Repeat for every enhancement/template prompt. For a source path containing spaces,
paste the actual path at the Python prompt without shell quotes or backslash
escaping; use Finder Get Info or a local file picker to obtain it.

**Checkpoint:** command exits 0 after all 16 measured renders and four real
manual QA decisions. Both manifests have current schema-2 records. No runtime
estimate may be invented; a failed/aborted benchmark remains incomplete.

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

## 9. Publish bounded metadata, then foreground worker

```bash
.venv-video/bin/python -m swico_video_node models audit
```
After exit 0 and both local calibration/review gates above, explicitly publish:
```bash
.venv-video/bin/python -m swico_video_node templates publish --all
```
**Checkpoint:** publication exits 0 (success may print nothing); invalid or stale
local records stop before metadata upload. On a network/422/401 error investigate
that cause; do not edit timings or approval hashes to fit. Then:
```bash
.venv-video/bin/python -m swico_video_node doctor --check-api
```
Before first worker startup `worker_active=false` and overall `ready=false` are
expected even after successful publication. If local runtime/models/templates
and authentication checks now pass, do NOT wait for overall true before starting:
```bash
caffeinate -is "$PWD/.venv-video/bin/python" -m swico_video_node run
```

Both feature flags may stay false. Publish transmits metadata/hashes/actual timings
only; not masters, faces, rights documents or arbitrary files. Doctor backend-active
is false before heartbeat. In another terminal run doctor again. A fresh heartbeat
must match both exact published runtime/QA identities. Stale accepted profiles
settle through existing failure/refund/allowance recovery, never render on new code
under old approval. Existing heartbeat/cancel/settlement is not blocked by flags.

**Checkpoint in Terminal 2:** `cd /Users/admin/Documents/swico_server/ai_tool`, then
`.venv-video/bin/python -m swico_video_node doctor --check-api`; after a fresh
heartbeat require authenticated/schema/control/active/current-template checks and
local readiness to pass. If blocked, use the specific diagnostic; do not rotate
credentials or activate checkout. Run the read-only Render checks in step 11.

Both flags remain false until genuine legal publication, rights, native outputs
and relevant privacy/cache/expiry checks have been approved. Only then may the
operator authorize `SWICO_VIDEO_ENABLED=true` for complimentary acceptance while
**`SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false`**. This exposes the feature: it is an
explicit operational authorization, not another software implementation phase.
Use approved consenting fixture subjects/accounts, not customer photos. Verify
each role alone and both, off/natural, captions, background exclusion, original
audio, reload/chat delivery, owner isolation, cancellation and exact 600-second
expiry. Record actual results privately; no automatic acceptance is performed.

## 10. Managed service (explicitly stop foreground first)

Pause new admission if necessary, drain/settle accepted work, then Ctrl+C the
foreground process and confirm it exited. Do not start two workers. In Mac repo root:
```bash
.venv-video/bin/python -m swico_video_node service install
```
**Checkpoint:** install succeeds with the absolute venv interpreter. After startup:
```bash
.venv-video/bin/python -m swico_video_node service status
.venv-video/bin/python -m swico_video_node doctor --check-api
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

**Checkpoint:** loaded AND running/PID AND fresh local liveness AND authenticated
backend readiness. A loaded plist alone fails this checkpoint. Then run the SAME
authorized fixture render/download/expiry/cancel checks under the managed service,
not just Terminal. If they fail, leave paid checkout off and inspect private logs.
Stop before any runtime update with
`.venv-video/bin/python -m swico_video_node service stop` (require `stopped=true`).
Optional removal after stop:
`.venv-video/bin/python -m swico_video_node service uninstall` preserves credentials
and templates. Do not paste stop/uninstall as part of a successful install sequence.

LaunchAgent starts after USER LOGIN, not before login/FileVault or after shutdown
without login. caffeinate reduces idle sleep on AC; it cannot promise service while
the lid is closed, the machine shuts down or the network is offline.

## 11. Existing Render checks and release authorization

In the EXISTING API Render Shell (no new deploy needed just to read status):
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

Provider TEST capture/refund must use the isolated local procedure in
[VIDEO_ACCEPTANCE.md](VIDEO_ACCEPTANCE.md#provider-test-acceptance--operator-authorization-required-not-run-here),
not replacement of production Razorpay keys. SMTP delivery requires a separately
authorized test address; configured=true is not delivery. Validate cache
headroom/load/persistence policy and immutable `ready_at + 600 seconds`, including
retries and delayed email. Do not automatically charge/refund or send test email.

For the required exact-content policy review, run the read-only
`backend/.venv/bin/python scripts/video_legal_diff.py` on the developer checkout.
Follow the existing owner/counsel workflow in VIDEO_ACCEPTANCE.md. Do not publish
the draft, reuse the old fingerprint or invent approval metadata. Document hashes
prove integrity, not model/template grants or legal approval.

Rollback: set both flags false; retain the video-aware payment dispatcher, database,
worker authentication and maintenance to drain/settle accepted work/refunds. Wait
for the immutable output windows, then stop the Mac if appropriate. No downgrade,
stamp, old dispatcher rollback, credential rotation or refund replay.
