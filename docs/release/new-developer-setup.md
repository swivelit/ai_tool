# New Developer Setup Guide

## Clone Repository

```bash
git clone <repository-url>
```

```bash
cd ai_tool
```

---

## Install Requirements

Required software:

- Node.js
- Python 3.11+
- Android Studio
- Android SDK
- Java JDK 17
- Git
- Expo CLI
- EAS CLI

---

## Install Mobile Dependencies

```bash
cd mobile
```

```bash
npm install
```

---

## Install Backend Dependencies

```bash
cd backend
```

```bash
pip install -r requirements.txt
```

---

## Configure Environment Variables

Copy environment example files:

```bash
cp mobile/.env.example mobile/.env
```

```bash
cp backend/.env.example backend/.env
```

Required configuration includes:

- Firebase configuration
- Model CDN URLs
- SHA-256 values
- Sarvam API key
- Database URL

---

## Run Debug APK

```bash
./launch-debug_apk.sh
```

---

## Run Release APK

```bash
BUILD_TYPE=release ./build-apk.sh
```

```bash
./launch-release_apk.sh
```

---

## Backend Startup

```bash
cd backend
```

```bash
python start_render.py
```

---

## Validation Checklist

- Debug APK launches successfully
- Release APK builds successfully
- Backend health endpoint works
- Firebase configuration works
- Environment variables are configured
- No secrets are committed into git

---

## Production Notes

- Release builds fail if critical configuration is missing
- Never commit secrets into the repository
- Always validate release builds before production deployment 