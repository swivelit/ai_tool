#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="com.swico.swivel"
APK_PATH="$ROOT_DIR/dist/tamil-ai-debug.apk"

cat <<'BANNER'
========================================
 Swico Android Debug APK Build
========================================
BANNER

cd "$ROOT_DIR"
BUILD_TYPE=debug BUILD_AAB=0 ./build-apk.sh

if [[ ! -s "$APK_PATH" ]]; then
  printf "ERROR: Debug APK was not created at %s\n" "$APK_PATH" >&2
  exit 1
fi

cat <<EOF

Debug APK build complete:
$APK_PATH

Install and launch:
  adb install -r "$APK_PATH"
  adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1
EOF
