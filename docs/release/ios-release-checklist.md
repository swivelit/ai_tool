# iOS Release Checklist

## Pre-Release Validation

- Verify production environment variables
- Verify Firebase iOS configuration
- Verify signing certificates
- Verify provisioning profiles
- Verify model CDN URLs
- Verify release configuration
- Verify Expo/EAS configuration

---

## Build Validation

- EAS build configuration verified
- Production configuration validated
- Firebase validation passes
- Model configuration validation passes
- Release build generated successfully

---

## Application Testing

- Install build on physical iPhone
- Verify application startup
- Verify Firebase connectivity
- Verify model downloads
- Verify inference execution
- Verify offline support
- Verify crash-free startup

---

## Security Checklist

- No secrets committed into git
- Signing certificates stored securely
- Production endpoints verified
- Debug features disabled
- Environment variables validated

---

## Release Approval

- QA approval completed
- Security review completed
- Performance validation completed
- Rollback plan verified
- Release notes prepared