# Swico video release follow-up — ZIP43

Reviewed on 19 September 2026 against `ai_tool-main(43).zip`, both attached Mac terminal logs and the supplied Render release-check output. This guide supersedes the previous ZIP42 setup advice where the current logs establish progress. No production changes were performed during this review.

## 1. How far from production?

Substantial implementation is complete, but this is **not ready for paying customers**. The remaining work combines a small set of code defects with actual Mac model installation, evidence, template review and full-flow acceptance. A percentage or launch date would be misleading while no successful native inference or measured clip time exists.

| Area | Current evidence | Status |
|---|---|---|
| Database | `current` and `heads` both `20260918_website_video` | Ready; no migration needed for this checkpoint |
| Existing Valkey | `cache_headroom=true` | Configuration/headroom passes |
| SMTP and Razorpay | Both configuration checks true | Configured; actual delivery/capture/refund still needs acceptance |
| Weekly testers | Enabled, ₹40, three configured subjects, `ok=true` | Checker passes; preserve these settings |
| Mac prerequisites | Intel x86_64, macOS 26.7, Python 3.12.14, MacPorts, FFmpeg/ffprobe 9.0.1 and locked packages | Installed; no host reinstall needed |
| Mac-to-Render pairing | `authenticated=true`, schema/control ready | Working; preserve the current token/digest |
| FaceFusion checkout | Bootstrap reports `Dirty/wrong engine checkout` | Blocked; inspect the separate engine repository |
| Models | Nine missing model files, expected hashes and evidence records | Not ready |
| Templates | Both imported masters/manifests exist; permission evidence missing | Preserve imports; complete evidence/review/calibration |
| Benchmark | Failed with permission error; both entered photo paths were empty | No native quality/timing evidence |
| LaunchAgent | Loaded and running, but no fresh local liveness/active worker | Process exists; not serving video jobs |
| Video policies | Exact video draft not published/approved | Blocks admission |
| Feature switches | Both true while prerequisites are missing | Set both false now; enable once the complete release passes |

The three Render blockers are:

```text
current_legal_publication_approved
worker_current_native_calibration
two_templates_published
```

The latter two summarize several missing Mac prerequisites; they cannot be fixed by another environment flag.

### Progress since ZIP42

The following fixes are present: correct CRC32/SHA-256 distinction, bounded GitHub download redirects, explicit SHA-256/local-model-file recording, corrected interpreter paths, checkout resume, transient status retry, processing ETA, photo removal/previews, readable edit confirmation, track correction commands and the previous refund-finalization lock ordering.

Do not instruct Codex to rebuild those features. Remaining source findings:

- **New admission lock-order risk:** `admit()` locks `VideoJob` before `VideoControl`; cancellation and maintenance use the opposite order. This can deadlock under concurrent PostgreSQL requests. It is inferred from the code; no production deadlock was observed in your logs.
- **Incomplete engine diagnostics:** bootstrap combines dirty/wrong revision into one message. Doctor's `runtime=true` does not validate the separate engine checkout, and missing model evidence masks later engine checks.
- **Benchmark accepts blank paths as the repository directory:** validate real files and prerequisites before loading the model or prompting for an expensive run.
- **Capabilities/allowance stay stale** after complimentary use, restoration, new requests, daily reset and worker recovery.
- **Focus/online recovery can start overlapping polls**, allowing old responses to replace a newer status/cancellation result.
- **Unpaid photos may expire behind a long render:** validation admission needs a truthful busy/capacity check before accepting uploads likely to expire in ten minutes.
- **Unlimited owner still hits the general six-preflights/hour cap.** Preserve one active request and resource limits, but align the product cap with the requested unlimited complimentary use.
- **A free-text supported-instructions field is still absent.** The UI currently builds the instruction string from role/enhancement/caption controls.
- **Targeted Playwright video tests are not run in ordinary CI.** Expand meaningful consent/payment/reconnect cases and wire the local mocked suite into CI.
- **One portable worker test still calls real native-Mac tool validation on Linux.** Fix the test seam, not the production check.

