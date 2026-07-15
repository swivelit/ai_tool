# Swico web production checklist

## Render

- Keep the existing manually configured backend and static-site resources; do
  not replace them with a Blueprint.
- Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, an exact comma-separated
  `CORS_ALLOW_ORIGINS` list (HTTPS origins only, no trailing slash), Firebase
  Admin credentials, OpenAI/Sarvam keys, SMTP/OTP values, database URL, and all
  backend-only Razorpay secrets on the backend service.
- Configure the static site to serve `web/dist`, rewrite application routes to
  `index.html`, and reproduce the headers in `web/public/_headers` if the Render
  static-site configuration does not ingest that file automatically.
- Keep HSTS only on HTTPS production resources.
- Add a private scheduled job for stale reservations. The threshold must exceed
  the longest provider timeout:

  `python -m scripts.billing_maintenance stale-reservations --age-seconds 1800`

- Run Razorpay reconciliation in dry-run first, alert on its output, then enable
  the idempotent apply form only after operational review:

  `python -m scripts.billing_maintenance razorpay --age-seconds 900 [--apply]`

## Firebase and Razorpay

- Add the deployed web domain to Firebase Authentication authorized domains and
  verify email/password authentication and the backend Firebase Admin project
  refer to the same project.
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
