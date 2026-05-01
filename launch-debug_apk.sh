#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
DIST_DIR="$ROOT_DIR/dist"
APK_PATH="$DIST_DIR/tamil-ai-debug.apk"
PACKAGE_NAME="com.harishajahan.tamilai"
METRO_PORT="${METRO_PORT:-8081}"
METRO_LOG="/tmp/tamil-ai-metro-${METRO_PORT}.log"
METRO_PID_FILE="/tmp/tamil-ai-metro-${METRO_PORT}.pid"

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

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

ANDROID_ABI_UTILS="$ROOT_DIR/scripts/android-abi-utils.sh"
[[ -f "$ANDROID_ABI_UTILS" ]] || fail "Android ABI helper not found at: $ANDROID_ABI_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_ABI_UTILS"

ANDROID_16KB_UTILS="$ROOT_DIR/scripts/android-16kb-utils.sh"
[[ -f "$ANDROID_16KB_UTILS" ]] || fail "Android 16 KB validation helper not found at: $ANDROID_16KB_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_16KB_UTILS"

metro_running() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS "http://127.0.0.1:${METRO_PORT}/status" 2>/dev/null | grep -q "packager-status:running"
}

stop_old_metro() {
  info "Stopping old Metro process on port ${METRO_PORT}"

  if [[ -f "$METRO_PID_FILE" ]]; then
    old_pid="$(cat "$METRO_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_pid:-}" ]]; then
      kill "$old_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$METRO_PID_FILE"
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${METRO_PORT}" | xargs kill >/dev/null 2>&1 || true
  fi

  sleep 2
}

start_metro() {
  info "Starting Metro on port ${METRO_PORT}"
  : > "$METRO_LOG"

  cd "$MOBILE_DIR"

  nohup env EXPO_NO_TELEMETRY=1 \
    npx expo start --dev-client --host lan --port "$METRO_PORT" --clear \
    > "$METRO_LOG" 2>&1 &

  echo "$!" > "$METRO_PID_FILE"

  cd "$ROOT_DIR"
}

wait_for_metro() {
  info "Waiting for Metro"

  if ! command -v curl >/dev/null 2>&1; then
    sleep 12
    return 0
  fi

  for _ in {1..90}; do
    if metro_running; then
      info "Metro is running"
      return 0
    fi
    sleep 1
  done

  echo ""
  echo "Metro log:"
  tail -80 "$METRO_LOG" || true
  fail "Metro did not start on port ${METRO_PORT}"
}

open_logs_terminal() {
  info "Opening Android debug logs"

  if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! osascript <<EOF
tell application "Terminal"
  do script "cd '$ROOT_DIR'; adb logcat -c; $LOG_CMD"
  activate
end tell
EOF
    then
      warn "Could not open a Terminal logcat window automatically."
      echo ""
      echo "Run this in another terminal for logs:"
      echo "  adb logcat -c"
      echo "  $LOG_CMD"
    fi
  else
    echo ""
    echo "Run this in another terminal for logs:"
    echo "  adb logcat -c"
    echo "  $LOG_CMD"
  fi
}

command -v adb >/dev/null 2>&1 || fail "adb is required but was not found in PATH."
command -v node >/dev/null 2>&1 || fail "Node.js is required but was not found in PATH."
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found in PATH."

[[ -d "$MOBILE_DIR" ]] || fail "Mobile folder not found at: $MOBILE_DIR"

ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$ANDROID_SDK" ]]; then
  for candidate in \
    "$HOME/Library/Android/sdk" \
    "$HOME/Android/Sdk" \
    "/Users/$USER/Library/Android/sdk"
  do
    if [[ -d "$candidate" ]]; then
      ANDROID_SDK="$candidate"
      break
    fi
  done
fi

cd "$ROOT_DIR"

info "Checking Android device/emulator"
adb get-state >/dev/null 2>&1 || fail "No Android device/emulator detected. Run: adb devices"

