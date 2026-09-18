# Swico video production review — 18 September 2026

## Scope and evidence

Inspected the uploaded `ai_tool-main(36).zip`, the user's Render/Mac output, and the actual GitHub Actions Windows job log through the GitHub connector. This review does not deploy or modify the repository. No native face inference, live payment/refund, customer email, template publication or legal approval was performed.

Source checkout: public commit `04cca915041da9968aaff60a2d897c44703d713c`, CI run `35336613862`, Windows job `105572804370`.

GitHub run: `https://github.com/swivelit/ai_tool/actions/runs/35336613862`.

An independent local command was run in the extracted checkout:

```text
Python 3.13.5, Linux
python -m pytest swico_video_node/tests -q
26 passed in 9.62s
```

These are worker contract/process tests, not the native Intel/Python 3.12 pipeline. The other test totals in the user's Codex report were not rerun in this review. GitHub showed success for backend, PostgreSQL lifecycle, web, Ubuntu CLI and macOS CLI; its Windows CLI job failed.

## Findings

### 1. Deployed migration is already current

The user's Render output shows current and heads both at `20260918_website_video`. The migration is not the cause of the installation or CI failure. No downgrade, stamp, reset or re-creation is indicated.

### 2. The actual Windows CI failure is in launcher preflight

Test: `installed launcher preflight rejects a wrong version`, in `cli/test/installed_agent_harness.test.mjs:27`.

The test expected `/version mismatch/`, but received an `installed launcher is not executable` error for its temporary `prefix/lib/swico.js` fixture. The stack identifies `cli/scripts/accept-installed-agent.mjs:56`.

The validator unconditionally tests POSIX executable mode bits. The fixture uses a POSIX-style JavaScript/shebang/symlink layout. This is a platform mismatch. Removing the permission test alone would not establish a valid Windows launch method; the fixture and invocation must also use meaningful platform semantics.

The real Windows job reported 147 passed, 1 failed and 2 skipped. Its dependent canonical artifact job was skipped, not independently shown to have an artifact-build defect.

### 3. Homebrew's current installer genuinely rejects a new Intel macOS install

The official installer checked during this review has an explicit non-arm64 abort on macOS. Repeating the previous Homebrew installation command will not fix this machine. The previous recommendation to bootstrap this new Intel installation using Homebrew was incorrect.

Use the official MacPorts package for macOS Tahoe v26, then install native `python312`, `py312-pip` and `ffmpeg`. This is a prerequisite installation route, not proof that all locked inference wheels and models run successfully on the user's Mac.

### 4. Two separate worker PATHs omit MacPorts

`swico_video_node/__main__.py`, `service('install')`:

```text
PATH=/usr/local/bin:/usr/bin:/bin
```

`swico_video_node/worker.py`, `execute()` child environment:

```text
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
```

Both omit `/opt/local/bin`, the default MacPorts binary directory. `engine.py` invokes `ffmpeg` and `ffprobe` by name. Therefore, exporting PATH only in Terminal is insufficient for the managed service or the explicitly sanitized render child. Fix both paths, preferably with shared validated absolute tool resolution, while preserving the minimal child environment.

### 5. Doctor hides credential-pairing diagnostics behind model readiness

`swico_video_node/__main__.py` returns early from `doctor --check-api` when local readiness prerequisites fail. The authenticated `/api/video-worker/v1/health` endpoint itself can be queried without model readiness. Diagnose authentication independently and report model/template blockers separately.

A configured backend digest only indicates the setting is present; it does not prove that it matches the new Mac's protected token. `storage.init()` creates or reuses the local token and prints only its SHA-256 digest.

### 6. Calibration/runtime binding needs strengthening

`templates.benchmark()` records the runtime, machine and OS, but `templates.approved(calibrated=True)` checks the approval hash and off/natural variant keys without comparing the recorded runtime to the currently executing runtime. FFmpeg/ffprobe identity is not part of the current profile binding.

This is a static-code gap, not a demonstrated paid production failure. Add reproducible regression tests and require renewed calibration when render-affecting runtime/tool identity changes. Do not simply rewrite existing approval fields.

The current benchmark performs 16 full renders for two templates and both enhancement variants with `--runs 3`. No processing-time estimate has been established on the user's target Mac.

### 7. Service status currently confuses loaded with running

`service('status')` labels a successful `launchctl print` as `running`. This only checks whether launchd knows the job, not whether a healthy worker is currently running. Improve state/exit/PID/heartbeat diagnostics and private startup logging.

### 8. Release checker reports configuration, not full external acceptance

The supplied output's material missing checks are:

```text
current_legal_publication_approved=false
worker_current_native_calibration=false
two_templates_published=false
```

`backend/scripts/swico_video_release_check.py` excludes `feature_enabled` and `paid_checkout_enabled` from its required readiness tuple. Both may remain false while prerequisites are checked. Enabling checkout is not a way to fix readiness.

Its SMTP and Razorpay booleans mean configured, not successful email delivery or payment/refund acceptance. Cache headroom is not a full persistence/load review. Template-ID existence alone should be strengthened to verify consistency with the current worker/profile.

### 9. Published Chat policies are not the same as video publication approval

`backend/app/video/policy.py` checks equality of the published legal pages and the video draft, then invokes the existing content-fingerprint approval validator. Preserve the existing approved Chat publication until the new exact content has genuinely been approved. Do not fabricate a legal-approved environment variable or reuse old approval for new pages.

Model rights, template video/audio rights and legal-page publication approval are separate requirements. InsightFace's MIT code license does not by itself grant commercial use of its restricted pretrained models.

## Recommended immediate operation

Keep both video feature flags false, retain the already-deployed compatible migration/payment code, install MacPorts prerequisites on the existing Mac, generate/pair its real token digest, then apply the complete corrective code pass before managed service installation. Native full-clip quality/calibration, genuine permissions, provider test capture/refund, authorized SMTP and retention/capacity acceptance are still required before paid launch.

## Primary external references checked

```text
https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh
https://www.macports.org/install.php
https://ports.macports.org/port/python312/
https://ports.macports.org/port/py312-pip/
https://ports.macports.org/port/ffmpeg/
https://nodejs.org/docs/latest-v22.x/api/fs.html
https://nodejs.org/api/child_process.html
https://github.com/deepinsight/insightface
https://render.com/docs/configure-environment-variables
```
