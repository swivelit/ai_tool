# Swico Video — complete first-run onboarding and operator-readiness correction

Work from the repository root. Inspect the current checkout before editing. Implement the complete scoped correction in one integrated change; do not stop at a plan, scaffold, or suggested diff. Do not recreate the website-video feature.

## 1. Current baseline and verified situation

The operator's latest supplied checkout is `d5e35f8c2cd5f4951cc4830848541f076687e47f`, the bot commit `chore(cli): release Swico CLI 0.2.9`. Its parent is `4e755ff50ffeed4864e7cfa2194bb5fa0a6056a0`, `fix(video): unblock Intel Mac setup and harden production readiness`. The earlier implementation report's CLI 0.2.8 baseline is historical, not the current version. Preserve the actual current package version and release metadata; never downgrade to 0.2.8 or republish an old artifact.

The hosted main CI run for the correction is `35346729754`: all seven jobs passed, including Windows CLI, the native ConPTY acceptance step, backend, web, PostgreSQL lifecycle, and canonical CLI artifact. The separate `Agent Native Isolation` workflow, run `35346729719`, failed at `Run installed Linux coding-agent acceptance`; its preceding hostile sandbox verification step passed. Do not conflate this separate coding-agent test with the video Mac worker. Do not disable, skip, or weaken that workflow. Keep unrelated agent functionality outside this change unless a shared regression is actually reproduced and the fix is demonstrably necessary. Report its state separately.

Production logs supplied by the operator establish:
- Alembic current and head: `20260918_website_video`.
- Video feature and paid checkout both disabled.
- Video configuration, schema, worker-digest presence, cache-headroom check, SMTP configuration and Razorpay configuration pass.
- Current video-policy publication, active calibrated worker, and two published templates are not ready.
- Weekly tester credits: `ok=true`, enabled, 3 configured subjects, allowance 40,000,000 micro-rupees.
- Existing CLI public readiness: true; local agent and cloud agent are disabled.

The operator video machine is:
- `admin@Admins-MacBook-Pro`.
- macOS Tahoe 26.7, build 25G229, native x86_64.
- Intel quad-core i7, 32 GB RAM, integrated Intel graphics.
- Repo: `/Users/admin/Documents/swico_server/ai_tool`.
- Command Line Tools: `/Library/Developer/CommandLineTools`.
- Standard Homebrew installer refused the machine.
- The operator ran `open "https://www.macports.org/install.php"`, then immediately tried `/opt/local/bin/port`.
- `/opt/local/bin/port` does not exist. This is an uncompleted MacPorts installation, not a pip, model, credential, or database failure. PATH changes cannot create an absent executable.

The reviewer inspected the supplied ZIP and independently ran `python -m pytest swico_video_node/tests -q --disable-warnings`: 75 passed on Linux/Python 3.13.5. This is NOT native Intel/Python 3.12 inference evidence. Do not copy that result as your own test execution or as target-machine acceptance.

## 2. Scope and invariants

Keep the architecture exactly as implemented: existing Render API/website/PostgreSQL/Valkey/SMTP/payment integrations, existing Windows Swico Free node, and local Intel Mac video worker. No new cloud GPU, external face-swap API, tunnel, public Mac listener, Render service, cron or database.

Preserve all business and security contracts:
- Signed-in ordinary users pay exactly 2500 paise per admitted template generation.
- `harishajidasan@gmail.com` remains unlimited complimentary for video without altering existing chat allowances.
- Existing eligible weekly tester cohort gets five complimentary video attempts per day; video accounting remains separate from weekly chat credits.
- READY video delivery ends at the immutable `ready_at + 600 seconds` boundary; reload, retry or email delivery cannot extend it.
- Templates and models stay on the Mac. No uploading original movie files, private photos, embeddings, or credentials into Git.
- Keep authenticated owner-scoped output, fail-closed unavailable-worker admission, queue estimates based on actual measurements, idempotent payment/refund handling and bounded cleanup.
- No change to Android, ordinary Chat/Voice, subscriptions, CLI product behavior, Windows inference or existing credit configuration.
- Existing migration is already deployed: do not modify it in place, stamp, downgrade, reset or erase financial history. This onboarding correction should need no migration.

The operator can install MacPorts and continue with the current code immediately. Do not imply that another new feature is a prerequisite for installing a package manager.

## 3. Read these files before changing anything

- Repository instructions and applicable AGENTS files, if present.
- `swico_video_node/scripts/setup_macos.sh`
- `swico_video_node/bootstrap.py`
- `swico_video_node/runtime.py`
- `swico_video_node/diagnostics.py`
- `swico_video_node/service.py`
- `swico_video_node/__main__.py`
- `swico_video_node/storage.py`
- `swico_video_node/models.py`
- `swico_video_node/templates.py`
- `swico_video_node/calibration.py`
- `swico_video_node/tests/test_hardening.py` and other worker tests.
- `backend/scripts/swico_video_release_check.py`
- `backend/app/video/policy.py`
- `scripts/video_legal_diff.py` and the existing publication validator.
- `docs/VIDEO_MAC_SETUP.md`, `docs/VIDEO_ACCEPTANCE.md`, `docs/VIDEO_RELEASE_CHECKLIST.md`, `docs/VIDEO_IMPLEMENTATION_REPORT.md`.
- Current `cli/package.json` and release workflow metadata for baseline reporting only.

