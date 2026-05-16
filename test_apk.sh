#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="com.harishajahan.tamilai"
APK_PATH="$DIST_DIR/tamil-ai-debug.apk"
METRO_PORT="${METRO_PORT:-8081}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$DIST_DIR/apk-test-$RUN_ID}"
UI_XML_DEVICE_PATH="/sdcard/jai-apk-test-window.xml"

RESULT=0
LOGCAT_PID=""
METRO_PID=""
STARTED_METRO=0
CRASH_MARKERS_FOUND=0
APK_16KB_VALIDATION_FAILED=0
declare -a FAILED_STEPS=()
declare -a SKIPPED_STEPS=()
declare -a RESPONSE_TIMINGS=()
declare -a CRASH_MARKERS=()

mkdir -p "$ARTIFACT_DIR"

info() {
  printf "\n> %s\n" "$1"
}

warn() {
  printf "\nWARN: %s\n" "$1"
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

record_skip() {
  SKIPPED_STEPS+=("$1")
  printf "SKIP: %s\n" "$1" >> "$ARTIFACT_DIR/skipped.log"
}

mark_failed() {
  RESULT=1
  FAILED_STEPS+=("$1")
}

run_step() {
  local name="$1"
  shift
  local log="$ARTIFACT_DIR/${name}.log"

  info "Running $name"
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n\n'
  } > "$log"

  if "$@" >> "$log" 2>&1; then
    printf "PASS %s\n" "$name" >> "$ARTIFACT_DIR/steps.log"
  else
    local status=$?
    printf "FAIL %s exit=%s\n" "$name" "$status" >> "$ARTIFACT_DIR/steps.log"
    mark_failed "$name:$status"
  fi
}

collect_cmd() {
  local name="$1"
  shift
  local log="$ARTIFACT_DIR/${name}.log"

  {
    printf '$'
    printf ' %q' "$@"
    printf '\n\n'
  } > "$log"

  if ! "$@" >> "$log" 2>&1; then
    printf "WARN %s collection failed\n" "$name" >> "$ARTIFACT_DIR/steps.log"
  fi
}

now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))'
}

write_ui_helper() {
  cat > "$ARTIFACT_DIR/find_ui_center.py" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

if len(sys.argv) != 4:
    sys.exit(2)

xml_path, mode, needle = sys.argv[1], sys.argv[2], sys.argv[3].lower()
attr = "text" if mode == "text" else "content-desc"

try:
    root = ET.parse(xml_path).getroot()
except Exception:
    sys.exit(1)

def center(bounds):
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds or "")
    if not match:
        return None
    left, top, right, bottom = map(int, match.groups())
    return (left + right) // 2, (top + bottom) // 2

for node in root.iter():
    value = (node.attrib.get(attr) or "").lower()
    resource_id = (node.attrib.get("resource-id") or "").lower()
    if needle and (needle in value or needle in resource_id):
        point = center(node.attrib.get("bounds"))
        if point:
            print(point[0], point[1])
            sys.exit(0)

sys.exit(1)
PY
}

dump_ui() {
  local label="${1:-ui}"
  local xml_path="$ARTIFACT_DIR/ui-${label}.xml"
  if adb shell uiautomator dump "$UI_XML_DEVICE_PATH" > "$ARTIFACT_DIR/uiautomator-${label}.log" 2>&1; then
    adb exec-out cat "$UI_XML_DEVICE_PATH" > "$xml_path" 2>> "$ARTIFACT_DIR/uiautomator-${label}.log" || true
  fi
  printf "%s\n" "$xml_path"
}

find_ui_center() {
  local mode="$1"
  local needle="$2"
  local label="${3:-find}"
  local xml_path
  xml_path="$(dump_ui "$label")"
  [[ -s "$xml_path" ]] || return 1
  python3 "$ARTIFACT_DIR/find_ui_center.py" "$xml_path" "$mode" "$needle"
}

