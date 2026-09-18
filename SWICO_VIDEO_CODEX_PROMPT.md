# Swico website template-video feature — complete implementation prompt

Run this task from the Swico repository root. Implement the complete feature, not a roadmap, UI mock, scaffold, or a sequence of partial feature releases. Inspect the checkout before editing; preserve unrelated work. Implement, test, and document the backend, website, Mac worker, payment/refund lifecycle, notifications, retention, and operations together. Do not deploy, charge a real customer, send real customer email, purchase a licence, or publish template assets without an explicit operator action.

## Product and infrastructure constraints

Swico already has a website, Android application, CLI, Render backend, and Windows Swico Free inference node. This task is WEBSITE ONLY. Do not change Android, the CLI feature scope, CLI pricing, Windows inference, chat token charging, voice charging, existing subscriptions, referral rewards, or weekly chat-credit accounting.

The complete deployment must use only the EXISTING Render services and databases plus the existing Windows laptop and this additional Intel Mac. No S3, R2, Cloudinary, Supabase, external video API, cloud GPU, new hosting provider, new Redis instance, new Render worker service, new cron service, public Mac endpoint, tunnel provider, router forwarding, or Docker requirement on the Mac. Razorpay and SMTP are existing dependencies, not new services.

Target worker machine, from the operator's screenshot:
- 2.3 GHz quad-core Intel Core i7, x86_64.
- Intel Iris Plus integrated graphics; do not treat its displayed 1536 MB as an NVIDIA GPU.
- 32 GB RAM. macOS screenshot reports Tahoe 26.7; verify actual OS/architecture at install time.
- Terminal currently shows `admin@Admins-MacBook-Pro swico_server %`. Do not assume an absolute repository path.

Implement a signed-in website route `/videos`, sidebar entry “Create video”, and two initial template slots, `couple-01` and `couple-02`. Templates are roughly 10 seconds. Store template master videos, analysis and model weights on the Mac only. The website renders generic icons or explicitly approved thumbnails plus template metadata; no original movie MP4 in the web build, Git repository, Render disk, or public endpoint.

The uploaded sample examined for this request is 10.034 seconds, 496 × 368, 301 video frames, approximately 30 fps, H.264 with AAC audio. It cuts between the two main roles, includes background people, side-profile views, and a cup/hand occluding a face. The second template and users' source photos were NOT available for a real two-template face-swap benchmark. Never fabricate those assets, actor identities, role timestamps, quality results, or runtime measurements. Operator-supplied media is loaded locally on the Mac, not from a ChatGPT sandbox path.

## Read and understand the existing integration points

Inspect these paths, adapting to changes in the actual checkout:

- `backend/app/auth.py`: AuthUser, verified-email/owned-user checks, `is_internal_test_user`, `is_weekly_tester_user`.
- `backend/app/billing/tester_credit.py`: `SWICO_WEEKLY_TESTER_CREDITS_ENABLED`, `SWICO_WEEKLY_TESTER_EMAILS`, `SWICO_WEEKLY_TESTER_ALLOWANCE_RUPEES`. Current weekly credit is Chat-only and resets Monday 00:00 UTC.
- `backend/app/email_service.py`: existing SMTP settings, `get_email_sender()`, response-ready helpers and sanitized errors.
- `backend/app/models.py`: PaymentOrder, ProcessedWebhook, WebChatThread, WebChatMessage and Job.
- `backend/app/billing/{service,razorpay_client,reconciliation,audit,schemas,schema_readiness}.py` and payment/refund serializers.
- `backend/app/web_api/router.py`: create order, verify payment, shared Razorpay webhook, authenticated chat endpoints.
- `backend/app/web_api/upload_store.py`: existing `WEB_UPLOAD_CACHE_URL`, private Redis/Valkey access and the HARD 300-second ordinary-chat-upload retention ceiling. Do not extend that ceiling.
- `backend/app/{job_queue,main,production_config}.py`, `backend/start_render.py`, existing lifecycle and worker claim separation.
- `backend/scripts/billing_maintenance.py`, existing release checks and billing cron operation.
- `web/src/App.tsx`, `pages/ChatPage.tsx`, `components/{Sidebar,Conversation}.tsx`, `api/client.ts`, `types/index.ts`, payment UI and legal content.
- `docs/RENDER_WEB_DEPLOYMENT.md` and existing tests.

