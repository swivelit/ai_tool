# Intel Mac video worker — first installation through serving acceptance

This is the existing Mac + existing Render API/website/PostgreSQL/Valkey architecture.
No new service, cache, cron, GPU, public Mac port or tunnel. Do not enable paid video
until [VIDEO_ACCEPTANCE.md](VIDEO_ACCEPTANCE.md) is complete. The migration is
ALREADY deployed at `20260918_website_video`; do not downgrade, stamp or reset.

**Current operator checkpoint:** Tahoe 26.7/native Intel, MacPorts 2.12.6,
Python 3.12.14, FFmpeg/ffprobe 9.0.1, `.venv-video`, locked dependencies and
`tools status` now succeed according to the operator. Do not reinstall those or
rotate credentials to diagnose a clip. Continue with pairing (section 5) and
local inspection/import (section 6). Sections 1–4 remain for a genuinely new Mac.
The current inspected checkout is `c429bab4`, CLI **0.2.9**.

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
It is NOT the developer test machine. Current inspected main is `c429bab4`, CLI
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

**Expected on a still-unprovisioned Mac:** `platform=native_intel`,
`macos_major=26`, `macports=missing_or_incomplete`, missing Python/codecs,
`prerequisites=blocked`, exit 1. This is actionable, not an application crash.
It examines prerequisites independently, reads no token, imports no worker, and
does not use sudo/downloads/API calls, create a venv or modify shell configuration.
Pip/venv usability and synthetic codec execution are later bootstrap checks.

**The earlier first-run root cause:** opening an installation webpage only opens the
browser; it does NOT download or install MacPorts. Exporting PATH does NOT install
a program. `port selfupdate` is NOT a first-install command. Do not run `port`
until `/opt/local/bin/port version` succeeds.

If native Python 3.12 and supported tools are **already** deliberately installed
through another route, MacPorts is not mandatory:

```bash
VIDEO_PYTHON="${SWICO_VIDEO_PYTHON:-$PWD/.venv-video/bin/python}"
bash swico_video_node/scripts/setup_macos.sh --check --python "$VIDEO_PYTHON"
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

## 6. Inspect, explicitly normalize only if needed, then import locally

Media inspection/import does NOT need model weights or a successful API pairing.
A 401 `credential_mismatch` is a separate Render digest-pairing issue. Keep the
existing token; the operator pairs its actual digest in Render, not a new token.
Both video flags remain false.

For the first source, in Mac Terminal at the existing repo root:

```bash
cd /Users/admin/Documents/swico_server/ai_tool
video_source_clip="$(/usr/bin/osascript -e 'POSIX path of (choose file with prompt "Select the licensed couple-01 master" of type {"public.movie"})')"
```

Cancel stops selection; do not continue with an empty path. Then:

```bash
.venv-video/bin/python -m swico_video_node templates inspect --file "$video_source_clip"
```

**Checkpoint:** JSON `accepted=true`, `classification=stable_cfr`, canonical FPS,
frame count, duration and bounded timestamp summary. No source path, faces or raw
ffmpeg stderr is printed; no source/state modification, lock creation or upload.
On rejection the command exits 1 and returns `reason` plus a safe next action.

The reported 496×368 / 301-frame / ~10.034s clip may have `nominal_fps=30` and
`average_fps=150500/5017`. Unequal headers are NOT in themselves VFR. Every decoded
PTS must fit the nominal rational grid. Tolerance is
`min(stream time_base, 1 millisecond) + 1 microsecond`; it applies to EACH adjacent
interval, each phase error from the first frame AND the full phase-error range.
Thus 33/34ms rounding fits 30fps; sustained drift, cadence changes, duplicate or
reversed PTS do not. `30000/1001` is retained exactly, not rounded to 30.
Coarser/ambiguous timing is refused, not granted a whole-frame tolerance. Total
duration must match decoded count / canonical FPS within twice that tolerance;
the video must start within one tolerance of zero (no silently discarded offset).
Finite rates 1–60, duration 1–30s, even dimensions 64–1920, 2–1800 decoded frames,
one video/at most one audio and 200MiB remain bounded.

**If accepted, direct import is valid; conversion is optional.** Only if you want
an explicit canonical MP4 master for interoperability, choose a NEW filename:

```bash
video_normalized_clip="${video_source_clip%.*}-swico-cfr.mp4"
.venv-video/bin/python -m swico_video_node templates normalize \
  --file "$video_source_clip" --output "$video_normalized_clip"
