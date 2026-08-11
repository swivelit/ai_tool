#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The Android application ID changed; the legacy custom scheme remains for
# existing deep-link compatibility and is intentionally independent of it.
PACKAGE_NAME="com.swico.swivel"
APK_PATH="${APK_PATH:-$ROOT_DIR/dist/tamil-ai-debug.apk}"
# Preserve the existing external/deep-link contract independently of the
# Android application ID migration.
DEEP_LINK_URL="${DEEP_LINK_URL:-com.swico.tamilai://}"

info() {
  printf "\n▶ %s\n" "$1"
}

skip() {
  printf "SKIP: %s\n" "$1"
  exit 2
}

fail() {
  printf "ERROR: %s\n" "$1" >&2
  exit 1
}

cat <<'BANNER'
========================================
 Swico Android Scheme Deep-Link Smoke Test
========================================
BANNER

cat <<EOF
Swico does not currently declare verified Android App Links in app.config.ts.
This script only checks the Swico custom scheme handled by the installed app:
  $DEEP_LINK_URL
EOF

command -v adb >/dev/null 2>&1 || skip "adb was not found in PATH."

if ! adb get-state >/dev/null 2>&1; then
  adb devices -l || true
  skip "No Android device/emulator detected. Connect one, then rerun: ./scripts/test-android-app-links.sh"
fi

if ! adb shell pm path "$PACKAGE_NAME" >/dev/null 2>&1; then
  [[ -s "$APK_PATH" ]] || skip "Swico is not installed and APK was not found at $APK_PATH. Build it with: BUILD_TYPE=debug ./build-apk.sh"
  info "Installing Swico debug APK"
  adb install -r "$APK_PATH"
fi

info "Starting Swico through its custom scheme"
start_output="$(
  adb shell am start -W \
    -a android.intent.action.VIEW \
    -c android.intent.category.BROWSABLE \
    -d "$DEEP_LINK_URL" \
    "$PACKAGE_NAME" 2>&1 | tr -d '\r'
)"
printf "%s\n" "$start_output"

if grep -E "Error|Exception|unable|not found|does not exist" <<< "$start_output" >/dev/null 2>&1; then
  fail "Android could not route the Swico scheme to $PACKAGE_NAME."
fi

sleep 2
if ! adb shell pidof "$PACKAGE_NAME" >/dev/null 2>&1; then
  fail "Deep-link launch command returned, but $PACKAGE_NAME is not running."
fi

info "Swico scheme deep-link smoke test passed"
