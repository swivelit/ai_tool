#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APK_PATH="$DIST_DIR/tamil-ai-debug.apk"
PACKAGE_NAME="com.harishajahan.tamilai"

LOG_CMD="adb logcat | grep --line-buffered -E 'ReactNativeJS|AndroidRuntime|FATAL EXCEPTION|Expo|tamilai|harishajahan|${PACKAGE_NAME}'"

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

open_logs_terminal() {
  info "Opening debug logs in a new terminal"

  if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript <<EOF
tell application "Terminal"
  do script "cd '$ROOT_DIR'; adb logcat -c; $LOG_CMD"
  activate
end tell
EOF

  elif command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- bash -lc "cd '$ROOT_DIR'; adb logcat -c; $LOG_CMD; exec bash"

  elif command -v konsole >/dev/null 2>&1; then
    konsole --noclose -e bash -lc "cd '$ROOT_DIR'; adb logcat -c; $LOG_CMD"

  elif command -v xterm >/dev/null 2>&1; then
    xterm -hold -e "cd '$ROOT_DIR'; adb logcat -c; $LOG_CMD"

  else
    warn "Could not open a new terminal automatically."
    echo ""
    echo "Run this manually in another terminal:"
    echo "  adb logcat -c"
    echo "  $LOG_CMD"
  fi
}

command -v adb >/dev/null 2>&1 || fail "adb is required but was not found in PATH."

cd "$ROOT_DIR"

info "Checking connected Android device"
adb get-state >/dev/null 2>&1 || fail "No Android device/emulator detected. Run: adb devices"

info "Cleaning old installed APK"
adb uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true

info "Building debug APK"
BUILD_TYPE=debug ./build-apk.sh

[[ -f "$APK_PATH" ]] || fail "Debug APK not found at $APK_PATH"

info "Installing debug APK"
adb install -r "$APK_PATH"

open_logs_terminal

info "Launching app"
adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
  || warn "APK installed, but automatic launch failed. Open it manually on the device."

echo ""
echo "Done."
echo "Installed: $APK_PATH"