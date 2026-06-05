#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="com.swico.tamilai"
APK_PATH="$DIST_DIR/tamil-ai-debug.apk"
METRO_PORT="${METRO_PORT:-8081}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$DIST_DIR/apk-test-$RUN_ID}"
UI_XML_DEVICE_PATH="/sdcard/jai-apk-test-window.xml"
LEGACY_PACKAGE_NAMES=("com.jeygroups.manas")
LEGACY_CLEANUP_DONE=0

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

lowercase() {
  printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]"
}

record_skip() {
  SKIPPED_STEPS+=("$1")
  printf "SKIP: %s\n" "$1" >> "$ARTIFACT_DIR/skipped.log"
}

record_skip_once() {
  local reason="$1"
  if [[ -f "$ARTIFACT_DIR/skipped.log" ]] && grep -Fqx "SKIP: ${reason}" "$ARTIFACT_DIR/skipped.log"; then
    return
  fi
  record_skip "$reason"
}

cleanup_legacy_packages() {
  if [[ "$LEGACY_CLEANUP_DONE" == "1" ]]; then
    return 0
  fi
  LEGACY_CLEANUP_DONE=1

  local removed=0
  local legacy_package
  for legacy_package in "${LEGACY_PACKAGE_NAMES[@]}"; do
    if adb shell timeout 3 pm path "$legacy_package" >/dev/null 2>&1; then
      adb shell am force-stop "$legacy_package" >/dev/null 2>&1 || true
      adb uninstall "$legacy_package" >/dev/null 2>&1 || true
      record_skip_once "removed-legacy-package-${legacy_package}"
      removed=1
    fi
  done

  if [[ "$removed" == "1" ]]; then
    adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    sleep 2
  fi
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
  rm -f "$xml_path" >/dev/null 2>&1 || true
  cleanup_legacy_packages
  if adb shell timeout 8 uiautomator dump "$UI_XML_DEVICE_PATH" > "$ARTIFACT_DIR/uiautomator-${label}.log" 2>&1; then
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

device_window_size() {
  local wm_output width height
  wm_output="$(adb shell wm size 2>/dev/null | tr -d '\r' || true)"
  if [[ "$wm_output" =~ ([0-9]+)x([0-9]+) ]]; then
    width="${BASH_REMATCH[1]}"
    height="${BASH_REMATCH[2]}"
    printf "%s %s\n" "$width" "$height"
    return 0
  fi
  return 1
}

voice_assistant_center_from_window() {
  local width height
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  printf "%s %s\n" "$((width / 2))" "$((height * 40 / 100))"
}

tap_e2e_hands_free_trigger_fallback() {
  local width height
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  adb shell input tap "$((width * 78 / 100))" "$((height * 10 / 100))"
  sleep 1
  adb shell input tap "$((width * 50 / 100))" "$((height * 15 / 100))"
}

tap_e2e_hands_free_stop_fallback() {
  local width height
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  adb shell input tap "$((width * 72 / 100))" "$((height * 15 / 100))"
}

tap_chat_input_fallback() {
  local width height
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  adb shell input tap "$((width * 44 / 100))" "$((height * 96 / 100))"
}

tap_chat_send_fallback() {
  local width height
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  adb shell input tap "$((width * 88 / 100))" "$((height * 96 / 100))"
}

submit_chat_input_via_keyboard() {
  adb shell input keyevent 66
}

tap_chat_send_button() {
  local tapped=1
  if submit_chat_input_via_keyboard; then
    tapped=0
    sleep 0.5
  fi
  if tap_desc_offset "chat-send-button" 0 0; then
    tapped=0
    sleep 0.3
  fi
  if tap_desc_offset "chat-send-button" 0 -20; then
    tapped=0
    sleep 0.3
  fi
  if tap_desc_offset "chat-send-button" 0 35; then
    tapped=0
    sleep 0.3
  fi
  if tap_chat_send_fallback; then
    tapped=0
  fi
  if [[ "$tapped" == "0" ]]; then
    adb shell input keyevent 111 >/dev/null 2>&1 || true
    sleep 0.5
  fi
  return "$tapped"
}

tap_chat_drawer_fallback() {
  local width height
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  adb shell input tap "$((width * 9 / 100))" "$((height * 10 / 100))"
}

swipe_chat_to_voice() {
  local width height start_x end_x y
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  start_x=$((width * 80 / 100))
  end_x=$((width * 20 / 100))
  y=$((height * 55 / 100))
  adb shell input swipe "$start_x" "$y" "$end_x" "$y" 420
}

swipe_voice_to_chat() {
  local width height start_x end_x y
  if ! read -r width height < <(device_window_size); then
    return 1
  fi
  start_x=$((width * 20 / 100))
  end_x=$((width * 80 / 100))
  y=$((height * 55 / 100))
  adb shell input swipe "$start_x" "$y" "$end_x" "$y" 420
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
  tap_desc "chat-input" || tap_chat_input_fallback || return 1
  adb shell input keyevent 123 >/dev/null 2>&1 || true
  for _ in {1..80}; do
    adb shell input keyevent 67 >/dev/null 2>&1 || true
  done
}

dismiss_external_system_ui_anr() {
  local xml_path center x y
  xml_path="$(dump_ui "dismiss-system-ui-anr")"
  [[ -s "$xml_path" ]] || return 1

  if center="$(python3 - "$xml_path" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(1)

def center(bounds):
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds or "")
    if not match:
        return None
    left, top, right, bottom = map(int, match.groups())
    return (left + right) // 2, (top + bottom) // 2

external_anr_titles = {
    "System UI isn't responding",
    "Pixel Launcher isn't responding",
    "Android System isn't responding",
}
title_seen = False
for node in root.iter():
    if node.attrib.get("resource-id") == "android:id/alertTitle" and node.attrib.get("text") in external_anr_titles:
        title_seen = True
        break

if not title_seen:
    sys.exit(1)

for node in root.iter():
    if node.attrib.get("resource-id") == "android:id/aerr_wait" and node.attrib.get("text") == "Wait":
        point = center(node.attrib.get("bounds"))
        if point:
            print(point[0], point[1])
            sys.exit(0)

sys.exit(1)
PY
)"; then
    read -r x y <<< "$center"
    adb shell input tap "$x" "$y" >/dev/null 2>&1 || true
    printf "External system ANR dialog dismissed with Wait\n" >> "$ARTIFACT_DIR/system-ui-anr.log"
    record_skip_once "external-system-ui-anr"
    record_skip_once "external-system-ui-anr-dismissed"
    sleep 2
    return 0
  fi

  return 1
}