Important starting hazards: PaymentOrder currently only permits topup/subscription and Chat/Voice buckets. `fulfill_payment_once()` and `credit_payment_once()` currently fall through to the top-up implementation for non-subscription orders. Existing RazorpayClient can fetch refunds but does not provide a refund-creation method. Existing uploads are not a video artifact store. Do not simply add a UI button and route video payments through those defaults.

## Eligibility, price and daily quota

Every ordinary VERIFIED signed-in website user, including a Free-tier account, may buy this standalone product for exactly INR 2500 paise (₹25 total). No guest access and no subscription prerequisite. This must not open Free access to the paid CLI.

`harishajidasan@gmail.com` has unlimited complimentary video generations. Preserve the existing chat exemption settings; do not edit their values. Use `SWICO_VIDEO_UNLIMITED_EMAILS=harishajidasan@gmail.com` for explicit video scope, applying the same verified-token-email == owned-database-email boundary. Do not trust an email, role, exemption flag, or amount submitted by a browser. Unlimited means no daily fee/count limit, not a bypass of safety, capacity, consent, identity ownership, model licences or worker health.

Members of the EXISTING weekly tester cohort get five complimentary generation attempts per day. Reuse its existing enabled/configured membership and verified-owned-email logic, not its remaining weekly balance. Video attempts must not spend or refresh the ₹40 chat allowance. Keep the weekly reset unchanged. Set the VIDEO daily timezone to configurable `Asia/Kolkata` by default, and return the next reset timestamp. Internal unlimited eligibility takes precedence over tester eligibility.

Make quota reservation atomic under concurrent requests and multiple API processes. Reserve a daily attempt on accepted complimentary admission, consume on processing start, release for pre-processing validation/cancellation and refund it once for genuine infrastructure/rendering failure. Automatic worker retries reuse the same reservation. Cancellation after processing has started must not enable unlimited free rendering. Cap six concurrent requests from a tester at five grants, including around midnight. Never silently charge when free attempts are exhausted. Show exhausted quota/reset; any separate paid choice requires a deliberate ₹25 checkout.

One outstanding video request per account by default, including unlimited accounts, and one Mac generation process at a time. These are capacity safeguards, not daily limits. Use a bounded global admission queue and disclose processing is asynchronous before payment. Show the user's actual queue position and estimated time AFTER payment or complimentary admission.

## User workflow and prompt semantics

Build the full flow: gallery -> template selection -> role-specific photo uploads -> validation/consent -> supported instruction preview -> fixed-price checkout or free allowance -> queued/processing status -> chat video card -> authenticated playback/download -> expired tombstone.

Provide “Male role” and “Female role” upload slots mapped to explicit template role IDs. Do not infer the uploader's gender or choose targets by gender/age/race classification. Allow replacing one role while retaining the other, or both, when supported by the template manifest. Require exactly one usable consenting person's face in each supplied source photo; clear actionable errors for zero/multiple faces, severe blur, unsupported files or unusable crops.

Because face detection/quality analysis must stay on the Mac, implement bounded asynchronous MAC preflight before checkout. Render may decode/re-encode images for basic file safety but must not load the face models. The website shows validation pending, the Mac validates the uploaded faces/content and template compatibility, and the API accepts only an unexpired successful preflight bound to exact source hashes, role mapping, template hash and profile. Reject/revalidate changed inputs. Rate-limit unpaid preflight and schedule it without starving paid renders; do not charge first and discover a basic invalid photo later. Preflight failure/abandonment does not consume a generation attempt.

