# Environment Matrix

| Environment | Backend URL | Firebase | Model CDN | Build Type |
|---|---|---|---|---|
| Development | Dev Backend | Dev Firebase | Dev CDN | Debug |
| Staging | Staging Backend | Staging Firebase | Staging CDN | Release Candidate |
| Production | Production Backend | Production Firebase | Production CDN | Release |

---

## Required Environment Variables

### Mobile

- Firebase configuration
- Model CDN URL
- API endpoints
- Release flags

### Backend

- Database URL
- Sarvam API key
- CDN configuration
- Model metadata configuration

---

## Validation Rules

- Production builds must use production endpoints
- Debug builds must not use production secrets
- SHA-256 values must match Firebase configuration
- CDN URLs must be reachable
- GGUF metadata must match release artifacts

---

## Release Validation

Release builds fail when:

- Production configuration is missing
- SHA-256 validation fails
- Firebase configuration is invalid
- Model metadata validation fails
- CDN configuration validation fails