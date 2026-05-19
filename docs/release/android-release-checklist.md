# Android Release Checklist

## Pre-Release Validation

- Verify production environment variables
- Verify Firebase configuration
- Verify SHA-256 fingerprints
- Verify model CDN URLs
- Verify GGUF metadata and byte sizes
- Verify release signing configuration
- Verify llama.cpp native binaries
- Verify EAS configuration

---

## Build Validation

Run release build:

```bash
BUILD_TYPE=release ./build-apk.sh
```

Expected validation checks:

- Environment validation passes
- Native llama.cpp validation passes
- Firebase validation passes
- Model configuration validation passes
- APK generated successfully

---

## APK Testing

- Install APK on physical Android device
- Verify application startup
- Verify model downloads
- Verify inference execution
- Verify Firebase connectivity
- Verify offline functionality
- Verify crash-free startup

---

## Security Checklist

- No secrets committed into git
- Release keys stored securely
- Production endpoints verified
- Debug logs disabled
- Environment variables validated

---

## Release Approval

- QA approval completed
- Performance validation completed
- Security review completed
- Rollback plan verified
- Release notes prepared