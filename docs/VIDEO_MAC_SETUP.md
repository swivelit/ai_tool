# Intel Mac and existing Render setup (operator actions, not executed automatically)

Do not enable paid checkout until the checklist passes. No new Render service,
Redis instance, cron, public Mac listener, tunnel, port forward or Docker is needed.
Use the checked-out repository path; do not assume a particular home-directory name.

## 1. Install on the Intel Mac

Confirm `uname -m` reports `x86_64`; inspect `sw_vers`. The prompt's screenshot OS
is not an acceptance result. Install native Python 3.12, Git, FFmpeg/ffprobe and
Command Line Tools using reviewed official installers/Homebrew if absent. Setup
checks these prerequisites instead of changing system Python or host security.

From the repository root:

```bash
bash swico_video_node/scripts/setup_macos.sh
source .venv-video/bin/activate
python -m swico_video_node init --worker-id intel-mac-01 --api-base https://ai-tool-rrau.onrender.com
```

Init prints **only the SHA-256 digest**. Copy it to the backend variable below.
The raw token stays in `~/Library/Application Support/SwicoVideo/worker.token`,
mode 0600. Init is idempotent and never replaces credentials. Keep this directory
private (0700), off shared drives and outside Git. Do not paste the token into a
terminal command, ticket, log, Render or plist. An optional `SWICO_VIDEO_DATA_DIR`
selects a private test/operator directory; use the same directory for all commands.

## 2. Genuine model/engine rights

Open `~/Library/Application Support/SwicoVideo/models.json` locally. For **each**
asset and `code_review`, provide named reviewer/date, actual licence text/reference,
commercial-permission document under `rights/`, and SHA-256 of each document.
For each weight supply the exact actual asset SHA-256 from an independently
verified permitted source. Relative document paths stay within `rights/`.
`shasum -a 256 /path/to/approved/document` can compute a digest. Hashing a fabricated
permission file is not permission; counsel/operator must assess legal sufficiency.
No rights or asset hashes have been supplied by this implementation.

```bash
python -m swico_video_node models audit
python -m swico_video_node models install --profile quality-cpu
python -m swico_video_node models audit
```

The first audit is expected to refuse missing documents/assets. `install` validates
the documents before downloading only the selected pipeline assets from pinned
upstream URLs; it verifies SHA-256 and refuses substitution. It never downloads
all FaceFusion models or approves a missing licence. Preserve original attributions.
No browser GUI or model auto-download is invoked by rendering.

## 3. Import, annotate and review actual local templates

Obtain permission for both template video modification/distribution and audio.
No movie/video sample is bundled. Replace paths with the actual operator files:

```bash
python -m swico_video_node templates import --id couple-01 --file /path/to/first.mp4 --title "Couple scene 1"
python -m swico_video_node templates import --id couple-02 --file /path/to/second.mp4 --title "Couple scene 2"
python -m swico_video_node templates prepare --id couple-01
python -m swico_video_node templates prepare --id couple-02
```

Fill each `templates/couple-0N/manifest.json` `rights` object with `reviewer`,
`reviewed_at` (YYYY-MM-DD), `licence_file`, `licence_sha256`, `permission_file`,
`permission_sha256`. These refer to genuine documents in the root `rights` folder.
Permission must cover video AND audio; review the complete licence chain.

The `review/` folder contains numbered annotated frames with track IDs. Inspect
every shot/cut/profile/occlusion locally using Finder/Preview. `tracks.json` contains
per-frame boxes and track IDs: correct/split association errors there first, leaving
background tracks excluded. Review prompts display each track's frame range and ask
male/female/exclude. It refuses duplicate role assignments within a frame. No gender
or performer identity is inferred. This is terminal annotation, not a LAN web server.

```bash
python -m swico_video_node templates review --id couple-01
python -m swico_video_node templates review --id couple-02
python -m swico_video_node benchmark --all-templates --interactive-sources --runs 3
```

Benchmark requires actual consenting adult source photos and a physical Intel Mac.
It measures cold/load separately, performs at least three full warm clips/template
for EACH of off/natural enhancement (at least six warm clips/template),
and pauses for you to watch the output before it deletes review output. Check both
roles, likeness, eyes/mouth, cup/hand occlusion, background exclusions, cuts/flicker
and audio sync. Reject failures. No quality approval or timing is pre-populated.
Model/profile/master/tracks/rights or rendering implementation changes invalidate
approval/calibration. Runtime checks reject changed Python/dependency versions.

## 4. Existing Render API: click-by-click

Before deployment, have counsel/operator review `web/src/content/videoLegalDraft.json`.
It includes proposed pricing, privacy, adult consent, delivery and refund amendments,
NOT an approval. After genuine approval, publish those reviewed pages in
`legalContent.json` with a NEW matching approval record using the existing legal
publication process (and update the proposal if counsel changes its wording).
Run `python3 scripts/check-legal-publication.py`. Do not copy the old approval hash.
Current Chat policies remain published unchanged while this review is pending.
Video admission and its release checker separately fail closed until this is done.

1. Open Render Dashboard → **existing backend Web Service** → Settings. Do not
   create a Blueprint or replace production with `render.staging.yaml`.
2. Preserve the current root/build/start and migration ownership. The existing
   repo-root contract uses `python backend/start_render.py`; its pre-deploy step is
   `cd backend && python -m alembic -c alembic.ini upgrade head`. Do not run a second
   migration owner. New additive head is `20260918_website_video`, after
   `20260917_cli_cloud_artifacts`. Back up non-media DB metadata first under existing
   operator policy. This task did NOT run a production migration.