The following fixes already exist and should be preserved rather than rewritten: MacPorts Python selection; pip-less virtual-environment support; pinned binary-wheel versions and recorded wheel hashes; explicit FFmpeg/ffprobe discovery; shared restricted child environment; independent API authentication diagnostics; truthful service status; runtime-bound calibration; complete model-rights inventory.

## 4. Fix the first-run bootstrap experience

Add a dependency-free shell preflight, or extend the existing shell entrypoint with a backward-compatible `--check` mode. It must run with built-in macOS tools BEFORE Python, pip, MacPorts, or FFmpeg exist. Do not import the Python worker merely to tell the user Python is missing.

Requirements:
1. Identify OS major version, CPU architecture, Command Line Tools, an existing explicitly selected/native Python 3.12, `/opt/local/bin/port`, FFmpeg, and ffprobe independently.
2. Missing MacPorts must be an actionable installation diagnostic when the default MacPorts path is needed. It must not prevent an already supported alternative native interpreter/tool installation from being selected deliberately.
3. Explain literally: opening an installation webpage only opens the browser; it does not download or install the package. Exporting PATH does not install a program. `port selfupdate` is not the first installation command.
4. Supply exact official Tahoe-package installation instructions and a success checkpoint: `/opt/local/bin/port version`.
5. Preserve normal `setup_macos.sh [--python /absolute/path/to/python3.12]` behavior. Check-only must not create a venv, contact the API, initialize/rotate credentials, fetch models, invoke sudo or change the host.
6. Setup must stop before dependent commands when a prerequisite fails. Classify missing package manager, missing Python, wrong Python version/architecture, missing FFmpeg, missing ffprobe and failed codec smoke separately.
7. Continue preserving the existing incomplete/foreign venv and engine-checkout safeguards: do not auto-delete or reset user files.
8. Test paths with spaces, missing tools, native alternative toolchains, macOS 26 Intel, unsupported platform, incomplete setup, repeated checks and interrupted installation.

Do NOT make ordinary setup auto-run sudo, install host packages, change global Python aliases or write shell configuration without explicit operator authorization.

An optional explicitly invoked prerequisite installer is acceptable ONLY if all of these hold: separate from default/check-only operation; requires a real interactive affirmative confirmation; supported OS/architecture guards; fixed official HTTPS artifact provenance; verified expected hash before privilege escalation; no arbitrary URL option; proper quoting; no TLS/Gatekeeper/SIP bypass; nonzero failures stop; installed-path verification; no activation of any video feature. Prefer small, easily audited code over a general-purpose installer framework.

## 5. Verified installer reference

The official MacPorts installation page inspected for this task lists MacPorts 2.12.6 and a Tahoe v26 package. Re-check primary sources before changing this reference. Do not switch to the newest macOS package merely because it appears first on the page.

Official release page:
`https://github.com/macports/macports-base/releases/tag/v2.12.6`

Tahoe package:
`https://github.com/macports/macports-base/releases/download/v2.12.6/MacPorts-2.12.6-26-Tahoe.pkg`

Official GitHub release-asset metadata reports:
- Asset ID: `529636707`.
- Filename: `MacPorts-2.12.6-26-Tahoe.pkg`.
- SHA-256: `ddd90723ba470a688296bb520335e1c7c08835d82df4141e6807b411bc8b78e8`.

This is the MacPorts INSTALLER checksum, never the worker-token digest and never a value for SWICO_VIDEO_WORKER_TOKEN_SHA256. This checksum was read from official release metadata, not computed from a local downloaded installer. Never claim the reviewer installed or executed the macOS package.

The runbook should show actual guarded download/verification/installation, not just `open` of a website. For example, use a subshell with `set -eu`, a local Downloads directory, HTTPS-only curl, `shasum -a 256 -c -`, and only after a successful check `sudo /usr/sbin/installer -pkg ... -target /`. Validate the installed executable. Test command generation/control flow with fixtures; do not run a real privileged installation on the developer's machine without separate authorization.

After MacPorts installation, the ordinary operator commands are:
```
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
sudo /opt/local/bin/port selfupdate
sudo /opt/local/bin/port install python312 py312-pip ffmpeg
```
Use actual upstream package definitions, not guessed package names. Avoid `port select` or replacing system Python; explicit interpreter paths suffice.

## 6. Make the runbook complete and easy to follow

Rewrite only the confusing onboarding portions, retain accurate evidence and security instructions. Every step must specify: where to run it, exact copyable command, expected success checkpoint, and what to do on failure. Do not mix commands whose prerequisites may not exist in an unconditional paste block.

