#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APK_PATH="$DIST_DIR/tamil-ai-release.apk"
PACKAGE_NAME="com.harishajahan.tamilai"

info() {
  printf "\n▶ %s\n" "$1"
}

warn() {
  printf "\n⚠️  %s\n" "$1"
}

fail() {
  printf "\n❌ %s\n" "$1"
  exit 1
}

command -v adb >/dev/null 2>&1 || fail "adb is required but was not found in PATH."

cd "$ROOT_DIR"

info "Cleaning old installed APK"
adb uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true

info "Building release APK"
BUILD_TYPE=release ./build-apk.sh

[[ -f "$APK_PATH" ]] || fail "Release APK not found at $APK_PATH"

info "Installing release APK"
adb install -r "$APK_PATH"

info "Launching app"
adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
  || warn "APK installed, but automatic launch failed. Open it manually on the device."

echo ""
echo "Done."
echo "Installed: $APK_PATH"