DEVICE_PAGE_SIZE="$(adb shell getconf PAGE_SIZE 2>/dev/null | tr -d '\r' | tr -d '[:space:]' || true)"
DEVICE_REQUIRES_16KB_APK=0
if [[ "$DEVICE_PAGE_SIZE" == "16384" ]]; then
  DEVICE_REQUIRES_16KB_APK=1
  info "16 KB page-size emulator detected; APK must pass 16 KB native library validation."
elif [[ -n "$DEVICE_PAGE_SIZE" ]]; then
  info "Android target page size: $DEVICE_PAGE_SIZE"
else
  warn "Could not read Android target page size with: adb shell getconf PAGE_SIZE"
fi

DEVICE_ANDROID_ABILIST="$(jai_android_read_device_abilist)" \
  || fail "Could not read connected Android device ABI list with adb."
ANDROID_ABIS_EXPLICIT_VALUE="${JAI_ANDROID_ABIS:-${ANDROID_ABIS:-}}"

if [[ -n "${ANDROID_ABIS_EXPLICIT_VALUE//[[:space:]]/}" ]]; then
  SELECTED_ANDROID_ABIS="$(jai_android_normalize_abi_list "$ANDROID_ABIS_EXPLICIT_VALUE")" \
    || fail "Invalid JAI_ANDROID_ABIS/ANDROID_ABIS value: $ANDROID_ABIS_EXPLICIT_VALUE"
  jai_android_abi_lists_intersect "$SELECTED_ANDROID_ABIS" "$DEVICE_ANDROID_ABILIST" \
    || fail "Connected Android target reports ABI list '$DEVICE_ANDROID_ABILIST', but JAI_ANDROID_ABIS is '$SELECTED_ANDROID_ABIS'. Choose a matching ABI."
else
  SELECTED_ANDROID_ABIS="$(jai_android_choose_supported_device_abi "$DEVICE_ANDROID_ABILIST")" \
    || fail "Connected Android target reports ABI list '$DEVICE_ANDROID_ABILIST', but this debug build supports only: $JAI_ANDROID_SUPPORTED_ABIS_CSV. Use an ARM64/x86_64 target or set JAI_ANDROID_ABIS explicitly."
fi

export JAI_ANDROID_ABIS="$SELECTED_ANDROID_ABIS"
info "Android target ABIs: $DEVICE_ANDROID_ABILIST"
info "Debug APK ABIs: $JAI_ANDROID_ABIS"

if jai_android_abi_list_contains "x86_64" "$SELECTED_ANDROID_ABIS" && ! is_truthy "${JAI_DEBUG_FULL_NATIVE:-}"; then
  export JAI_DEBUG_LITE="1"
  info "x86_64 emulator detected; enabling JAI_DEBUG_LITE=1. Set JAI_DEBUG_FULL_NATIVE=1 to test the full native runtime."
fi

info "Building debug APK first"
BUILD_TYPE=debug ./build-apk.sh

[[ -f "$APK_PATH" ]] || fail "Debug APK not found at $APK_PATH"

if [[ "$DEVICE_REQUIRES_16KB_APK" == "1" ]]; then
  info "Validating debug APK before install"
  if ! jai_android_validate_apk_16kb_or_allow_debug_skip "$APK_PATH" "debug" "$ANDROID_SDK"; then
    fail "16 KB page-size emulator requires a 16 KB-compatible APK. Stopping before install."
  fi
fi

info "Cleaning old installed APK"
adb uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true

info "Installing debug APK"
adb install -r "$APK_PATH"

stop_old_metro
start_metro
wait_for_metro

info "Forwarding device port ${METRO_PORT} to Metro"
adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" >/dev/null 2>&1 || true

open_logs_terminal

info "Launching app"
adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
  || warn "APK installed, but automatic launch failed. Open it manually."

echo ""
echo "Done."
echo "Installed: $APK_PATH"
echo "Metro log: $METRO_LOG"
echo ""
echo "Keep Metro running while using this debug APK."
echo "For a standalone APK, run: ./launch-release_apk.sh"
