# Swico website videos: complete guide and Codex prompt

Reviewed 19 September 2026 against the supplied `ai_tool-main(42).zip`.

This is a source review and implementation handoff. No production deployment, payment, email, model installation or repository modification was performed. The attached screenshot shows Render; the pasted Markdown contains masked environment entries. No actual sample movie or replacement photos were present in this turn, so visual quality and Mac throughput cannot be measured here.

## 1. What exists, what to finish, and the intended product

Yes, a template can replace the actor's face with one supplied photo and the actress's face with another, subject to clear source faces and reliable tracking. The existing repository already implements the real FaceFusion inference path and most of the complete product. Finish this implementation in one development pass; do not create a second video system or split the requested features into future phases.

| Component | Responsibility |
|---|---|
| Existing Swico website | Two template icons, photos, supported edit prompt, explicit ₹25 checkout or complimentary attempt, queue/progress, chat result and download |
| Existing Render API/PostgreSQL | Authentication, quotas, orders, durable queue, worker leases, output access, expiry, refunds and SMTP notification intent |
| Existing `swico-upload-cache` Valkey | Private temporary face uploads and completed MP4 bytes |
| Intel Mac | Permanent template masters and model files; photo preflight, face tracking, swapping, enhancement and encoding |
| Existing Windows node | Continue serving Swico Free as it does today |

The Mac polls Render over outbound HTTPS. There is no incoming Mac port, tunnel, new hosting service, cloud GPU or external video provider. Template masters remain on the Mac. A completed MP4 is temporarily relayed to the existing Valkey cache, so downloading an already-ready result does not depend on the Mac staying online during the ten-minute window.

Product rules:

- Any verified, signed-in website account, including a Swico Free account, can explicitly purchase one template video for ₹25 total / 2500 paise. Guests cannot.
- `harishajidasan@gmail.com` receives unlimited complimentary generations. Its existing unlimited Chat-token setting remains unchanged. One active request per account and actual Mac capacity still apply.
- Members of the existing weekly developer-test programme receive five complimentary attempts per day, resetting at midnight Asia/Kolkata. Their ₹40 weekly Chat credits are neither deducted nor changed.
- Payment is for the video, with no wallet credit, subscription change or referral award. Validate photos and supported options before charging. Recover failed paid jobs through the existing refund process.
- ETA is based on actual Mac measurements and current queue state. Show it after admission/payment and while processing. Do not invent a processing time from the ten-second clip duration.
- The MP4 is available in the user's chat for exactly 600 seconds from first READY. The ready email uses the existing SMTP sender and links back to authenticated Swico access. It does not attach a permanent copy or extend the expiry.
- Prompts control supported template edits. FaceFusion does not generate a new scene, speech, clothing or action from text. The current backend accepts `swap`, `enhance`, and an optional printable-ASCII caption up to 100 characters. A proper prompt field is part of the completion work below.