Face swapping is not arbitrary text-to-video generation. Implement an optional prompt limited to actual supported operations, with a structured confirmation before charging. For example, explicit grammar `swap: both|male|female`, `enhance: natural|off`, and `caption: ...`, with documented escaping/length rules. Friendly controls may generate that grammar. Unsupported instructions such as changing location, costume, actions, identity of background people or speech must be rejected/explained BEFORE checkout, not silently ignored. Never pass prompt text to a shell or ffmpeg filter expression. Safely render captions from escaped text/files, preserving Unicode where supported and reporting unsupported font coverage before payment.

Validate bytes, dimensions, decoded image format, EXIF orientation and pixel count. Strip metadata and re-encode bounded normalized images. Reject decompression bombs, path tricks, SVG/HTML disguised as images, arbitrary URLs and unsupported formats. Raw upload cap 5 MiB per image, normalized cap 2 MiB per image are proposed defaults; document and test actual limits.

Require appropriate uploaded-face consent, adult-use confirmation for this product, and a versioned acceptable-use policy. Keep FaceFusion/content-safety protections enabled. Label outputs visibly as AI-edited with a small unobtrusive Swico watermark. Do not implement deceptive verification, sexual impersonation, or identity-recognition functionality. Do not store photos, face embeddings or generated frames in chat memory, RAG, analytics, error logs or a reusable face library.

## Mac connection, durable queue and isolation

Create a separate top-level `swico_video_node` package with its own environment and dependency lock. All face analysis, swapping, enhancement and video encoding happen on the Mac. Render handles lightweight upload checks, authentication, billing, queue metadata, notifications and temporary delivery only.

The Mac connects OUTBOUND over HTTPS to the existing API. Implement authenticated polling/short long-polling, worker registration/capability reporting, heartbeat, claim, progress, input fetch, result upload and completion/failure. Never ask Render to call a private LAN address. The Mac receives only its own worker token, not DATABASE_URL, Redis URL, Firebase service-account credentials, Razorpay keys, SMTP passwords or other application secrets.

Generate a high-entropy token locally, store it in a mode-0600 file outside Git, and configure only its SHA-256 digest on Render as `SWICO_VIDEO_WORKER_TOKEN_SHA256`. Compare digests in constant time, scope to worker `intel-mac-01`, support controlled rotation, and never print raw tokens in logs or commands. Credentials must not appear in process arguments or a broadly readable launchd plist.

Persist video jobs, frozen input/template/model-profile references, admission order, quota/payment funding, transitions, worker leases, attempts, artifact metadata and notification/refund intents in the existing PostgreSQL database. Use short database transactions, row locking/SKIP LOCKED where appropriate, unique constraints and idempotency keys. Do not implement the paid queue in an in-memory Python list, browser state, or solely Redis.

Video inference claims must be separate from the existing Job handlers/Windows/knowledge/CLI workers. Reuse existing lightweight API worker infrastructure for maintenance/outboxes where safe, but do not let the generic worker accidentally claim video inference jobs. Periodic maintenance must be singleton/DB-claim safe across API processes and survive restart; no new Render service or cron.

Worker leases need attempt-scoped fencing tokens. Heartbeat/progress and complete/fail/upload must match job, worker, attempt and unexpired lease. An expired or cancelled worker cannot overwrite a retried/successful job. Maintain heartbeats independently of long native inference calls. Kill subprocess trees on cancellation/timeouts; verify ownership before any cleanup. Use local process locking to prevent launchd and a foreground worker processing concurrently.

Recheck healthy worker, approved template/model versions, calibration, cache capacity and admission budget before accepting a new paid order. Reserve checkout capacity briefly; release abandoned holds. Handle capture arriving after a hold/input deadline or worker outage by durable recovery/refund, not lost payment or a rejected callback. Existing accepted jobs retain a bounded recovery path when checkout is disabled. Pausing new admission must not prevent already-paid completion, downloads, refunds or notifications.

## Temporary delivery and retention, without new infrastructure

Reuse the SAME private Valkey service already addressed by `WEB_UPLOAD_CACHE_URL`, with a separate binary-safe client and namespace such as `swico:video:*`. Do not modify the ordinary upload store's 300-second policy or reuse its JSON/base64 object schema for MP4s. Do not create another Redis service or put original templates in Valkey.