record_external_disconnect_if_previous_system_anr() {
  local previous_artifact
  previous_artifact="$(find "$DIST_DIR" -maxdepth 1 -type d -name 'apk-test-*' ! -path "$ARTIFACT_DIR" -print 2>/dev/null | sort | tail -1 || true)"
  [[ -n "$previous_artifact" ]] || return 0
  if [[ -s "$previous_artifact/system-ui-anr.log" ]] || \
    { [[ -f "$previous_artifact/skipped.log" ]] && grep -E "external-system-ui-anr" "$previous_artifact/skipped.log" >/dev/null 2>&1; }; then
    record_skip_once "external-emulator-disconnected"
    record_skip_once "external-emulator-disconnected-after-system-ui-anr"
  fi
}

wait_for_text() {
  local text="$1"
  local timeout="${2:-30}"
  local deadline=$((SECONDS + timeout))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if find_ui_center text "$text" "wait-text-${text//[^A-Za-z0-9]/_}" >/dev/null; then
      return 0
    fi
    dismiss_external_system_ui_anr || true
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
    dismiss_external_system_ui_anr || true
    sleep 1
  done
  return 1
}

assert_desc_absent() {
  local desc="$1"
  local label="${2:-absent-${desc//[^A-Za-z0-9]/_}}"
  local xml_path
  xml_path="$(dump_ui "$label")"
  [[ -s "$xml_path" ]] || return 0
  if grep -F "$desc" "$xml_path" > "$ARTIFACT_DIR/${label}-unexpected-match.log" 2>/dev/null; then
    mark_failed "${label}-${desc}-present"
    return 1
  fi
  return 0
}

dismiss_expo_warning() {
  local xml_path center x y
  xml_path="$(dump_ui "dismiss-expo-warning")"
  [[ -s "$xml_path" ]] || return 1
  if center="$(python3 - "$xml_path" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(1)

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

wait_for_voice_mode_ready() {
  wait_for_desc "voice-swipe-surface" 8 ||
    wait_for_desc "Hold the assistant to talk" 4 ||
    wait_for_text "Hold to Talk" 4 ||
    wait_for_text "Listening" 4 ||
    wait_for_desc "voice-session-transcript" 4
}

chat_input_text() {
  local label="${1:-chat-input-text}"
  local xml_path
  xml_path="$(dump_ui "$label")"
  [[ -s "$xml_path" ]] || return 1
  python3 - "$xml_path" <<'PY'
import sys
import xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(1)
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
  local retry_deadline=$SECONDS
  local retry_count=0
  local current_text
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if ! current_text="$(chat_input_text "${label}-${SECONDS}")"; then
      sleep 1
      continue
    fi
    if [[ "$current_text" != *"$previous_text"* ]]; then
      return 0
    fi

    if [[ "$SECONDS" -ge "$retry_deadline" && "$retry_count" -lt 6 ]]; then
      printf "retry=%s seconds=%s text=%s\n" "$retry_count" "$SECONDS" "$current_text" >> "$ARTIFACT_DIR/chat-send-retries-${label}.log"
      tap_chat_send_button >/dev/null 2>&1 || true
      retry_count=$((retry_count + 1))
      retry_deadline=$((SECONDS + 4))
    fi

    sleep 1
  done
  return 1
}

complete_onboarding_smoke_if_present() {
  if ! find_ui_center desc "onboarding-option-english" "onboarding-detect-english" >/dev/null 2>&1 && \
    ! find_ui_center desc "onboarding-option-tamil" "onboarding-detect-tamil" >/dev/null 2>&1; then
    return 1
  fi

  info "Completing onboarding starter-profile smoke path"
  capture_step "onboarding-detected"

  if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "ta" ]]; then
    tap_desc "onboarding-option-tamil" || tap_text "Tamil" || true
  else
    tap_desc "onboarding-option-english" || tap_text "English" || true
  fi
  sleep 1
  tap_desc "onboarding-option-26_35" || tap_text "26 35" || true
  sleep 1
  tap_desc "onboarding-option-working_professional" || tap_text "Working Professional" || true
  sleep 1
  tap_desc "onboarding-option-short_direct" || tap_text "Short Direct" || true
  sleep 1
  tap_desc "onboarding-option-short" || tap_text "Short" || true
  sleep 1
  tap_desc "onboarding-option-coach" || tap_text "Coach" || true
  sleep 1
  tap_desc "onboarding-option-career_growth" || tap_text "Career Growth" || true
  sleep 1
  tap_desc "onboarding-option-too_many_questions" || tap_text "Too Many Questions" || true
  sleep 1
  tap_desc "onboarding-multi-submit" || tap_text "Continue with" || true

  if ! wait_for_text "Starter profile ready" 35 && ! wait_for_text "starter profile is ready" 10; then
    mark_failed "onboarding-starter-profile-ready-missing"
  fi

  if wait_for_text "active or available" 3 || find_ui_center desc "onboarding-option-afternoon" "onboarding-stale-afternoon" >/dev/null 2>&1; then
    mark_failed "onboarding-optional-work-rhythm-asked-after-too-many-questions"
  fi

  if tap_desc "onboarding-option-afternoon"; then
    sleep 2
    local xml_path ready_count
    xml_path="$(dump_ui "onboarding-after-stale-afternoon-tap")"
    ready_count="$(grep -o "starter profile is ready\\|Starter profile ready" "$xml_path" 2>/dev/null | wc -l | tr -d '[:space:]')"
    if [[ "${ready_count:-0}" -gt 1 ]]; then
      mark_failed "onboarding-duplicate-ready-after-stale-chip"
    fi
  fi

  tap_desc "onboarding-continue-button" || tap_text "Continue to app" || true
  wait_for_desc "chat-input" 60
}

relaunch_app_for_recovery() {
  adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 2
}

