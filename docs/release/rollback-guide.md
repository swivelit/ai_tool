# Rollback Guide

## Rollback Conditions

Rollback must be performed if:

- Release build crashes
- Firebase validation fails
- Production environment variables are invalid
- Model downloads fail
- Critical API failures occur
- Inference execution fails

---

## Rollback Steps

### 1. Stop Current Release

- Stop APK distribution
- Disable production rollout
- Notify internal team

---

### 2. Restore Previous Stable Build

Run previous stable release build:

```bash
BUILD_TYPE=release ./build-apk.sh
```

---

### 3. Validate Rollback Build

- Verify application startup
- Verify Firebase connectivity
- Verify backend connectivity
- Verify model downloads
- Verify inference execution

---

### 4. Redeploy Stable Release

- Upload stable APK
- Update release notes
- Mark failed release as deprecated

---

## Rollback Validation

- Previous release artifacts available
- Release notes verified
- Production configuration verified
- Health checks passing
- No critical errors detected

---

## Production Notes

- Always keep previous stable build
- Never release unverified APKs
- Validate rollback before redeployment
- Document rollback reason in release notes