Use this video namespace for bounded input relay and completed MP4 delivery. Ensure upload parsers and HTTP middleware do not silently spool images or MP4s to Render disk; use bounded streaming or explicitly bounded in-memory handling. Inspect the existing Valkey persistence/snapshot/backup policy. Do not claim a key expiry physically deletes managed backup copies, and do not change global persistence settings in a way that breaks other workloads; document the real access-expiry and residual-retention boundary. Keep raw media out of PostgreSQL (including BYTEA), DB backups, Git, Render persistent/ephemeral disk, application logs and error traces. Financial/job records may persist without media.

Prepared unpaid uploads have a short explicit expiry. Paid job sources must remain retrievable until processing or a bounded job deadline; do not allow a normal 300-second upload TTL to destroy a paid job waiting in the queue. Use atomic pin/promotion or Mac durable-ack semantics with tested cross-store failure handling. Delete source photos/embeddings/intermediate frames promptly at terminal states; show the source retention policy before checkout. Proposed hard job-age limit: 14400 seconds, including recovery, with compensating refund/allowance restoration on non-delivery.

Bound all inputs/results/chunks, including HTTP request bodies without Content-Length. Proposed output cap: 16 MiB; video cache budget: 128 MiB; global in-flight admission cap: six including checkout holds. These are application ceilings, NOT assertions that the deployed Valkey has that headroom. Check actual capacity and reserve budget atomically before charging. Leave headroom for chat uploads, limit simultaneous transfers, and fail only video admission when unavailable; never evict chat uploads or flush shared Redis. Support safe bounded chunks/retries and checksum validation. No globally changed Redis eviction configuration as a shortcut.

Publish READY only after the complete MP4 exists, passes integrity/container checks and is actually retrievable through the authenticated API. Use a two-step upload/finalization protocol; handle a crash between Redis and PostgreSQL without false READY states. At first READY set immutable `ready_at` and `expires_at=ready_at+600 seconds` using server UTC. Never reset these on retries, page refresh, resend email, re-upload, worker reconnect, playback or download.

Serve through an owner-authenticated API. Check expiry on every request (and Range request), return 410 for an expired owned result, prevent IDOR, set private/no-store headers and do not issue public static URLs or long-lived bearer links. A bounded authenticated fetch -> Blob/ObjectURL is acceptable for browser playback; clean it up at expiry/logout/unmount and do not expose Firebase tokens in URLs. Any streaming/range alternative must retain equivalent authorization.

Keep the generated MP4 temporarily in Valkey for at most the remaining fixed 600-second window, so a Mac outage after upload does not immediately make a paid download impossible. A Mac retry copy may exist until that SAME deadline, with protected local storage, cleanup while running and mandatory startup/resume cleanup. A cache repair never extends expiry. Explain honestly that an offline/powered-off Mac cannot physically erase files at an exact wall-clock time and that downloaded user copies cannot be revoked. Do not claim SSD secure erasure from unlink(). Template masters remain on the Mac intentionally.

At expiry remove access and media, revoke object URLs in active pages and preserve only an “expired” chat/history card plus required non-media payment/audit metadata. Clean orphaned uploads, cancelled/failed artifacts and abandoned checkout sources. If an artifact is lost before the promised availability window, expose a recoverable state and an appropriate non-delivery/refund policy rather than a broken Download button.

## Payments, refunds and financial regression safety

Implement `video_template` as an explicit non-wallet payment product. Extend the existing PaymentOrder safely through Alembic, with appropriate amount/currency/product constraints, a unique job/order association and zero wallet credit. Keep wallet credit buckets strictly Chat/Voice; if PaymentOrder needs a video categorization, use payment-specific typing/constraints rather than broadening the wallet APIs. Never disguise video as a top-up or debit chat/tester credits.