ensure_chat_input_ready() {
  local label="${1:-chat-input-ready}"
  if wait_for_desc "chat-input" 3; then
    return 0
  fi

  for _ in {1..3}; do
    relaunch_app_for_recovery
    if wait_for_desc "chat-input" 5; then
      record_skip_once "${label}-used-app-relaunch"
      return 0
    fi

    swipe_voice_to_chat >/dev/null 2>&1 || true
    if wait_for_desc "chat-input" 5; then
      return 0
    fi

    adb shell input keyevent 4 >/dev/null 2>&1 || true
    if wait_for_desc "chat-input" 5; then
      return 0
    fi
  done

  capture_step "${label}-chat-input-not-ready"
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
  collect_cmd "dumpsys-meminfo-package-${label}" adb shell dumpsys meminfo "$PACKAGE_NAME"
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
  local memory_pressure_file="$ARTIFACT_DIR/memory-pressure.log"
  local memory_pressure_package_file="$ARTIFACT_DIR/memory-pressure-package.log"
  local memory_pressure_system_file="$ARTIFACT_DIR/memory-pressure-system.log"
  local external_anr_file="$ARTIFACT_DIR/external-system-anr.log"
  : > "$markers_file"
  : > "$memory_pressure_file"
  : > "$memory_pressure_package_file"
  : > "$memory_pressure_system_file"
  : > "$external_anr_file"
  CRASH_MARKERS_FOUND=0

  CRASH_MARKERS=(
    "FATAL EXCEPTION"
    "ANR in"
    "SIGSEGV"
    "SIGABRT"
    "OutOfMemoryError"
    "lowmemorykiller"
    "Kill '${PACKAGE_NAME}'"
    "WINDOW DIED"
    "Process ${PACKAGE_NAME}"
    "has died"
    "ReactNativeJS.*Error"
    "ReactNativeJS.*Requiring unknown module"
    "Requiring unknown module \"react-native\""
    "localIdleQueue.ts"
    "Unable to load script"
    "ReferenceError"
    "TypeError"
    "JAI_LLAMA_CPP_BACKEND_MISSING"
    "JAI_NATIVE_STT_NOT_IMPLEMENTED"
  )

  if [[ -f "$log_file" ]]; then
    for marker in "${CRASH_MARKERS[@]}"; do
      if [[ "$marker" == "lowmemorykiller" ]]; then
        grep -E -n "lowmemorykiller" "$log_file" >> "$memory_pressure_file" 2>/dev/null || true
        grep -E -n "lowmemorykiller:.*(Kill '${PACKAGE_NAME}'|${PACKAGE_NAME})" "$log_file" >> "$memory_pressure_package_file" 2>/dev/null || true
        grep -E -n "lowmemorykiller" "$log_file" | grep -Ev "Kill '${PACKAGE_NAME}'|${PACKAGE_NAME}" >> "$memory_pressure_system_file" 2>/dev/null || true
        if [[ -s "$memory_pressure_package_file" ]]; then
          cat "$memory_pressure_package_file" >> "$markers_file"
          CRASH_MARKERS_FOUND=1
        fi
        continue
      fi
      if [[ "$marker" == "FATAL EXCEPTION" ]]; then
        local android_runtime_file="$ARTIFACT_DIR/android-runtime-app-markers.log"
        : > "$android_runtime_file"
        python3 - "$log_file" "$android_runtime_file" "$PACKAGE_NAME" <<'PY'
import sys

log_file, markers_file, package_name = sys.argv[1:4]
ignore_needles = (
    "com.android.commands.uiautomator",
    "UiAutomationService",
    "uiautomator",
    "app_process",
)

with open(log_file, "r", encoding="utf-8", errors="replace") as handle:
    lines = handle.readlines()

markers = []
for index, line in enumerate(lines):
    if "FATAL EXCEPTION" not in line:
        continue
    block = lines[index : min(len(lines), index + 80)]
    text = "".join(block)
    if any(needle in text for needle in ignore_needles):
        continue
    if package_name not in text:
        continue
    markers.extend(block)
    markers.append("\n")

with open(markers_file, "w", encoding="utf-8") as handle:
    handle.writelines(markers)
PY
        if [[ -s "$android_runtime_file" ]] && cat "$android_runtime_file" >> "$markers_file" 2>/dev/null; then
          CRASH_MARKERS_FOUND=1
        fi
        continue
      fi
      if [[ "$marker" == "ANR in" ]]; then
        if grep -E -n "ANR in ${PACKAGE_NAME}|ANR in .*${PACKAGE_NAME}" "$log_file" >> "$markers_file" 2>/dev/null; then
          CRASH_MARKERS_FOUND=1
        fi
        grep -E -n "ANR in (system|com\\.android\\.|com\\.google\\.android\\.)|System UI isn't responding|Pixel Launcher isn't responding|Android System isn't responding" "$log_file" >> "$external_anr_file" 2>/dev/null || true
        if [[ -s "$external_anr_file" ]]; then
          record_skip_once "external-system-ui-anr"
          record_skip_once "external-system-app-anr"
        fi
        continue
      fi
      if [[ "$marker" == "has died" ]]; then
        if grep -E -n "Process ${PACKAGE_NAME} .*has died|Process ${PACKAGE_NAME}.*has died|${PACKAGE_NAME} has died" "$log_file" >> "$markers_file" 2>/dev/null; then
          CRASH_MARKERS_FOUND=1
        fi
        continue
      fi
      if [[ "$marker" == "WINDOW DIED" ]]; then
        if grep -E -n "WINDOW DIED.*${PACKAGE_NAME}" "$log_file" >> "$markers_file" 2>/dev/null; then
          CRASH_MARKERS_FOUND=1
        fi
        continue
      fi
      if [[ "$marker" == "ReactNativeJS.*Error" ]]; then
        local react_native_error_file="$ARTIFACT_DIR/react-native-error-markers.log"
        : > "$react_native_error_file"
        python3 - "$log_file" "$react_native_error_file" "$ARTIFACT_DIR/metro-disconnect-warning.log" <<'PY'
import sys

log_file, markers_file, metro_file = sys.argv[1:4]
with open(log_file, "r", encoding="utf-8", errors="replace") as handle:
    lines = handle.readlines()

markers = []
metro_warnings = []
for index, line in enumerate(lines):
    if "ReactNativeJS:" not in line:
        continue
    if not ("[Error" in line or "Error:" in line or "Unhandled" in line or "Uncaught" in line):
        continue
    if "ReactNativeJS: Error: undefined" in line:
        context = "".join(lines[max(0, index - 12) : index + 1])
        if "Cannot connect to Metro." in context:
            metro_warnings.append(line)
            continue
    markers.append(line)

with open(markers_file, "w", encoding="utf-8") as handle:
    handle.writelines(markers)
with open(metro_file, "w", encoding="utf-8") as handle:
    handle.writelines(metro_warnings)
PY
        if [[ -s "$ARTIFACT_DIR/metro-disconnect-warning.log" ]]; then
          record_skip_once "metro-disconnect-warning"
        fi
        if [[ -s "$react_native_error_file" ]] && cat "$react_native_error_file" >> "$markers_file" 2>/dev/null; then
          CRASH_MARKERS_FOUND=1
        fi
        continue
      fi
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

scan_voice_reply_markers() {
  local start_line="${1:-0}"
  local log_file="$ARTIFACT_DIR/logcat-full.log"
  local markers_file="$ARTIFACT_DIR/voice-markers.log"

  : > "$markers_file"
  [[ -f "$log_file" ]] || return 1

  local recent
  recent="$(tail -n "+$((start_line + 1))" "$log_file" 2>/dev/null || true)"
  printf "%s\n" "$recent" | grep -E "client_voice_upload_started|e2e_voice_mock" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_tts_started" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_tts_completed" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_playback_started" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_playback_finished" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_tts_failed|client_voice_reply_playback_failed" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "requested_reply_language['\": ]+${EXPO_PUBLIC_E2E_REPLY_LANGUAGE}" >> "$markers_file" 2>/dev/null || true
  if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "ta" ]]; then
    printf "%s\n" "$recent" | grep -E "tts_language_code['\": ]+ta-IN|target_language_code['\": ]+ta-IN" >> "$markers_file" 2>/dev/null || true
    printf "%s\n" "$recent" | grep -E "local_tamil|tts_locale_style['\": ]+local_tamil" >> "$markers_file" 2>/dev/null || true
  else
    printf "%s\n" "$recent" | grep -E "tts_language_code['\": ]+en-IN|target_language_code['\": ]+en-IN" >> "$markers_file" 2>/dev/null || true
  fi

  grep -E "client_voice_upload_started|e2e_voice_mock" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_tts_started" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_tts_completed" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_playback_started" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_playback_finished" "$markers_file" >/dev/null 2>&1 &&
    grep -E "requested_reply_language['\": ]+${EXPO_PUBLIC_E2E_REPLY_LANGUAGE}" "$markers_file" >/dev/null 2>&1 &&
    grep -E "tts_language_code['\": ]+(en-IN|ta-IN)|target_language_code['\": ]+(en-IN|ta-IN)" "$markers_file" >/dev/null 2>&1 &&
    ! grep -E "client_voice_reply_tts_failed|client_voice_reply_playback_failed" "$markers_file" >/dev/null 2>&1 &&
    { [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" != "ta" ]] || grep -E "local_tamil|tts_locale_style['\": ]+local_tamil" "$markers_file" >/dev/null 2>&1; }
}

scan_hands_free_reply_markers() {
  local start_line="${1:-0}"
  local log_file="$ARTIFACT_DIR/logcat-full.log"
  local markers_file="$ARTIFACT_DIR/hands-free-markers.log"

  : > "$markers_file"
  [[ -f "$log_file" ]] || return 1

  local recent
  recent="$(tail -n "+$((start_line + 1))" "$log_file" 2>/dev/null || true)"
  printf "%s\n" "$recent" | grep -E "onCommandAudio|e2e_hands_free_audio_mock|hands-free command audio received" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "/api/transcribe-and-analyze" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_source['\": ]+handsfree|client_source.*handsfree" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_upload_started" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_upload_completed" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_tts_started" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_tts_completed" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_playback_started" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_playback_finished" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "client_voice_reply_tts_failed|client_voice_reply_playback_failed" >> "$markers_file" 2>/dev/null || true
  printf "%s\n" "$recent" | grep -E "requested_reply_language['\": ]+${EXPO_PUBLIC_E2E_REPLY_LANGUAGE}" >> "$markers_file" 2>/dev/null || true
  if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "ta" ]]; then
    printf "%s\n" "$recent" | grep -E "tts_language_code['\": ]+ta-IN|target_language_code['\": ]+ta-IN" >> "$markers_file" 2>/dev/null || true
  else
    printf "%s\n" "$recent" | grep -E "tts_language_code['\": ]+en-IN|target_language_code['\": ]+en-IN" >> "$markers_file" 2>/dev/null || true
  fi

  grep -E "onCommandAudio|e2e_hands_free_audio_mock|hands-free command audio received" "$markers_file" >/dev/null 2>&1 &&
    grep -E "/api/transcribe-and-analyze" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_source['\": ]+handsfree|client_source.*handsfree" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_upload_started" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_upload_completed" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_tts_started" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_tts_completed" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_playback_started" "$markers_file" >/dev/null 2>&1 &&
    grep -E "client_voice_reply_playback_finished" "$markers_file" >/dev/null 2>&1 &&
    grep -E "requested_reply_language['\": ]+${EXPO_PUBLIC_E2E_REPLY_LANGUAGE}" "$markers_file" >/dev/null 2>&1 &&
    grep -E "tts_language_code['\": ]+(en-IN|ta-IN)|target_language_code['\": ]+(en-IN|ta-IN)" "$markers_file" >/dev/null 2>&1 &&
    ! grep -E "client_voice_reply_tts_failed|client_voice_reply_playback_failed" "$markers_file" >/dev/null 2>&1
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
    collect_cmd "final-dumpsys-meminfo" adb shell dumpsys meminfo
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

for tool in node npm curl python3; do
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
  run_step "mobile-tests" env \
    -u EXPO_PUBLIC_E2E_MOCK_AUTH \
    -u EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP \
    -u EXPO_PUBLIC_E2E_MOCK_VOICE_TURN \
    -u EXPO_PUBLIC_E2E_MOCK_HANDS_FREE \
    -u EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO \
    -u EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT \
    -u EXPO_PUBLIC_E2E_REPLY_LANGUAGE \
    -u EXPO_PUBLIC_E2E_TAMIL_STYLE \
    -u EXPO_PUBLIC_E2E_VOICE_QUERY \
    -u EXPO_PUBLIC_E2E_VOICE_SURFACE \
    -u EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT \
    -u EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE \
    -u EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND \
    -u JAI_DEBUG_LITE \
    bash -lc "cd '$MOBILE_DIR' && npm test -- --run"
  run_step "mobile-release-verify-backend-first" bash -lc "cd '$MOBILE_DIR' && npm run release:verify-backend-first"
  run_step "bash-n-build-apk" bash -n "$ROOT_DIR/build-apk.sh"
  run_step "bash-n-launch-debug-apk" bash -n "$ROOT_DIR/launch-debug_apk.sh"
  run_step "bash-n-test-apk" bash -n "$ROOT_DIR/test_apk.sh"
else
  record_skip "SKIP_PRECHECKS=1"
fi

info "Checking Android device/emulator"
if ! command -v adb >/dev/null 2>&1; then
  mark_failed "missing-tool:adb"
  record_skip "APK install/UI automation skipped because adb was not found in PATH"
  exit "$RESULT"
fi

if ! adb get-state > "$ARTIFACT_DIR/adb-get-state.log" 2>&1; then
  collect_cmd "adb-devices" adb devices -l
  mark_failed "no-android-device"
  record_external_disconnect_if_previous_system_anr
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
export EXPO_PUBLIC_E2E_MOCK_VOICE_TURN="${EXPO_PUBLIC_E2E_MOCK_VOICE_TURN:-1}"
export EXPO_PUBLIC_E2E_MOCK_HANDS_FREE="${EXPO_PUBLIC_E2E_MOCK_HANDS_FREE:-1}"
export EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO="${EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO:-1}"
export EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT="${EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT:-}"
export EXPO_PUBLIC_E2E_REPLY_LANGUAGE="${EXPO_PUBLIC_E2E_REPLY_LANGUAGE:-en}"
export EXPO_PUBLIC_E2E_TAMIL_STYLE="${EXPO_PUBLIC_E2E_TAMIL_STYLE:-chennai_conversational}"
export EXPO_PUBLIC_E2E_VOICE_QUERY="${EXPO_PUBLIC_E2E_VOICE_QUERY:-spitzola}"
export EXPO_PUBLIC_E2E_VOICE_SURFACE="${EXPO_PUBLIC_E2E_VOICE_SURFACE:-live}"
export EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT="${EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT:-1}"
export EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE="${EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE:-Hey Elli}"
export EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND="${EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND:-tell me about Spitzola}"
export EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT="${EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT:-1}"
export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="${EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-false}"
export EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT="${EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT:-false}"
export EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS="${EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS:-false}"

{
  printf "EXPO_PUBLIC_E2E_MOCK_AUTH=%s\n" "$EXPO_PUBLIC_E2E_MOCK_AUTH"
  printf "EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP=%s\n" "$EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP"
  printf "EXPO_PUBLIC_E2E_MOCK_VOICE_TURN=%s\n" "$EXPO_PUBLIC_E2E_MOCK_VOICE_TURN"
  printf "EXPO_PUBLIC_E2E_MOCK_HANDS_FREE=%s\n" "$EXPO_PUBLIC_E2E_MOCK_HANDS_FREE"
  printf "EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO=%s\n" "$EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO"
  printf "EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT=%s\n" "$EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT"
  printf "EXPO_PUBLIC_E2E_REPLY_LANGUAGE=%s\n" "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE"
  printf "EXPO_PUBLIC_E2E_TAMIL_STYLE=%s\n" "$EXPO_PUBLIC_E2E_TAMIL_STYLE"
  printf "EXPO_PUBLIC_E2E_VOICE_QUERY=%s\n" "$EXPO_PUBLIC_E2E_VOICE_QUERY"
  printf "EXPO_PUBLIC_E2E_VOICE_SURFACE=%s\n" "$EXPO_PUBLIC_E2E_VOICE_SURFACE"
  printf "EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT=%s\n" "$EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT"
  printf "EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE=%s\n" "$EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE"
  printf "EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND=%s\n" "$EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND"
  printf "EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT=%s\n" "$EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT"
} > "$ARTIFACT_DIR/e2e-env.log"

# APK E2E mock validates mobile voice UI, mic gesture, assistant reply visibility,
# cached playback, and telemetry. Backend tests validate real Sarvam TTS speaker
# compatibility, so this mock must not be the only coverage for provider bugs.
# Language scenarios are explicit: English expects "E2E voice reply ready." with
# requested_reply_language 'en' and target en-IN; Tamil expects Chennai-style
# "Seri, unga voice reply ready." with requested_reply_language 'ta' and ta-IN.
# Scenario 1: English Settings -> transcript contains English mock text,
# no Tamil script, requested_reply_language: 'en', TTS target en-IN.
# Scenario 2: Tamil Settings -> transcript contains Chennai Tamil mock
# text ("Seri"), requested_reply_language: 'ta', TTS target ta-IN.
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

adb shell pm grant "$PACKAGE_NAME" android.permission.RECORD_AUDIO > "$ARTIFACT_DIR/grant-record-audio.log" 2>&1 || true

if curl -fsS "http://127.0.0.1:${METRO_PORT}/status" > "$ARTIFACT_DIR/metro-status.log" 2>&1; then
  record_skip "Metro already running on port $METRO_PORT"
else
  info "Starting Metro on port $METRO_PORT"
  (
    cd "$MOBILE_DIR"
    EXPO_NO_TELEMETRY=1 \
    EXPO_PUBLIC_E2E_MOCK_AUTH="$EXPO_PUBLIC_E2E_MOCK_AUTH" \
    EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP="$EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP" \
    EXPO_PUBLIC_E2E_MOCK_VOICE_TURN="$EXPO_PUBLIC_E2E_MOCK_VOICE_TURN" \
    EXPO_PUBLIC_E2E_MOCK_HANDS_FREE="$EXPO_PUBLIC_E2E_MOCK_HANDS_FREE" \
    EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO="$EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO" \
    EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT="$EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT" \
    EXPO_PUBLIC_E2E_REPLY_LANGUAGE="$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" \
    EXPO_PUBLIC_E2E_TAMIL_STYLE="$EXPO_PUBLIC_E2E_TAMIL_STYLE" \
    EXPO_PUBLIC_E2E_VOICE_QUERY="$EXPO_PUBLIC_E2E_VOICE_QUERY" \
    EXPO_PUBLIC_E2E_VOICE_SURFACE="$EXPO_PUBLIC_E2E_VOICE_SURFACE" \
    EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT="$EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT" \
    EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE="$EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE" \
    EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND="$EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND" \
    EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT="$EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT" \
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
collect_cmd "adb-reverse-list" adb reverse --list
collect_cmd "metro-status-before-launch" curl -fsS "http://127.0.0.1:${METRO_PORT}/status"
collect_cmd "dumpsys-meminfo-before-launch" adb shell dumpsys meminfo
collect_cmd "dumpsys-meminfo-package-before-launch" adb shell dumpsys meminfo "$PACKAGE_NAME"

start_logcat

run_step "launch-app-monkey" adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1

for _ in {1..45}; do
  if adb shell pidof "$PACKAGE_NAME" > "$ARTIFACT_DIR/app-pid.log" 2>&1; then
    break
  fi
  sleep 1
done
collect_cmd "dumpsys-meminfo-package-after-launch" adb shell dumpsys meminfo "$PACKAGE_NAME"
collect_cmd "dumpsys-meminfo-after-launch" adb shell dumpsys meminfo

capture_step "launch"

if complete_onboarding_smoke_if_present; then
  capture_step "onboarding-complete"
fi

launch_chat_ready_timeout="${APK_LAUNCH_CHAT_READY_TIMEOUT:-240}"
if wait_for_desc "chat-input" "$launch_chat_ready_timeout" || ensure_chat_input_ready "launch"; then
  dismiss_expo_warning || true
  capture_step "chat-ready"
  assert_desc_absent "chat-mic-button" "chat-mic-button-absent-after-launch" || true
  assert_desc_absent "chat-voice-button" "chat-voice-button-absent-after-launch" || true
  assert_desc_absent "open-voice-mode-button" "open-voice-mode-button-absent-after-launch" || true
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

voice_log_start_line=0
if [[ -f "$ARTIFACT_DIR/logcat-full.log" ]]; then
  voice_log_start_line="$(wc -l < "$ARTIFACT_DIR/logcat-full.log" | tr -d '[:space:]')"
fi
voice_query_lower="$(lowercase "$EXPO_PUBLIC_E2E_VOICE_QUERY")"
voice_expected_reply="E2E voice reply ready."
if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "ta" ]]; then
  voice_expected_reply="Seri, unga voice reply ready."
fi
if [[ "$voice_query_lower" == *"spitzola"* ]]; then
  if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "ta" ]]; then
    voice_expected_reply="Spitzola"
  else
    voice_expected_reply="not finding"
  fi
fi

capture_step "voice-before"
collect_cmd "dumpsys-meminfo-before-voice" adb shell dumpsys meminfo
voice_sheet_opened=0
voice_sheet_ui_visible=0
if swipe_chat_to_voice; then
  voice_sheet_opened=1
  if wait_for_voice_mode_ready; then
    voice_sheet_ui_visible=1
  else
    record_skip "voice modal opened by swipe, but uiautomator could not inspect the React Native modal tree"
  fi
elif tap_desc "e2e-open-voice-button"; then
  voice_sheet_opened=1
  record_skip "swipe-chat-to-voice used E2E open voice fallback after Android swipe automation did not open the voice sheet"
  if wait_for_voice_mode_ready; then
    voice_sheet_ui_visible=1
  else
    record_skip "E2E voice fallback opened the modal, but uiautomator could not inspect the React Native modal tree"
  fi
fi

if [[ "$voice_sheet_opened" != "1" ]]; then
  mark_failed "voice-sheet-not-ready"
  capture_step "voice-sheet-not-ready"
else
    capture_step "voice-modal-open"
    assistant_center=""
    if ! assistant_center="$(find_ui_center desc "Hold the assistant to talk" "voice-assistant")"; then
      if assistant_center="$(voice_assistant_center_from_window)"; then
        record_skip "voice-assistant-not-found-in-uiautomator; used coordinate fallback"
      else
        mark_failed "voice-assistant-not-found"
        capture_step "voice-assistant-not-found"
      fi
    fi
    if [[ -n "$assistant_center" ]]; then
      read -r assistant_x assistant_y <<< "$assistant_center"
      adb shell input swipe "$assistant_x" "$assistant_y" "$assistant_x" "$assistant_y" 2200 >/dev/null 2>&1 || mark_failed "voice-assistant-long-press"

      voice_reply_seen=0
      voice_reply_ui_seen=0
      voice_reply_markers_seen=0
      deadline=$((SECONDS + 180))
      while [[ "$SECONDS" -lt "$deadline" ]]; do
        if ! assert_app_alive "during-voice-test"; then
          break
        fi
        if wait_for_desc "voice-session-transcript" 1 && wait_for_desc "voice-session-assistant-turn" 1; then
          voice_reply_seen=1
          voice_reply_ui_seen=1
          break
        fi
        if wait_for_text "$voice_expected_reply" 1; then
          voice_reply_seen=1
          voice_reply_ui_seen=1
          break
        fi
        if scan_voice_reply_markers "$voice_log_start_line"; then
          voice_reply_seen=1
          voice_reply_markers_seen=1
          break
        fi
        sleep 1
      done
      if [[ "$voice_reply_seen" != "1" ]]; then
        mark_failed "voice-session-assistant-turn-not-visible"
      fi
      if [[ "$voice_reply_ui_seen" == "1" ]]; then
        wait_for_desc "voice-session-transcript" 2 || mark_failed "voice-session-transcript-not-visible"
        wait_for_desc "voice-session-user-turn" 2 || mark_failed "voice-session-user-turn-not-visible"
        wait_for_desc "voice-session-assistant-turn" 2 || mark_failed "voice-session-assistant-turn-not-visible"
        if ! wait_for_text "$voice_expected_reply" 15; then
          mark_failed "voice-reply-language-mismatch-${EXPO_PUBLIC_E2E_REPLY_LANGUAGE}"
        fi
      else
        record_skip "Voice reply UI was visible in screenshots but unavailable to uiautomator; strict voice telemetry markers were used"
      fi
      if [[ "$voice_reply_ui_seen" == "1" && "$voice_query_lower" == *"spitzola"* ]]; then
        if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "en" ]]; then
          wait_for_text "Spitzola" 10 || mark_failed "voice-spitzola-term-missing"
          wait_for_text "misheard" 10 || wait_for_text "misspelled" 10 || mark_failed "voice-spitzola-uncertainty-missing"
          if wait_for_text "Hi. How can I help?" 1; then
            mark_failed "voice-spitzola-routed-to-greeting"
          fi
        else
          wait_for_text "clear-aa" 2 || wait_for_text "kandupidikka" 2 || wait_for_text "nu" 2 || mark_failed "voice-tamil-local-style-missing"
        fi
      fi
      if [[ "$voice_reply_ui_seen" == "1" && "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "en" ]]; then
        xml_path="$(dump_ui "voice-language-english")"
        if [[ -s "$xml_path" ]] && grep -Eq "[\x{0B80}-\x{0BFF}]" "$xml_path" 2>/dev/null; then
          mark_failed "voice-english-reply-contained-tamil-script"
        fi
      fi

      if [[ "$voice_reply_ui_seen" == "1" ]] && wait_for_text "Hold the assistant. Your speech and reply will appear here." 1; then
        mark_failed "voice-empty-helper-visible"
      fi
      if [[ "$voice_reply_ui_seen" == "1" ]] && wait_for_desc "voice-reply-status" 1; then
        mark_failed "voice-reply-status-visible"
      fi
      if [[ "$voice_reply_ui_seen" == "1" ]] && wait_for_desc "voice-last-reply" 1; then
        mark_failed "voice-last-reply-visible"
      fi
      capture_step "voice-ui-clean"

      voice_markers_seen="$voice_reply_markers_seen"
      deadline=$((SECONDS + 25))
      while [[ "$SECONDS" -lt "$deadline" ]]; do
        if scan_voice_reply_markers "$voice_log_start_line"; then
          voice_markers_seen=1
          break
        fi
        sleep 1
      done
      if [[ "$voice_markers_seen" != "1" ]]; then
        mark_failed "voice-telemetry-markers-missing"
      fi
      if [[ -f "$ARTIFACT_DIR/logcat-full.log" ]] && \
        tail -n "+$((voice_log_start_line + 1))" "$ARTIFACT_DIR/logcat-full.log" | \
          grep -E "client_voice_reply_tts_failed|client_voice_reply_playback_failed" > "$ARTIFACT_DIR/voice-tts-failures.log" 2>/dev/null; then
        mark_failed "voice-tts-failed"
      fi
      if [[ -f "$ARTIFACT_DIR/logcat-full.log" ]] && \
        tail -n "+$((voice_log_start_line + 1))" "$ARTIFACT_DIR/logcat-full.log" | \
          grep -E "predicted_label['\": ]+greeting|route_taken['\": ]+agent_local_greeting|agent_local_greeting" > "$ARTIFACT_DIR/voice-greeting-misroute.log" 2>/dev/null; then
        mark_failed "voice-greeting-misroute"
      fi
      scan_crashes
      capture_step "voice-after"
    fi
fi

if ! swipe_voice_to_chat || ! wait_for_desc "chat-input" 10; then
  adb shell input keyevent 4 >/dev/null 2>&1 || true
  if wait_for_desc "chat-input" 10; then
    record_skip_once "voice-swipe-right-close-used-back-fallback"
  elif ensure_chat_input_ready "voice-close-recover-chat"; then
    record_skip_once "voice-swipe-right-close-used-chat-recovery"
  else
    mark_failed "voice-swipe-right-close"
  fi
fi
capture_step "voice-closed"
assert_desc_absent "chat-mic-button" "chat-mic-button-absent-after-voice" || true

if is_truthy "${EXPO_PUBLIC_E2E_MOCK_HANDS_FREE:-}"; then
  hands_free_log_start_line=0
  if [[ -f "$ARTIFACT_DIR/logcat-full.log" ]]; then
    hands_free_log_start_line="$(wc -l < "$ARTIFACT_DIR/logcat-full.log" | tr -d '[:space:]')"
  fi

  capture_step "hands-free-before"
  assert_desc_absent "chat-mic-button" "chat-mic-button-absent-before-hands-free" || true

  hands_free_trigger_tapped=0
  if wait_for_desc "e2e-hands-free-trigger-button" 20; then
    if tap_desc "e2e-hands-free-trigger-button"; then
      hands_free_trigger_tapped=1
    else
      mark_failed "tap-e2e-hands-free-trigger"
      capture_step "hands-free-trigger-tap-failed"
    fi
  else
    record_skip "e2e-hands-free-trigger-desc-not-found; used coordinate fallback"
    capture_step "hands-free-trigger-desc-not-found"
    if tap_desc "e2e-hands-free-trigger-button" || tap_text "E2E hands-free"; then
      hands_free_trigger_tapped=1
    elif tap_e2e_hands_free_trigger_fallback; then
      hands_free_trigger_tapped=1
    else
      mark_failed "e2e-hands-free-trigger-not-found"
      capture_step "hands-free-trigger-not-found"
    fi
  fi

  if [[ "$hands_free_trigger_tapped" == "1" ]]; then
    hands_free_reply_seen=0
    hands_free_reply_ui_seen=0
    hands_free_markers_seen=0
    deadline=$((SECONDS + 240))
    while [[ "$SECONDS" -lt "$deadline" ]]; do
      if ! assert_app_alive "during-hands-free-test"; then
        break
      fi
      if wait_for_desc "voice-session-assistant-turn" 1; then
        hands_free_reply_seen=1
        hands_free_reply_ui_seen=1
        break
      fi
      if wait_for_desc "voice-session-transcript" 1 && wait_for_text "$voice_expected_reply" 1; then
        hands_free_reply_seen=1
        hands_free_reply_ui_seen=1
        break
      fi
      if scan_hands_free_reply_markers "$hands_free_log_start_line"; then
        hands_free_reply_seen=1
        hands_free_markers_seen=1
        break
      fi
      sleep 1
    done

    if [[ "$hands_free_reply_seen" != "1" ]]; then
      mark_failed "hands-free-reply-not-visible"
      capture_step "hands-free-reply-not-visible"
    fi

    if [[ "$hands_free_reply_ui_seen" == "1" ]]; then
      wait_for_voice_mode_ready || mark_failed "hands-free-modal-not-open"
      wait_for_desc "voice-session-transcript" 3 || mark_failed "hands-free-transcript-not-visible"
      wait_for_desc "voice-session-user-turn" 3 || mark_failed "hands-free-user-turn-not-visible"
      wait_for_desc "voice-session-assistant-turn" 3 || mark_failed "hands-free-assistant-turn-not-visible"
      if ! wait_for_text "$voice_expected_reply" 4; then
        mark_failed "hands-free-reply-language-mismatch-${EXPO_PUBLIC_E2E_REPLY_LANGUAGE}"
      fi
    else
      record_skip "Hands-free reply UI was visible in screenshots but unavailable to uiautomator; strict command-audio telemetry markers were used"
    fi

    hands_free_status_seen=0
    if [[ "$hands_free_reply_ui_seen" == "1" ]]; then
      deadline=$((SECONDS + 60))
      while [[ "$SECONDS" -lt "$deadline" ]]; do
        if wait_for_text "Listening" 1; then
          hands_free_status_seen=1
          break
        fi
        sleep 1
      done
    elif [[ "$hands_free_markers_seen" == "1" ]]; then
      hands_free_status_seen=1
    fi
    if [[ "$hands_free_status_seen" != "1" ]]; then
      mark_failed "hands-free-listening-resumed"
    fi

    deadline=$((SECONDS + 60))
    while [[ "$SECONDS" -lt "$deadline" ]]; do
      if scan_hands_free_reply_markers "$hands_free_log_start_line"; then
        hands_free_markers_seen=1
        break
      fi
      sleep 1
    done
    if [[ "$hands_free_markers_seen" != "1" ]]; then
      mark_failed "hands-free-telemetry-markers-missing"
    fi
    if [[ -f "$ARTIFACT_DIR/logcat-full.log" ]] && \
      tail -n "+$((hands_free_log_start_line + 1))" "$ARTIFACT_DIR/logcat-full.log" | \
        grep -E "client_voice_reply_tts_failed|client_voice_reply_playback_failed" > "$ARTIFACT_DIR/hands-free-tts-failures.log" 2>/dev/null; then
      mark_failed "hands-free-tts-failed"
    fi

    capture_step "hands-free-after-reply"

    hands_free_stop_tapped=0
    if wait_for_desc "e2e-hands-free-stop-button" 15; then
      if tap_desc "e2e-hands-free-stop-button"; then
        hands_free_stop_tapped=1
      else
        mark_failed "tap-e2e-hands-free-stop"
      fi
    else
      record_skip "e2e-hands-free-stop-desc-not-found; used coordinate fallback"
      if tap_desc "e2e-hands-free-stop-button" || tap_text "E2E stop" || tap_e2e_hands_free_stop_fallback; then
        hands_free_stop_tapped=1
      else
        mark_failed "e2e-hands-free-stop-not-found"
      fi
    fi
    if [[ "$hands_free_stop_tapped" == "1" ]]; then
      sleep 2
      if ! wait_for_text "Listening" 8 && ! wait_for_desc "chat-input" 8; then
        if ensure_chat_input_ready "hands-free-stop-recover-chat"; then
          record_skip_once "hands-free-stop-used-chat-recovery"
        else
          mark_failed "hands-free-stop-did-not-return-to-wake"
        fi
      fi
    fi
    capture_step "hands-free-after-stop"
    assert_desc_absent "chat-mic-button" "chat-mic-button-absent-after-hands-free" || true
    ensure_chat_input_ready "after-hands-free" || mark_failed "chat-input-not-ready-after-hands-free"
  fi
fi

for message in "hello" "what can you do" "tell me about solo leveling"; do
  label="$(printf '%s' "$message" | tr -c 'A-Za-z0-9' '_' | tr '[:upper:]' '[:lower:]')"
  is_general_question=0
  input_clear_timeout=30
  result_wait_seconds=8
  if [[ "$message" == "tell me about solo leveling" ]]; then
    is_general_question=1
    input_clear_timeout=90
    result_wait_seconds=90
  fi

  dismiss_expo_warning || true
  if ! ensure_chat_input_ready "before-message-${label}"; then
    mark_failed "chat-input-not-ready-${label}"
    continue
  fi
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
  if ! tap_chat_send_button; then
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

if is_truthy "${EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT:-}"; then
  if [[ "$EXPO_PUBLIC_E2E_REPLY_LANGUAGE" == "ta" ]]; then
    life_message="இன்று நான் எவ்வளவு நடந்தேன்? Phone எவ்வளவு நேரம் use பண்ணினேன்?"
  else
    life_message="How much did I walk today and how long did I use my phone?"
  fi
  life_label="life-context"
  dismiss_expo_warning || true
  if ensure_chat_input_ready "before-${life_label}" && clear_chat_input; then
    type_text "$life_message"
    sleep 1
    local_start="$(now_ms)"
    if tap_chat_send_button && assert_app_alive "after-submit-${life_label}"; then
      wait_for_chat_input_cleared "$life_message" 90 "input-cleared-${life_label}" ||
        mark_failed "message-not-submitted-${life_label}"

      if ! wait_for_text "7,420" 30 && ! wait_for_text "7420" 10; then
        mark_failed "life-context-steps-missing"
      fi
      if ! wait_for_text "5.7" 10 && ! wait_for_text "5.6" 10 && ! wait_for_text "km" 10 && ! wait_for_text "meters" 10; then
        mark_failed "life-context-distance-missing"
      fi
      if ! wait_for_text "3.5 hours" 20 && ! wait_for_text "3.5" 10 && ! wait_for_text "210 minutes" 10 && ! wait_for_text "3.5 மணி" 10 && ! wait_for_text "3.5 hours" 10; then
        mark_failed "life-context-screen-time-missing"
      fi
      capture_step "after-${life_label}"
      local_end="$(now_ms)"
      RESPONSE_TIMINGS+=("${life_message}: $((local_end - local_start))ms")
    else
      mark_failed "tap-chat-send-button-${life_label}"
    fi
  else
    mark_failed "chat-input-not-ready-${life_label}"
  fi
fi

if tap_desc "chat-drawer-button" || tap_chat_drawer_fallback; then
  if ! wait_for_text "Voice" 8; then
    mark_failed "history-voice-kind-label-missing"
  fi
  if ! wait_for_text "Chat" 8; then
    mark_failed "history-chat-kind-label-missing"
  fi
  capture_step "history-kind-labels"
  adb shell input keyevent 4 >/dev/null 2>&1 || true
  wait_for_desc "chat-input" 5 || true
else
  mark_failed "history-drawer-not-opened"
fi

final_chat_xml="$ARTIFACT_DIR/ui-after-message-tell_me_about_solo_leveling.xml"
if [[ -f "$final_chat_xml" ]]; then
  if ! grep -Fqi 'text="hello"' "$final_chat_xml" 2>/dev/null; then
    mark_failed "first-message-not-visible-after-second"
  fi
  if ! grep -Fqi 'text="what can you do"' "$final_chat_xml" 2>/dev/null; then
    mark_failed "second-message-not-visible"
  fi
  if ! grep -Fqi 'text="tell me about solo leveling"' "$final_chat_xml" 2>/dev/null; then
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
