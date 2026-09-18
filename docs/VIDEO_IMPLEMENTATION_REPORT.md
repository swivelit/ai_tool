# Website video implementation evidence — 2026-09-18

## Baseline and outcome

Started at `2e00790859e43277b5c4a36d9033e5b6d189640f` (`fix(cli): correct installed agent launcher acceptance`).
CLI `@swiveltechnologies/swico` remains **0.2.8**, unchanged. The initial untracked
`SWICO_VIDEO_CODEX_PROMPT.md` was read completely and preserved. No applicable
AGENTS.md was present. Android/mobile, CLI, Windows inference, existing weekly
credit settings and subscriptions were not rewritten. No production deployment,
migration, payment, email, model download or template publication occurred.

IMPLEMENTED: website upload/preflight/confirmation/admission, standalone payment and
refund dispatch, independent daily allowances, fenced single-Mac queue, pinned CPU
adapter, explicit model/template review, local benchmarks, chat delivery/deep links,
SMTP outbox, private fixed-expiry media, cleanup, estimates and release checks.
The worker interfaces are runnable Python commands, not an external agent placeholder.

BLOCKED for production: native full-model/full-clip acceptance, actual commercial
rights and both operator templates/photos, fresh video legal publication approval,
provider test-mode acceptance, SMTP deliverability and deployed Valkey policy review.
Both video flags remain default false. No model/quality/timing evidence was invented.

## Migration

One new revision: `20260918_website_video`, directly after
`20260917_cli_cloud_artifacts`. Adds five metadata-only tables:
`video_control`, `video_template`, `video_quota`, `video_job`, `video_outbox`.
PaymentOrder permits the explicit zero-wallet-credit video product with its fixed
2500-paise constraint. No raw media column/table was added.

Fresh/upgrade migration tests passed on disposable SQLite; a fresh disposable
PostgreSQL cluster was migrated through the old head and upgraded to the new head.
`alembic current` on that PostgreSQL database reported
`20260918_website_video (head)`. It was stopped after tests. Production was not queried.
Never downgrade/stamp production or delete financial history for rollback.

## Actual validation

Backend commands run from `backend/`, using its existing `.venv` (Python 3.14.7):

- `SWICO_TEST_VALKEY_SERVER=/tmp/swico-video-valkey.aCmjXU/valkey-8.0.2/src/valkey-server .venv/bin/python -m pytest -q`:
  **2,217 passed, 10 skipped**, 177.96 seconds. Default suite uses disposable SQLite;
  PostgreSQL-only cases were run separately, not counted as passing SQLite cases.
- `TEST_DATABASE_URL=postgresql+psycopg://hari@127.0.0.1:55483/swico_video_test APP_ENV=test .venv/bin/python -m pytest tests/test_video_postgres.py tests/test_website_video.py tests/test_cli_postgres_lifecycle.py -q`:
  **44 passed**, 7.52 seconds, actual disposable PostgreSQL. Includes concurrent
  five-of-six quota grants, exclusive claims, duplicate completion, callback/webhook
  race, and existing CLI lifecycle regression.
- Final video/cache/migration focused rerun:
  `SWICO_TEST_VALKEY_SERVER=/tmp/swico-video-valkey.aCmjXU/valkey-8.0.2/src/valkey-server .venv/bin/python -m pytest tests/test_website_video.py tests/test_video_valkey.py tests/test_startup_migrations.py -q`:
  **46 passed**, 35.40 seconds.
- Real Valkey cache tests: **3 passed** separately, also included above. Official
  Valkey 8.0.2 source was built under /tmp only. Each test starts/stops an ephemeral
  Unix-socket process with no TCP port or persistence; it never connects to the
  existing application cache. Atomic reservation/promotion, binary retries,
  namespace isolation, byte limits and fixed expiry were exercised.
- Signed Razorpay events and SMTP use controlled doubles. They are NOT provider
  test-mode, live payment or inbox-delivery evidence. Structural MP4 fixtures are
  NOT real inference or decoded-quality evidence.

From the repository root:
`backend/.venv/bin/python -m pytest swico_video_node/tests -q`:
**26 passed**, 5.56 seconds. Actual local POSIX tests exercised termination escalation,
descendant cleanup, inherited lock ownership and supervisor-death containment.
Other tests cover command routing, private token rotation, provenance tamper denial,
path escapes, caption handling and runtime-ABI refusal. No weights were loaded.

Web commands from `web/`:
- `npm ci`: passed; existing dependency audit reported 8 findings (4 moderate,
  4 high). No unrelated dependency upgrades/audit fixes were applied.
- `npm run typecheck`, `npm run lint`: passed.
- `npm run test -- --run`: **591 passed, 45 files**, 18.21 seconds.
- `npx playwright test e2e/videos.spec.ts --project=chromium`: **4 passed**,
  9.3 seconds. Actual Chromium, local mocked API/auth—not real customer checkout
  or rendered media. Tests cover login destination, reload/expiry and role-photo
  consent/preflight/admission ordering. Additional ChatPage tests prove owner-job
  deep links consume persisted video cards without chat generation and cannot
  override a newer user navigation.
- Production-style `npm run build`: passed with the existing CI public fixture:
  `VITE_API_BASE_URL=https://api.example.test VITE_FIREBASE_API_KEY=ci-public-test-key VITE_FIREBASE_AUTH_DOMAIN=swico-ci.firebaseapp.com VITE_FIREBASE_PROJECT_ID=swico-ci VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef123456 VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890 npm run build`.
  The first build without Firebase variables correctly refused missing config.

