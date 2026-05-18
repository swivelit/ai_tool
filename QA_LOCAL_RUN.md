# Tamil AI: Local QA Automation Guide

This guide provides instructions for QA guide to execute the regression suite on local machines. 

## 📋 Prerequisites

### 1. Hardware & OS
- **Windows** (with PowerShell/Bash) or **macOS/Linux**.
- Physical Android device or Emulator (API 30+ recommended).

### 2. Software Setup
- **Node.js v20+** and **npm**.
- **Android SDK** (ensure `adb` is in your PATH).
- **Git Bash** (if on Windows).
- **Python 3.10+** (for backend evals).

---

## 🚀 Getting Started

### 1. Environment Configuration
Create a `.env` in the `mobile/` directory with:
```bash
EXPO_PUBLIC_E2E_MOCK_AUTH=1
EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP=1
```

### 2. Device Preparation
- Enable **USB Debugging** on your device.
- Connect via USB or `adb connect`.
- Verify connection:
  ```bash
  adb devices
  ```

---

## 🛠️ Running the Tests

### 1. Full Regression Suite
The most common way to run the full E2E flow and golden evaluations:
```bash
./test_apk.sh
```

### 2. Targeted Evaluations (Task 8)
If you only need to verify AI logic without building an APK:
```bash
# Run everything
./scripts/run_golden_eval.sh all

# Run only Mobile Assistant evals
./scripts/run_golden_eval.sh mobile

# Run only Backend safety/health evals
./scripts/run_golden_eval.sh backend
```

---

## 📦 Artifacts & Review

After a run finishes, artifacts are stored in:
`dist/apk-test-YYYYMMDD-HHMMSS/`

### Key Artifacts:
- **`summary.txt`**: The "Executive Dashboard" showing PASS/FAIL and performance.
- **`logcat-full.log`**: Complete device logs for debugging crashes.
- **`screen-*.png`**: Screenshots taken at every critical step.
- **`artifacts-*.zip`**: Packaged bundle for CI/CD attachment.

---

## 🔍 Troubleshooting

### 1. "Chat input not found after launch"
- **Cause:** Metro bundler failed to serve the app or device lost connection.
- **Fix:** Restart the script. The `retry_command` logic should handle minor flakiness.

### 2. "ADB: Device unauthorized"
- **Fix:** Check your phone screen and allow the USB debugging prompt.

### 3. Missing Golden Evals
- **Fix:** Ensure you have run `npm install` in the `mobile/` and `backend/` directories.

---

## ✅ Pre-Release Checklist

Before every release build, ensure:
- [ ] `./scripts/run_golden_eval.sh all` passes 100%.
- [ ] `./test_apk.sh` verdict is **PASS (READY FOR RELEASE)**.
- [ ] Performance timings are within thresholds (3s for first response).
- [ ] `crash-markers.log` is empty.

---