```

**Checkpoint:** exit 0, `normalized=true`. This reads a private bounded snapshot,
uses reviewed absolute native tools, produces H.264 CRF18/slow/yuv420p/faststart,
removes source metadata/chapters and copies at most one compatible AAC/MP3/ALAC
audio stream unchanged. It uses file-only protocols and never a shell or API.
It corrects only the already-proven timestamp quantization onto the rational
grid—no arbitrary VFR guessing, frame duplication/drop, scaling or audio retiming.
Same-production-probe and full decode must pass, with unchanged frame count,
dimensions/rate and bounded duration/audio offsets, before atomic no-overwrite
publication. Existing outputs (including symlinks) are never replaced. Failures
remove owned temporary work, not the original or another process's output.
Unsupported audio or genuine VFR requires separately reviewed preparation, not
this command. A forced OS kill may leave a hidden `.swico-normalize-*` scratch
directory beside the requested output; inspect/remove only that owned residue.

Only after normalization success:

```bash
.venv-video/bin/python -m swico_video_node templates inspect --file "$video_normalized_clip"
```

Require accepted stable CFR and the same count/geometry. Play the whole output
locally (`open "$video_normalized_clip"`) and check A/V sync. Conversion supplies
NO copyright/audio rights. To use it, explicitly set
`video_source_clip="$video_normalized_clip"`; otherwise retain the accepted original.

```bash
.venv-video/bin/python -m swico_video_node templates import \
  --id couple-01 --file "$video_source_clip" --title "Couple scene 1"
```

**Checkpoint:** `imported=true`, rights/template/calibration all false. The exact
copied master is probed and hashed; master + manifest publish together under the
existing worker lock. Rejection leaves no permanent template directory, master or
manifest. An existing complete OR partial template directory is never adopted or
overwritten. A hard crash can leave a hidden `.import-*` staging directory in
private templates storage, never an approved/published template; inspect/archive
that owned residue explicitly. Import performs no conversion or network upload.

Repeat selection/inspection (and optional normalization) for `couple-02`, then:

```bash
video_source_clip="$(/usr/bin/osascript -e 'POSIX path of (choose file with prompt "Select the reviewed couple-02 original or normalized master" of type {"public.movie"})')"
```

On successful selection, inspect it and require `accepted=true` before importing:

```bash
.venv-video/bin/python -m swico_video_node templates inspect --file "$video_source_clip"
```

Then:

```bash
.venv-video/bin/python -m swico_video_node templates import \
  --id couple-02 --file "$video_source_clip" --title "Couple scene 2"
```

Do not reuse the first path accidentally. On `template_existing`, inspect the
private existing files instead of deleting/replacing them. On odd dimensions,
resolution/duration/rate/timing errors, stop at the named reason; this command
does not auto-crop, stretch or trim. `template_probe_failed` calls for `tools status`
and local source inspection, not credential rotation or nonexistent diagnostic logs.

### Genuine rights, technical provenance, then model install/audit

Successful import is NOT inference, template approval, commercial authorization or
calibration. Do not edit `models.json` or either template manifest by hand. The
commands below copy the real documents into the private rights directory, hash the
copied bytes, make a private backup, and update JSON atomically. They never upload a
document or call a provider. Use a Finder picker so a literal example path cannot be
mistaken for a real command:

```bash
VIDEO_PYTHON="${SWICO_VIDEO_PYTHON:-$PWD/.venv-video/bin/python}"
LICENCE_FILE="$(osascript -e 'POSIX path of (choose file with prompt "Choose the genuine model licence evidence")')"
PERMISSION_FILE="$(osascript -e 'POSIX path of (choose file with prompt "Choose the genuine commercial permission evidence")')"
printf 'Enter the real accountable reviewer name or role: '; read -r REVIEWER
printf 'Enter the real review date (YYYY-MM-DD): '; read -r REVIEWED_AT
"$VIDEO_PYTHON" -m swico_video_node models evidence add \
  --asset code_review --reviewer "$REVIEWER" \
  --reviewed-at "$REVIEWED_AT" --licence-file "$LICENCE_FILE" --permission-file "$PERMISSION_FILE"