Make fulfillment and refund dispatch exhaustive for topup/subscription/video_template. Unknown products must fail, never fall through to wallet credit. Adapt create/verify/status/history schemas, purchase presentation, schema readiness, reconciliation, audit, refunds, and existing tests. Preserve existing money units: video gross = 2500 paise, credited_amount_micros = 0. Do not invoke the top-up allocation calculation or referral/subscription fulfillment for video. Do not describe gross sales as net profit.

Use the server-created provider order ID and captured payment verification, including exact expected amount/currency and order/payment ownership. Browser checkout success alone must not enqueue work. Checkout callback and the EXISTING shared webhook must converge on the same idempotent transaction: one verified payment -> one queued video job, one funding record and one chat request. Handle a paid-order event without a payment ID by recovering a verified captured payment before fulfillment. Do not add a competing webhook with divergent product state.

Handle duplicate, delayed and out-of-order provider events, two callbacks racing, refunds before capture delivery, multiple attempted payments on an order, expired holds and conflicting idempotency payloads. A refunded or terminally failed job must never be resurrected by a late success callback.

Add the missing refund-creation client path using CURRENT official provider contracts, timeout handling and provider-supported idempotency where available. Validate those contracts instead of inventing an idempotency header. Persist a refund intent before external side effects, and reconcile an ambiguous POST timeout before submitting another refund. Refund a genuine unrecoverable paid generation failure to the original payment source for the paid amount, not to a chat wallet. Distinguish refund_pending/submitted/processed/failed/manual_review in UI and audit. Do not say “refunded” merely because a refund was requested. Free requests restore their allowance once instead of creating refunds. Never retry paid mutations blindly.

Extend the existing reconciliation/audit code so video orders do not appear as missing wallet credits and legitimate chat/voice/subscription findings remain intact. Keep existing cron service names, schedules and dry-run/apply semantics unchanged.

## SMTP notifications and chat integration

Reuse `get_email_sender()` and the existing `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USE_TLS` on Render. SMTP credentials must not go to the Mac. Add a video-ready body; do not repurpose OTP content or store an MP4 attachment in email.

Create a durable notification outbox entry transactionally with READY, unique per job/event. Send immediately through a lightweight existing API worker, with bounded retries/backoff and a stable Message-ID. SMTP is not an exactly-once delivery or inbox-arrival guarantee; ambiguous send timeouts may require retry and must not regenerate/recharge the video. Do not starve OTP delivery. Never log full email bodies, credentials or raw faces.

Resolve the recipient from the job owner's verified server-owned identity, not a browser form or a worker-supplied address. The message includes the template label, login-protected website job/chat link, and the exact expiry time with timezone. Stop stale “your video is ready” retries after expiry; do not reset the download window for delayed delivery. Preserve video availability even if sending email fails and record an operator-visible notification status.

Add persistent typed video metadata to ordinary chat messages/cards, not base64 or media blobs. The completed result must appear in the user's CHAT as requested, not only on a separate jobs dashboard. Implement reliable owner-checked deep linking that opens the correct thread/card after login; existing ChatPage does not automatically support a made-up query parameter. Test actual navigation, reload and a second device. Suppress chat edit/regenerate/token-charge actions that are inappropriate for a purchased video; do not let ordinary chat regeneration start another free/paid render accidentally.

## Face-swap engine, quality and licensing

Use a pinned FaceFusion integration rather than a browser GUI automated with clicks. Preferred initial candidate: FP32 `inswapper_128` on ONNX CPU, high-fidelity frame handling and conservative optional GFPGAN enhancement, subject to proper commercial rights and actual identity/temporal evaluation. Make the engine/profile versioned and replaceable. Do not assert that a larger face crop, enhancer, or pixel boost automatically produces a better likeness. Compare supported higher-quality profiles where rights and hardware permit; choose by measured identity preservation and temporal stability, not merely speed or nominal resolution.

