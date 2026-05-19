# Versioning Convention

## App Version Format

Use semantic versioning format:

```text
MAJOR.MINOR.PATCH
```

Example:

```text
1.0.0
1.1.0
1.1.1
```

---

## Version Rules

### MAJOR

Increase MAJOR version when:

- Breaking changes are introduced
- Large architecture changes happen
- Old versions become incompatible

Example:

```text
1.x.x → 2.0.0
```

---

### MINOR

Increase MINOR version when:

- New features are added
- Existing functionality is improved
- Backward compatibility is maintained

Example:

```text
1.0.0 → 1.1.0
```

---

### PATCH

Increase PATCH version when:

- Bugs are fixed
- Small production fixes are released
- No major functionality changes occur

Example:

```text
1.1.0 → 1.1.1
```

---

## Backend Versioning

Example:

```text
backend-v1.0.0
```

---

## Model Configuration Versioning

Example:

```text
gemma-4b-v1
qwen3-8b-v2
```

---

## Seed Data Versioning

Example:

```text
seed-data-2026-05
```

---

## Production Notes

- Every production release must have a unique version
- Release notes must match the released version
- Rollback builds must reference previous stable versions
- Version numbers must be updated before production release