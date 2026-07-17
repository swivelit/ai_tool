# Render deployment for the standalone web app

Do not create a Blueprint for the existing production resources. They were created manually; update them in the Render dashboard.

## New isolated staging project — beginner setup

`render.staging.yaml` is only for three new resources:
`swico-api-staging`, `swico-web-staging`, and `swico-postgres-staging`. It puts
the API and database in the same region, wires `DATABASE_URL` only through the
staging `fromDatabase` reference, and defines no environment group. Never
attach a production environment group or copy a production credential.

1. In Render, create or select a project named **Swico Staging** and an
   environment named **Staging**. Do not place existing production resources in
   it.
2. Open **Blueprints → New Blueprint Instance**, connect this repository and
   branch, select **Use a custom Blueprint path**, and enter
   `render.staging.yaml`. Review that the plan contains only the three staging
   resource names before applying it.
3. In the initial Blueprint form, provide every `sync:false` value. On the API,
   set `CORS_ALLOW_ORIGINS` to the exact staging web HTTPS origin; provide a
   staging OpenAI key, matching Razorpay Test Mode key ID/secret/webhook secret,
   and optional staging Sentry DSN. Never enter a Live key or production value.
4. On the static site, provide `VITE_API_BASE_URL` with the staging API HTTPS
   origin and all five Firebase Web app values:
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, and
   `VITE_FIREBASE_MESSAGING_SENDER_ID`. These are public build values, not Admin
   credentials. Rebuild after any change.
5. In `swico-api-staging` open **Environment → Secret Files**, upload the
   staging Firebase Admin service-account JSON with the exact filename
   `firebase-admin-staging.json`. The Blueprint already sets
   `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin-staging.json`.
   Do not add `FIREBASE_CREDENTIALS_JSON` or reuse the production file.
6. In Firebase Authentication open **Settings → Authorized domains** and add
   the staging static-site hostname without scheme or path. If the browser key
   is website-restricted, allow both the staging origin and its `/*` form.
7. In the staging Firebase project create one dedicated email/password account
   used only by deployed staging E2E. Store its credentials only in the GitHub
   staging Environment described below.
8. Keep `BILLING_CHECKOUT_ENABLED=false` initially. After a second operator
   verifies `RAZORPAY_MODE=test`, matching `rzp_test_` credentials, webhook,
   staging domain, and visible **Test Mode** badge, temporarily enable checkout
   in staging and fund the dedicated account with one supervised Razorpay Test
   Mode transaction. Disable checkout again unless a specifically approved
   staging exercise needs it. Another staging-only funding mechanism requires
   explicit operational approval. Never automate payment in Playwright.
9. Confirm `GET /api/web/health` returns success. This endpoint performs a
   database query, so the Render health check also proves the isolated staging
   database is reachable.

The file has been checked by repository tests and parsed as YAML. A Render CLI
or API validation must be run by the operator when authenticated tooling is
available; a repository YAML parse is not a claim that Render accepted or
created the Blueprint.

## Existing API service — exact settings

- Root Directory: **blank**
- Build Command:
  `python -m pip install --upgrade pip && pip install -r backend/requirements.txt`
- Pre-deploy Command:
  `cd backend && python -m alembic -c alembic.ini upgrade head`
- Start Command:
  `python backend/start_render.py`
- Health Check Path: `/health`
- Instance: paid, always running
- Region: the same region as PostgreSQL

The root must remain blank. `backend/config.py` and `backend/app/agentic_service.py` still have repository-root runtime reads involving `mobile/data/`.

Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, `LOG_CHAT_CONTENT=false`, `AUTH_ALLOW_DEV_TOKENS=false`, `AUTO_CREATE_TABLES=false`, `RUN_MIGRATIONS_ON_STARTUP=false`, `REQUIRE_MIGRATIONS_BEFORE_STARTUP=false`, `BILLING_CHECKOUT_ENABLED=false`, and `CORS_ALLOW_ORIGINS=https://<web-domain>`. Production requires the checkout switch to be explicit. The pre-deploy command is the only production migration owner. Keep the existing database, Firebase Admin, provider, email, and operational variables. Add all billing variables documented in `backend/.env.example`, including Razorpay key ID/secret/webhook secret, limits/packages, credit/reserve/markup configuration, provider pricing, FX rate/buffer, webhook size, and the non-secret token-estimate reference provider/model. Secrets must be Render secret environment variables.

Exact environment delta for this release:

