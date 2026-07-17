# Render deployment for the standalone web app

Do not create a Blueprint for the existing production resources. They were created manually; update them in the Render dashboard.

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

Configure `billing-stale-reservations` with this command:

```bash
cd backend && python -m scripts.billing_maintenance stale-reservations --age-seconds 1800
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
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900
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

Render did not apply `web/public/_headers` to the audited static site automatically. Reproduce every header from that file in the static-site dashboard/edge configuration and verify them with `curl -I` after deployment. In particular, the response—not only an HTML meta tag—must include CSP (with `frame-ancestors 'none'`), Referrer-Policy, X-Content-Type-Options, X-Frame-Options, Permissions-Policy, and HSTS on HTTPS resources.

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

## Production launch checks

Publish owner-provided and reviewed Terms, Privacy, Refund/Cancellation, Contact/support, and AI-limitations content; verify provider prices/FX policy; configure alerts and reconciliation; validate refund/support runbooks; load-test PostgreSQL connections/rate limiting; and confirm CSP/security headers at the edge. Confirm production CORS contains no wildcard. Razorpay Live Mode and Live checkout remain blocked until every item is complete.

## Controlled first Live payment plan (do not execute until every blocker is cleared)

After reviewed legal content is published, backup/restore and monitoring evidence exists, Test Mode payment/webhook/replay/refund has passed, and the owner explicitly authorizes Live Mode: deploy all three matching Live Razorpay values together, use one authorized owner-controlled account, make one ₹10 payment with owner-controlled payment details, verify one 5,000,000-micro-INR ledger credit and one provider usage debit, monitor webhook/reconciliation, and stop the pilot immediately on any mismatch. Never use customer data for this pilot. This plan is documentation only and is not authorization to enable Live Mode or make a payment.
