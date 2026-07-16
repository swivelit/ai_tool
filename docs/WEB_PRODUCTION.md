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
  `REQUIRE_MIGRATIONS_BEFORE_STARTUP=false`. Keep `RAZORPAY_MODE=test` and a
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

## Legal blocker

TODO(LEGAL-BLOCKER): reviewed Terms, Privacy, Refund policy, AI limitations, and
Contact/support publication copy is required before accepting Razorpay Live
Mode payments. The pages currently provide complete layout and explicit content
slots only; they intentionally do not invent legal terms.

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
