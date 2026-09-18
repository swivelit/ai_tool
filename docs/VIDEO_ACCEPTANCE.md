# Video correction acceptance and diagnostics

Use alongside [VIDEO_MAC_SETUP.md](VIDEO_MAC_SETUP.md). Software tests, native
model QA, rights, publication approval, provider acceptance and deploy readiness
are independent. None is manufactured by a configured flag or hash.

## Reproducible local software checks (no provider/customer calls)

From the repository root, with the existing test environment:

```bash
backend/.venv/bin/python -m pytest swico_video_node/tests -q
bash -n swico_video_node/scripts/setup_macos.sh
bash -n swico_video_node/scripts/prerequisites_macos.sh
backend/.venv/bin/python scripts/check-tracked-secrets.py
backend/.venv/bin/python scripts/check-web-product-language.py
backend/.venv/bin/python scripts/check-legal-publication.py
git diff --check
```

Before Python exists, on the operator Mac use
`bash swico_video_node/scripts/setup_macos.sh --check`. Exit 1 with missing
prerequisites is expected, not video failure. No worker import, venv creation,
installer, sudo, credential change or API request occurs. Follow the guarded
Tahoe installer block in VIDEO_MAC_SETUP.md; opening its webpage installs nothing.
`test_first_run.py` executes the actual shell orchestration with fixture OS/tool
facts and the exact documented installer block with inert command substitutes.
It checks hash-before-privilege ordering and interruption/failure stops, not a
real package installation. A real bad checksum is also tested without installing.

From `backend/`:

```bash
.venv/bin/python -m pytest tests/test_website_video.py tests/test_video_valkey.py tests/test_startup_migrations.py -q
.venv/bin/python -m pytest -q
```

`test_video_valkey.py` starts its own disposable Unix-socket Valkey/Redis with no
TCP port or persistence. Set `SWICO_TEST_VALKEY_SERVER` to a reviewed installed
binary if it is not on PATH. It never flushes/connects to `WEB_UPLOAD_CACHE_URL`.
For PostgreSQL, provide `TEST_DATABASE_URL` pointing ONLY to a disposable local
test DB, then run `tests/test_video_postgres.py tests/test_website_video.py
tests/test_cli_postgres_lifecycle.py`. The test fixture resets tables: NEVER use a
Render/production connection. No new migration is needed by this correction.