Important licence boundaries: InsightFace's permissive code licence does not cover unrestricted commercial use of its pretrained weights. Check the swapper, embedding/recognizer, face detector, landmarks, masks, enhancer and other downloaded weights separately. GHOST's declared Apache licence does not automatically clear pretrained recognition dependencies. HyperSwap/SimSwap are not automatically unrestricted commercial substitutes. Preserve upstream attribution and use restrictions. Do not download all FaceFusion assets indiscriminately, bypass safety checks, scrape random weights, or invent licence permission.

Create a model provenance/rights manifest with actual source, release/commit, hash, dependency, licence text/reference, operator-provided commercial permission and review status. Production generation and paid admission must reject an uncleared complete pipeline, even for complimentary/unlimited users. A config boolean or an operator's email does not create legal permission. Template rights for commercial modification/distribution, audio rights and uploaded-face consent are separate. Keep legal/privacy/refund/pricing copy aligned with what is genuinely implemented; flag operator/counsel approvals rather than pretending they are supplied.

Use a separate Intel dependency lock and setup script, not backend requirements or an Apple Silicon environment. Verify wheel architecture, Python ABI, ONNX opset/runtime, engine imports and full model inference. ONNX Runtime 1.19.2 has a published macOS universal2/Python-3.12 wheel, but that does NOT prove compatibility with current FaceFusion or imply that it is the best supported version. Do not blindly replace one dependency pin in the latest upstream requirements. Select a genuinely compatible pinned combination or provide a reproducible Intel build; document security/support implications and native checks not executed. No unpinned `master`, `pip install -U` of the engine stack, forced ARM wheels, CUDA assumptions or fictitious MPS acceleration. CPU is baseline; CoreML is allowed only after actual model coverage, output-quality and full-clip timing validation on this Intel machine.

Build per-template shot detection and explicit ROLE TRACKS, including admin review/annotation and exclusions for all background people. Do not identify or name performers. Do not use “swap every male/female face”, global left-to-right ordering, or averaging the two uploaded identities. Compute each source embedding separately. Detect/associate against original frames and role tracks, preserve occlusion (especially cup/hand), and composite only the intended face region.

Decode/process in a bounded streaming/chunked pipeline rather than keeping an entire high-resolution sequence in RAM. For frames containing both roles, apply both mapped faces with original-frame references and encode the final video once; avoid two lossy full-video passes and re-identification of already-swapped faces. Cache only fixed-template analysis, not customers' identities. Preserve aspect ratio, timing/PTS and source audio sync; do not force exactly 300 frames or distort 496x368 to 16:9. Use controlled ffmpeg argument arrays with shell=False, timeouts, per-job temp directories and safe root/symlink checks. Preserve original quality where possible; do not force 4K upscaling or degrade output under queue pressure.

Preflight and benchmark actual local source photos with consent. Record cold start separately, run at least three full-clip warm trials per active template/profile, and retain only non-identifying timing/quality metadata unless the operator explicitly retains local review assets under a separate policy. Review likeness, eye/mouth stability, occluders, cuts, background faces, flicker, audio sync and both-role correctness. Template approval must bind the video hash, role-track version and engine/quality profile. Any change invalidates the approval/calibration as appropriate.

## Queue estimates and availability

Calculate ETA from measured per-template/per-profile full-job timings, current running job remaining time, jobs ahead and transfer/encoding overhead. Use observed progress, not a made-up progress animation. Show a range and low-confidence/calibrating state when samples are few; three runs do not justify claiming a reliable p90 SLA. Update estimates as jobs advance. If the Mac is stale, show paused/unavailable and stop new paid admission instead of counting down an invented completion time. Do not run multiple expensive jobs merely because the Mac has 32 GB RAM.

Store worker version, model/profile hashes, template availability, disk/cache headroom, heartbeat and current load without exposing secrets. Readiness for video is separate from chat/CLI readiness; an offline Mac must not take the existing chat API down. Bound maximum accepted wait time and job age, with clear failure/refund recovery.

## Required operational interface and configuration contract

Create these real runnable interfaces and test their help/argument handling. The operator will be instructed to use them; do not leave these names as pseudocode:

