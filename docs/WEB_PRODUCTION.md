# Swico web production checklist

## Render

- Keep the existing manually configured backend and static-site resources; do
  not replace them with a Blueprint.
- Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, an exact comma-separated
  `CORS_ALLOW_ORIGINS` list (HTTPS origins only, no trailing slash), Firebase
  Admin credentials, OpenAI/Sarvam keys, SMTP/OTP values, database URL, and all
  backend-only Razorpay secrets on the backend service.
- Configure the Render secret file as `firebase-admin.json`, set
  `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin.json`, and remove
  `FIREBASE_CREDENTIALS_JSON`. Production accepts exactly one Firebase Admin
  credential method.
- Set `LOG_CHAT_CONTENT=false`, `AUTH_ALLOW_DEV_TOKENS=false`,
  `AUTO_CREATE_TABLES=false`, `RUN_MIGRATIONS_ON_STARTUP=false`, and
  `REQUIRE_MIGRATIONS_BEFORE_STARTUP=false`. Set
  `BILLING_CHECKOUT_ENABLED=false` explicitly for the initial deployment. Keep
  `RAZORPAY_MODE=test` and a
  `rzp_test_` key until every Live blocker is cleared.
- Configure the static site to serve `web/dist`, rewrite application routes to
  `index.html`, and reproduce the headers in `web/public/_headers` if the Render
  static-site configuration does not ingest that file automatically.
- Set all required public `VITE_*` values on the Render static-site service.
  Select **Save, rebuild, and deploy** after changing any of them because Vite
  embeds their values in the browser bundle at build time. Production builds
  reject missing, insecure, or malformed public configuration without printing
  the supplied values.
- Keep HSTS only on HTTPS production resources.
- Add a private scheduled job for stale reservations. The threshold must exceed
  the longest provider timeout:

  `cd backend && python -m scripts.billing_maintenance stale-reservations --age-seconds 1800`

- Run Razorpay reconciliation in dry-run first, alert on its output, then enable
  the idempotent apply form only after operational review:

  `cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 [--apply]`

- Configure every financial Cron Job with `APP_ENV=production`, the Render
  PostgreSQL internal `DATABASE_URL`, `AUTO_CREATE_TABLES=false`,
  `RUN_MIGRATIONS_ON_STARTUP=false`, and
  `REQUIRE_MIGRATIONS_BEFORE_STARTUP=false`. Razorpay reconciliation also needs
  `RAZORPAY_MODE`, `RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET`; it does not need
  unrelated Firebase, OpenAI, Sarvam, SMTP, webhook, or frontend credentials.
- Financial Cron Jobs must never use SQLite, create tables, or run Alembic. The
  backend service pre-deploy command is the sole production migration owner.
  Missing or unsafe database configuration exits before engine creation with
  configuration status `78`.
- Render service-level environment variables override environment-group
  values. Avoid duplicate `DATABASE_URL` entries and verify the Cron Job sees
  the intended internal PostgreSQL URL without printing it.
- Razorpay reconciliation is non-mutating unless `--apply` is explicitly
  present. Do not add `--apply` or switch to Live Mode automatically.

- Verify the API and static site use the same explicit Git branch. Verify the
  static response headers in the dashboard because `_headers` was not applied
  by the audited Render deployment.

## Firebase and Razorpay

- Copy the browser configuration from **Firebase Console → Project settings →
  Your apps → Web app → SDK setup and configuration → Config**. Do not copy
  Android `google-services.json` values into the website. The production Web
  app ID must contain `:web:`.
- Add `swico-web.onrender.com` to Firebase Authentication authorized domains.
  For a website-restricted browser key, allow
  `https://swico-web.onrender.com` and
  `https://swico-web.onrender.com/*`. API restrictions on that key must permit
  **Identity Toolkit API** and **Token Service API**.
- Never put Firebase Admin service-account JSON or backend secrets in `VITE_*`
  variables. Keep Admin credentials on the backend service, and verify those
  credentials belong to the same Firebase project as the frontend Web
  configuration.
- Register the production webhook URL and events in Razorpay, set distinct
  checkout and webhook secrets, verify signature delivery, and complete an
  end-to-end Test Mode payment before requesting Live Mode.
- Confirm captured-but-not-credited, duplicate webhook, delayed webhook, partial
  refund, full refund, and reconciliation alerts in the Render environment.
- Confirm `/api/web/billing/public-config` returns the explicit expected
  `razorpay_mode` and `checkout_enabled`; never derive mode in the browser from
  the public-key prefix.

## Legal blocker