- Add API variable `BILLING_CHECKOUT_ENABLED=false` (backend-only, explicit in production).
- Add or accept defaults for `USAGE_ESTIMATE_REFERENCE_PROVIDER=openai` and `USAGE_ESTIMATE_REFERENCE_MODEL=gpt-5-nano` (backend-only, non-secret display reference).
- Keep `BILLING_CREDIT_PERCENT=50`; do not change it.
- Add `SENTRY_DSN` only as a backend/Cron secret when an alert project is ready;
  set `SENTRY_TRACES_SAMPLE_RATE=0.05` and `SENTRY_PROFILES_SAMPLE_RATE=0`.
- Keep `RAZORPAY_MODE=test` plus matching `rzp_test_` ID/secret/webhook secret. Do not add Live credentials.
- Remove no `VITE_*` variables. Do not add Razorpay secrets or checkout flags to the static-site environment.

For Firebase Admin, configure exactly one credential method. The recommended
Render setup is a secret file named `firebase-admin.json` plus
`GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin.json`. Remove
`FIREBASE_CREDENTIALS_JSON` when using that secret file. Production startup
rejects both methods together and rejects neither method; it never logs their
values or credential paths.

For the controlled release, set `RAZORPAY_MODE=test` and prove that `RAZORPAY_KEY_ID` starts with `rzp_test_`. Do not add Live credentials yet. Production startup validates these combinations without logging values and exits before serving if they are unsafe.

Run the pre-deploy migration before enabling website traffic. Revision `8c1f4e7b2a90` creates `web_usage_preferences` and `web_usage_period_lock` additively. Verify `/api/web/health`, `/api/web/billing/public-config`, authenticated bootstrap/profile/usage contracts, existing-credit chat while checkout is disabled, then Test Mode checkout, capture, duplicate webhook replay, and refund in staging after intentionally enabling the switch there.

## Financial Cron Jobs

Both Cron Jobs use branch `main`, region **Virginia**, and a blank Root
Directory. Render evaluates Cron schedules in UTC. Configure these schedules:

- `billing-stale-reservations`: `*/10 * * * *`
- `razorpay-reconciliation`: `*/15 * * * *`
- `billing-financial-audit`: `*/5 * * * *`

Configure `billing-stale-reservations` with this command:

```bash
cd backend && python -m scripts.billing_maintenance stale-reservations --age-seconds 1800
```

Configure `billing-financial-audit` with this read-only command:

```bash
cd backend && python -m scripts.billing_maintenance audit --captured-uncredited-age-seconds 900 --fail-on-findings
```

Every financial Cron Job requires:

```bash
APP_ENV=production
DATABASE_URL=<Render PostgreSQL internal URL>
AUTO_CREATE_TABLES=false
RUN_MIGRATIONS_ON_STARTUP=false
REQUIRE_MIGRATIONS_BEFORE_STARTUP=false
```

Razorpay reconciliation additionally requires `RAZORPAY_MODE`,
`RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET` in Test Mode:

```bash
RAZORPAY_MODE=test
RAZORPAY_KEY_ID=<matching rzp_test_ key>
RAZORPAY_KEY_SECRET=<matching Test Mode secret>
```

Its initial dry-run command is:

```bash
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 --fail-on-findings
```

The only explicit mutating form is:

```bash
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 --apply
```

Dry-run is the default. Create the Cron Job without `--apply`, retain its Test
Mode output as review evidence, and add `--apply` only after explicit operational
approval. Never enable Live Mode as part of Cron setup. Maintenance
configuration errors exit with status `78` before database-engine or
Razorpay-client creation and never print supplied values.

Audit or reconciliation findings exit with status `3`. In the Render workspace,
open **Integrations → Notifications**, configure Email, Slack, or both, and set
**Default Service Notifications** to **Only failure notifications** (or **All
notifications**). On each Cron Job’s **Settings** page, scroll to
**Notifications** and retain the workspace default or explicitly select **Only
failure notifications**. Use **Trigger Run** on staging and retain evidence that
a deliberate non-zero run reaches the configured destination.

Financial Cron Jobs must use PostgreSQL and must not create tables or run
migrations. The backend service pre-deploy command remains the sole production
Alembic owner; Cron Jobs have no migration or pre-deploy command. Render
service-level variables override environment-group values, including a
service-level `DATABASE_URL`, so verify that each Cron Job uses the intended
internal database URL without logging it. Do not add a production Blueprint for
these manually managed resources.

The PostgreSQL credential exposed in the earlier screenshot must be rotated
manually in Render, then updated on the affected services. Never place real
credentials in screenshots, test output, Git history, or documentation.

After the OTP timestamp migration, verify PostgreSQL reports
`timestamp with time zone` for `email_otp_code.created_at`, `expires_at`, `consumed_at`, and
`last_sent_at` through `information_schema.columns`. Existing values are
converted with `AT TIME ZONE 'UTC'`; no OTP rows are deleted or recreated.