```
bash swico_video_node/scripts/setup_macos.sh
source .venv-video/bin/activate
python -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
python -m swico_video_node models audit
python -m swico_video_node models install --profile quality-cpu
python -m swico_video_node templates import --id couple-01 --file /path/to/first.mp4 --title "Couple scene 1"
python -m swico_video_node templates import --id couple-02 --file /path/to/second.mp4 --title "Couple scene 2"
python -m swico_video_node templates prepare --id couple-01
python -m swico_video_node templates review --id couple-01
python -m swico_video_node templates prepare --id couple-02
python -m swico_video_node templates review --id couple-02
python -m swico_video_node benchmark --all-templates --interactive-sources --runs 3
python -m swico_video_node templates publish --all
python -m swico_video_node doctor --check-api
python -m swico_video_node run
python -m swico_video_node service install
python -m swico_video_node service status
python -m swico_video_node service stop
python -m swico_video_node service uninstall
```

Default data root is `$HOME/Library/Application Support/SwicoVideo`. Init creates directories/manifest skeletons/config outside Git with safe permissions, does not overwrite existing credentials, and prints ONLY the digest to paste into Render. Model installation explains missing genuine licence evidence rather than silently approving it. Template review must provide a usable local-only annotation/approval workflow (loopback binding, no LAN exposure, authenticated nonce/CSRF/origin protection if browser based). Missing media or unreviewed templates remain disabled. Publishing sends only approved metadata/allowed thumbnails and calibration, never original videos or personal photos.

Setup checks x86_64, OS, Command Line Tools, FFmpeg and an appropriate native Python, creates `.venv-video`, installs locked dependencies and pinned engine assets as appropriate, and does not change the existing system Python/backend/Windows environment. Warn clearly about unsupported dependency/platform combinations instead of claiming a successful worker install. Use a user LaunchAgent with absolute safely quoted paths, fixed PATH, auto-restart, graceful shutdown, log rotation, backoff, and no raw secrets in the plist. Provide an appropriate AC-powered idle-sleep assertion while serving (for example a correctly supervised caffeinate wrapper), and explain that this does not override lid-closed sleep, power loss or an unbooted machine. `service install` should install/start it and report paths. Logs live under the default data root's `logs/worker.log`. Explain login/session and FileVault-unlock requirements; do not disable security or enable automatic login.

Implement the following backend variables, document defaults and validate safe ranges:

```
SWICO_VIDEO_ENABLED=true
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
SWICO_VIDEO_PRICE_PAISE=2500
SWICO_VIDEO_OUTPUT_TTL_SECONDS=600
SWICO_VIDEO_UNLIMITED_EMAILS=harishajidasan@gmail.com
SWICO_VIDEO_TESTER_DAILY_LIMIT=5
SWICO_VIDEO_DAILY_RESET_TIMEZONE=Asia/Kolkata
SWICO_VIDEO_WORKER_TOKEN_SHA256=<digest only>
SWICO_VIDEO_WORKER_STALE_SECONDS=45
SWICO_VIDEO_MAX_INFLIGHT_JOBS=6
SWICO_VIDEO_MAX_ACTIVE_PER_USER=1
SWICO_VIDEO_MAX_JOB_AGE_SECONDS=14400
SWICO_VIDEO_MAX_OUTPUT_BYTES=16777216
SWICO_VIDEO_CACHE_BUDGET_BYTES=134217728
SWICO_VIDEO_PUBLIC_WEB_ORIGIN=https://swico.in
```

These enable the website feature but NOT live paid checkout until the operator sets the checkout flag true after genuine rights, worker, QA, billing and storage checks pass. Default both feature/checkout flags false when absent. Preserve existing SMTP, Razorpay, weekly tester and internal test settings. Reuse WEB_UPLOAD_CACHE_URL without putting it on the Mac or static site. Do not put video secrets into a shared group that gives them to unrelated workers. Do not create a frontend VITE secret. The public UI reads non-secret capabilities from the backend.