For this Intel i7 / 32 GB Mac, retain the already-integrated CPU FaceFusion/InSwapper 128 profile with optional conservative GFPGAN enhancement. This is a practical compatibility recommendation, not a claim that it wins a quality benchmark. Compare enhancement off/natural on both real clips; restoration can alter likeness. The existing pins are FaceFusion 3.0.1 at `03d49d0c7de095a41628a74d94a146214f82837a`, Python 3.12 and ONNX Runtime 1.19.2. Do not replace them with latest/ARM/CUDA dependencies without native validation. The pinned ONNX Runtime release provides a [CPython 3.12 macOS universal2 wheel](https://pypi.org/project/onnxruntime/1.19.2/).

InSwapper/ArcFace pretrained weights have separate commercial restrictions despite InsightFace's MIT code licence. The existing code records model and template permissions and contains a complete video policy draft. Those records do not create rights to third-party models, movie footage or music. [InsightFace's licence statement](https://github.com/deepinsight/insightface#license) and [FaceFusion's model licence inventory](https://docs.facefusion.io/introduction/licenses) describe the distinction.

### Confirmed findings for the next implementation pass

1. **Model provenance is currently broken.** `swico_video_node/models.py` expects each upstream `.hash` file to contain 64 hexadecimal SHA-256 characters. I fetched the pinned upstream `hash_helper.py`: it uses CRC32, formatted as eight hexadecimal characters. The actual `2dfan4.hash` response is `a948738e`. Its URL redirects to `release-assets.githubusercontent.com`, which the current sidecar fetcher rejects. The official release API returned `digest: null` for the inspected legacy ONNX assets, so a GitHub API SHA-256 cannot simply be assumed. Keep CRC32 separate from a real SHA-256 of the model bytes. Do not pad it or hash the sidecar and call that the model digest. Sources: [pinned hash implementation](https://raw.githubusercontent.com/facefusion/facefusion/03d49d0c7de095a41628a74d94a146214f82837a/facefusion/hash_helper.py), [actual sidecar](https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/2dfan4.hash), [release metadata](https://api.github.com/repos/facefusion/facefusion-assets/releases/tags/models-3.0.0). Only source/checksum/metadata were fetched; no model weights were downloaded.
2. **The Mac runbook points at the wrong Python.** Setup creates `repo/.venv-video`, but part of `docs/VIDEO_MAC_SETUP.md` uses an interpreter underneath Application Support. Use `video_python="$PWD/.venv-video/bin/python"` at the repository root.
3. **Interrupted checkout cannot be resumed in the UI.** The backend can return the existing order, but the buttons disappear when a job enters `checkout`.
4. **Polling stops permanently after a transient error.** Conversely, settled history cards can poll indefinitely, and the active job is polled twice. Capabilities and daily allowance become stale.
5. **The processing ETA disappears.** The card renders its estimate only when a queue position is present; processing jobs have an ETA but no queue position.
6. **An invalid replacement photo can leave the previously selected photo active.** Clear the affected selection and show which photo will actually be submitted.
7. **Tracking is position-based.** Existing preparation associates detections with consecutive-frame box overlap. Crossing/occluded people need ambiguity detection and a usable split/reassign/exclude correction tool. The current runbook asks the operator to edit `tracks.json` manually.
8. **Busy Mac preflight can outlast unpaid upload retention.** Unpaid photos expire ten minutes after job creation, while already-paid renders have priority. Make validation availability visible before uploading; do not charge for expired preflight or extend retention silently.
9. **Potential refund database deadlock.** The outbox finalizer locks outbox then payment; the refund webhook locks payment then job/outbox. This is a source-inferred concurrency risk, not a reproduced live failure. Use consistent lock order and a real disposable PostgreSQL race test.
10. **Tests need correction.** The video Playwright happy path selects one unnamed checkbox although the form has eight consent checkboxes. It is not run by ordinary frontend CI. A worker unit test also accidentally resolves native macOS tools despite injecting a fake capture function.

Verification performed: worker suite **187 passed, 1 failed** on Linux. The failure is the native-tool test seam above, not a face-inference result. The existing legal publication checker passes for the old published pages; `video_policy_ready()` is **false** for the current video draft. Backend/frontend suites were not run here because their project dependencies are absent. Neither actual Intel inference nor payment/SMTP delivery has been tested by this review.

## 2. Render changes, step by step

These are configuration steps for the complete implementation, not development phases. Keep new admissions disabled while assembling and checking the completed release, then enable the finished feature once its checks pass.

1. Run the Codex prompt in section 5 on your development checkout. Review the resulting changes and publish that reviewed commit through your usual Git workflow.
2. In Render, open **My project → Production → ai_tool → Environment**. Your screenshot also shows a pending invoice/payment-failed banner; use Render Billing to settle it so the existing services are not interrupted.
3. Check both the service's own environment and the linked `swico-backend-production` group before editing. A service-level value takes precedence over a linked-group value. Avoid contradictory duplicates. Put video-specific settings on the existing API service; no new environment group is needed. [Render environment-variable documentation](https://render.com/docs/configure-environment-variables).
4. Add or correct the following values. Preserve an already-correct value rather than repeatedly changing it.

```dotenv
SWICO_VIDEO_ENABLED=false
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
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

`MAX_INFLIGHT_JOBS=6` is an upper bound, not six simultaneous renders or a throughput promise. The Mac processes one inference job at a time. A slow measured template may require a smaller queue; use benchmark/capacity evidence to choose it.

5. Generate/re-display the existing worker digest on the Mac using section 3, then set **`SWICO_VIDEO_WORKER_TOKEN_SHA256`** to that 64-character value. Store only the digest on Render. Do not replace a working token to troubleshoot a model or clip.
6. Reuse these existing settings:

| Purpose | Existing settings |
|---|---|
| Database | Existing production database configuration |
| Private temporary media | `WEB_UPLOAD_CACHE_URL` connected to `swico-upload-cache` |
| Existing OTP/notification SMTP | `EMAIL_USER`, `EMAIL_PASS`, optional `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USE_TLS` |
| Existing Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| Existing tester eligibility | `SWICO_WEEKLY_TESTER_CREDITS_ENABLED`, `SWICO_WEEKLY_TESTER_EMAILS`, `SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES` |

Keep the current tester emails and ₹40 allowance. There is no separate video tester-email list in this checkout. Do not replace working production payment keys with test keys on the live API.

7. In **swico-upload-cache**, inspect its existing capacity, persistence/backups and eviction settings. The video code requires bounded `maxmemory` and spare capacity, uses a 128 MiB maximum video budget and reserves 20 MiB per active/ready job. Its minimum admission headroom check is 52 MiB. Do not flush the cache or alter ordinary Chat's five-minute upload policy. Size the existing service against measured use; TTL expiry is not a promise of deletion from backups. [Render Key Value documentation](https://render.com/docs/key-value).
8. Use **Save, rebuild, and deploy** for changed API configuration/code. Deploy the matching website commit to **swico-web** through its existing build settings. Keep the current migration/build/start commands. Do not install FaceFusion, ONNX models, FFmpeg inference tooling or the Mac worker on Render. No new cron is necessary: the API already runs video expiry/refund/email maintenance.
9. In **ai_tool → Shell**, run:

```bash
cd /opt/render/project/src/backend
python -m alembic -c alembic.ini current
python -m alembic -c alembic.ini heads
python -m scripts.swico_video_release_check --pretty
python scripts/weekly_tester_credit_check.py --pretty
```

The supplied ZIP's migration head is `20260918_website_video`. Compare current to heads after the implementation; if Codex adds a necessary migration, use the new reviewed head. If already equal, no manual migration is needed. If behind, use the existing predeploy migration path. Do not stamp, downgrade or reset the production database.

10. Publish the exact reviewed video policy pages using the existing local helper, then deploy those changes to both API and website. The draft is presently not published. Start with this **read-only** command from the developer repository root:

```bash
python3 scripts/video_legal_diff.py
python3 scripts/publish-video-legal.py --help
```

For the owner-attestation route, replace the values with the real accountable publisher and actual review date:

```bash
python3 scripts/publish-video-legal.py \
  --owner-attestation \
  --approver-role "ACCOUNTABLE PUBLISHER NAME AND ROLE" \
  --approval-date "YYYY-MM-DD" \
  --dry-run
```

After the publisher reviews those exact pages, the existing publication command is the same with `--dry-run` removed and `--confirm-authority --confirm-not-counsel-reviewed --confirm-right-to-publish` added. These flags attest to publication authority and review of that text; they are not model/movie/music licences. This review did not execute publication or create an attestation for you.

11. Complete actual Mac template/output checks, an isolated Razorpay test capture/refund, an explicitly addressed operator SMTP test, and expiry/reconnect acceptance. Do not use real customers as test recipients. The release checker can pass with the feature flags still false; it checks configuration, not successful external delivery.
12. Once the finished release passes, change these two API settings together and deploy:

```dotenv
SWICO_VIDEO_ENABLED=true
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=true
```

Check `/videos`, one complimentary owner request and the intended payment flow. If a serious issue appears, disable both flags while leaving the video-aware backend, payment history and maintenance running to settle accepted work/refunds.

## 3. Mac commands

Run these on **admin@Admins-MacBook-Pro**, the Intel video Mac. Commands assume you are in its `swico_server` directory or existing repository. Your ZIP's runbook describes a previous installation; verify the actual machine rather than reinstalling working tools.

### A. Locate/update the existing checkout and check prerequisites

If the repository is the `ai_tool` folder within your current `swico_server` directory:

```bash
cd ai_tool
git status --short
git log -1 --oneline
```

If already inside `ai_tool`, omit `cd ai_tool`. If no checkout exists, run this from `swico_server` once:

```bash
git clone https://github.com/swivelit/ai_tool.git
cd ai_tool
```

Do not overwrite uncommitted changes. If a worker is running, first pause new video admissions, let accepted work settle, and run its `service stop` before updating its code or environment. Use the existing repository interpreter for that stop command.

After the reviewed fix is on GitHub and any running worker is stopped, a clean checkout can update with:

```bash
git pull --ff-only
uname -m
sw_vers
xcode-select -p
bash swico_video_node/scripts/setup_macos.sh --check
```

If Apple's command-line tools are missing:

```bash
xcode-select --install
```

Finish the Apple installation dialog and rerun the checks. If Python 3.12, FFmpeg and ffprobe are already present and accepted, skip host installation.

If using MacPorts and it is not installed, open the official installer page, download the package matching the version printed by `sw_vers`, and run the macOS installer:

```bash
open https://www.macports.org/install.php
```

Opening the page does not install MacPorts. Do not choose a Tahoe package merely because an old runbook mentions Tahoe. After installation, verify it and install any missing required packages:

```bash
/opt/local/bin/port version
sudo /opt/local/bin/port selfupdate
sudo /opt/local/bin/port install python312 py312-pip ffmpeg
/opt/local/bin/python3.12 --version
/opt/local/bin/ffmpeg -version
/opt/local/bin/ffprobe -version
```

These `sudo` commands are host installations performed by you, not by this review. A deliberately installed alternative native Python/toolchain is also supported; pass its actual absolute Python path to setup.

### B. Bootstrap, preserve the token, pair with Render

At the Mac repository root:

```bash
export PATH="/opt/local/bin:/opt/local/sbin:$PATH"
bash swico_video_node/scripts/setup_macos.sh --python /opt/local/bin/python3.12
video_python="$PWD/.venv-video/bin/python"
"$video_python" -m swico_video_node tools status
"$video_python" -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
```

Require setup success before using the environment. `init` preserves an existing protected token and prints its digest. Copy that digest into Render's `SWICO_VIDEO_WORKER_TOKEN_SHA256`, save/deploy if changed, then:

```bash
"$video_python" -m swico_video_node doctor --check-api
```

At this point `checks.api.authenticated=true` is the pairing result to look for. Overall readiness can remain false until models/templates/calibration and the first worker heartbeat exist. HTTP 401 means pairing needs checking; do not rotate credentials or weaken authentication.

Set `video_python="$PWD/.venv-video/bin/python"` again in each new Terminal opened at the repository root. Permanent state is separately stored under `~/Library/Application Support/SwicoVideo`.

### C. Import the two templates locally

Only import a template ID if it has not already been imported. Existing masters are intentionally preserved.

Select the first clip with a Finder file picker:

```bash
video_clip="$(osascript -e 'POSIX path of (choose file with prompt "Choose template 1" of type {"public.movie"})')"
```

If you cancel the picker, stop that step. Otherwise inspect, require `accepted=true`, then import:

```bash
"$video_python" -m swico_video_node templates inspect --file "$video_clip"
"$video_python" -m swico_video_node templates import --id couple-01 --file "$video_clip" --title "Couple scene 1"
```

Repeat with the second source:

```bash
video_clip="$(osascript -e 'POSIX path of (choose file with prompt "Choose template 2" of type {"public.movie"})')"
"$video_python" -m swico_video_node templates inspect --file "$video_clip"
"$video_python" -m swico_video_node templates import --id couple-02 --file "$video_clip" --title "Couple scene 2"
```

Run import only after inspection passes. Existing validation accepts stable constant frame cadence and preserves dimensions/frame count. It does not silently trim, resize or retime genuine variable-frame-rate media. The optional `templates normalize --file ... --output ...` produces a separate canonical MP4 from already-supported cadence; use it only when appropriate and inspect/play its result.

### D. Record real evidence, correct model provenance, install models

**Run the Codex fix first. The current ZIP's sidecar fetch/record workflow is broken.** The following existing commands are useful for inspecting status:

```bash
"$video_python" -m swico_video_node models evidence status
"$video_python" -m swico_video_node models provenance status
"$video_python" -m swico_video_node models audit
```

The evidence inventory is `code_review` plus:

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

For each applicable asset, choose genuine documentation and fill in the real reviewer/date. This command already exists; values below are examples to replace, not evidence:

```bash
video_asset="inswapper_128.onnx"
video_reviewer="ACTUAL REVIEWER NAME"
video_review_date="YYYY-MM-DD"
video_licence="$(osascript -e 'POSIX path of (choose file with prompt "Choose the applicable model licence document")')"
video_permission="$(osascript -e 'POSIX path of (choose file with prompt "Choose the actual commercial permission document")')"
"$video_python" -m swico_video_node models evidence add \
  --asset "$video_asset" --reviewer "$video_reviewer" --reviewed-at "$video_review_date" \
  --licence-file "$video_licence" --permission-file "$video_permission"
```

Repeat for the complete inventory with documents applicable to each item. For genuinely applicable permissive components, the existing `--permission-basis applicable_licence` alternative is available; it is not allowed for the three restricted InSwapper/ArcFace/RetinaFace assets.

For technical provenance, the Codex prompt requires a corrected status command that distinguishes CRC32 from SHA-256 and a supported route for independently reviewed SHA-256 evidence. Use its generated, tested commands. The old `models provenance record --asset ... --confirm-technical-hash` cannot manufacture a SHA-256 from the legacy sidecar. This guide intentionally does not provide fabricated model digests or present a proposed new CLI option as already implemented.

Once the corrected tooling has recorded authentic technical evidence and required permissions, run:

```bash
"$video_python" -m swico_video_node models install --profile quality-cpu
"$video_python" -m swico_video_node models audit
```

The installer downloads the reviewed model bytes; the setup script alone does not. No model download should occur during a customer's job. The audit also checks template rights: if those are still missing, its template-rights blockers are expected here. Record both templates' rights below and rerun the audit before preparation.

Record the rights for each imported template before preparation/review. Use actual video/audio modification and distribution permissions:

```bash
video_template_licence="$(osascript -e 'POSIX path of (choose file with prompt "Choose template 1 licence evidence")')"
video_template_permission="$(osascript -e 'POSIX path of (choose file with prompt "Choose template 1 video and audio permission evidence")')"
"$video_python" -m swico_video_node templates rights add --id couple-01 \
  --reviewer "$video_reviewer" --reviewed-at "$video_review_date" \
  --licence-file "$video_template_licence" --permission-file "$video_template_permission" \
  --confirm-video-modification --confirm-video-distribution --confirm-audio-rights
"$video_python" -m swico_video_node templates rights status --id couple-01
```

Repeat for `couple-02` with its corresponding documents. Update the reviewer/date if different. Existing approved evidence does not need to be repeatedly imported; changing it invalidates the relevant approval/calibration. Then rerun `"$video_python" -m swico_video_node models audit` and require it to pass.

### E. Prepare/review both roles and measure the actual Mac

```bash
"$video_python" -m swico_video_node templates prepare --id couple-01
"$video_python" -m swico_video_node templates prepare --id couple-02
open "$HOME/Library/Application Support/SwicoVideo/templates/couple-01/review"
open "$HOME/Library/Application Support/SwicoVideo/templates/couple-02/review"
```

Use your actual `SWICO_VIDEO_DATA_DIR` if overridden. Inspect every shot/frame, assign the actor and actress to their intended roles, exclude background faces, and correct ambiguous tracks with the correction workflow delivered by Codex. Then:

```bash
"$video_python" -m swico_video_node templates review --id couple-01
"$video_python" -m swico_video_node templates review --id couple-02
"$video_python" -m swico_video_node benchmark --all-templates --interactive-sources --runs 3
```

Supply approved local test photos. The current benchmark does 16 full renders: two templates × two enhancement variants × one initial render plus three warm runs. It asks for actual output review. Open a second Terminal/Finder window while the first waits:

```bash
open "$HOME/Library/Application Support/SwicoVideo/benchmarks"
```

Watch the complete output before confirming its QA prompt. Check both identities, mouth/eyes, cuts, occlusion, flicker, background people, audio sync and disclosure. The current benchmark renders both roles; also exercise male-only and female-only requests in acceptance. Model/tool/tracking changes invalidate earlier timing evidence and require a real rerun.

### F. Publish metadata and run the Mac worker

After the local checks pass:

```bash
"$video_python" -m swico_video_node templates publish --all
caffeinate -is "$video_python" -m swico_video_node run
```

Keep this Terminal open. In a second Terminal at the same repository root:

```bash
video_python="$PWD/.venv-video/bin/python"
"$video_python" -m swico_video_node doctor --check-api
```

Publishing sends template metadata and measurements, not the movie masters. Confirm a fresh worker heartbeat and matching template/calibration identities before enabling website admissions.

For the managed LaunchAgent, first stop the foreground worker with Ctrl+C when no accepted request is running, then:

```bash
"$video_python" -m swico_video_node service install
"$video_python" -m swico_video_node service status
"$video_python" -m swico_video_node doctor --check-api
```

Check actual running/heartbeat status, not just a loaded plist. Keep the Mac powered, awake, connected and logged in. A LaunchAgent starts after login; `caffeinate` does not keep a powered-off or closed-lid sleeping laptop serving jobs.

## 4. Suggested commit message

Use after the corresponding changes are implemented and reviewed:

```text
fix(video): complete model onboarding and recoverable template video workflow
```

## 5. Complete Codex Luna prompt — paste from here

You are working at the root of the existing Swico `ai_tool` repository. Use Codex Luna with high effort. Implement and verify the complete website template-video feature in one sustained pass, building on the existing code. Do not return a roadmap, split the features into later stages, or stop after scaffolding. Complete every code/test/documentation task possible with available resources, recording genuine external prerequisites separately.

Read repository instructions and inspect current files before editing. Preserve unrelated working-tree changes and existing production behaviour. Record the actual starting revision. This review used `ai_tool-main(42).zip`; do not assume the active checkout has the same revision or still has every reported defect.

SCOPE AND ARCHITECTURE

- Website, video backend and `swico_video_node` only. No Android, Windows Swico Free, ordinary CLI feature work, token pricing, subscription or weekly-credit rewrites.
- Existing Render API + website + PostgreSQL + private `WEB_UPLOAD_CACHE_URL` Valkey; existing Windows Free node; one Intel Mac video worker (2.3 GHz quad-core i7, Iris Plus, 32 GB). No new service, cron, tunnel, public Mac port, cloud GPU or external video API.
- Templates `couple-01` and `couple-02` are approximately ten-second movies stored permanently on the Mac. Website shows icons and safe metadata. Customer media is private and transient. Mac polls outbound HTTPS and runs at most one native inference job at a time.

PRODUCT CONTRACT TO IMPLEMENT COMPLETELY

1. A verified signed-in website user selects a template, chooses male/female/both roles, uploads the required photos, enters supported edit instructions, confirms consent and sees what edit will be made. Anonymous users cannot submit. Free-tier website users may buy a video; this does not grant CLI access.
2. Fixed ₹25 total / 2500 paise per paid request. Reuse existing Razorpay verification/webhooks. No wallet credits, Chat-credit debits, subscriptions or referral awards. Payment and generation must be idempotent across double-clicks, reloads, callbacks, duplicate webhooks and uncertain network responses.
3. `harishajidasan@gmail.com` has unlimited complimentary generations. Preserve existing unlimited Chat-token configuration. Existing weekly developer-test users have five complimentary video attempts per Asia/Kolkata calendar day, independent of the existing ₹40 weekly balance. Preserve quota reservation/restoration and precedence. Keep resource/concurrency limits; remove the ordinary six-preflights/hour product cap for the explicitly configured unlimited account, while retaining appropriate infrastructure protection. Do not silently charge an exhausted tester; require explicit paid choice.
4. Photo/model/template availability validation precedes charging. On a busy CPU worker, do not accept photos that will predictably expire waiting for validation. Expose validation availability or a bounded reservation mechanism without inventing new infrastructure, extending unpaid retention silently, or disrupting accepted paid jobs.
5. Show queue position and a measured ETA after payment/complimentary admission, and ETA/progress during processing. Distinguish worker offline, waiting, rendering, payment confirmation pending, cancellation and refund states. No invented benchmark times or promises.
6. Publish an ordinary chat result card and owner-only MP4 download. First READY fixes expiry at ready_at + 600 seconds; retries, refresh, emails and reconnects never extend it. Support authenticated expiry and Range behaviour. Revoke local object URLs at expiry/logout/account change. Paid media lost before expiry must enter the existing non-delivery/refund recovery path.
7. Send ready email through the existing SMTP service/outbox to the verified login email. Link back to authenticated Swico, include exact expiry, and do not attach the MP4. Delivery failure does not rerun generation or extend expiry. Preserve bounded retries and truthful notification/refund status.
8. Implement a clearly labelled prompt/instructions field connected to the existing strict server parser. Support role selection, enhancement and caption; show examples and a human-readable confirmation rather than raw JSON. Reject unsupported scene/action/speech requests before checkout. Do not claim text-to-video generation. Preserve existing printable-ASCII caption limits unless implementing and testing a proper expanded font pipeline in this same pass. Never execute prompt text as code, shell or FFmpeg expressions.

PRIORITY A — FIX REAL MODEL ONBOARDING, NOT JUST MOCKS

Inspect `swico_video_node/models.py`, bootstrap/runtime, CLI, tests and runbook. The pinned FaceFusion source is commit `03d49d0c7de095a41628a74d94a146214f82837a`.

The source review fetched that commit's `facefusion/hash_helper.py`; `create_hash()` uses `format(zlib.crc32(content), '08x')`. The real legacy `2dfan4.hash` contains `a948738e`, eight hex characters. Its GitHub release URL redirects to `release-assets.githubusercontent.com`. Current `_fetch_sidecar` refuses redirects and demands 64 hex SHA-256 characters. Current tests mostly mock a fictional 64-character sidecar. The inspected legacy 2dfan4/inswapper ONNX release API entries return `digest: null`.

Recheck upstream contracts using bounded read-only fetches. Implement correct technical provenance with algorithm-labelled fields. Keep upstream CRC32 distinct from independently reviewed SHA-256 of the full model artifact. Never pad CRC32, hash the sidecar and call it the model digest, or treat a missing GitHub `digest` as approval. Add a supported local CLI import/record route for independently reviewed expected SHA-256 evidence, with backups, atomic updates, asset/path/algorithm validation and current review metadata. Preserve any valid existing 64-character model hashes and identify uncertain legacy provenance without rewriting it as verified.

If an authentic expected SHA-256 source is unavailable, report that exact external evidence as missing while completing the tooling and all other implementation. Do not bypass the existing expected-hash gate or automatically bless arbitrary downloaded bytes. Explicit authorized acquisition/inspection, artifact integrity and publisher authenticity must be accurately distinguished.

Implement bounded HTTPS GitHub asset redirects with validated hosts/paths, no scheme downgrade, no user-supplied arbitrary URL, hop/time/size limits and no forwarded credentials. Apply consistent safe retrieval policy to sidecars and actual model installs. Missing/malformed/upstream-changed data must yield useful diagnostics without installing partial/unverified assets. Status-only commands must not download ONNX bytes. Existing model rights checks remain independent and enforced.

Correct all runbook interpreter paths: bootstrap makes repository `.venv-video`, not Application Support `.venv-video`. Use the actual absolute repository interpreter. Reuse existing tokens, reviewed tools and valid installs. Do not reinstall MacPorts, rotate credentials, upgrade to latest FaceFusion/ORT or force ARM/CUDA/MPS simply to make a check pass. Supply exact tested CLI commands for the revised provenance flow, including the missing-evidence case.

PRIORITY B — RECOVERABLE WEBSITE FLOW

Inspect `web/src/pages/VideosPage.tsx`, `web/src/video/VideoCard.tsx`, types, tests and backend API contracts.

- Add Resume payment for an existing unexpired `checkout`. Use the backend's existing idempotent `/jobs/{id}/admit` behaviour; do not create another order when dismissal, script-load failure, uncertain verify, webhook delay or reload occurs. Show checkout expiry and recover cancelled/expired holds accurately. Guard double submission and account changes.
- Consolidate active-job polling. Retry transient failures with bounded backoff/jitter, online/focus recovery and clear recovered errors. Abort on logout/unmount and reject stale-account responses. Stop settled history polling; keep bounded updates while refund/email settlement genuinely remains pending.
- Refresh capabilities/allowance on quota consumption/restoration, new request, daily reset and worker availability recovery.
- Render `eta_seconds` and `paused` independently from `queue_position`, including processing jobs. Expired estimates must not look current.
- Clear a role's previous photo when an invalid/empty replacement is selected. Add local preview/removal and enforce per-role requirements before creating a job. Clear/revoke previews and stale upload operations across account changes and completion.
- Keep product text understandable; remove raw implementation JSON/status jargon where users need a plain description. Do not expose machine paths, provider secrets, model licences or private evidence in the customer flow.

PRIORITY C — QUALITY, TRACK CORRECTION AND WORKER RELIABILITY

Inspect `templates.py`, `engine.py`, worker lifetime/leases, calibration and provenance.

Existing tracking greedily matches box IoU between frames. Improve associations for crossings, re-entry, occlusion and shot cuts using appropriate local face features and ambiguity handling. Avoid confident wrong-role assignments. Keep local reviewed role maps and exclude background faces; do not use automated gender prediction. Provide a bounded usable local track split/reassign/exclude workflow instead of requiring hand edits of `tracks.json`. Validate frame ranges/overlap/roles, preserve masters, write atomically and invalidate approval/calibration when required.

Use original-frame detections for both replacements, maintain masks/compositing and one final encode with original audio. Retain source frame rate, dimensions and aspect ratio unless the operator explicitly creates a separate reviewed master. Prioritize identity, temporal consistency and occlusion handling. Compare enhancement off/natural on actual source clips when available; never fabricate visual QA or model timings. Check that all output-affecting implementation files/settings are covered by approval/calibration identity.

Preserve worker heartbeat fencing, lease loss/process-group termination, one local process lock, cancellation, bounded retries, restart cleanup and private temporary data handling. Verify foreground and LaunchAgent behaviours separately on actual macOS when accessible. No model download during jobs. Ensure measured ETA evidence remains bound to current code, templates, tools, model bytes and execution profile. Include male-only/female-only/both output acceptance, not only the existing both-role benchmark.

PRIORITY D — PAYMENT, CACHE AND LAUNCH CORRECTNESS

Investigate the possible refund lock inversion: maintenance finalization locks `VideoOutbox` then `PaymentOrder`; the webhook path locks `PaymentOrder`, then `VideoJob`, then updates outbox. Standardize lock order across all affected paths and add a deterministic race test using disposable PostgreSQL. Do not claim SQLite proves row-lock concurrency. Preserve durable external-operation intents, original-payment refunds, no blind duplicate POST after uncertainty, and accurate processed/refund/manual-review states.

Validate the busy-preflight problem, one active request/account, daily quota races, late captures, cancellation/restoration, stale worker, stale calibration, cache loss, duplicate READY and immutable expiry. Keep PostgreSQL authoritative for paid jobs. Reuse the separate binary `swico:video:*` Valkey namespace, bounded transfers/headroom and 600-second output access. Do not flush shared cache, change Chat's 300-second upload rule or alter global eviction silently. Keep maintenance operating for accepted jobs/refunds when new admissions are disabled.

Review the existing video legal documents and exact-content publication helper. The ZIP has an unreviewed video proposal whose pages differ from the currently published policies. The old publication check passing does not approve video. Complete any code/documentation consistency work and the actionable readiness reporting, without fabricating model/template rights, accountable-owner attestation, counsel review or QA results. Missing real evidence does not justify leaving unrelated implementation unfinished.

TESTS AND EVIDENCE

- Reproduce reported defects against the actual checkout before fixing them. Add meaningful regression tests for changed money/concurrency, selection/privacy, retry/expiry, tracking and provenance behaviour.
- Replace fictional hash assumptions with realistic CRC32 sidecars, absent/present SHA256 metadata, allowed/rejected redirects, size bounds, tampering and wrong-asset cases. No real restricted models in tests.
- Fix `test_output_metadata_verification_requires_exact_disclosure` so its injected fake capture does not accidentally resolve native Mac binaries on Linux. Keep actual production native-tool validation intact. The reviewed worker suite result was 187 pass / 1 failure on Linux; do not relabel that as Mac inference success.
- Update video Playwright fixtures for current consent_version, all eight named consent confirmations, async preflight and real state transitions. Add checkout dismissal/resume/reload, delayed capture, processing ETA, temporary network failure recovery, invalid replacement selection, account change and expiry cases. Add the focused local mocked video browser suite to existing CI; do not contact production.
- Run focused backend video/billing/tester/migration tests; worker tests; frontend lint/typecheck/unit/build and targeted Playwright. Use disposable real PostgreSQL and Valkey for tests that require them, respecting existing test configuration and isolation. Run required repository gates. Never point test reset/cleanup at production databases or shared cache.
- Run actual Intel model/codec/clip acceptance only when the real environment, legitimate assets and consenting source photos are available. Record not-run prerequisites plainly. Configured SMTP is not delivered mail; mock Razorpay is not provider capture/refund; unit tests are not likeness QA.
- Do not charge, refund or email real users as tests. Use explicit operator-provided test credentials and recipient authorization for external acceptance. This task authorizes local implementation, fixes and reviewable artifacts, not unrequested production mutations.

DELIVER EVERYTHING IN THIS PASS

1. Implemented code, useful regression coverage and required CI updates; no placeholder engine or deferred requested subsystem.
2. Updated `docs/VIDEO_MAC_SETUP.md`, generation/acceptance/release docs and implementation report based on actual results. Remove stale success claims and broken paths/commands. Distinguish commands already executed from instructions for the operator.
3. A beginner-friendly Render runbook with exact existing service names, env keys, digest pairing, migration current/head checks and readiness diagnostics. No new infrastructure. Keep both admission flags off in defaults and provide one final activation step for the complete verified release.
4. An existing-state-safe Mac runbook covering prerequisite check, isolated bootstrap, token reuse/pairing, two template imports, real evidence/provenance, model installation, usable role corrections, actual benchmark, metadata publication, foreground and LaunchAgent. Document all new CLI commands from their actual help output.
5. Final report: changed paths, what already existed, bugs fixed, tests actually run and results, remaining real external evidence/actions, exact Render/Mac commands, and a commit message. Do not claim production readiness or make up timing/quality merely because tests pass. Do not automatically commit, push or deploy.

Suggested commit message, adjusted to actual changes: `fix(video): complete model onboarding and recoverable template video workflow`.
