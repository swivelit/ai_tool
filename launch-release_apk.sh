#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="com.swico.swivel"
MAIN_ACTIVITY="$PACKAGE_NAME/.MainActivity"
APK_PATH="$DIST_DIR/tamil-ai-release.apk"
SMOKE_DIR="$DIST_DIR/release-smoke-$(date +%Y%m%d-%H%M%S)"

info() {
  printf "\n▶ %s\n" "$1"
}

warn() {
  printf "\n⚠️  %s\n" "$1" >&2
}

fail() {
  printf "\n❌ %s\n" "$1" >&2
  printf "Diagnostics: %s\n" "$SMOKE_DIR" >&2
  exit 1
}

command -v adb >/dev/null 2>&1 || fail "adb is required but was not found in PATH."

ANDROID_ABI_UTILS="$ROOT_DIR/scripts/android-abi-utils.sh"
[[ -f "$ANDROID_ABI_UTILS" ]] || fail "Android ABI helper not found: $ANDROID_ABI_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_ABI_UTILS"

ANDROID_16KB_UTILS="$ROOT_DIR/scripts/android-16kb-utils.sh"
[[ -f "$ANDROID_16KB_UTILS" ]] || fail "Android 16 KB validation helper not found: $ANDROID_16KB_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_16KB_UTILS"

SIGNING_UTILS="$ROOT_DIR/scripts/android-release-signing.sh"
[[ -f "$SIGNING_UTILS" ]] || fail "Android release signing helper not found: $SIGNING_UTILS"
# shellcheck disable=SC1090
source "$SIGNING_UTILS"

mkdir -p "$SMOKE_DIR"

ensure_device() {
  adb get-state >/dev/null 2>&1 || fail "No connected Android device/emulator is available."
  local boot_completed
  boot_completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | tr -d '[:space:]' || true)"
  [[ "$boot_completed" == "1" ]] || fail "Connected Android target is not fully booted (sys.boot_completed=$boot_completed)."
}

capture_device_details() {
  local model api abi page_size size density
  model="$(adb shell getprop ro.product.model | tr -d '\r')"
  api="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  abi="$(jai_android_read_device_abilist)"
  page_size="$(adb shell getconf PAGESIZE | tr -d '\r')"
  size="$(adb shell wm size | tr -d '\r')"
  density="$(adb shell wm density | tr -d '\r')"

  {
    printf "model=%s\n" "$model"
    printf "api=%s\n" "$api"
    printf "abi_list=%s\n" "$abi"
    printf "page_size=%s\n" "$page_size"
    printf "screen_size=%s\n" "$size"
    printf "density=%s\n" "$density"
  } | tee "$SMOKE_DIR/device.txt"

  DEVICE_ABILIST="$abi"
  QA_ABI="$(jai_android_choose_supported_device_abi "$DEVICE_ABILIST")" \
    || fail "Connected target ABI list '$DEVICE_ABILIST' is unsupported."
  printf "qa_abi=%s\n" "$QA_ABI" | tee -a "$SMOKE_DIR/device.txt"
}

capture_system_state() {
  adb shell dumpsys activity activities > "$SMOKE_DIR/activity.txt" 2>&1 || true
  adb shell dumpsys package "$PACKAGE_NAME" > "$SMOKE_DIR/package.txt" 2>&1 || true
  adb shell dumpsys meminfo "$PACKAGE_NAME" > "$SMOKE_DIR/meminfo.txt" 2>&1 || true
  adb exec-out screencap -p > "$SMOKE_DIR/screenshot.png" 2>"$SMOKE_DIR/screenshot.err" || true
  adb shell uiautomator dump /sdcard/swico-release-smoke-ui.xml > "$SMOKE_DIR/uiautomator-command.log" 2>&1 || true
  adb pull /sdcard/swico-release-smoke-ui.xml "$SMOKE_DIR/uiautomator.xml" > "$SMOKE_DIR/uiautomator-pull.log" 2>&1 || true
}

ensure_device
capture_device_details