Create `backend/scripts/swico_video_release_check.py`, with JSON-safe redacted output and meaningful exit codes, plus focused backend/web/node tests and operational docs `docs/VIDEO_GENERATION.md`, `docs/VIDEO_MAC_SETUP.md`, `docs/VIDEO_RELEASE_CHECKLIST.md`. Update `.env.example`, `.gitignore`, pricing/privacy/refund copy, and the main Render deployment guide. Keep current build/start/migration ownership; verify the actual Alembic head and add one forward migration without rewriting history. Leave existing Render cron schedules unchanged.

## Acceptance tests and completion report

Write and run relevant tests, distinguishing local unit/mocked tests from real integrations. At minimum cover:

1. Verified account ownership, guest/unverified rejection, forged emails, non-owner job/media access, expired media and Range authorization.
2. Unlimited precedence, tester membership independent of weekly balance, five concurrent grants not six, midnight rollover, idempotent retry, quota restoration once and explicit paid choice.
3. Tampered ₹25 amount/currency/order, wrong payment ID, browser success before capture, callback/webhook races, duplicate/out-of-order events and one paid order -> one job.
4. Zero changes to Chat/Voice balances, ₹40 weekly allowance, subscription/referral entitlements and existing CLI/Android/Windows contracts.
5. Captured payment after upload/hold expiry, worker outage after checkout, failure before/after enqueue, refund timeout ambiguity, partial/provider refunds, refund replay and no refunded-job resurrection.
6. Leases, fencing, worker crash/restart, duplicate workers, progress heartbeats during native inference, process-tree cancellation, stale completion rejection and bounded retry/deadline.
7. Input TTL over a long queue, cache reservation races/headroom, output oversize/checksum failure, cross-store finalization crash, Redis failure/eviction, API redeploy and no in-memory-only paid state.
8. Ten-minute expiry measured from first usable READY, no timer reset after refresh/re-upload/email retry, automatic cleanup/orphans, Mac resume cleanup, revoked browser blobs and honest downloaded-copy limitations.
9. Durable email intent, failure/retry without regeneration/recharge, correct verified recipient, expiry in body, correct login return/deep link and no stale ready emails after expiry.
10. Exactly two source identities, one-role use, multiple-face source rejection, background exclusion, cuts/profile views/occlusion, one final encode, A/V timing and separate quality evidence for each real template.
11. Licence/hash/profile mismatch blocks generation; fake providers and dummy media never count as production inference proof; unreviewed/missing second template stays disabled.
12. Full website flow with accessible forms, real chat result card, post-payment ETA, refresh/relogin, failure/refund states and expired history; regression coverage for existing chat/voice/billing.

Run migrations and tests only against safe local/test resources unless explicitly authorized. Do not run real live payments, refunds or email against user accounts automatically. On non-Intel/non-macOS environments, produce the executable Intel install/benchmark checks but mark native results NOT RUN. Missing operator assets, commercial permissions, hardware execution or payment-provider test credentials must be reported precisely, not disguised as passing integration tests.

Finish by reporting: changed paths; actual commands/results; migration revision/head; every unfinished or blocked native/provider validation; exact Render click-by-click settings; exact Mac terminal commands; model/weight licence inventory; measured template timings only where genuinely measured; retention/refund behavior; and a suitable commit message. Do not report “production ready” solely because mocks pass. Do not stop at a plan: implement every code path above that the repository and available environment allow, keeping external approvals as explicit operational prerequisites rather than stubs.

## Primary references to check during implementation

Use current official contracts and pinned source, rather than assuming historical CLI syntax:

- https://docs.facefusion.io/introduction/licenses
- https://docs.facefusion.io/installation
- https://docs.facefusion.io/usage/cli-arguments/processors/face-swapper
- https://github.com/deepinsight/insightface/blob/master/README.md
- https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html
- https://pypi.org/project/onnxruntime/1.19.2/
- https://render.com/docs/configure-environment-variables
- https://render.com/docs/disks
- https://docs.brew.sh/Installation
- Razorpay's current official Standard Checkout, payment capture, webhook validation and refund/idempotency documentation. Verify availability/contracts; do not invent unsupported refund parameters.