## Static site — exact settings

- Service type: Static Site
- Root Directory: `web`
- Build Command: `npm ci && npm run build`
- Publish Directory: `dist`
- Rewrite: `/*` to `/index.html`

Set the backend and static site to the same explicit Git branch and record the deployed commit SHA during each release. This repository cannot prove the private dashboard selection; verify it in **Settings → Build & Deploy → Branch** for both services.

Set only the public `VITE_*` values in `web/.env.example`: API base URL and Firebase Web app configuration. Do not place Firebase Admin credentials or OpenAI, Sarvam, Razorpay secret, webhook secret, or database values in the static site.

Copy the Firebase browser configuration from **Firebase Console → Project settings → Your apps → Web app → SDK setup and configuration → Config**. Do not copy values from the Android `google-services.json`; the production Firebase app ID for this website must contain `:web:`. Set every required `VITE_*` value on the Render **static-site service**, then select **Save, rebuild, and deploy**. Vite embeds these variables at build time, so changing them without rebuilding does not update the deployed site. The production build validates the public configuration and stops with variable names—but never values—when required settings are missing or malformed.

Never put Firebase Admin service-account JSON or backend secrets in `VITE_*` variables. The Firebase Admin credentials on the backend service must belong to the same Firebase project as the frontend Web configuration.

For `https://swico-web.onrender.com`, complete these Firebase Console settings:

- Add `swico-web.onrender.com` to **Firebase Authentication → Settings → Authorized domains**.
- If the browser API key uses website restrictions, allow both `https://swico-web.onrender.com` and `https://swico-web.onrender.com/*`.
- If the browser API key uses API restrictions, permit **Identity Toolkit API** and **Token Service API**.

Render did not apply `web/public/_headers` to the audited static site automatically. Reproduce these exact name/value pairs from that file in the static-site dashboard/edge configuration:

- `Content-Security-Policy`: `default-src 'self'; script-src 'self' https://checkout.razorpay.com https://*.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-src https://*.firebaseapp.com https://*.razorpay.com https://api.razorpay.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`
- `Referrer-Policy`: `strict-origin-when-cross-origin`
- `X-Content-Type-Options`: `nosniff`
- `X-Frame-Options`: `DENY`
- `Permissions-Policy`: `camera=(), geolocation=(), microphone=()`
- `Strict-Transport-Security`: `max-age=31536000; includeSubDomains`

The response—not an HTML meta tag—must contain them. Run the network check only
when the deployed URL is explicitly configured:

```bash
DEPLOYED_WEB_URL=https://<web-domain>
python scripts/check-web-security-headers.py --url "$DEPLOYED_WEB_URL"
```

Point the desired web custom domain at the Render static site and complete Render certificate validation. Add the final origin (scheme and hostname, without a trailing slash) to API `CORS_ALLOW_ORIGINS` and add the hostname to Firebase Authentication authorized domains. Point the API custom domain at the existing API service and update `VITE_API_BASE_URL`; select **Save, rebuild, and deploy** because Vite variables are build-time values.

## Razorpay Test and Live setup

Create separate Test and Live webhooks targeting `https://<api-domain>/api/web/billing/razorpay/webhook`. Subscribe to `payment.captured`, `order.paid`, `refund.processed`, and `refund.failed`. Use a distinct webhook secret per mode. Test end-to-end in Test Mode, then replace all three API-side Razorpay values together for Live Mode. Never expose the key secret or webhook secret to the static site.

The API returns an explicit `razorpay_mode` enum and validates its public-key prefix. For a future cutover, keep checkout disabled, replace `RAZORPAY_MODE`, key ID, key secret, and webhook secret as one reviewed change, deploy/verify the API public config, then enable checkout as a separate reviewed change. Never mix Test and Live values.

## Migration and rollback

1. Back up PostgreSQL and note the currently deployed image and Alembic revision.
2. Run `cd backend && python -m alembic -c alembic.ini upgrade head` as the pre-deploy step; confirm head `8c1f4e7b2a90`.
3. Deploy the API first with `BILLING_CHECKOUT_ENABLED=false`, smoke existing mobile endpoints and new web contracts, then deploy the static site.
4. For an application rollback, first disable checkout, then deploy the previous API/static versions. Leave additive billing/chat/settings tables intact so ledger/payment and user-setting history is preserved.
5. Database downgrade of `6d4f2a9c8b71` destroys financial/chat tables and is not a normal rollback. Downgrading `8c1f4e7b2a90` also removes user preferences and serialization rows. In production, preserve additive tables and fix forward.

## Disposable recovery drill