```

Repeat the command for every asset, using a real reviewer/date each time. For
genuinely applicable permissive components only, the permission file may be omitted
with this explicit basis:

```bash
printf 'Enter the real reviewer and review date again when they differ: '; read -r REVIEWER REVIEWED_AT
"$VIDEO_PYTHON" -m swico_video_node models evidence add \
  --asset 2dfan4.onnx --reviewer "$REVIEWER" --reviewed-at "$REVIEWED_AT" \
  --licence-file "$LICENCE_FILE" --permission-basis applicable_licence
```

Never use that basis for `inswapper_128.onnx`, `arcface_w600k_r50.onnx` or
`retinaface_10g.onnx`. Those restricted pretrained weights require separate,
genuine right-holder commercial permission evidence as well as licence evidence.
Possession, a filename, a licence keyword or a technical hash is not permission.
Check bounded local status at any time:

```bash
"$VIDEO_PYTHON" -m swico_video_node models evidence status
```

FaceFusion 3.0.1 uses a fixed adjacent `.hash` release sidecar for each exact
`.onnx` source. The pinned legacy sidecars use FaceFusion's CRC32 format (for
example `a948738e` for `2dfan4`), not a padded SHA-256. Some newer sidecars may
be full SHA-256 and the command labels the algorithm. Provenance is technical
only. The read-only status command does not contact the network; `--fetch`
explicitly retrieves only small HTTPS sidecars from the pinned GitHub path and
never downloads model bytes:

```bash
"$VIDEO_PYTHON" -m swico_video_node models provenance status
"$VIDEO_PYTHON" -m swico_video_node models provenance status --fetch
```

After independently reviewing that the sidecar belongs to the pinned source,
record its algorithm-labelled technical provenance with an explicit
acknowledgement. A CRC32 sidecar is recorded as CRC32 and cannot satisfy the
full-model SHA-256 install gate:

```bash
"$VIDEO_PYTHON" -m swico_video_node models provenance record \
  --asset 2dfan4.onnx --confirm-technical-hash
```

If a real reviewer has independently inspected the complete model bytes and
recorded a genuine full-model SHA-256, the safer novice route is to choose the
local model file directly. This computes the digest without copying, installing,
uploading or downloading model bytes:

```bash
"$VIDEO_PYTHON" -m swico_video_node models provenance record \
  --asset 2dfan4.onnx --model-file "$(osascript -e 'POSIX path of (choose file with prompt "Choose the independently reviewed model file")')" \
  --reviewer "$REVIEWER" --reviewed-at "$REVIEWED_AT" \
  --confirm-technical-hash
