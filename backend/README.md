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

Set production auth explicitly on Render:

```bash
APP_ENV=production
AUTH_ALLOW_DEV_TOKENS=false
DOWNLOAD_TOKEN_SECRET=<long random secret>
FIREBASE_CREDENTIALS_JSON=<Firebase Admin service account JSON>
```

Or use a mounted secret file:

```bash
APP_ENV=production
AUTH_ALLOW_DEV_TOKENS=false
DOWNLOAD_TOKEN_SECRET=<long random secret>
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-admin.json
```

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
- Confirm `FIREBASE_CREDENTIALS_JSON` exists, unless using `GOOGLE_APPLICATION_CREDENTIALS`.
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

Run these as private Render cron jobs against the same database. The stale age
must remain longer than the longest configured provider timeout so an active
generation is never released:

```bash
python -m scripts.billing_maintenance stale-reservations --age-seconds 1800
python -m scripts.billing_maintenance razorpay --age-seconds 900
python -m scripts.billing_maintenance razorpay --age-seconds 900 --apply
```

The Razorpay command is dry-run unless `--apply` is supplied. It reports
long-lived attempted orders and idempotently repairs captured-but-not-credited
orders and processed refunds. Duplicate webhook deliveries remain protected by
the processed-event and wallet-ledger idempotency keys. Review dry-run output
before enabling the apply job and alert on platform-absorbed usage overages.

Some upstream provider consumption can occur before a cancellation reaches the
provider. Swico settles reported or conservatively estimated partial usage; it
releases the full reservation only when no provider usage/output was observed.
