# Swico web production checklist

## Render

- Keep the existing manually configured backend and static-site resources; do
  not replace them with a Blueprint.
- Set `WEB_APP_ENABLED=true`, `APP_ENV=production`, an exact comma-separated
  `CORS_ALLOW_ORIGINS` list (HTTPS origins only, no trailing slash), Firebase
  Admin credentials, OpenAI/Sarvam keys, SMTP/OTP values, database URL, and all
  backend-only Razorpay secrets on the backend service.
- `CORS_ALLOW_ORIGINS` remains the HTTPS-only production website allow-list:
  `https://swico-web.onrender.com,https://swico.in,https://www.swico.in`.
  For local Vite frontend development against the hosted backend, add the
  separate loopback-only setting
  `CORS_ALLOW_LOCAL_DEV_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`.
  Never put HTTP localhost origins into `CORS_ALLOW_ORIGINS` or use wildcard
  CORS. Local frontend -> local backend development may continue using the
  existing local `CORS_ALLOW_ORIGINS` example.
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
- Set these backend-only Render values exactly for the reviewed package change:

  ```dotenv
  BILLING_TOPUP_PACKAGES_PAISE=1500,29900
  BILLING_ENFORCE_TOPUP_PACKAGES=false
  BILLING_MIN_TOPUP_PAISE=1500
  BILLING_MAX_TOPUP_PAISE=50000
  ```

  Values are paise (`1500` is ₹15; `29900` is ₹299). Custom whole-rupee amounts
  are accepted only inside the configured bounds and the backend remains
  authoritative. The frontend reads the maximum from public configuration.
  Changing the maximum requires deliberate operator review. Razorpay keys,
  mode, webhook URL/events, and webhook secrets do not change for this release.
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

- Schedule Razorpay reconciliation only in dry-run form and alert only on its
  high/actionable exit status:

  `cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 --summary-only --fail-on-findings`

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
  present. Never schedule `--apply`; staging uses Test Mode credentials and
  production live checkout/reconciliation uses Live Mode credentials with the
  production payment database. Never mix those modes or credentials.

- Verify the API and static site use the same explicit Git branch. Verify the
  static response headers in the dashboard because `_headers` was not applied
  by the audited Render deployment.
- Use `render.staging.yaml` only for the isolated **Swico Staging / Staging**
  project environment. Confirm it creates exactly `swico-api-staging`,
  `swico-web-staging`, and `swico-postgres-staging`, and never attach a
  production environment group. Provide all `sync:false` values in the initial
  Blueprint form and upload `firebase-admin-staging.json` only to the staging
  API secret files.
- A successful Render build does not prove a scheduled financial job ran.
  Manually select **Trigger Run** for each staging financial job, inspect its
  safe output and exit status, and retain evidence for stale reservations,
  reconciliation dry-run, and financial audit.

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
  `razorpay_mode`, `checkout_enabled`, `custom_topup_enabled=true`, bounds, and
  exactly the 1,500/29,900-paise presets; never derive mode in the browser from
  the public-key prefix.

## Razorpay Live two-phase cutover

Before either phase, run `python scripts/check-razorpay-live-readiness.py`; the legal publication and all other repository checks must pass. An authorized operator can run `python scripts/check-razorpay-live-readiness.py --validate-environment` without printing secrets.

Phase one: use the Live key ID, Live key secret, and a separate Live webhook secret; set `RAZORPAY_MODE=live` and keep `BILLING_CHECKOUT_ENABLED=false`; deploy and verify; run Razorpay reconciliation and the financial audit. Test and Live credentials and webhooks are separate.

Phase two: set `BILLING_CHECKOUT_ENABLED=true` and deploy separately; make one controlled ₹15 payment; verify exactly-once credit and webhook replay idempotency; run reconciliation and audit. Disable checkout immediately on any mismatch.

## Legal publication

The revised policy pages in `web/src/content/legalContent.json` are proposed
content and remain blocked until exact owner/counsel-approved replacement
wording and a matching canonical SHA-256 approval record are supplied. Do not
deploy this code or change approval metadata, versions, or effective dates
speculatively. The checker does not provide legal advice or certify legal
compliance.

Raw PDFs, DOCX files, counsel correspondence, signatures, private identity
material and any future private review evidence must remain under the ignored
`private/legal-source/` directory. Razorpay Live Mode and
`BILLING_CHECKOUT_ENABLED=true` remain separate operational decisions and must
stay disabled until the Live-readiness and operational evidence below are
complete.

## Release order and rollback

