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

Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, `LOG_CHAT_CONTENT=false`, `AUTH_ALLOW_DEV_TOKENS=false`, `AUTO_CREATE_TABLES=false`, `RUN_MIGRATIONS_ON_STARTUP=false`, `REQUIRE_MIGRATIONS_BEFORE_STARTUP=false`, and `CORS_ALLOW_ORIGINS=https://<web-domain>`. The pre-deploy command is the only production migration owner. Keep the existing database, Firebase Admin, provider, email, and operational variables. Add all billing variables documented in `backend/.env.example`, including Razorpay key ID/secret/webhook secret, limits/packages, credit/reserve/markup configuration, provider pricing, FX rate/buffer, and webhook size. Secrets must be Render secret environment variables.

For the controlled release, set `RAZORPAY_MODE=test` and prove that `RAZORPAY_KEY_ID` starts with `rzp_test_`. Do not add Live credentials yet. Production startup validates these combinations without logging values and exits before serving if they are unsafe.

Run the pre-deploy migration before enabling website traffic. Verify `/api/web/health`, `/api/web/billing/public-config`, an authenticated bootstrap, Test Mode checkout, capture, duplicate webhook replay, and refund in staging.

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

## Migration and rollback

1. Back up PostgreSQL and note the currently deployed image and Alembic revision.
2. Run `cd backend && python -m alembic -c alembic.ini upgrade head` as the pre-deploy step.
3. Deploy the API with `WEB_APP_ENABLED=false`, check existing mobile endpoints, then enable it and deploy the static site.
4. For an application rollback, disable `WEB_APP_ENABLED` and deploy the previous API/static versions. Leave the additive billing/chat tables intact so ledger/payment history is preserved.
5. Database downgrade of `6d4f2a9c8b71` destroys financial/chat tables and is not a normal rollback. Use it only before real transactions, after a verified backup and explicit approval. In production, fix forward.

## Production launch checks

Replace legal placeholders, verify provider prices/FX policy, configure alerts and reconciliation, validate refund/support runbooks, load-test PostgreSQL connections/rate limiting, and confirm CSP/security headers at the edge. Confirm production CORS contains no wildcard.

## Controlled first Live payment plan (do not execute until every blocker is cleared)

After reviewed legal content is published, backup/restore and monitoring evidence exists, Test Mode payment/webhook/replay/refund has passed, and the owner explicitly authorizes Live Mode: deploy all three matching Live Razorpay values together, use one authorized owner-controlled account, make one ₹10 payment with owner-controlled payment details, verify one 5,000,000-micro-INR ledger credit and one provider usage debit, monitor webhook/reconciliation, and stop the pilot immediately on any mismatch. Never use customer data for this pilot. This plan is documentation only and is not authorization to enable Live Mode or make a payment.