From `cli/`: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`, `npm run release:check -- --keep-artifact`.
The launcher tests run public `.cmd` shim semantics on Windows and a shebang
launcher on POSIX; wrong-version/help/path confinement are required on BOTH.
Only POSIX execute-bit/symlink semantics are platform-specific. The operator-supplied
parent-commit main CI run `35346729754` passed all seven jobs, including Windows
CLI/native ConPTY and canonical artifact. That is historical hosted evidence,
not a new CI execution in this first-run pass. Separate Agent Native Isolation
run `35346729719` passed hostile isolation but failed installed coding-agent
acceptance; it remains unchanged/out of scope, not a video-worker failure.
Canonical CI dependencies/provenance/version are unchanged (current CLI 0.2.9).

From `web/`: `npm ci`, `npm run typecheck`, `npm run lint`,
`npm run test -- --run`, `npx playwright test e2e/videos.spec.ts --project=chromium`,
`npm run build` with the existing CI public Firebase fixture or authorized build
configuration. Browser fixtures do not charge, send email or run inference.

## Interpreting operator diagnostics

| Check | What it proves | What it does not prove |
|---|---|---|
| shell prerequisites=present | Selected native Python/tool files and CLT found | pip/venv health, codec execution, authentication or inference |
| port version | MacPorts executable runs after installation | Python, FFmpeg, model permissions or worker readiness |
| init digest | Local protected credential exists | Render has matching digest |
| doctor API authenticated | Exact credential accepted by HTTPS health | Models, publication, output quality |
| schema_ready / control_initialized | Tables / singleton independently | Active native worker |
| loaded / running / local_liveness | launchd definition / PID / recent local progress | Successful backend pairing |
| dependency smoke | Locked packages and headless imports | Model load, quality or performance |
| codec smoke | Actual synthetic H264 encode/probe/decode | Face-swap inference |
| native calibration | Operator-recorded measured output review, current identity | Independent scientific/legal certification |
| smtp / razorpay_configured | Settings exist | Delivered message, capture/refund |
| cache_headroom | Present memory headroom | Persistence, eviction or load acceptance |

Runtime changes withdraw worker readiness and reject new purchases. A stale
queued attempt fails safely through existing allowance/refund settlement; do not
update its frozen hashes. Heartbeat/terminal result/owner cancel still operate
with admission flags disabled. A worker stopping during a render terminates its
owned process group and leaves fenced backend recovery; no global process kill.

The same authorized native fixture must pass foreground AND LaunchAgent operation.
Include offline/reconnect, stop during validation/render/upload, parent crash,
out-of-date profile, fixed 600-second output expiry, owner-only download and email
delay. Verify exactly one processing job and durable accounting after restart.
Do not run customer photos as a probe. Do not publish or mark QA before viewing
the actual operator-owned results. Capture only metadata/timings; no faces/secrets.

## Genuine model and template prerequisites

Run `models audit` to get all ten review objects (code + nine models), exact local
manifest paths and blockers. A missing technical file is separate from missing
commercial permission. Permissive applicable licence grants can suffice if their
conditions apply; restricted pretrained weights need the right holder's grant.
Original video and audio rights, source-adult consent, human track review and
result QA are additional independent requirements. Neither owner legal-page
attestation nor a code licence supplies those rights.

Pinned source inspected:
`03d49d0c7de095a41628a74d94a146214f82837a` (FaceFusion 3.0.1).
Used imports include detector/landmarker/recognizer/masker/safety and the direct
`swap_face`/`enhance_face` APIs, their transitive headless imports and both mask
models. GUI/Gradio and demographic classifier execution are not part of the
adapter. Setup's smoke imports these modules without calling download/pre-check
or creating an inference session. Full ONNX compatibility still requires authorized
weights on the actual native Python 3.12 Mac.

## Proposed policy comparison — no automatic publication

```bash
backend/.venv/bin/python scripts/video_legal_diff.py
```

This prints a readable pages diff and canonical fingerprints only; it writes
nothing. The published Chat policy and its approval remain unchanged.
Proposed video pages currently hash to:
`0518d19801fea2db4292a4d232fdc59ec44fd6ddcf44ce580e33aeb293ef9481`.
Recompute after any content change; this string is NOT an approval.

Owner/counsel must review exact text covering face consent, restrictions, ₹25
standalone payments, refunds, source/output retention and delivery. Only after
actual written authorization, publish the approved pages and fresh metadata under
the existing `scripts/check-legal-publication.py` contract:

- Owner: `publicationStatus=owner_approved`, `approvalType=owner_attestation`,
  genuine `approvedByNameOrRole`, `writtenAttestationReference`, `approvalDate`,
  `legalReviewStatus=not_reviewed_by_counsel`, exact `approvedLegalContentSha256`;
  corresponding genuine reference/date/hash in
  `docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md`.
- Counsel: `publicationStatus=approved_by_counsel`, `approvalType=counsel_approval`,
  genuine `counselNameOrFirm`, `writtenApprovalReference`, `approvalDate`, exact
  `approvedLegalContentSha256`.

Do not copy the old fingerprint or invent reviewer/date. The video gate additionally
requires published pages to equal the proposed video pages. Run the publication
checker and video release checker afterward. No `LEGAL_APPROVED` flag exists.

## Provider TEST acceptance — operator authorization required, NOT RUN here

Do NOT replace Razorpay Live keys on the existing production service. Use a local
isolated backend/browser, disposable local Postgres and Valkey, separate local Mac
data directory, approved fixture assets/accounts and ONLY an operator-authorized
Razorpay TEST account. No extra hosted service/tunnel is required or authorized.

1. Prepare an isolated local environment file, mode 0600, outside Git. Include a
   disposable `DATABASE_URL`, disposable `WEB_UPLOAD_CACHE_URL`, `APP_ENV=test`,
   `AUTH_ALLOW_DEV_TOKENS=false`, legitimate test Firebase configuration and test
   Razorpay keys/webhook secret with `RAZORPAY_MODE=test`. Keep both video flags
   false until legal/local fixture prerequisites pass. Use a test inbox, never a
   customer address. Do not source a production environment file.
2. Start the existing backend locally with a locally trusted TLS certificate/key
   supplied by the operator (never disable certificate verification):
   `cd backend` then
   `.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8443 --ssl-certfile /absolute/test-cert.pem --ssl-keyfile /absolute/test-key.pem`.
   Migrate ONLY that disposable DB with the normal `alembic upgrade head` before
   startup. Existing browser `npm run dev` must target this API and test Firebase.
3. With a distinct `SWICO_VIDEO_DATA_DIR` and no production service running, init
   the local worker using `--api-base https://localhost:8443`; copy ONLY its digest
   to that isolated backend. Complete actual rights/native preparation before a
   real render. Never reuse or rotate the production worker token.
4. After local publication/native gates pass, explicitly enable test-only video
   admission/checkout. In the browser submit an approved fixture, observe actual
   preflight, confirm ₹25 TEST checkout and use official Razorpay TEST instruments.
   Check one captured order/one job/no wallet or subscription credit on callback
   replay. If the provider cannot reach localhost for webhooks, provider webhook
   delivery remains NOT RUN; do not invent it. Signed local replay tests cover the
   dispatcher deterministically but are not provider delivery evidence.
5. Trigger a controlled infrastructure failure/cancellation in the disposable job.
   Observe one durable refund intent, actual TEST provider refund ID and truthful
   pending/processed/failed state. Repeat callbacks/status reconciliation and
   confirm no duplicate refund or allowance restoration. Do not retry an unknown
   refund POST manually. Test late capture after source expiry similarly.
6. With separately authorized test SMTP/inbox, complete a test output; check the
   authenticated website link, correct account/timezone, fixed expiry and no
   attachment. Delay/retry must not renew the output. Disable both flags and
   confirm accepted work/refunds and owner access still drain.
7. Record non-secret IDs, amounts, timestamps and outcomes; do not record keys,
   headers, images, embeddings or customer data. Stop local processes and remove
   only the explicitly owned disposable resources. Never perform these actions
   against production as a substitute for isolated acceptance.

## Primary sources checked

- [MacPorts official install/Tahoe](https://www.macports.org/install.php)
- [pip interpreter management](https://pip.pypa.io/en/stable/topics/python-option/)
- [Node Windows .cmd spawning](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
- [Node filesystem semantics](https://nodejs.org/api/fs.html)
- [Pinned FaceFusion source](https://github.com/facefusion/facefusion/tree/03d49d0c7de095a41628a74d94a146214f82837a)
- [InsightFace licensing distinction](https://github.com/deepinsight/insightface)
- [Render environment changes](https://render.com/docs/configure-environment-variables)

No reference is permission to bypass the explicit operator release gates.