tap_text() {
  local text="$1"
  local center
  if center="$(find_ui_center text "$text" "tap-text-${text//[^A-Za-z0-9]/_}")"; then
    adb shell input tap $center
    return 0
  fi
  return 1
}

tap_desc() {
  local desc="$1"
  local center
  if center="$(find_ui_center desc "$desc" "tap-desc-${desc//[^A-Za-z0-9]/_}")"; then
    adb shell input tap $center
    return 0
  fi
  return 1
}

tap_desc_offset() {
  local desc="$1"
  local dx="${2:-0}"
  local dy="${3:-0}"
  local center x y
  if center="$(find_ui_center desc "$desc" "tap-desc-${desc//[^A-Za-z0-9]/_}")"; then
    read -r x y <<< "$center"
    adb shell input tap "$((x + dx))" "$((y + dy))"
    return 0
  fi
  return 1
}

type_text() {
  local raw="$1"
  local escaped="${raw// /%s}"
  escaped="${escaped//&/\\&}"
  escaped="${escaped//</\\<}"
  escaped="${escaped//>/\\>}"
  adb shell input text "$escaped"
}

clear_chat_input() {
  tap_desc "chat-input" || return 1
  adb shell input keyevent 123 >/dev/null 2>&1 || true
  for _ in {1..80}; do
    adb shell input keyevent 67 >/dev/null 2>&1 || true
  done
}

wait_for_text() {
  local text="$1"
  local timeout="${2:-30}"
  local deadline=$((SECONDS + timeout))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if find_ui_center text "$text" "wait-text-${text//[^A-Za-z0-9]/_}" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_desc() {
  local desc="$1"
  local timeout="${2:-30}"
  local deadline=$((SECONDS + timeout))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if find_ui_center desc "$desc" "wait-desc-${desc//[^A-Za-z0-9]/_}" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

dismiss_expo_warning() {
  local xml_path center x y
  xml_path="$(dump_ui "dismiss-expo-warning")"
  [[ -s "$xml_path" ]] || return 1
  if center="$(python3 - "$xml_path" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()

def bounds_tuple(value):
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", value or "")
    if not match:
        return None
    return tuple(map(int, match.groups()))

def center(bounds):
    parsed = bounds_tuple(bounds)
    if not parsed:
        return None
    left, top, right, bottom = parsed
    return (left + right) // 2, (top + bottom) // 2

for node in root.iter():
    label = f"{node.attrib.get('content-desc') or ''} {node.attrib.get('text') or ''}"
    if "Open debugger to view warnings" not in label:
        continue

    warning_bounds = bounds_tuple(node.attrib.get("bounds"))
    if not warning_bounds:
        continue

    left, top, right, bottom = warning_bounds
    fallback = (right - 58, (top + bottom) // 2)
    for child in node.iter():
        if child is node:
            continue
        if child.attrib.get("clickable") != "true":
            continue
        child_center = center(child.attrib.get("bounds"))
        if child_center and child_center[0] >= right - 120:
            print(child_center[0], child_center[1])
            sys.exit(0)

    print(fallback[0], fallback[1])
    sys.exit(0)

sys.exit(1)
PY
)"; then
    read -r x y <<< "$center"
    adb shell input tap "$x" "$y" >/dev/null 2>&1 || true
    sleep 1
    return 0
  fi
  return 1
}

chat_input_text() {
  local label="${1:-chat-input-text}"
  local xml_path
  xml_path="$(dump_ui "$label")"
  [[ -s "$xml_path" ]] || return 1
  python3 - "$xml_path" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
for node in root.iter():
    if node.attrib.get("resource-id") == "chat-input" or node.attrib.get("content-desc") == "chat-input":
        print(node.attrib.get("text") or "")
        sys.exit(0)
sys.exit(1)
PY
}

assistant_response_count() {
  local label="${1:-assistant-response-count}"
  local xml_path
  xml_path="$(dump_ui "$label")"
  [[ -s "$xml_path" ]] || {
    printf "0\n"
    return 0
  }
  python3 - "$xml_path" <<'PY'
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    print(0)
    sys.exit(0)

count = 0
for node in root.iter():
    content_desc = node.attrib.get("content-desc") or ""
    resource_id = node.attrib.get("resource-id") or ""
    if "chat-assistant-response" in content_desc or "chat-assistant-response" in resource_id:
        count += 1

print(count)
PY
}

wait_for_chat_input_cleared() {
  local previous_text="$1"
  local timeout="${2:-8}"
  local label="${3:-chat-input-cleared}"
  local deadline=$((SECONDS + timeout))
  local current_text
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    current_text="$(chat_input_text "${label}-${SECONDS}" || true)"
    if [[ "$current_text" != *"$previous_text"* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

capture_screen() {
  local label="$1"
  adb exec-out screencap -p > "$ARTIFACT_DIR/screen-${label}.png" 2> "$ARTIFACT_DIR/screen-${label}.err" || true
}

capture_step() {
  local label="$1"
  capture_screen "$label"
  dump_ui "$label" >/dev/null || true
  collect_cmd "dumpsys-activity-${label}" adb shell dumpsys activity
  collect_cmd "dumpsys-window-${label}" adb shell dumpsys window
}

assert_app_alive() {
  local label="$1"
  local log="$ARTIFACT_DIR/app-pid-${label}.log"

  if adb shell pidof "$PACKAGE_NAME" > "$log" 2>&1; then
    return 0
  fi

  mark_failed "app-not-running-${label}"
  capture_step "app-not-running-${label}"
  return 1
}

scan_crashes() {
  local log_file="$ARTIFACT_DIR/logcat-full.log"
  local markers_file="$ARTIFACT_DIR/crash-markers.log"
  : > "$markers_file"

  CRASH_MARKERS=(
    "FATAL EXCEPTION"
    " E AndroidRuntime:"
    "ANR in"
    "SIGSEGV"
    "SIGABRT"
    "OutOfMemoryError"
    "ReactNativeJS.*Error"
    "Unable to load script"
    "ReferenceError"
    "TypeError"
    "JAI_LLAMA_CPP_BACKEND_MISSING"
    "JAI_NATIVE_STT_NOT_IMPLEMENTED"
  )

  if [[ -f "$log_file" ]]; then
    for marker in "${CRASH_MARKERS[@]}"; do
      if grep -E -n "$marker" "$log_file" >> "$markers_file" 2>/dev/null; then
        CRASH_MARKERS_FOUND=1
      fi
    done
  fi

  if [[ "$CRASH_MARKERS_FOUND" == "1" ]]; then
    mark_failed "crash-markers"
  fi
}

scan_general_question_route_markers() {
  local label="$1"
  local start_line="${2:-0}"
  local log_file="$ARTIFACT_DIR/logcat-full.log"
  local markers_file="$ARTIFACT_DIR/route-markers-${label}.log"

  : > "$markers_file"

  if [[ -f "$log_file" ]] && tail -n "+$((start_line + 1))" "$log_file" | grep -E -n \
    "client_local_path_skipped_for_safety|client_backend_fallback_started|client_backend_fallback_completed|chat_turn_completed" \
    > "$markers_file" 2>/dev/null; then
    return 0
  fi

  return 1
}

start_logcat() {
  adb logcat -c > "$ARTIFACT_DIR/logcat-clear.log" 2>&1 || true
  adb logcat -v threadtime > "$ARTIFACT_DIR/logcat-full.log" 2>&1 &
  LOGCAT_PID="$!"
}

stop_background_jobs() {
  if [[ -n "${LOGCAT_PID:-}" ]]; then
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
    wait "$LOGCAT_PID" >/dev/null 2>&1 || true
    LOGCAT_PID=""
  fi

  if [[ "$STARTED_METRO" == "1" && -n "${METRO_PID:-}" ]]; then
    kill "$METRO_PID" >/dev/null 2>&1 || true
    wait "$METRO_PID" >/dev/null 2>&1 || true
    METRO_PID=""
  fi
}

write_summary() {
  local summary="$ARTIFACT_DIR/summary.txt"
  {
    printf "APK path: %s\n" "$APK_PATH"
    printf "Artifact path: %s\n" "$ARTIFACT_DIR"
    if [[ "$RESULT" == "0" ]]; then
      printf "Test result: PASS\n"
    else
      printf "Test result: FAIL\n"
    fi
    printf "Crash markers found: %s\n" "$CRASH_MARKERS_FOUND"
    if [[ -s "$ARTIFACT_DIR/crash-markers.log" ]]; then
      printf "\nCrash marker matches:\n"
      sed -n '1,80p' "$ARTIFACT_DIR/crash-markers.log"
    fi
    printf "\nResponse timings:\n"
    if [[ "${#RESPONSE_TIMINGS[@]}" -eq 0 ]]; then
      printf "none\n"
    else
      printf '%s\n' "${RESPONSE_TIMINGS[@]}"
    fi
    printf "\nSkipped steps:\n"
    if [[ "${#SKIPPED_STEPS[@]}" -eq 0 ]]; then
      printf "none\n"
    else
      printf '%s\n' "${SKIPPED_STEPS[@]}"
    fi
    printf "\nFailed steps:\n"
    if [[ "${#FAILED_STEPS[@]}" -eq 0 ]]; then
      printf "none\n"
    else
      printf '%s\n' "${FAILED_STEPS[@]}"
    fi
  } > "$summary"
  cat "$summary"
}

finish() {
  local exit_code=$?
  set +e

  if command -v adb >/dev/null 2>&1 && adb get-state >/dev/null 2>&1; then
    collect_cmd "final-dumpsys-activity" adb shell dumpsys activity
    collect_cmd "final-dumpsys-window" adb shell dumpsys window
    collect_cmd "final-dumpsys-package" adb shell dumpsys package "$PACKAGE_NAME"
    collect_cmd "final-dumpsys-meminfo-package" adb shell dumpsys meminfo "$PACKAGE_NAME"
    if is_truthy "${COLLECT_BUGREPORT:-}"; then
      collect_cmd "bugreport" adb bugreport "$ARTIFACT_DIR/bugreport.zip"
    fi
  fi

  stop_background_jobs
  scan_crashes

  if [[ "$exit_code" -ne 0 ]]; then
    RESULT=1
  fi

  write_summary
  exit "$RESULT"
}

trap finish EXIT

write_ui_helper

for tool in adb node npm curl python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    mark_failed "missing-tool:$tool"
  fi
done

if [[ "$RESULT" != "0" ]]; then
  record_skip "required tool missing"
  exit "$RESULT"
fi

[[ -d "$MOBILE_DIR" ]] || {
  mark_failed "missing-mobile-dir"
  exit "$RESULT"
}

ANDROID_ABI_UTILS="$ROOT_DIR/scripts/android-abi-utils.sh"
ANDROID_16KB_UTILS="$ROOT_DIR/scripts/android-16kb-utils.sh"
[[ -f "$ANDROID_ABI_UTILS" ]] || {
  mark_failed "missing-android-abi-utils"
  exit "$RESULT"
}
[[ -f "$ANDROID_16KB_UTILS" ]] || {
  mark_failed "missing-android-16kb-utils"
  exit "$RESULT"
}
# shellcheck disable=SC1090
source "$ANDROID_ABI_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_16KB_UTILS"

ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$ANDROID_SDK" ]]; then
  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/Users/$USER/Library/Android/sdk"; do
    if [[ -d "$candidate" ]]; then
      ANDROID_SDK="$candidate"
      break
    fi
  done
fi

if ! is_truthy "${SKIP_PRECHECKS:-}"; then
  run_step "mobile-typecheck" bash -lc "cd '$MOBILE_DIR' && npm run typecheck"
  run_step "mobile-tests" bash -lc "cd '$MOBILE_DIR' && npm test -- --run"
  run_step "mobile-release-verify-local-first" bash -lc "cd '$MOBILE_DIR' && npm run release:verify-local-first"
  run_step "bash-n-build-apk" bash -n "$ROOT_DIR/build-apk.sh"
  run_step "bash-n-launch-debug-apk" bash -n "$ROOT_DIR/launch-debug_apk.sh"
  run_step "bash-n-test-apk" bash -n "$ROOT_DIR/test_apk.sh"
else
  record_skip "SKIP_PRECHECKS=1"
fi

info "Checking Android device/emulator"
if ! adb get-state > "$ARTIFACT_DIR/adb-get-state.log" 2>&1; then
  mark_failed "no-android-device"
  record_skip "APK install/UI automation skipped because adb did not detect a device"
  exit "$RESULT"
fi

collect_cmd "adb-devices" adb devices -l
collect_cmd "device-getprop" adb shell getprop
collect_cmd "device-page-size" adb shell getconf PAGE_SIZE
collect_cmd "device-wm-size" adb shell wm size
collect_cmd "device-wm-density" adb shell wm density
collect_cmd "device-df" adb shell df -h
collect_cmd "device-dumpsys-meminfo" adb shell dumpsys meminfo

DEVICE_PAGE_SIZE="$(adb shell getconf PAGE_SIZE 2>/dev/null | tr -d '\r' | tr -d '[:space:]' || true)"
DEVICE_REQUIRES_16KB_APK=0
if [[ "$DEVICE_PAGE_SIZE" == "16384" ]]; then
  DEVICE_REQUIRES_16KB_APK=1
fi

if DEVICE_ANDROID_ABILIST="$(jai_android_read_device_abilist 2> "$ARTIFACT_DIR/android-abi-read.err")"; then
  ANDROID_ABIS_EXPLICIT_VALUE="${JAI_ANDROID_ABIS:-${ANDROID_ABIS:-}}"
  if [[ -n "${ANDROID_ABIS_EXPLICIT_VALUE//[[:space:]]/}" ]]; then
    if SELECTED_ANDROID_ABIS="$(jai_android_normalize_abi_list "$ANDROID_ABIS_EXPLICIT_VALUE")"; then
      if ! jai_android_abi_lists_intersect "$SELECTED_ANDROID_ABIS" "$DEVICE_ANDROID_ABILIST"; then
        mark_failed "android-abi-mismatch"
      fi
    else
      mark_failed "android-abi-invalid"
      SELECTED_ANDROID_ABIS="$JAI_ANDROID_DEFAULT_ABIS_CSV"
    fi
  else
    if ! SELECTED_ANDROID_ABIS="$(jai_android_choose_supported_device_abi "$DEVICE_ANDROID_ABILIST")"; then
      mark_failed "android-abi-unsupported"
      SELECTED_ANDROID_ABIS="$JAI_ANDROID_DEFAULT_ABIS_CSV"
    fi
  fi
  export JAI_ANDROID_ABIS="$SELECTED_ANDROID_ABIS"
  printf "Device ABIs: %s\nSelected ABIs: %s\n" "$DEVICE_ANDROID_ABILIST" "$JAI_ANDROID_ABIS" > "$ARTIFACT_DIR/android-abi-selection.log"
else
  mark_failed "android-abi-read"
fi

export EXPO_PUBLIC_E2E_MOCK_AUTH="${EXPO_PUBLIC_E2E_MOCK_AUTH:-1}"
export EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP="${EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP:-1}"
export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="${EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-false}"
export EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT="${EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT:-false}"
export EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS="${EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS:-false}"

if is_truthy "${EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-}"; then
  info "Debug APK voice routing: local/native STT (manual development opt-in)"
else
  info "Debug APK voice routing: backend Sarvam (default)"
fi

if is_truthy "${STRICT_NATIVE:-}"; then
  unset JAI_DEBUG_LITE
  record_skip "STRICT_NATIVE=1, not forcing JAI_DEBUG_LITE"
else
  export JAI_DEBUG_LITE="${JAI_DEBUG_LITE:-1}"
fi

if is_truthy "${REUSE_APK:-}" && [[ -f "$APK_PATH" ]]; then
  record_skip "REUSE_APK=1, existing APK build reused"
else
  run_step "build-debug-apk" env BUILD_TYPE=debug ./build-apk.sh
fi

if [[ ! -f "$APK_PATH" ]]; then
  mark_failed "apk-missing:$APK_PATH"
  exit "$RESULT"
fi

if [[ -n "${ANDROID_SDK:-}" ]]; then
  if jai_android_validate_apk_16kb_or_allow_debug_skip "$APK_PATH" "debug" "$ANDROID_SDK" > "$ARTIFACT_DIR/apk-16kb-validation.log" 2>&1; then
    printf "PASS apk-16kb-validation\n" >> "$ARTIFACT_DIR/steps.log"
  else
    APK_16KB_VALIDATION_FAILED=1
    mark_failed "apk-16kb-validation"
  fi
else
  record_skip "Android SDK not found; test harness skipped explicit 16 KB APK validation"
fi

if [[ "$DEVICE_REQUIRES_16KB_APK" == "1" && "$APK_16KB_VALIDATION_FAILED" == "1" ]]; then
  record_skip "Device requires 16 KB page-size compatible APK; install skipped after validation failure"
  exit "$RESULT"
fi

if is_truthy "${REUSE_APK:-}" && adb shell pm path "$PACKAGE_NAME" > "$ARTIFACT_DIR/pm-path.log" 2>&1; then
  record_skip "REUSE_APK=1, installed package reused"
else
  collect_cmd "adb-uninstall-old-apk" adb uninstall "$PACKAGE_NAME"
  run_step "adb-install-debug-apk" adb install -r "$APK_PATH"
fi

if curl -fsS "http://127.0.0.1:${METRO_PORT}/status" > "$ARTIFACT_DIR/metro-status.log" 2>&1; then
  record_skip "Metro already running on port $METRO_PORT"
else
  info "Starting Metro on port $METRO_PORT"
  (
    cd "$MOBILE_DIR"
    EXPO_NO_TELEMETRY=1 \
    EXPO_PUBLIC_E2E_MOCK_AUTH="$EXPO_PUBLIC_E2E_MOCK_AUTH" \
    EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP="$EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP" \
    EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="$EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE" \
    EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT="$EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT" \
    EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS="$EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS" \
    npx expo start --dev-client --host lan --port "$METRO_PORT" --clear
  ) > "$ARTIFACT_DIR/metro.log" 2>&1 &
  METRO_PID="$!"
  STARTED_METRO=1

  for _ in {1..90}; do
    if curl -fsS "http://127.0.0.1:${METRO_PORT}/status" >> "$ARTIFACT_DIR/metro-status.log" 2>&1; then
      break
    fi
    sleep 1
  done
fi

run_step "adb-reverse-metro" adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}"

start_logcat

run_step "launch-app-monkey" adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1

for _ in {1..45}; do
  if adb shell pidof "$PACKAGE_NAME" > "$ARTIFACT_DIR/app-pid.log" 2>&1; then
    break
  fi
  sleep 1
done

capture_step "launch"

if wait_for_desc "chat-input" 60; then
  dismiss_expo_warning || true
  capture_step "chat-ready"
else
  capture_step "auth-or-setup"
  if wait_for_desc "login-email-input" 3; then
    mark_failed "chat-automation-stopped-at-login"
    record_skip "Chat automation stopped at login screen; E2E mock auth did not take effect"
  elif wait_for_desc "model-setup-status" 3; then
    mark_failed "chat-automation-stopped-at-model-setup"
    record_skip "Chat automation stopped at model setup screen"
  else
    mark_failed "chat-input-not-found-after-launch"
    record_skip "Chat input not found after launch"
  fi
  exit "$RESULT"
fi

for message in "hello" "what can you do" "tell me about solo leveling"; do
  label="$(printf '%s' "$message" | tr -c 'A-Za-z0-9' '_' | tr '[:upper:]' '[:lower:]')"
  is_general_question=0
  input_clear_timeout=8
  result_wait_seconds=8
  if [[ "$message" == "tell me about solo leveling" ]]; then
    is_general_question=1
    input_clear_timeout=90
    result_wait_seconds=90
  fi

  dismiss_expo_warning || true
  if ! clear_chat_input; then
    mark_failed "clear-chat-input"
    continue
  fi
  sleep 1
  before_response_count="$(assistant_response_count "before-message-${label}" || printf "0")"
  general_log_start_line=0
  if [[ "$is_general_question" == "1" && -f "$ARTIFACT_DIR/logcat-full.log" ]]; then
    general_log_start_line="$(wc -l < "$ARTIFACT_DIR/logcat-full.log" | tr -d '[:space:]')"
  fi
  type_text "$message"
  sleep 1
  dismiss_expo_warning || true
  local_start="$(now_ms)"
  adb shell input keyevent 111 >/dev/null 2>&1 || true
  sleep 1
  if ! tap_desc_offset "chat-send-button" 0 35; then
    mark_failed "tap-chat-send-button"
    continue
  fi
  if ! assert_app_alive "after-submit-${label}"; then
    continue
  fi
  if ! wait_for_chat_input_cleared "$message" "$input_clear_timeout" "input-cleared-${label}"; then
    mark_failed "message-not-submitted-${label}"
    capture_step "submit-failed-${label}"
    continue
  fi

  if [[ "$is_general_question" == "1" ]]; then
    route_marker_seen=0
    response_seen=0
    deadline=$((SECONDS + result_wait_seconds))

    while [[ "$SECONDS" -lt "$deadline" ]]; do
      if ! assert_app_alive "during-general-question-${label}"; then
        break
      fi

      scan_crashes
      if [[ "$CRASH_MARKERS_FOUND" == "1" ]]; then
        capture_step "crash-during-general-question-${label}"
        break
      fi

      if scan_general_question_route_markers "$label" "$general_log_start_line"; then
        route_marker_seen=1
      fi

      current_response_count="$(assistant_response_count "general-response-count-${label}-${SECONDS}" || printf "0")"
      if [[ "$before_response_count" =~ ^[0-9]+$ ]] && \
        [[ "$current_response_count" =~ ^[0-9]+$ ]] && \
        (( current_response_count > before_response_count )); then
        response_seen=1
      fi

      if [[ "$response_seen" == "1" || "$route_marker_seen" == "1" ]]; then
        break
      fi

      sleep 2
    done

    if ! assert_app_alive "after-general-question-${label}"; then
      continue
    fi

    if [[ "$route_marker_seen" != "1" && "$response_seen" != "1" ]]; then
      mark_failed "general-question-no-route-marker-or-response-${label}"
    fi
  else
    wait_for_desc "chat-thinking-indicator" 8 || true
    sleep 8
    assert_app_alive "after-local-question-${label}" || true
  fi

  capture_step "after-message-${label}"
  local_end="$(now_ms)"
  RESPONSE_TIMINGS+=("${message}: $((local_end - local_start))ms")
done

final_chat_xml="$ARTIFACT_DIR/ui-after-message-tell_me_about_solo_leveling.xml"
if [[ -f "$final_chat_xml" ]]; then
  if ! grep -q 'text="hello"' "$final_chat_xml"; then
    mark_failed "first-message-not-visible-after-second"
  fi
  if ! grep -q 'text="what can you do"' "$final_chat_xml"; then
    mark_failed "second-message-not-visible"
  fi
  if ! grep -q 'text="tell me about solo leveling"' "$final_chat_xml"; then
    mark_failed "general-message-not-visible"
  fi
fi

if wait_for_desc "app-alert-modal" 2; then
  capture_step "alert-or-setup"
  tap_text "Not now" || tap_text "OK" || true
fi

collect_cmd "dumpsys-package" adb shell dumpsys package "$PACKAGE_NAME"
collect_cmd "dumpsys-meminfo-package" adb shell dumpsys meminfo "$PACKAGE_NAME"

exit "$RESULT"
