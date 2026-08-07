# Backend

## Local setup

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m pytest
```

Local `.env` defaults:

```bash
APP_ENV=development
AUTH_ALLOW_DEV_TOKENS=true
FIREBASE_CREDENTIALS_JSON=
GOOGLE_APPLICATION_CREDENTIALS=
DOWNLOAD_TOKEN_SECRET=
```

Email OTP signup and password reset use SMTP from the backend only:

```bash
EMAIL_USER=<smtp username>
EMAIL_PASS=<smtp password or app password>
EMAIL_FROM=<optional sender address>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USE_TLS=true
EMAIL_OTP_SECRET=<long random secret>
EMAIL_OTP_TTL_SECONDS=600
EMAIL_OTP_COOLDOWN_SECONDS=60
EMAIL_OTP_MAX_ATTEMPTS=5
EMAIL_OTP_DEV_RETURN_CODE=false
```

For Gmail or Google Workspace SMTP, `EMAIL_PASS` must be an app password or SMTP-specific password. Do not use the normal mailbox login password. If Google Workspace app passwords are disabled by admin policy, use another SMTP provider or enable an allowed SMTP method.

For Postgres URLs, use the SQLAlchemy psycopg 3 driver form:

```bash
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/DB_NAME
```

Run Alembic migrations before deployed startup. Runtime `create_all()` is only enabled by default for the local SQLite fallback.

## Render production auth

Use exactly one Firebase Admin credential method in production. The recommended
Render setup is a secret file named `firebase-admin.json`:

```bash
APP_ENV=production
AUTH_ALLOW_DEV_TOKENS=false
DOWNLOAD_TOKEN_SECRET=<long random secret>
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin.json
```

Remove `FIREBASE_CREDENTIALS_JSON` when using the secret-file method. As an
alternative, configure only the JSON environment variable:

```bash
APP_ENV=production
AUTH_ALLOW_DEV_TOKENS=false
DOWNLOAD_TOKEN_SECRET=<long random secret>
FIREBASE_CREDENTIALS_JSON=<Firebase Admin service account JSON>
```

Production startup rejects both methods configured together and rejects neither
method configured. Validation names variables only and never prints values or
credential paths.

Smoke test after deployment:

```bash
curl -i -H "Authorization: Bearer definitely-not-a-real-token" https://ai-tool-rrau.onrender.com/users/resolve
```

Expected result after Firebase Admin is configured: `401 Invalid auth token`. If it returns `503`, Firebase Admin is still not configured.

## Render OTP email setup checklist

Set these on the Render backend service, not in mobile or Expo config:

- `EMAIL_USER=<SMTP username/sender mailbox>`
- `EMAIL_PASS=<SMTP password or app password>`
- `EMAIL_FROM=<sender email, preferably the same as EMAIL_USER first>`
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_USE_TLS=true`
- `EMAIL_OTP_SECRET=<long random secret>`
- Confirm exactly one Firebase Admin method is configured. For the recommended
  Render secret file `firebase-admin.json`, set
  `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin.json` and remove
  `FIREBASE_CREDENTIALS_JSON`.
- Save and deploy/redeploy the backend after changing env values.

Do not wrap Render env values in accidental quotes unless the value truly requires them. Do not commit `.env` files.

Admin-only diagnostics:

```bash
curl -sS -H "x-admin-token: $DEBUG_ADMIN_TOKEN" \
  https://<render-backend>/api/admin/email/status

curl -sS -X POST -H "content-type: application/json" \
  -H "x-admin-token: $DEBUG_ADMIN_TOKEN" \
  -d '{"to_email":"admin@example.com"}' \
  https://<render-backend>/api/admin/email/send-test
```

The status response only returns safe metadata: booleans for whether each SMTP/OTP variable is set, masked sender fields, SMTP host/port/TLS, `from_matches_user`, and missing/invalid env names. It never returns `EMAIL_PASS`, `EMAIL_OTP_SECRET`, raw OTP codes, Firebase credentials, or full email bodies.

## Render billing maintenance

Run these as private Render Cron Jobs against the same PostgreSQL database. Each
financial Cron Job requires this explicit environment:

```bash
APP_ENV=production
DATABASE_URL=<Render PostgreSQL internal URL>
AUTO_CREATE_TABLES=false
RUN_MIGRATIONS_ON_STARTUP=false
REQUIRE_MIGRATIONS_BEFORE_STARTUP=false
```

The Razorpay reconciliation job additionally requires `RAZORPAY_MODE`,
`RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET`. It does not require Firebase,
OpenAI, Sarvam, SMTP, or the Razorpay webhook secret. Keep these variables in a
shared Render environment group where practical, and remove duplicate
service-level `DATABASE_URL` entries: Render service-level values override
environment-group values.

Use the repository-root commands below. The stale age must remain longer than
the longest configured provider timeout so an active generation is never
released:

```bash
cd backend && python -m scripts.billing_maintenance stale-reservations --age-seconds 1800
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900
cd backend && python -m scripts.billing_maintenance razorpay --age-seconds 900 --apply
```

Billing maintenance exits with configuration-error status `78` before creating
a database engine when `DATABASE_URL` is absent, blank, unsupported, or unsafe.
PostgreSQL is the normal requirement. SQLite is available only for explicit
local automation with `APP_ENV=test` or `APP_ENV=development` together with
`BILLING_MAINTENANCE_ALLOW_SQLITE=true`; production always rejects SQLite. The
safe startup record contains only the command, apply state where relevant,
database backend, `APP_ENV`, and Razorpay mode.

A financial Cron Job must never use SQLite, create tables, or run migrations.
The backend service's pre-deploy Alembic command is the sole production
migration owner. The Razorpay command is dry-run unless `--apply` is supplied;
never add `--apply` until the dry-run output has been reviewed. It reports
long-lived attempted orders and idempotently repairs captured-but-not-credited
orders and processed refunds. Duplicate webhook deliveries remain protected by
the processed-event and wallet-ledger idempotency keys. Review dry-run output
before enabling the apply job and alert on platform-absorbed usage overages.

Some upstream provider consumption can occur before a cancellation reaches the
provider. Swico settles reported or conservatively estimated partial usage; it
releases the full reservation only when no provider usage/output was observed.

## Generated-answer preservation invariants

Changes to generation, verification, repair, persistence, or streaming must
preserve these rules:

1. Telemetry, validation, and formatting are subordinate to answer delivery. A
   failure in one of those stages must downgrade or discard unsafe metadata,
   never destroy an answer that generation already produced. Enforcement lives
   in `app/web_ai/persistence.py::persist_answer_quality()` and the degraded
   finalize path in `app/web_api/chat_service.py::execute_web_turn()`. Regression
   coverage includes `test_unsafe_quality_observation_does_not_destroy_completed_answer` in
   `tests/test_web_chat_api.py`.
2. A repair may not make an answer worse. If the repaired answer fails more
   deterministic checks than the draft, keep the draft and record
   `repair_rejected_regression`. Enforcement is in the verified-generation
   repair callbacks in `app/web_api/chat_service.py::execute_web_turn()`;
   `test_destructive_architecture_repair_is_rejected` in
   `tests/test_web_triag_phase3.py` pins the behavior.
3. A client disconnect must not discard visible output already received from a
   provider. Persist the partial response as interrupted/unverified and release
   or settle its reservation from authoritative usage. Enforcement is in
   `app/web_api/chat_service.py::execute_web_turn()` and
   `app/web_api/router.py::chat_stream()`;
   `test_disconnected_buffered_turn_persists_partial_answer` in
   `tests/test_web_chat_api.py` pins persistence, lifecycle, and settlement.