On the original paid Postgres service open **Recovery**, scroll to
**Point-in-Time Recovery**, select **Restore Database**, supply a disposable
name and a time at least ten minutes in the past, choose whether to copy
settings, and select **Start Recovery** (or **Customize Recovery**, then start).
Wait for **Recovery In Progress → Creating → Available**. On the new database’s
**Info** page copy its connection URL only into the temporary verification
environment; do not update any API, Cron Job, or environment group.

```bash
cd backend
APP_ENV=staging RESTORE_DRILL_CONFIRMATION=disposable \
DATABASE_URL=<restored-database-url> python -m scripts.verify_restore
```

The verifier starts a PostgreSQL read-only transaction, compares the one current
Alembic head, checks required tables/row counts, wallet/uniqueness/foreign-key
invariants, and rolls back. Retain its safe JSON plus restore point, commit,
operator, and timestamp. Cleanup: confirm the recovery URL is not referenced by
services or environment groups, remove temporary shell/CI values, then delete
the disposable database from its **Settings** page. Never delete, suspend, or
repoint the primary during a drill.

## Deployed Playwright

Local mode keeps the Vite server, mock authentication, and intercepted backend.
Deployed modes start no local server, set no mock-auth variable, and use real
Firebase/API traffic.

```bash
cd web
PLAYWRIGHT_MODE=staging PLAYWRIGHT_BASE_URL=https://<staging-web-domain> \
E2E_TEST_EMAIL=<dedicated-test-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-smoke.spec.ts \
  --project=chromium --project=mobile-chromium

PLAYWRIGHT_MODE=production-readonly PLAYWRIGHT_BASE_URL=https://<production-web-domain> \
E2E_TEST_EMAIL=<dedicated-readonly-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-readonly.spec.ts \
  --project=chromium --project=mobile-chromium
```

Create GitHub Environments named exactly **staging** and
**production-readonly** under **Repository Settings → Environments**. In each,
add Environment secrets named exactly `PLAYWRIGHT_BASE_URL`, `E2E_TEST_EMAIL`,
and `E2E_TEST_PASSWORD`; use a dedicated account and the matching
credential-free HTTPS origin. Restrict branches and reviewers as appropriate.
The workflow uses these as test-only environments and does not create
deployment records.

Open **Actions → Deployed web smoke → Run workflow**, select `staging` or
`production-readonly`, and run the intended commit. Runs for one environment
are serialized. Retain the run URL and safe Step Summary fields: mode, base
hostname, commit SHA, desktop/mobile result, and timestamp. Reports and traces
are private failure-only artifacts. Never copy the test account, Firebase token,
or API authorization header into logs or the summary.

Local mode continues to start Vite with mocked authentication. Deployed mode
starts no local server, enables no mock authentication, requires HTTPS, uses
real Firebase/API traffic, and runs desktop/mobile sequentially. The staging
test fails before mutations when token credits are unusable and instructs the
operator to perform the one supervised Test Mode funding transaction; it never
submits payment details. Do not claim a deployed pass without a real non-local
HTTPS run with real credentials.

A successful Render build is not proof that a Cron Job executed successfully.
For each financial staging job, open it in Render, select **Trigger Run**, inspect
the exit status and safe output, verify the intended database and Test Mode,
and retain evidence. Do this separately for stale reservations, Razorpay
reconciliation dry-run, and financial audit.

## Production launch checks

Run `python scripts/check-legal-publication.py`; it intentionally fails until
owner-provided, counsel-approved Terms, Privacy, Refund/Cancellation,
Contact/support, AI-limitations, Digital-delivery, and Pricing/top-up content,
identity/contact metadata, effective dates, and versions are published. Verify
provider prices/FX policy; configure alerts/reconciliation; validate the
refund/incident ownership template; load-test PostgreSQL connections/rate
limiting; and confirm edge headers/CORS. Razorpay Live Mode and Live checkout
remain blocked until every item is complete.

Legal publication remains a separate expected blocker. Razorpay Live Mode is
deferred, and production `BILLING_CHECKOUT_ENABLED` remains `false`.

## Controlled first Live payment plan (do not execute until every blocker is cleared)

After reviewed legal content is published, backup/restore and monitoring evidence exists, Test Mode payment/webhook/replay/refund has passed, and the owner explicitly authorizes Live Mode: deploy all three matching Live Razorpay values together, use one authorized owner-controlled account, make one ₹10 payment with owner-controlled payment details, verify one 5,000,000-micro-INR ledger credit and one provider usage debit, monitor webhook/reconciliation, and stop the pilot immediately on any mismatch. Never use customer data for this pilot. This plan is documentation only and is not authorization to enable Live Mode or make a payment.