```

The direct `--sha256` form is available for a reviewer who already has a
verified digest, but never paste a guess or a sidecar CRC32 value. If the
independent full-model SHA-256 is unavailable, leave the asset blocked. Repeat
for all nine assets only when evidence exists. Then run the strict audit. Its blockers name the next
command or missing real-world evidence and do not print private source paths:

```bash
"$VIDEO_PYTHON" -m swico_video_node models audit
```

Only after actual permissions, licence review and technical hashes are complete:

```bash
"$VIDEO_PYTHON" -m swico_video_node models install --profile quality-cpu
"$VIDEO_PYTHON" -m swico_video_node models audit
```

Download success proves only that bytes match the recorded technical hashes. It
does not prove commercial authorization. No restricted weight download occurs
before the existing rights gate passes.

## 7. Both real templates and human track review

After section 6: both imports, genuine model/template/audio rights and model audit
must pass. Do not import either template again. Prepare each separately:
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

Inspect and correct ambiguous local tracks without editing JSON by hand:

```bash
.venv-video/bin/python -m swico_video_node templates tracks status --id couple-01
.venv-video/bin/python -m swico_video_node templates tracks reassign --id couple-01 --track 2 --role female
.venv-video/bin/python -m swico_video_node templates tracks exclude --id couple-01 --track 3
.venv-video/bin/python -m swico_video_node templates tracks split --id couple-01 --track 1 --at-frame 180
```

Use `status` first. `split` creates a new excluded track at the selected decoded
frame; reassign it only after inspecting the annotated frames. These commands are
local, bounded and atomic. They never alter `master.mp4`; every correction
invalidates template approval and calibration, so `review` and a real benchmark
must be repeated. No role is inferred from gender or demographics.

Initial masters: CFR, even 64–1920px, 1–30sec, 1–60fps. Caption: printable ASCII,
100 characters. Unsupported input/options are rejected before checkout.

Record imported template rights through the safe command below. It requires
separate genuine evidence for the licence and permission plus three explicit
assertions: permission to modify the video, permission to use/distribute the
resulting video, and permission for the audio in that output. Face consent is not
movie or audio copyright permission. The command never changes `master.mp4`.

```bash
TEMPLATE_LICENCE="$(osascript -e 'POSIX path of (choose file with prompt "Choose the genuine template licence evidence")')"
TEMPLATE_PERMISSION="$(osascript -e 'POSIX path of (choose file with prompt "Choose the genuine template video/audio permission evidence")')"
printf 'Enter the real template reviewer and review date: '; read -r TEMPLATE_REVIEWER TEMPLATE_REVIEWED_AT
"$VIDEO_PYTHON" -m swico_video_node templates rights add --id couple-01 \
  --reviewer "$TEMPLATE_REVIEWER" --reviewed-at "$TEMPLATE_REVIEWED_AT" \
  --licence-file "$TEMPLATE_LICENCE" --permission-file "$TEMPLATE_PERMISSION" \
  --confirm-video-modification --confirm-video-distribution --confirm-audio-rights
"$VIDEO_PYTHON" -m swico_video_node templates rights status --id couple-01
```

Repeat with `couple-02` and genuine evidence. Rights changes invalidate approval
and calibration, so record rights before preparation/review. Unknown IDs, missing
masters/manifests and incomplete assertions fail closed. No metadata is published.
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

## 12. Legal publication and source-face consent

The website records a versioned set of adult/source-face, photo-rights,
synthetic-media, prohibited-use, retention and disclosure confirmations before
photo validation. Admission rechecks the stored version; changing or replaying
old consent cannot open a job or payment. Keep both video flags false while
these gates are incomplete.

Run the local owner publication helper from the repository checkout, not from
the Mac worker. First inspect the exact proposed pages without changing the
canonical pages:

```bash
python scripts/video_legal_diff.py
python scripts/publish-video-legal.py \
  --owner-attestation \
  --approver-role "REAL ACCOUNTABLE OWNER ROLE" \
  --approval-date "YYYY-MM-DD" \
  --dry-run
```

Replace the quoted values with real accountable-owner information. The helper
rejects placeholders, shows old and proposed page SHA-256 values, validates the
candidate, and changes nothing in dry-run mode. A real publication requires the
same command without `--dry-run` plus
`--confirm-authority --confirm-not-counsel-reviewed --confirm-right-to-publish`.
It creates private backups before atomically replacing the legal pages and
attestation. It is not counsel approval and does not create model, movie,
performer, source-face or audio rights.

The final order is: genuine rights evidence and grievance/takedown coverage;
owner page review/publication; model audit/install; template preparation and
frame/track review; native benchmark; complimentary QA; authorized Razorpay
TEST/SMTP/cache-expiry acceptance; then separate paid rollout authorization.
