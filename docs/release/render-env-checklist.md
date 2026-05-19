# Render Environment Checklist

## Required Environment Variables

- DATABASE_URL
- SARVAM_API_KEY
- OPENAI_API_KEY
- MODEL_CDN_URL
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- CORS_ALLOWED_ORIGINS

---

## Backend Validation

- Database connectivity verified
- Firebase Admin configuration verified
- Sarvam API access verified
- OpenAI fallback verified
- CDN connectivity verified
- Health endpoint verified

---

## Deployment Checklist

- Environment variables configured
- Production secrets added securely
- Render service connected
- Health checks enabled
- Auto deploy verified
- Rollback configuration verified

---

## Security Validation

- Secrets not exposed in logs
- CORS configured correctly
- Debug mode disabled
- Production endpoints verified
- HTTPS enforced

---

## Health Verification

Expected endpoints:

```bash
curl https://your-render-service.onrender.com/health
```

```bash
curl https://your-render-service.onrender.com/status
```