Repository: `git diff --check`, tracked AND new-file high-confidence secret scan,
`check-web-product-language.py`, `check-legal-publication.py`, five workflow YAML
parses and `bash -n swico_video_node/scripts/setup_macos.sh` passed.
Actionlint was unavailable. Existing shared legal policies/approval were restored
unchanged after regression tests exposed that making them unreviewed would unpublish
Chat policies; assertions were not weakened. New amendments are solely in
`videoLegalDraft.json`, explicitly unapproved. The video-only runtime/release gate
requires those pages to receive fresh valid publication approval.

The local video release checker returned **ready=false / exit 1** as required:
schema present, but no approved video policy, configured worker, templates or cache.
No production configuration was used to fill these prerequisites.

## Native/provider evidence and operator prerequisites

Current host diagnostic: Intel x86_64, macOS **26.6.2**, Python **3.14.7**.
`backend/.venv/bin/python -m swico_video_node doctor` correctly returned nonzero:
the separate native Python **3.12** environment is required.

NOT RUN: FaceFusion/ONNX native model imports and full inference, both-template
likeness/temporal/occlusion/audio QA, real warm/cold timings, launchd serving,
real worker/API transfer under interrupted native inference, Razorpay test/live
capture/refund, actual SMTP and deployed Valkey backup/eviction validation.
No commercial grants, source photos, template approvals or benchmark timings supplied.

Model inventory and restrictions are in VIDEO_GENERATION.md. Every asset and engine
code review requires genuine documents and actual hashes. No pretrained asset is
declared commercially cleared by this implementation.

## Render/Mac handoff and rollback

**No Render changes required now; do not enable video.** Keep existing services,
CLI flags, Windows configuration, subscription/Chat/Voice billing, weekly testers
and cron schedules unchanged. Future operator-only steps, ALL exact variables,
secret placement, migration ownership and runnable Mac commands are in
[VIDEO_MAC_SETUP.md](VIDEO_MAC_SETUP.md). No new Render service/cache/cron required.

The new switches are `SWICO_VIDEO_ENABLED=false` and
`SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false` until the corresponding checklist passes.
The worker token is generated locally; only its printed SHA-256 goes to the API.
No backend/provider/database/SMTP secret goes to the Mac/browser.

Rollback is admission shutdown and drain: both flags false, keep the video-aware
API/Mac/authentication alive to settle work and refunds, retain metadata/migration,
wait for fixed output windows/cleanup, then stop the Mac service. Do not roll back
to the old payment dispatcher while video orders exist. No production downgrade,
stamp, deletion, payment retry or legal approval is authorized by this report.

Commit message:
`feat(video): add gated website template videos with Intel Mac rendering and durable billing`

## Changed paths

- `.github/workflows/ci.yml`
- `.gitignore`
- `backend/.env.example`
- `backend/alembic/versions/20260918_website_video.py`
- `backend/app/billing/audit.py`
- `backend/app/billing/razorpay_client.py`
- `backend/app/billing/reconciliation.py`
- `backend/app/billing/schema_readiness.py`
- `backend/app/billing/service.py`
- `backend/app/email_service.py`
- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/video/__init__.py`
- `backend/app/video/cache.py`
- `backend/app/video/config.py`
- `backend/app/video/maintenance.py`
- `backend/app/video/media.py`
- `backend/app/video/models.py`
- `backend/app/video/policy.py`
- `backend/app/video/router.py`
- `backend/app/video/service.py`
- `backend/app/video/transfers.py`
- `backend/app/web_api/chat_service.py`
- `backend/app/web_api/router.py`
- `backend/scripts/swico_video_release_check.py`
- `backend/tests/conftest.py`
- `backend/tests/test_startup_migrations.py`
- `backend/tests/test_video_postgres.py`
- `backend/tests/test_video_valkey.py`
- `backend/tests/test_website_video.py`
- `docs/RENDER_WEB_DEPLOYMENT.md`
- `docs/VIDEO_GENERATION.md`
- `docs/VIDEO_IMPLEMENTATION_REPORT.md`
- `docs/VIDEO_MAC_SETUP.md`
- `docs/VIDEO_RELEASE_CHECKLIST.md`
- `swico_video_node/__init__.py`
- `swico_video_node/__main__.py`
- `swico_video_node/engine.py`
- `swico_video_node/models.py`
- `swico_video_node/requirements-intel.lock`
- `swico_video_node/scripts/setup_macos.sh`
- `swico_video_node/storage.py`
- `swico_video_node/templates.py`
- `swico_video_node/tests/test_node.py`
- `swico_video_node/worker.py`
- `web/e2e/videos.spec.ts`
- `web/src/App.tsx`
- `web/src/billing/paymentPresentation.ts`
- `web/src/components/Conversation.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/src/components/Sidebar.tsx`
- `web/src/content/videoLegalDraft.json`
- `web/src/pages/ChatPage.test.tsx`
- `web/src/pages/ChatPage.tsx`
- `web/src/pages/VideosPage.test.tsx`
- `web/src/pages/VideosPage.tsx`
- `web/src/types/index.ts`
- `web/src/video/VideoCard.test.tsx`
- `web/src/video/VideoCard.tsx`
- `web/src/video/types.ts`
- `web/src/video/video.css`