info "Building release APK for connected QA ABI: $QA_ABI"
(
  cd "$ROOT_DIR"
  JAI_ANDROID_ABIS="$QA_ABI" BUILD_TYPE=release ./build-apk.sh
) > "$SMOKE_DIR/build.log" 2>&1 || {
  tail -100 "$SMOKE_DIR/build.log" >&2 || true
  fail "Release APK build failed."
}

[[ -s "$APK_PATH" ]] || fail "Release APK not found at $APK_PATH"
printf "apk=%s\n" "$APK_PATH" | tee "$SMOKE_DIR/artifact.txt"

info "Uninstalling previous package"
adb uninstall "$PACKAGE_NAME" > "$SMOKE_DIR/uninstall.log" 2>&1 || true

info "Installing exact release APK"
if ! adb install "$APK_PATH" > "$SMOKE_DIR/install.log" 2>&1; then
  cat "$SMOKE_DIR/install.log" >&2 || true
  fail "Release APK installation failed."
fi

info "Clearing logcat and launching standalone MainActivity"
if ! adb logcat -c > "$SMOKE_DIR/logcat-clear.log" 2>&1; then
  warn "adb logcat could not clear its buffers; continuing with a recorded warning."
fi
if ! adb shell am start -W -n "$MAIN_ACTIVITY" > "$SMOKE_DIR/start.log" 2>&1; then
  fail "MainActivity launch command failed."
fi

survived=0
process_lost=0
saw_pid=0
first_pid=""
last_pid=""
: > "$SMOKE_DIR/pid-survival.log"
for second in $(seq 1 30); do
  pid="$(adb shell pidof "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' | tr -d '[:space:]' || true)"
  printf "%02d pid=%s\n" "$second" "$pid" >> "$SMOKE_DIR/pid-survival.log"
  if [[ -n "$pid" ]]; then
    saw_pid=1
    last_pid="$pid"
    [[ -n "$first_pid" ]] || first_pid="$pid"
  elif [[ "$saw_pid" == "1" ]]; then
    process_lost=1
  fi
  sleep 1
done

if [[ "$saw_pid" == "1" && "$process_lost" == "0" && -n "$last_pid" ]]; then
  survived=1
fi

adb logcat -d -v threadtime > "$SMOKE_DIR/logcat-full.log"
adb logcat -b crash -d -v threadtime > "$SMOKE_DIR/logcat-crash.log"
capture_system_state

startup_crash=0
if rg -n -i "FATAL EXCEPTION|AndroidRuntime|ReactNativeJS.*(Error|Unhandled)|UnsatisfiedLinkError|SoLoaderDSONotFoundError|SIGSEGV|SIGABRT|OutOfMemoryError|ANR in .*${PACKAGE_NAME}" \
  "$SMOKE_DIR/logcat-full.log" "$SMOKE_DIR/logcat-crash.log" > "$SMOKE_DIR/crash-markers.log" 2>/dev/null; then
  startup_crash=1
else
  : > "$SMOKE_DIR/crash-markers.log"
fi

summary_status="FAIL"
if [[ "$survived" == "1" && "$startup_crash" == "0" ]]; then
  summary_status="PASS"
fi

{
  printf "status=%s\n" "$summary_status"
  printf "package=%s\n" "$PACKAGE_NAME"
  printf "activity=%s\n" "$MAIN_ACTIVITY"
  printf "qa_abi=%s\n" "$QA_ABI"
  printf "first_pid=%s\n" "${first_pid:-<none>}"
  printf "last_pid=%s\n" "${last_pid:-<none>}"
  printf "process_lost_during_window=%s\n" "$([[ "$process_lost" == "1" ]] && printf true || printf false)"
  printf "process_survived_30s=%s\n" "$([[ "$survived" == "1" ]] && printf true || printf false)"
  printf "startup_crash_markers=%s\n" "$([[ "$startup_crash" == "1" ]] && printf true || printf false)"
  printf "apk=%s\n" "$APK_PATH"
  printf "artifact_dir=%s\n" "$SMOKE_DIR"
} > "$SMOKE_DIR/summary.txt"

cat "$SMOKE_DIR/summary.txt"
if [[ "$summary_status" != "PASS" ]]; then
  fail "Release standalone smoke failed."
fi

printf "\n✅ Release standalone smoke passed.\nDiagnostics: %s\n" "$SMOKE_DIR"
