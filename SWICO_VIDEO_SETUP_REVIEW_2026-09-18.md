# Swico video setup review — 18 September 2026

## Scope

Reviewed upload: `ai_tool-main(37).zip`.
ZIP SHA-256: `f30ed0cef9acd15e43eaa1e511e718cc769ccbd2711fd4df5b2c7ea042162328`.
Extracted privately for inspection; no changes were made to the uploaded source, production, GitHub, the user's Mac, payments or email.

## Current blocking error

The operator log shows that `/opt/local/bin/port` does not exist. The command `open "https://www.macports.org/install.php"` opens a browser page; it is not a package installation. The subsequent explicit-path failure is not repaired by exporting PATH. MacPorts must be installed before `port selfupdate` or `port install` can run.

## Verified repository/CI identity

The operator log ends at `d5e35f8c`. The uploaded `cli/package.json` and lock file declare version 0.2.9. GitHub confirms full commit `d5e35f8c2cd5f4951cc4830848541f076687e47f` is the bot's `chore(cli): release Swico CLI 0.2.9`, with parent `4e755ff50ffeed4864e7cfa2194bb5fa0a6056a0`.

Main CI run 35346729754 for the corrective parent commit completed successfully with all seven jobs passed. Windows CLI testing, native ConPTY helper acceptance and canonical CLI artifact checks passed. This is specifically the correction's run, not a claim that every workflow or every later commit passed.

Separate Agent Native Isolation run 35346729719 failed at installed Linux coding-agent acceptance. Its prior hostile Linux sandbox verification step passed. This is a separate CLI agent release issue, not evidence of a failed Mac video render. Existing production agent flags remain disabled in the supplied logs.

## Source checks

- `swico_video_node/scripts/setup_macos.sh` prefers `/opt/local/bin/python3.12`, supports `--python`, refuses missing executables and runs the bootstrap from the repository root. It does not install MacPorts.
- `bootstrap.py` verifies native Darwin/x86_64 Python 3.12, creates a pip-less dedicated venv where needed, uses the existing base pip to manage it, installs version-pinned binary wheels, records wheel hashes, checks tools, and imports the used pinned engine modules. Setup does not download model weights or prove face inference.
- `runtime.py` searches `/opt/local/bin` and validates absolute executable identities. The restricted environment is shared with rendering children and launchd. Replacing tools invalidates reviewed identities.
- `diagnostics.py` checks authenticated API health independently of missing models and templates. Overall readiness can legitimately remain false after successful pairing.
- `service.py` distinguishes loaded/running/PID/last-exit/local liveness/backend state. A loaded LaunchAgent alone is not output acceptance.
- `models.py` inventories nine ONNX assets plus code-rights evidence. Model hashes and document integrity do not grant rights. Local `models.json` and the rights directory contain operator-owned evidence and must stay out of Git.
- `templates.py` contains import/prepare/role-review/benchmark/publish commands. Two actual clips and manual quality review are required. With `--runs 3`, both templates and two enhancement options produce 16 full render calls (one initial plus three measured per combination). Watching the output requires operator action before typing the approval response.
- `backend/scripts/swico_video_release_check.py` requires configuration, policy approval, digest presence, schema, active calibrated worker, two current templates, cache check, SMTP and Razorpay configuration. It deliberately does not require either public feature flag to be on.
- `backend/app/video/policy.py` requires matching proposed/published pages and the existing exact-content approval validator. A Render boolean cannot replace this approval.

## Independently executed test

Environment: Linux, Python 3.13.5.

```text
python -m pytest swico_video_node/tests -q --disable-warnings
75 passed in 10.18s
```

These are worker tests, including applicable OS process-control tests. No native Intel Mac face inference, model download, payment-provider operation, real email, or production cache acceptance was performed during this review. The full backend/web/CLI suites were not independently re-run here.

## Supplied production logs

Current/head both equal `20260918_website_video`. Both video flags are false. Weekly tester-credit check is healthy (3 subjects, 40,000,000 micro-rupees). CLI public readiness is true while agent/cloud-agent capabilities are disabled. Video policy approval, worker native calibration and two published templates remain false. Digest presence and SMTP/payment configuration are not completed acceptance.

## Verified MacPorts installer reference

Official page: https://www.macports.org/install.php
Release: https://github.com/macports/macports-base/releases/tag/v2.12.6
Tahoe artifact: https://github.com/macports/macports-base/releases/download/v2.12.6/MacPorts-2.12.6-26-Tahoe.pkg
Official release asset ID: 529636707.
Official API-reported SHA-256: `ddd90723ba470a688296bb520335e1c7c08835d82df4141e6807b411bc8b78e8`.

The release metadata was inspected. The installer binary was not downloaded or executed in the review environment. Operator download must pass the recorded checksum before installation. Do not bypass a checksum/TLS failure or substitute a different OS package.

Official package definitions:
- https://ports.macports.org/port/python312/
- https://ports.macports.org/port/py312-pip/
- https://ports.macports.org/port/ffmpeg/

Model permissions reference: https://github.com/deepinsight/insightface (License section).
Render environment-variable procedure: https://render.com/docs/configure-environment-variables

## Conclusion

The immediate error requires completing host installation, not rebuilding the website video workflow. No new application regression is demonstrated by this MacPorts error. Paid readiness remains unproven until the actual serving Mac loads approved models, produces accepted full clips from both reviewed templates, publishes current calibration, and completes authorized foreground/LaunchAgent, payment/refund, notification, expiry and cache acceptance. Keep both public video flags disabled during initial provisioning.
