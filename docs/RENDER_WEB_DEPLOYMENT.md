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

Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, `AUTO_CREATE_TABLES=false`, and `CORS_ALLOW_ORIGINS=https://<web-domain>`. Keep the existing database, Firebase Admin, OpenAI, Sarvam, email, and operational variables. Add all billing variables documented in `backend/.env.example`, including Razorpay key ID/secret/webhook secret, limits/packages, credit/reserve/markup configuration, provider pricing, FX rate/buffer, and webhook size. Secrets must be Render secret environment variables.

Run the pre-deploy migration before enabling website traffic. Verify `/api/web/health`, `/api/web/billing/public-config`, an authenticated bootstrap, Test Mode checkout, capture, duplicate webhook replay, and refund in staging.

## Static site — exact settings

- Service type: Static Site
- Root Directory: `web`
- Build Command: `npm ci && npm run build`
- Publish Directory: `dist`
- Rewrite: `/*` to `/index.html`

Set only the public `VITE_*` values in `web/.env.example`: API base URL and Firebase Web app configuration. Do not place Firebase Admin credentials or OpenAI, Sarvam, Razorpay secret, webhook secret, or database values in the static site.

Point the desired web custom domain at the Render static site and complete Render certificate validation. Add the final origin (scheme and hostname, without a trailing slash) to API `CORS_ALLOW_ORIGINS` and add the domain to Firebase Authentication authorized domains. Point the API custom domain at the existing API service and update `VITE_API_BASE_URL`; rebuild the static site because Vite variables are build-time values.

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
