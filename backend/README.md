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

For Gmail, `EMAIL_PASS` must be a Gmail app password. Do not use your normal Google account password.

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