Owner-provided, counsel-approved Terms, Privacy, Refund/Cancellation,
Contact/support, AI-limitations, Digital-delivery, and Pricing/top-up content is
required before accepting Razorpay Live Mode payments. The structured module at
`web/src/content/legalContent.json` intentionally has unreviewed empty slots;
it does not invent legal terms.

Razorpay Live Mode and `BILLING_CHECKOUT_ENABLED=true` must remain disabled
until all seven content areas are published and reviewed, in addition to the
operational evidence below.

## Release order and rollback

1. Back up PostgreSQL and record the deployed commit and Alembic revision.
2. Deploy the API first and run additive revision `8c1f4e7b2a90`; keep checkout disabled.
3. Smoke `bootstrap`, profile, usage settings/summary, existing-credit chat, and billing public config.
4. Deploy the static site only after the API contract is live. Re-test desktop/mobile Settings and Test Mode checkout in staging.
5. Fix forward for application issues. The new tables contain settings/lock rows only, but a database downgrade is still not the routine rollback path. Roll the API/static images back while leaving additive tables and financial history intact.
6. If payment risk is detected, set `BILLING_CHECKOUT_ENABLED=false` on the API and redeploy. This stops new orders without disabling existing-credit usage; reconcile existing orders before any further change.

## Release operations

- Confirm support contact details, monitoring/alert destinations, log retention,
  database backups and restore testing, incident ownership, and refund handling.
- Verify light/dark UI at 1440, 1024, 768 and 390 CSS pixels, including empty and
  long chats, long code blocks, Tamil text, billing, offline state, and provider
  failure state on real browsers.
- Re-run backend, web, and mobile quality gates and verify the CSP against real
  Firebase email/password traffic and Razorpay Checkout before each release.

The following fields intentionally have no invented values and block Live Mode
until an owner records direct evidence:

| Operational item | Required evidence |
| --- | --- |
| Published support contact | Reviewed address/channel visible on the deployed support page |
| Refund owner | Named on-call role and escalation path in the private runbook |
| Incident owner | Named primary/backup role and incident channel |
| API/deployment alerts | Alert destination plus a forced test notification |
| Payment reconciliation review | Schedule, reviewer, and retained review record |
| Database backups | Paid/non-expiring database plan and successful backup timestamp |
| Restore test | Disposable restore, migration/current check, and application smoke result |
| Log retention | Documented retention and access policy |
| Negative wallet procedure | Query, investigation owner, and compensating-entry approval path |
| Provider outage procedure | Disable/routing decision, customer status update, and recovery owner |

## Live launch commands

These gates are separate from the normal local build. The legal checker is
expected to fail until approved publication data exists:

```bash
python scripts/check-legal-publication.py
python scripts/check-web-product-language.py
python scripts/check-tracked-secrets.py
```

Run deployed staging tests only with a real non-local HTTPS domain and dedicated
Firebase test account:

```bash
cd web
PLAYWRIGHT_MODE=staging PLAYWRIGHT_BASE_URL=https://<staging-web-domain> \
E2E_TEST_EMAIL=<dedicated-test-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-smoke.spec.ts
```

Production verification is read-only:

```bash
cd web
PLAYWRIGHT_MODE=production-readonly PLAYWRIGHT_BASE_URL=https://<production-web-domain> \
E2E_TEST_EMAIL=<dedicated-readonly-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-readonly.spec.ts
```

Do not report deployed tests as passed unless a command actually ran against
the named HTTPS domain. Neither deployed suite completes a Razorpay payment.

## Disposable restore verification

Use a Render point-in-time recovery instance, never the primary database. On
the original paid Postgres service open **Recovery**, scroll to **Point-in-Time
Recovery**, choose **Restore Database**, name the disposable instance, select a
time at least ten minutes in the past, choose whether to copy settings, and
select **Start Recovery** (or **Customize Recovery**, then start). Wait for the
new service to move from **Recovery In Progress** to **Creating** to
**Available**. Copy its URL from the restored instance’s **Info** page into a
temporary shell variable; do not save it or replace a service `DATABASE_URL`.

```bash
cd backend
APP_ENV=staging RESTORE_DRILL_CONFIRMATION=disposable \
DATABASE_URL=<restored-database-url> python -m scripts.verify_restore
```

Retain the safe row-count/invariant result, restore point, Git SHA, and operator
timestamp. Cleanup: confirm no API/Cron/environment group references the
recovery URL, remove temporary shell/CI values, then delete the disposable
recovery database from its Render **Settings** page. Never delete or suspend the
primary as part of a drill.