Actual verification in this review: current worker suite **195 passed, 1 failed** on Linux. Failure: `test_output_metadata_verification_requires_exact_disclosure`. The existing legal checker passes for old published pages; the video publication dry-run passes without writing an attestation. Full backend/web suites and real Intel inference/provider/SMTP tests were not run here. ZIP43's implementation report contains earlier checkout-specific test results, which should not be described as new verification of this release.

## 2. Render changes — only what is needed now

1. Open **Render → My project → Production → ai_tool → Environment**.
2. Change the effective values of these two variables:

```dotenv
SWICO_VIDEO_ENABLED=false
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
```

3. Check for service-level overrides if those variables also appear in `swico-backend-production`. A service value overrides the linked group. Save and deploy the actual changes. [Render environment-variable documentation](https://render.com/docs/configure-environment-variables).
4. Preserve the existing worker digest, database, Valkey URL, SMTP, Razorpay, owner unlimited email, ₹25 price, 600-second retention, five daily video attempts and ₹40 weekly tester configuration. No new service, cron, database, cache or migration is needed to resolve the reported checkpoint.
5. After deployment, open **ai_tool → Shell**:

```bash
cd /opt/render/project/src/backend
python -m scripts.swico_video_release_check --pretty
```

With the same remaining prerequisites, the expected result is:

```json
{
  "ready": false,
  "prerequisites_ready": false,
  "rollout_safe": true,
  "feature_configured_enabled": false,
  "paid_configured_enabled": false,
  "release_state": "disabled_pending_prerequisites"
}
```

The readiness checker still exits nonzero while prerequisites are missing; this is expected. `rollout_safe=true` means admissions are safely disabled, not that the video feature is complete.

6. Run the Codex prompt below on the development checkout. Review and commit the resulting code through your existing workflow. Deploy API and website from the same reviewed release when their changes are ready.
7. Complete publication of the **actual reviewed video policies** on the development checkout, not by editing ephemeral files in Render Shell. From repository root:

```bash
python3 scripts/video_legal_diff.py
python3 scripts/publish-video-legal.py \
  --owner-attestation \
  --approver-role "Harikrishnan Kaithavalappil Shajahan, CTO, Swivel Technologies" \
  --approval-date 2026-09-19 \
  --dry-run
```

That exact dry-run passed during this review and changed no permanent files. Use the real date on which you review the pages. The current candidate fingerprint is `29f25752f2ab4d30d505515fd5198e2fbc02f3a7cf1f0408d527e61530990ee0`; calculate it again after any text change rather than copying old hashes.

If you are the accountable publisher, have reviewed those exact pages and can make the stated confirmations, publish locally by repeating the command without `--dry-run`, adding:

```text
--confirm-authority --confirm-not-counsel-reviewed --confirm-right-to-publish
```

Then run:

```bash
python3 scripts/check-legal-publication.py
git diff --stat
```

The helper updates `web/src/content/legalContent.json` and `docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md`. Include both in the reviewed commit and deploy **ai_tool and swico-web**. Publishing those pages records your publication attestation; it does not supply missing third-party model or template permission documents. This review has not attested or published for you.

8. Complete the Mac sequence below, actual output review, isolated payment/refund acceptance, an explicitly authorized operator SMTP recipient test and private-download/expiry checks. The readiness checker can pass with both switches false.
9. When the complete release is verified, enable both settings and deploy once:

```dotenv
SWICO_VIDEO_ENABLED=true
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=true
```

Recheck readiness and the website. If an issue appears, set both false while preserving the video-aware payment dispatcher, database and maintenance so existing work/refunds can settle. Do not downgrade/stamp the database or delete payment/outbox records.

## 3. Mac commands — continue from your current installation

Run one numbered step at a time. If a command exits with an error, fix that step before starting the next. Your earlier pasted commands continued after failed setup and benchmark; that is why a LaunchAgent was installed before the worker was ready.

### A. Stop the currently loaded, unready worker

After disabling new admissions on Render:

```bash
cd /Users/admin/Documents/swico_server/ai_tool
video_python="$PWD/.venv-video/bin/python"
"$video_python" -m swico_video_node service stop
```

Require `stopped=true` and `credentials_preserved=true`. This stops the LaunchAgent and retains its configuration. Your supplied logs show no active ready worker. If actual accepted work has appeared since those logs, allow it to settle before stopping.

### B. Inspect the separate FaceFusion checkout

```bash
video_data="$("$video_python" -c 'from swico_video_node.storage import root; print(root())')"
video_engine="$video_data/engine/facefusion"

git -C "$video_engine" rev-parse HEAD
git -C "$video_engine" status --short --untracked-files=all
git -C "$video_engine" diff --stat
```

Expected HEAD:

```text
03d49d0c7de095a41628a74d94a146214f82837a
```

The status output should be empty. These checks target a different Git working tree from `ai_tool`, normally `/Users/admin/Library/Application Support/SwicoVideo/engine/facefusion`. A clean main repository does not establish that this checkout is clean. [Git status documentation](https://git-scm.com/docs/git-status).

Your logs do not contain this engine status or actual HEAD, so the evidence does not distinguish modified/untracked files from a wrong commit. Do not assume corruption, blame a specific file, use `git reset --hard`, or run `git clean`.

### C. Preserve the problematic engine and recreate the pinned checkout

For the reported dirty/wrong checkout, this block checks its state again. A matching clean engine is kept. Otherwise the block preserves the complete old engine in a new private archive directory and lets setup recreate only the pinned engine. Tokens, configuration, template masters, rights and manifests outside that checkout remain in place.

```bash
"$video_python" - <<'PY'
from pathlib import Path
import json
import subprocess
import tempfile
from swico_video_node.storage import ENGINE_COMMIT, exclusive, root

with exclusive():
    source = root() / "engine" / "facefusion"
    if source.is_symlink() or not source.is_dir():
        raise SystemExit("Expected an existing real FaceFusion directory; inspect the path.")
    git_dir = source / ".git"
    if git_dir.is_symlink() or not git_dir.is_dir():
        raise SystemExit("Expected the existing FaceFusion Git checkout; inspect before recovery.")
    actual = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        capture_output=True, text=True, timeout=15,
    )
    state = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=all"],
        capture_output=True, text=True, timeout=15, check=True,
    )
    if actual.returncode == 0 and actual.stdout.strip() == ENGINE_COMMIT and not state.stdout.strip():
        print(json.dumps({"archived": False, "reason": "pinned_engine_already_clean"}))
    else:
        archive = Path(tempfile.mkdtemp(prefix="facefusion-archive-", dir=source.parent))
        destination = archive / "facefusion"
        source.rename(destination)
        print(json.dumps({"archived": True, "preserved_checkout": str(destination)}))
PY
```

No files are deleted. Any old model weights inside that engine also remain in the archive; they are not automatically trusted or reactivated. Your current logs report no installed model files.

Once the block succeeds:

```bash
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
bash swico_video_node/scripts/setup_macos.sh --python /opt/local/bin/python3.12
```

Require successful exit and `dependency_import_smoke: true`. Seeing pip's `No broken requirements found` alone is insufficient: your previous setup failed immediately afterward at engine validation. Recreating the pinned checkout is not a MacPorts/Python/FFmpeg reinstall.

If a new reviewed Swico correction is upstream, update the clean main checkout while the worker is stopped, before rerunning setup:

```bash
git status --short
git pull --ff-only
```

Preserve any local changes instead of resetting them. Do not run `init`, `rotate-token`, or change the Render digest: pairing is already working.

### D. Inspect and complete the existing model/template evidence

```bash
"$video_python" -m swico_video_node models evidence status
"$video_python" -m swico_video_node models provenance status
"$video_python" -m swico_video_node templates rights status --id couple-01
"$video_python" -m swico_video_node templates rights status --id couple-02
```

These report missing items; they do not create permission or model files. Both templates are already imported, so do not import them again.

For each applicable model/engine evidence record, choose the actual documents and enter the actual reviewer/date. Example for one asset, replacing the reviewer/date with real values:

```bash
video_reviewer="Harikrishnan Kaithavalappil Shajahan, CTO, Swivel Technologies"
video_review_date="2026-09-19"
video_asset="inswapper_128.onnx"
video_licence="$(osascript -e 'POSIX path of (choose file with prompt "Choose the applicable model licence document")')"
video_permission="$(osascript -e 'POSIX path of (choose file with prompt "Choose the actual commercial permission document")')"
```

After successful selections and an actual review:

```bash
"$video_python" -m swico_video_node models evidence add \
  --asset "$video_asset" --reviewer "$video_reviewer" --reviewed-at "$video_review_date" \
  --licence-file "$video_licence" --permission-file "$video_permission"
```

Inventory: `code_review`, `inswapper_128.onnx`, `arcface_w600k_r50.onnx`, `retinaface_10g.onnx`, `2dfan4.onnx`, `fan_68_5.onnx`, `dfl_xseg.onnx`, `bisenet_resnet_34.onnx`, `gfpgan_1.4.onnx`, `open_nsfw.onnx`. Use evidence applicable to each item. The existing `--permission-basis applicable_licence` alternative is only for genuinely applicable permissive components; the three restricted model assets explicitly require separate permission evidence.

ZIP43 now supports recording the SHA-256 of an actual, independently reviewed local model file:

```bash
video_model_file="$(osascript -e 'POSIX path of (choose file with prompt "Choose the reviewed ONNX file for the selected asset")')"
"$video_python" -m swico_video_node models provenance record \
  --asset "$video_asset" --model-file "$video_model_file" \
  --reviewer "$video_reviewer" --reviewed-at "$video_review_date" \
  --confirm-technical-hash
```

Alternatively, if the reviewer already has the genuine full-model SHA-256, use `--sha256 "$video_expected_sha256"` instead of `--model-file`. Record all nine model hashes. Do not use the worker-token digest, a document hash, a CRC32 checksum or an arbitrary downloaded file as reviewed model provenance. The command hashes/records only; it does not install or upload the selected file. If neither legitimate assets nor reviewed hashes are available, those are still required inputs, not something another environment setting supplies.

`models provenance status --fetch` can inspect the fixed upstream sidecars. Recording a legacy CRC32 sidecar does not fill the independent expected SHA-256 requirement.

Add rights to each existing template using its actual supporting documents. Example for `couple-01`:

```bash
video_template_licence="$(osascript -e 'POSIX path of (choose file with prompt "Choose template 1 licence evidence")')"
video_template_permission="$(osascript -e 'POSIX path of (choose file with prompt "Choose template 1 video and audio permission evidence")')"
"$video_python" -m swico_video_node templates rights add --id couple-01 \
  --reviewer "$video_reviewer" --reviewed-at "$video_review_date" \
  --licence-file "$video_template_licence" --permission-file "$video_template_permission" \
  --confirm-video-modification --confirm-video-distribution --confirm-audio-rights
```

Repeat for `couple-02` with its applicable documents. The existing legal templates and owner policy attestation are not substitutes for missing model/movie/audio grants. Use the current review date; do not backdate or assert documents were reviewed when they were not.

After evidence and expected hashes are complete:

```bash
"$video_python" -m swico_video_node models install --profile quality-cpu
```

After installation succeeds:

```bash
"$video_python" -m swico_video_node models audit
```

Require `ready=true` before preparation. This audit covers template evidence as well as model files.

### E. Prepare, correct and review both templates

Run each command only after the previous one succeeds:

```bash
"$video_python" -m swico_video_node templates prepare --id couple-01
"$video_python" -m swico_video_node templates prepare --id couple-02
open "$video_data/templates/couple-01/review"
open "$video_data/templates/couple-02/review"
```

Inspect every shot/frame. Current correction commands exist:

```bash
"$video_python" -m swico_video_node templates tracks status --id couple-01
"$video_python" -m swico_video_node templates tracks status --id couple-02
```

Use only track IDs and frame numbers actually shown in your review. The available forms are `tracks reassign --id ... --track ... --role male|female|exclude`, `tracks exclude --id ... --track ...`, and `tracks split --id ... --track ... --at-frame ...`. Do not copy someone else's role mapping; background faces must remain excluded. Corrections invalidate old approval/calibration.

After reviewing/correcting:

```bash
"$video_python" -m swico_video_node templates review --id couple-01
"$video_python" -m swico_video_node templates review --id couple-02
```

Enter the actual roles at the prompts and confirm only after viewing the frames.

### F. Benchmark with real non-empty photo paths

Your previous log shows both source paths blank. The current code interprets an empty string as the current directory; the next Codex fix must reject that before loading the engine.

For the current interactive command, obtain actual paths using Finder:

```bash
video_male_photo="$(osascript -e 'POSIX path of (choose file with prompt "Choose the consenting adult male-role source photo")')"
video_female_photo="$(osascript -e 'POSIX path of (choose file with prompt "Choose the consenting adult female-role source photo")')"
printf 'Male photo: %s\nFemale photo: %s\n' "$video_male_photo" "$video_female_photo"
```

Keep these paths private. Then run:

```bash
"$video_python" -m swico_video_node benchmark --all-templates --interactive-sources --runs 3
```

At its male/female prompts, paste the corresponding full path above, without shell quotes or backslashes. Provide consent only for actual consenting test subjects. The current benchmark renders two templates × two enhancement variants × (one initial + three warm renders) = 16 full renders. Watch the result before each QA confirmation. A second Terminal can open the review directory:

```bash
cd /Users/admin/Documents/swico_server/ai_tool
video_data="$("$PWD/.venv-video/bin/python" -c 'from swico_video_node.storage import root; print(root())')"
open "$video_data/benchmarks"
```

You can also open the actual path printed by the benchmark. A failed benchmark must not be followed by publication or service startup. No processing-time estimate is known until this succeeds. Also test male-only and female-only jobs separately; this benchmark renders both roles.

### G. Publish metadata, start foreground, then install service

After both calibrated templates pass:

```bash
"$video_python" -m swico_video_node templates publish --all
```

After publication succeeds:

```bash
caffeinate -is "$video_python" -m swico_video_node run
```

Leave that terminal open. In another terminal:

```bash
cd /Users/admin/Documents/swico_server/ai_tool
video_python="$PWD/.venv-video/bin/python"
"$video_python" -m swico_video_node doctor --check-api
```

Look for local/native readiness, authenticated API, fresh `worker_active=true` and `templates_current=true`. The API worker-active check is expected to be false before the first successful worker heartbeat; do not require that before starting the foreground worker.

After foreground acceptance, stop it with Ctrl+C while no accepted job is processing, then:

```bash
"$video_python" -m swico_video_node service install
"$video_python" -m swico_video_node service status
"$video_python" -m swico_video_node doctor --check-api
```

Check loaded, running, fresh local liveness and backend/native readiness. Your previous `running=true` alone did not establish a serving worker. Keep the Mac connected, awake and logged in; the LaunchAgent starts after user login.

Finally run the Render release check again with switches still false. After all technical and actual delivery checks pass, use the final activation step in section 2.

## 4. Suggested commit message

Use after the corresponding fixes are implemented and reviewed:

```text
fix(video): recover Mac engine setup and close release readiness gaps
```

## 5. Detailed Codex Luna prompt — paste this section at repository root

Use high effort and work from the current Swico `ai_tool` repository root. Complete the remaining website-video code, tests and operational fixes in one sustained implementation pass. Build on the existing implementation; do not restart it, return a staged roadmap or stop after a plan. Finish everything possible with available code/resources and identify actual external prerequisites precisely.

Read applicable repository instructions and inspect the current revision/working tree first. Preserve unrelated changes. The review was of `ai_tool-main(43).zip`; recheck findings against the actual current checkout before editing. Do not assume the old report's `1a6297f1` or `c429bab4` is the current revision.

SCOPE AND FIXED REQUIREMENTS

- Website/video backend/Intel Mac worker only. Existing Render API/website/PostgreSQL/private `WEB_UPLOAD_CACHE_URL` Valkey, existing Windows Swico Free node and one Intel Mac. No new hosting, service, cron, public Mac port, tunnel, GPU provider or video API. No Android, ordinary CLI, Chat-credit, subscription or Windows-node changes.
- Keep ₹25 total / 2500 paise per paid template generation, output available for 600 seconds from first READY, existing SMTP notification to verified account email, durable queue/refund recovery and private chat output.
- Keep `harishajidasan@gmail.com` unlimited complimentary video use, existing weekly tester membership at five complimentary video attempts/day Asia/Kolkata, and unchanged ₹40 weekly Chat credits. One active request/account and actual machine capacity remain enforced. Remove the ordinary six-preflights/hour product cap for the explicitly configured unlimited account while retaining resource protection.
- Templates `couple-01` and `couple-02` stay on the Mac; website publishes icons/metadata. One native inference job at a time; outbound HTTPS polling only.

CURRENT VERIFIED OPERATOR CHECKPOINT — DO NOT REPEAT SETUP UNNECESSARILY

Render: migration current=head `20260918_website_video`; cache headroom, SMTP configuration, Razorpay configuration, worker digest and schema all pass. Weekly tester check has enabled=true, allowance_micros=40000000, three subjects and ok=true. Both video flags are currently true but readiness fails on exact legal publication, current native calibration and two published templates. Runbook must instruct disabling both flags now while preserving settlement; no migration or new service is needed merely for these blockers.

Actual Mac: `/Users/admin/Documents/swico_server/ai_tool`, Intel x86_64 macOS26.7, Python3.12.14, MacPorts and FFmpeg/ffprobe9.0.1, repo `.venv-video`. Prerequisite check passes; locked package installation/pip check passes. Bootstrap then reports `Dirty/wrong engine checkout; inspect/archive explicitly, no reset performed`. API doctor reports authenticated=true, schema/control=true, worker_active=false, templates_current=false. Runtime/tools report true; nine model records lack evidence, hashes and installed bytes. Both template master/manifest pairs already exist but lack permission evidence. Do not re-import or delete them.

The LaunchAgent is loaded/running but not ready; there is no evidence of a crash. Benchmark source path inputs were blank and failed on missing evidence. No native inference/quality or timing success exists. Preserve token/digest; do not call init/rotate-token or reinstall the working host toolchain to troubleshoot these failures.

PRESERVE ALREADY-COMPLETED FIXES

ZIP43 already distinguishes legacy CRC32 from SHA-256, permits bounded GitHub asset redirects, supports provenance record --sha256/--model-file with reviewer/date, provides track status/split/reassign/exclude, resumes checkout, retries transient status failures, displays processing ETA, clears old invalid photo selections and shows previews, and fixes the earlier refund-finalization lock order. Review and retain these rather than recreating them.

TASK A — ENGINE INTEGRITY DIAGNOSIS AND SAFE RECOVERY

1. Inspect bootstrap.py, diagnostics.py, models.py, storage.py, runtime and service startup. `engine_checkout()` combines dirty status and wrong HEAD. Expected FaceFusion commit is `03d49d0c7de095a41628a74d94a146214f82837a` under `root()/engine/facefusion`, separate from the main Git checkout.
2. Add one shared read-only engine status function used by bootstrap/doctor/audit. Report expected/actual commit, missing/non-repository/wrong-revision/tracked-change/untracked-change separately, with bounded redacted summaries. It must run even when model evidence is missing; don't let missing rights hide engine corruption/changes. Do not imply `runtime=true` proves engine integrity.
3. Add an explicit conservative archive/recreate command or a fully validated operator recovery path. It must hold the existing worker lock, refuse unsafe paths/symlinks, confirm the worker is stopped, preserve the complete old checkout in a unique private archive and recreate only the pinned engine. Preserve token, config, masters, rights, model manifests, tool configuration and any archived model bytes. A clean pinned checkout should be a no-op. Do not git-reset/clean, alter ignore settings to conceal changes or silently trust modifications. Keep partial/network-failed recovery resumable and diagnosable.
4. Reorder bootstrap checks where appropriate so a known invalid engine is diagnosed before unnecessarily repeating expensive dependency downloads, without weakening binary/native requirements. Provide exact existing-install commands from actual CLI help and remove stale first-install instructions for this checkpoint.
5. Check launch/service diagnostics distinguish loaded, running, local liveness and serving readiness. Report blocked prerequisites usefully without creating a restart/retry loop the operator mistakes for availability. Starting a service must not claim native readiness.

TASK B — MODEL/TEMPLATE ONBOARDING AND BENCHMARK USABILITY

1. Keep algorithm-labelled CRC32 and independently reviewed expected full-model SHA-256 distinct. Preserve explicit --sha256/--model-file functionality and existing genuine evidence requirements. No fabricated hashes, automatic grants or model download from status commands. Ensure useful existing-state-safe commands for all nine assets plus engine code review. Technical file integrity is not proof of publisher authenticity or commercial permission.
2. Fix template-specific remediation: missing template permission currently recommends `models evidence add`; it must say `templates rights add --id couple-01` or couple-02 with the appropriate fields. Distinguish absent bytes, expected hash, documentation, reviewer metadata and engine integrity.
3. Validate local prerequisites before asking for benchmark consent/photos. Reject blank paths, directories, unreadable files, unsupported inputs and inappropriate symlinks before constructing Engine. Blank input currently becomes the repository directory through Path('').resolve(). Provide convenient file selection if useful, while preserving explicit user consent and actual visual QA.
4. Preserve the existing two imported masters. Review the new track correction implementation, validation and approval/calibration invalidation; ensure corrections cannot leave unusable orphan track roles or inconsistent state, and retain a recoverable record of changed tracks. Do not automate role mapping or QA acceptance.
5. Exercise male-only/female-only/both swaps, enhancement off/natural, captions, occlusion/cuts/background exclusion, disclosure and audio sync on actual Mac/approved assets when available. Preserve current rendering/quality/runtime bindings and actual measured calibration; do not fabricate timings or sign QA hashes. No new inference backend or silent dependency upgrade.

TASK C — FIX ADMISSION CONCURRENCY WITHOUT BREAKING CHECKOUT RECOVERY

1. Reproduce the ZIP43 lock inversion: router.admit() calls owned_job(FOR UPDATE) before admission()->control(FOR UPDATE), while cancel/fenced/maintenance take VideoControl before VideoJob. This is a possible PostgreSQL deadlock on concurrent initial admission and cancellation/sweep. Use a consistent control-before-job order without applying fresh-admission gates to existing owner checkout recovery. Taking the serialization lock and checking availability are separate concerns.
2. Preserve idempotent reuse of the same unexpired Razorpay order, expired-hold closeout, funding mismatch rejection, no second order on retry, and late-capture refund handling. Keep earlier corrected PaymentOrder→VideoJob→VideoOutbox refund ordering; audit interactions rather than fixing one inversion by creating another.
3. Add deterministic concurrent admission/cancel/sweep tests using disposable real PostgreSQL and transaction synchronization. SQLite is not concurrency proof. No production DB tests, resets or stamp/downgrade.
4. Address unpaid preflight starvation: photos expire 600 seconds from creation while paid renders have priority. Use current readiness/queue estimates for truthful validation availability or bounded reservation before accepting uploads likely to expire; never charge expired input, silently extend retention or add infrastructure. Keep existing paid jobs and source deletion guarantees.

TASK D — COMPLETE REMAINING WEBSITE UX AND BROWSER VERIFICATION

1. Refresh capabilities and allowance after complimentary admission, cancellation/restoration, new request, daily reset and worker recovery. Add retry for the initial capabilities fetch and bounded focus/online refresh. Protect account ownership and stale response handling. Current refresh occurs only on mount and successful paid verification.
2. Make VideoCard polling single-flight with exactly one owned timer. Focus/online can currently start a fetch while another is active, producing overlapping timers and out-of-order state regressions. Reject stale responses across cancel/mutations, account changes and unmount. Add deferred-response tests that deterministically reproduce the race, not only immediately resolved mocks. Preserve expiry and bounded settlement polling.
3. Finish local photo selection checks: zero-byte/unsupported MIME selection must not contradict the displayed error text. Preserve authoritative backend image decoding, preview cleanup and old-photo clearing.
4. Add the requested supported-instructions prompt field wired to the strict existing parser with understandable examples and confirmation. Role/enhancement/caption controls alone are not a prompt field. Keep supported face replacement scope explicit; no claims of arbitrary scene/action/speech generation or unimplemented Unicode caption support.
5. Expand local Playwright acceptance to assert all eight named/versioned consent fields, asynchronous validation, actual mocked Razorpay modal/order reuse/dismissal, uncertain verification/webhook recovery, reload, quota/reset refresh, transient/overlapping polling, owner isolation and immutable expiry. Current resume unit coverage returning checkout:null does not exercise modal reopening.
6. Wire the local mocked Chromium video suite into existing CI. The normal workflow currently does not execute it. No production accounts, customers or transactions in automated browser tests.

TASK E — POLICY PUBLICATION AND RELEASE HANDOFF

1. Existing documents and publication helper already exist. Read current videoLegalDraft/legalContent/attestation validation; don't create duplicate policy packs. The old published checker passes but the video gate is false because pages differ. Correct stale hardcoded hashes and checkout claims in VIDEO_ACCEPTANCE and other docs; compute current fingerprints via the helper.
2. A real owner can review the candidate with `scripts/video_legal_diff.py` and `publish-video-legal.py --owner-attestation --approver-role ... --approval-date ... --dry-run`. Make the exact non-mutating candidate concrete. Do not fabricate the user's attestations or publish without genuine authority/review. Explain the actual helper confirmation flags and which two canonical files need commit/deployment to API and website. Policy publication does not grant model/movie/audio rights.
3. Preserve disabled-admission drain/settlement. No new service, cache, cron or migration unless an actual necessary code change requires a reviewed additive migration. Current schema is already head. Leave default flags false and provide one final activation for the complete verified feature.
4. Missing actual rights, reviewed assets, local Mac access or provider credentials must be recorded as specific external prerequisites while you complete all unrelated code/test/doc work. Do not stop halfway through implementation because you cannot run an external acceptance test.

VALIDATION AND FINAL DELIVERABLES

- Run meaningful focused tests for engine status/recovery preserving state, benchmark input rejection, evidence remediation, PostgreSQL lock ordering, preflight admission, polling races, quota refresh, prompt grammar and checkout recovery.
- Fix the surviving worker unit test `test_output_metadata_verification_requires_exact_disclosure`: it injects fake capture but still resolves native macOS tools on Linux. Mock/inject the correct test seam while retaining production native validation. Current review result is 195 passed, 1 failed on Linux; do not label historical 195-pass output as current proof.
- Run required worker/backend/frontend gates and the local mocked video browser suite. Use isolated real PostgreSQL/Valkey only where required. No skipped/fake native results or test weakening to declare ready.
- Run actual Mac face inference, template quality, foreground/service operation and measured calibration only when the real environment and approved assets are accessible. Configured SMTP/Razorpay is not actual delivery/capture/refund. Provider tests need isolated test credentials and an explicitly authorized recipient; do not send real-customer emails or initiate real charges as tests.
- Deliver code fixes, tests/CI changes, updated Mac/Render/acceptance docs and a current implementation report. State what was already fixed, what you changed, actual commands/results, external blockers and exact operator next steps. Supply a suggested commit message.
- Do all implementation in one pass. Do not automatically commit, push, deploy, rotate credentials, sign policy/model/template permissions or mark unseen output QA-PASS.

Suggested commit message: `fix(video): recover Mac engine setup and close release readiness gaps`.