Provide the full end-to-end operator sequence:
1. Existing clean checkout: inspect, no reclone/reset.
2. Actual Tahoe MacPorts install, success verification.
3. Python/pip/FFmpeg install and checks.
4. Existing native setup with explicit MacPorts Python.
5. Tool status and synthetic encode/decode checks, labeled NOT face inference.
6. Init preserving existing credentials and printing only their digest.
7. Paste only that digest into the existing API variable, apply via Render save/deploy, then independently check API pairing.
8. Explain that `authenticated=true` can coexist with overall `ready=false` before models, calibration and an active worker exist. Do not create a circular requirement to have a running worker before first startup.
9. Run the complete rights inventory. Point to the private manifest and exact required fields; do not invent commercial grants or model hashes.
10. Install approved models, import both actual templates with safe file-picker examples, complete actual template/audio rights, prepare and inspect frames, manually assign roles/exclusions.
11. Benchmark both templates on the real operator Mac using consenting photos. Explain how to open the output in a SECOND terminal while the first awaits QA input. Do not type QA-PASS automatically. Record real evidence only, including failures; preserve cleanup.
12. Publish reviewed metadata after both templates validate, start the foreground worker, re-check readiness in a second terminal/Render shell, then authorize deployed complimentary acceptance.
13. Stop foreground worker before installing LaunchAgent. Test the actual managed-service render path, not just a loaded plist.
14. Keep provider TEST payments/refunds isolated from production payment credentials and existing customer billing. SMTP testing requires an authorized address. Cache expiry, capacity and persistence review must be real.
15. Keep both video flags off during initial provisioning. Distinguish prerequisites, permission to expose complimentary testing, and final paid-checkout authorization without proposing staged feature implementation.

## 7. Readiness reporting and legal approval

Do not turn a metadata/configuration checker into a claim of end-to-end production acceptance. The existing release checker deliberately excludes the enabled/paid flags from its required readiness conditions. Preserve that distinction. Missing model permissions, policy approval, actual outputs and payment/delivery evidence cannot be resolved by toggling a flag.

Improve docs/reporting so it is explicit that:
- `worker_token_digest_configured=true` does not prove token pairing.
- SMTP/Razorpay configured booleans do not prove actual delivery/capture/refund.
- Cache headroom at a point in time is not acceptance of all retention/persistence/load behavior.
- Green unit tests, resolved wheels and synthetic color-frame encode/decode are not real face inference.
- Document hashes prove integrity, not a licence grant.

Preserve the current exact-content legal-publication gate. The read-only `scripts/video_legal_diff.py` can show the proposed pages. Do not automatically replace published policies, reuse old approval fingerprints, fabricate reviewer names/dates, or mark legal approval as obtained. Explain actual operator approval steps based on the current publication workflow.

Keep actual operational evidence private and exclude raw tokens, source photos, face embeddings, private signed documents, database/payment secrets and customer identifiers from Git and diagnostic exports. A structured redacted local report may be added only if it materially reduces operator mistakes, reuses existing checks and remains read-only by default.

## 8. Testing and evidence

Run applicable shell syntax/control-flow tests and the worker suite. Test new preflight code using temporary files or injected executables so CI does not need to install MacPorts, run sudo, download movie clips, obtain model licences or call production.

Preserve all existing worker, backend/video, web, billing and release tests. If only shell/docs change, do not claim new full backend/web runs unless you actually execute them. If shared/runtime/backend behavior changes, run the relevant focused and full regression suites available in the environment and report exact commands and results.

Explicitly classify:
- Source inspection.
- Unit/mocked checks.
- Real OS process-control tests.
- Synthetic codec tests.
- Locked wheel resolution/import tests.
- Hosted native Windows CI.
- Native model inference on the operator Mac.
- Actual template quality review.
- Authorized payment-provider/SMTP/cache acceptance.

Do not copy previous counts or report blocked/not-run checks as passed. Do not introduce a requirement for a new service solely to run acceptance.

## 9. Deliverables

Complete the scoped fix, then provide:
1. The exact missing-installation root cause, distinct from remaining release prerequisites.
2. Changed paths and why each is necessary. No unrelated CLI feature changes or version downgrade.
3. Exact tests actually run and evidence limits.
4. Migration impact (expected none).
5. Render instructions: keep both flags false; preserve all existing settings; pair actual worker digest only after init; no gratuitous deploy when nothing changed.
6. A verified novice-friendly Mac sequence that downloads and INSTALLS MacPorts before calling `port` and does not depend on unavailable `python`.
7. Remaining owner-supplied permissions, source/template review and target-machine/provider acceptance.
8. A commit message appropriate to actual changes, such as `fix(video): clarify first-run Mac installation and prerequisite checks`.

Do not commit, push, deploy, publish templates, send real email, charge/refund real customers, rotate credentials, modify production data, enable features or run privileged installers automatically. Missing operator prerequisites must not stop completion of the software/documentation fix, but must remain genuine release blockers.
