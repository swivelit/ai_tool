#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
DIST_DIR="$ROOT_DIR/dist"
APK_PATH="$DIST_DIR/tamil-ai-debug.apk"
PACKAGE_NAME="com.harishajahan.tamilai"
METRO_PORT="${METRO_PORT:-8081}"

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

metro_running() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS "http://127.0.0.1:${METRO_PORT}/status" 2>/dev/null | grep -q "packager-status:running"
}

open_metro_terminal() {
  info "Starting Metro bundler on port ${METRO_PORT}"

  if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript <<EOF
tell application "Terminal"
  do script "cd '$MOBILE_DIR'; EXPO_NO_TELEMETRY=1 npx expo start --dev-client --host localhost --port ${METRO_PORT} --clear"
  activate
end tell
EOF

  elif command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- bash -lc "cd '$MOBILE_DIR'; EXPO_NO_TELEMETRY=1 npx expo start --dev-client --host localhost --port ${METRO_PORT} --clear; exec bash"

  elif command -v konsole >/dev/null 2>&1; then
    konsole --noclose -e bash -lc "cd '$MOBILE_DIR'; EXPO_NO_TELEMETRY=1 npx expo start --dev-client --host localhost --port ${METRO_PORT} --clear"

  elif command -v xterm >/dev/null 2>&1; then
    xterm -hold -e "cd '$MOBILE_DIR'; EXPO_NO_TELEMETRY=1 npx expo start --dev-client --host localhost --port ${METRO_PORT} --clear"

  else
    warn "Could not open Metro automatically."
    echo "Run this manually in another terminal:"
    echo "  cd '$MOBILE_DIR'"
    echo "  npx expo start --dev-client --host localhost --port ${METRO_PORT} --clear"
  fi
}

wait_for_metro() {
  command -v curl >/dev/null 2>&1 || {
    sleep 8
    return 0
  }

  for _ in {1..60}; do
    if metro_running; then
      info "Metro is running"
      return 0
    fi
    sleep 1
  done

  warn "Metro did not answer on port ${METRO_PORT}. The app may still show the red bundle screen."
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
    warn "Could not open a new logs terminal automatically."
    echo "Run this manually in another terminal:"
    echo "  adb logcat -c"
    echo "  $LOG_CMD"
  fi
}

command -v adb >/dev/null 2>&1 || fail "adb is required but was not found in PATH."
command -v node >/dev/null 2>&1 || fail "Node.js is required but was not found in PATH."
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found in PATH."

[[ -d "$MOBILE_DIR" ]] || fail "Mobile folder not found at: $MOBILE_DIR"

cd "$ROOT_DIR"

info "Checking connected Android device"
adb get-state >/dev/null 2>&1 || fail "No Android device/emulator detected. Run: adb devices"

if metro_running; then
  info "Metro is already running on port ${METRO_PORT}"
else
  open_metro_terminal
  wait_for_metro
fi

info "Forwarding Android device port ${METRO_PORT} to laptop Metro"
adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" >/dev/null 2>&1 \
  || warn "adb reverse failed. This is OK for emulator, but physical USB devices need it."

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
echo ""
echo "Important:"
echo "- Keep the Metro terminal open while using the debug APK."
echo "- For a standalone APK that works without Metro/laptop, run: ./launch-release_apk.sh"