3. Environment → Edit. Add these to the API ONLY (not shared with Windows/CLI/static
   site). Start with BOTH switches false:

```dotenv
SWICO_VIDEO_ENABLED=false
SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false
SWICO_VIDEO_PRICE_PAISE=2500
SWICO_VIDEO_OUTPUT_TTL_SECONDS=600
SWICO_VIDEO_UNLIMITED_EMAILS=harishajidasan@gmail.com
SWICO_VIDEO_TESTER_DAILY_LIMIT=5
SWICO_VIDEO_DAILY_RESET_TIMEZONE=Asia/Kolkata
SWICO_VIDEO_WORKER_TOKEN_SHA256=<the digest printed by Mac init>
SWICO_VIDEO_WORKER_STALE_SECONDS=45
SWICO_VIDEO_MAX_INFLIGHT_JOBS=6
SWICO_VIDEO_MAX_ACTIVE_PER_USER=1
SWICO_VIDEO_MAX_JOB_AGE_SECONDS=14400
SWICO_VIDEO_MAX_OUTPUT_BYTES=16777216
SWICO_VIDEO_CACHE_BUDGET_BYTES=134217728
SWICO_VIDEO_PUBLIC_WEB_ORIGIN=https://swico.in
```

The digest is an authentication verifier; keep it backend-only. The raw worker
token is the secret and is never configured on Render. Other listed values are
non-secret policy settings. `SWICO_VIDEO_PRICE_PAISE` and output TTL are fixed;
invalid values fail video configuration, not ordinary Chat startup.

4. Preserve the **existing** backend-only `WEB_UPLOAD_CACHE_URL`, `DATABASE_URL`,
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
   `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USE_TLS`.
   Do not create new stores or send these secrets to the Mac. Check actual Valkey
   maxmemory/headroom, eviction and managed persistence/backups with the existing
   operator account. A 128 MiB app budget is NOT a claim the current instance has
   that capacity. Do not change global persistence or eviction to force readiness.
5. Keep all CLI/Free/weekly/internal settings and existing billing cron schedules
   exactly as they are. No video cron/background worker service is required; a
   bounded API maintenance thread claims durable outbox rows. It continues draining
   when video switches are turned off; durable pending jobs keep it active even if
   the worker token is revoked. Keep the digest configured during a normal drain.
6. After the operator-approved code/migration deployment (not performed here),
   use Render Shell with the service's Python environment:

```bash
cd backend
python -m alembic current
python scripts/swico_video_release_check.py --pretty
python scripts/weekly_tester_credit_check.py --pretty
python scripts/swico_cli_release_check.py --pretty --public
```

Video checker must remain nonzero until real worker/template/cache/SMTP prerequisites
are present. It does not send email, call payment APIs, buy licences or run inference.
7. Existing Static Site: preserve its Firebase/public API configuration and current
   `npm ci && npm run build` / `web/dist` contract. There are **no new VITE secrets**.
   No original template assets are copied into its bundle.

## 5. Publish metadata and start the Mac

Only after both local templates and rights/quality evidence are approved:

```bash
python -m swico_video_node templates publish --all
python -m swico_video_node doctor --check-api
python -m swico_video_node run
```

Publish sends only dimensions, hashes, title and real calibration; never masters,
sources, embeddings or frames. Stop foreground run with Ctrl+C before installing
the service. A local flock plus backend boot identity prevents duplicate workers.

```bash
python -m swico_video_node service install
python -m swico_video_node service status
python -m swico_video_node service stop
python -m swico_video_node service uninstall
```

Install creates/starts `~/Library/LaunchAgents/in.swico.video-worker.plist`, using
absolute executable/repository paths, fixed PATH and a supervised `caffeinate -i -s`.
It has no token argument or credential content. Logs rotate at
`~/Library/Application Support/SwicoVideo/logs/worker.log`. launchd restarts failed
processes with throttling; network failures back off. A user must log in and unlock
FileVault after reboot. `caffeinate` does not defeat lid-closed sleep, power loss or
shutdown. Do not disable security/auto-login. Scratch cleanup runs on restart.

## 6. Controlled activation, drain and rollback

Keep paid checkout false until genuine provider **test-mode** capture/webhook/refund,
SMTP, browser delivery, retention and both-template native acceptance pass. Never
send real customer mail or charge accounts as an unattended smoke test.

After operator/counsel approval, enable only `SWICO_VIDEO_ENABLED=true` for a
controlled complimentary check. Existing unlimited/tester membership still requires
verified ownership and all safety/capacity/licence gates. After all acceptance and
payment-mode review, separately enable `SWICO_VIDEO_PAID_CHECKOUT_ENABLED=true`.
Do not flip an existing live Razorpay account into test mode on production to test it;
use disposable local test configuration and explicitly supplied provider test keys.

Drain: set paid checkout false, then feature false. Keep API, Mac and digest running
until accepted jobs settle, output windows expire, and pending email/refund intents
resolve. Status/cancel/media/worker settlement do not depend on admission flags.
Check `video_outbox` manual_review/failed via authorized operator DB read tools; an
ambiguous refund needs provider receipt reconciliation before any manual retry.

Rollback: leave both flags false; retain additive schema and new dispatcher while
video orders exist. Do not run downgrade/stamp or deploy an older dispatcher that
mistakes video for top-up. Restore ordinary website separately if needed; do not
delete payment history. Stop/uninstall the Mac only after drain, or allow bounded
lease failure compensation. Token rotation: drain/stop, run
`python -m swico_video_node rotate-token`, update ONLY its printed digest on the API,
then restart; revoked token requests
fail authentication and leases recover. Never publish token bytes.