1. Back up PostgreSQL and record the deployed commit and Alembic revision.
2. Deploy the API first and run through additive revision `a7c4e9d2f1b6`; keep checkout disabled.
3. Smoke `bootstrap`, profile, usage settings/summary, existing-credit chat, and billing public config.
4. Deploy the static site only after the API contract is live. Re-test desktop/mobile Settings and Test Mode checkout in staging.
5. Fix forward for application issues. The new tables contain settings/lock rows only, but a database downgrade is still not the routine rollback path. Roll the API/static images back while leaving additive tables and financial history intact.
6. If payment risk is detected, set `BILLING_CHECKOUT_ENABLED=false` on the API and redeploy. This stops new orders without disabling existing-credit usage; reconcile existing orders before any further change.

This release adds only the nullable `UsageCharge.billing_exemption_reason` audit column. Deploy and migrate the API first, confirm its health and additive contracts, then deploy the static site and run the production-readonly workflow.

An old local `created` order means checkout was opened but payment was not established, so the audit reports it as informational/non-actionable. `attempted` is warning/non-actionable until Razorpay reconciliation checks provider state. Verified captured-but-uncredited and credited-without-ledger states are high/actionable. Clean, informational-only, and warning-only reports exit `0`; `--fail-on-findings` exits `3` only for high/actionable results. The database audit never calls Razorpay, so the separate dry-run reconciliation remains required.

Payment history now labels unfinished checkouts truthfully: **Checkout not completed** for `created`, confirmation pending for `attempted`, token confirmation pending for captured/uncredited, and **Payment completed** only when the append-only payment-credit ledger entry exists. Refund labels show actual rupee amounts; no cash-like token-credit balance is introduced.

For a targeted dry-run investigation use:

```bash
cd backend && python -m scripts.billing_maintenance razorpay \
  --internal-order-id <uuid> \
  --age-seconds 900 \
  --fail-on-findings
```

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

These gates are separate from the normal local build. The legal publication
checker is expected to fail specifically on the three stale approved pricing
references until approved replacements exist:

```bash
python scripts/check-legal-publication.py
python scripts/check-legal-source-readiness.py \
  --source-dir private/legal-source
python scripts/check-web-product-language.py
python scripts/check-tracked-secrets.py
```

The publication failure is an intentional release blocker. The source-readiness
command evaluates structure only; even a future pass is not a claim of legal
approval. Razorpay remains in Test Mode and checkout remains disabled. After
exact approved content and matching approval metadata arrive, rerun every gate
before applying the documented backend Render amount changes or deploying the
static site.

Run deployed staging tests only with a real non-local HTTPS domain and dedicated
Firebase test account:

```bash
cd web
PLAYWRIGHT_MODE=staging PLAYWRIGHT_BASE_URL=https://<staging-web-domain> \
E2E_TEST_EMAIL=<dedicated-test-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-smoke.spec.ts \
  --project=chromium --project=mobile-chromium
```

Production verification is read-only:

```bash
cd web
PLAYWRIGHT_MODE=production-readonly PLAYWRIGHT_BASE_URL=https://<production-web-domain> \
E2E_TEST_EMAIL=<dedicated-readonly-account> E2E_TEST_PASSWORD=<secret> \
npx playwright test e2e/deployed-readonly.spec.ts \
  --project=chromium --project=mobile-chromium
```

Do not report deployed tests as passed unless a command actually ran against
the named HTTPS domain. Neither deployed suite completes a Razorpay payment.

For the manual workflow, create GitHub Environments named exactly `staging` and
`production-readonly`. Add only `PLAYWRIGHT_BASE_URL`, `E2E_TEST_EMAIL`, and
`E2E_TEST_PASSWORD` as Environment secrets in each. Add the staging hostname to
Firebase Authentication Authorized Domains, create a dedicated staging Firebase
email/password account, and fund it once through a supervised Razorpay Test Mode
transaction after staging Test Mode is verified. Playwright must never automate
that payment.

Open **Actions → Deployed web smoke → Run workflow**, choose the matching mode,
and retain the run URL, commit SHA, timestamp, and desktop/mobile result. The
workflow serializes runs that share an environment account, checks headers first,
and keeps reports/traces as private failure-only artifacts. Local mocked results
are not deployed results.

Operational ownership is complete only when the private record passes locally:

```bash
python scripts/check-ops-readiness.py --file private/ops-ownership.json
```

The completed file stays private and is never uploaded to CI. Owner-attested
legal publication does not authorize Razorpay Live Mode; production
`BILLING_CHECKOUT_ENABLED=false` remains mandatory until the separate cutover.

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
