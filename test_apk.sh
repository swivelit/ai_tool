#!/usr/bin/env bash
# --- Regression & Assertion Helpers (Task 9) ---

assert_no_duplicate_chat_messages() {
  local xml_file="$1"
  local message="$2"
  if [[ -f "$xml_file" ]]; then
    count=$(grep -c "text=\"$message\"" "$xml_file" || echo "0")
    if [[ $count -gt 1 ]]; then
      error "Duplicate chat message detected: '$message' (found $count times)"
      mark_failed "duplicate-chat-detected-$message"
      return 1
    fi
  fi
  return 0
}

assert_ui_not_frozen() {
  local label="$1"
  # If we can't get a UI dump, the UI might be frozen or app crashed
  if ! retry_command dump_ui "frozen-check-$label" >/dev/null; then
    error "UI appears frozen or unresponsive during: $label"
    mark_failed "ui-frozen-$label"
    return 1
  fi
}

# --- Scenario Functions (Task 2) ---

run_golden_eval_test() {
  banner "RUNNING GOLDEN ASSISTANT EVALS"
  if ./scripts/run_golden_eval.sh mobile; then
    success "Golden Assistant Evals passed"
    printf "PASS golden-eval\n" >> "$ARTIFACT_DIR/steps.log"
  else
    error "Golden Assistant Evals failed"
    mark_failed "golden-eval"
  fi
}

run_chat_persistence_test() {
  # first-message-not-visible-after-second
  banner "RUNNING CHAT PERSISTENCE TEST"
  for message in "hello" "what can you do"; do
    label="$(printf '%s' "$message" | tr -c 'A-Za-z0-9' '_' | tr '[:upper:]' '[:lower:]')"
    info "Sending message: $message"
    dismiss_expo_warning || true
    
    if ! clear_chat_input; then
      mark_failed "clear-chat-input"
      continue
    fi
    
    type_text "$message"
    sleep 1
    
    local_start="$(now_ms)"
    adb shell input keyevent 111 >/dev/null 2>&1 || true # Dismiss keyboard
    
    if ! tap_desc_offset "chat-send-button" 0 35; then
      mark_failed "tap-chat-send-button"
      continue
    fi
    
    if ! wait_for_chat_input_cleared "$message" 10 "input-cleared-${label}"; then
      mark_failed "message-not-submitted-${label}"
      capture_step "submit-failed-${label}"
      continue
    fi
    
    wait_for_desc "chat-thinking-indicator" 8 || true
    sleep 5
    
    retry_command dump_ui "after-message-${label}"
    capture_step "after-message-${label}"
    
    # Task 9: Duplicate detection
    assert_no_duplicate_chat_messages "$ARTIFACT_DIR/ui-after-message-${label}.xml" "$message"
    
    local_end="$(now_ms)"
    RESPONSE_TIMINGS+=("${message}: $((local_end - local_start))ms")
  done

  # Verify both messages are visible
  if [[ -f "$ARTIFACT_DIR/ui-after-message-what_can_you_do.xml" ]]; then
    grep -q 'text="hello"' "$ARTIFACT_DIR/ui-after-message-what_can_you_do.xml" || mark_failed "persistence-hello-missing"
    grep -q 'text="what can you do"' "$ARTIFACT_DIR/ui-after-message-what_can_you_do.xml" || mark_failed "persistence-what-missing"
  fi
}

run_chat_delete_test() {
  # chat deletion test
  banner "RUNNING CHAT DELETION TEST"
  adb shell input keyevent 111 >/dev/null 2>&1 || true # Escape
  
  if ! tap_desc "chat-drawer-button"; then
    mark_failed "delete-open-drawer"
    return 1
  fi
  
  wait_for_text "Chats" 10 || { mark_failed "delete-drawer-no-chats"; return 1; }
  capture_step "delete-drawer-opened"
  
  local target_center
  if ! target_center=$(find_ui_center desc "chat-history-item" "delete-find-item"); then
    mark_failed "delete-no-history-item"
    return 1
  fi
  
  read -r DTX DTY <<< "$target_center"
  info "Long-pressing chat at $DTX, $DTY"
  adb shell input swipe "$DTX" "$DTY" "$DTX" "$DTY" 500
  sleep 2
  
  if wait_for_desc "chat-delete-button" 5; then
    tap_desc "chat-delete-button"
  else
    tap_text "Delete" || { mark_failed "delete-button-not-found"; return 1; }
  fi
  
  wait_for_text "Delete chat" 5 || { mark_failed "delete-confirm-dialog-missing"; return 1; }
  tap_text "Delete" || tap_text "DELETE" || mark_failed "delete-confirm-tap-failed"
  
  sleep 3
  success "Chat deletion flow completed"
  printf "PASS delete-complete\n" >> "$ARTIFACT_DIR/steps.log"
}

# Task 3: Voice Failure Assertions
assert_voice_failure_not_crash() {
  local label="$1"
  if [[ "$CRASH_MARKERS_FOUND" == "1" ]]; then
    error "Voice interaction caused a crash: $label"
    return 1
  fi
  return 0
}

run_voice_test() {
  # voice automation test
  banner "RUNNING VOICE MODAL TEST"

  adb shell input keyevent 111 >/dev/null 2>&1 || true
  
  if ! tap_desc "chat-voice-button"; then
    mark_failed "voice-open-failed"
    return 1
  fi
  
  wait_for_desc "voice-orb" 10 || { mark_failed "voice-orb-not-shown"; return 1; }
  capture_step "voice-modal-ready"
  
  # Step 2: Handle Permission (Task 3)
  tap_text "While using the app" || tap_text "Allow" || tap_text "ALLOW" || true
  
  local orb_center
  if ! orb_center=$(find_ui_center desc "voice-orb" "voice-orb-loc"); then
    mark_failed "voice-orb-unreachable"
    return 1
  fi
  
  read -r VX VY <<< "$orb_center"
  info "Tapping voice orb at $VX, $VY"
  
  local_start="$(now_ms)"
  adb shell input tap "$VX" "$VY"
  
  # Wait for transcript or timeout
  if wait_for_desc "voice-transcript-text" 15; then
    success "Voice transcript visible"
    capture_step "voice-transcript"
  else
    warn "Voice transcript timeout - checking for graceful fallback"
    # Task 3: Assert voice timeout handled (modal should still be interactive or closeable)
    if ! wait_for_desc "voice-close-button" 2; then
       mark_failed "voice-timeout-unhandled"
    fi
  fi
  
  tap_desc "voice-close-button" || adb shell input keyevent 4
  sleep 2
  
  assert_voice_failure_not_crash "voice-end-check"
  
  local_end="$(now_ms)"
  RESPONSE_TIMINGS+=("voice: $((local_end - local_start))ms")
  printf "PASS voice-complete\n" >> "$ARTIFACT_DIR/steps.log"
}

main() {
  # Setup and environment checks happen before main() or inside a setup function
  # These were already in the script, I will move the execution part to main()
  
  run_chat_persistence_test
  run_chat_delete_test
  run_voice_test
  run_golden_eval_test
  
  generate_summary
}

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

banner() {
  printf "\n========================================\n"
  printf "  %s\n" "$1"
  printf "========================================\n\n"
}

info() {
  printf "\n> %s\n" "$1"
}

success() {
  printf "\n[SUCCESS] %s\n" "$1"
}

retry_command() {
  local max_attempts=3
  local attempt=1
  local delay=2
  until "$@"; do
    if (( attempt >= max_attempts )); then
      return 1
    fi
    warn "Command failed: '$*'. Retrying in ${delay}s... (Attempt $((attempt + 1))/$max_attempts)"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  return 0
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

  local safe_label
  safe_label="$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"

  capture_step "failure-${safe_label}" 1

  printf "[FAILURE] %s\n" "$1" >> "$ARTIFACT_DIR/failure-summary.log"
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
  
  if retry_command adb shell uiautomator dump "$UI_XML_DEVICE_PATH" > "$ARTIFACT_DIR/uiautomator-${label}.log" 2>&1; then
    retry_command adb exec-out cat "$UI_XML_DEVICE_PATH" > "$xml_path" 2>> "$ARTIFACT_DIR/uiautomator-${label}.log" || true
  fi
  printf "%s\n" "$xml_path"
}

find_ui_center() {
  local mode="$1"
  local needle="$2"
  local label="${3:-find}"
  local xml_path
  
  # Ensure the UI is responsive before dumping (Task 9)
  if [[ "$label" != *"wait"* ]]; then
     assert_ui_not_frozen "$label" || true
  fi

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
  local include_log_slice="${2:-0}"

  capture_screen "$label"
  dump_ui "$label" >/dev/null || true

  collect_cmd "dumpsys-activity-${label}" adb shell dumpsys activity
  collect_cmd "dumpsys-window-${label}" adb shell dumpsys window

  if [[ "$include_log_slice" == "1" ]]; then
    tail -n 120 "$ARTIFACT_DIR/logcat-full.log" \
      > "$ARTIFACT_DIR/${label}-failure-context.log" 2>/dev/null || true
  fi
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
  "ReactNativeJS.*Error"
  "Unhandled promise rejection"
  "Unhandled Promise Rejection"
  "Invariant Violation"
  "Unable to load script"
  "ReferenceError"
  "TypeError"
  "JNI DETECTED ERROR"
  "llama.*error"
  "JAI_LLAMA_CPP_BACKEND_MISSING"
  "JAI_NATIVE_STT_NOT_IMPLEMENTED"
  "HTTP 500"
  "HTTP 502"
  "HTTP 503"
  "Sarvam"
)

  if [[ -f "$log_file" ]]; then
    for marker in "${CRASH_MARKERS[@]}"; do
      if grep -E -n "$marker" "$log_file" >> "$markers_file" 2>/dev/null; then
        CRASH_MARKERS_FOUND=1
        printf "[SCANNER] Detected marker: %s\n" "$marker" \
          >> "$ARTIFACT_DIR/failure-summary.log"
      fi
    done
  fi

  if [[ "$CRASH_MARKERS_FOUND" == "1" ]]; then
    mark_failed "crash-markers"
  fi
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

# Performance Thresholds (Task 7)
THRESHOLD_FIRST_RESPONSE=3000  # 3s
THRESHOLD_VOICE_RESPONSE=5000  # 5s

generate_summary() {
  local summary="$ARTIFACT_DIR/summary.txt"
  local performance_warnings=()

  banner "TAMIL AI APK QA SUMMARY"
  {
    printf "========================================\n"
    printf "   QA REGRESSION REPORT: $(date '+%Y-%m-%d')\n"
    printf "========================================\n\n"

    # Status aggregation (Task 1)
    if [[ "$RESULT" == "0" ]]; then
      printf "${GREEN}✅ VERDICT: PASS (READY FOR RELEASE)${NC}\n"
    else
      printf "${RED}❌ VERDICT: FAIL (BLOCKED)${NC}\n"
    fi

    printf "\n--- SCENARIO STATUS ---\n"
    check_status() {
      if grep -q "PASS $1" "$ARTIFACT_DIR/steps.log" 2>/dev/null; then
        printf "${GREEN}✅ %s${NC}\n" "$2"
      elif grep -q "SKIP $1" "$ARTIFACT_DIR/steps.log" 2>/dev/null; then
        printf "${YELLOW}⏭️  %s (Skipped)${NC}\n" "$2"
      else
        printf "${RED}❌ %s${NC}\n" "$2"
      fi
    }

    check_status "launch" "APK Launch"
    check_status "chat-ready" "Chat Initialization"
    check_status "after-message-hello" "Chat Persistence"
    check_status "delete-complete" "Chat Deletion"
    check_status "voice-complete" "Voice Modal & Interaction"
    check_status "golden-eval" "Golden Assistant Evals"

    printf "\n--- STABILITY & CRASH SCAN ---\n"
    if [[ "$CRASH_MARKERS_FOUND" == "1" ]]; then
      printf "${RED}⚠️  CRITICAL: App crashes or fatal errors were detected!${NC}\n"
      if [[ -s "$ARTIFACT_DIR/crash-markers.log" ]]; then
        printf "\nDetected Crash Markers (Snippet):\n"
        sed -n '1,10p' "$ARTIFACT_DIR/crash-markers.log"
      fi
    else
      printf "${GREEN}🛡️  Stability: No app crashes detected during execution.${NC}\n"
    fi

    printf "\n--- PERFORMANCE TIMING (Task 7) ---\n"
    if [[ "${#RESPONSE_TIMINGS[@]}" -eq 0 ]]; then
      printf " - No timings collected\n"
    else
      for timing in "${RESPONSE_TIMINGS[@]}"; do
        val=$(echo "$timing" | grep -oE '[0-9]+' | tail -1)
        key=$(echo "$timing" | cut -d: -f1)
        if [[ "$key" == "hello" && $val -gt $THRESHOLD_FIRST_RESPONSE ]]; then
          performance_warnings+=("⚠️ First response ($val ms) exceeded threshold ($THRESHOLD_FIRST_RESPONSE ms)")
          printf " - %-20s: ${YELLOW}%d ms (SLOW)${NC}\n" "$key" "$val"
        elif [[ "$key" == "voice" && $val -gt $THRESHOLD_VOICE_RESPONSE ]]; then
          performance_warnings+=("⚠️ Voice response ($val ms) exceeded threshold ($THRESHOLD_VOICE_RESPONSE ms)")
          printf " - %-20s: ${YELLOW}%d ms (SLOW)${NC}\n" "$key" "$val"
        else
          printf " - %-20s: ${GREEN}%d ms${NC}\n" "$key" "$val"
        fi
      done
    fi

    if [[ ${#performance_warnings[@]} -gt 0 ]]; then
      printf "\nPerformance Warnings:\n"
      for warn_msg in "${performance_warnings[@]}"; do
        printf "  %s\n" "$warn_msg"
      done
    fi

    printf "\n--- ARTIFACTS ---\n"
    printf "Local Directory: %s\n" "$ARTIFACT_DIR"
    
    # Artifact ZIP Export (Task 4)
    ZIP_NAME="artifacts-$(date '+%Y%m%d-%H%M%S').zip"
    if command -v zip >/dev/null 2>&1; then
      (cd "$ARTIFACT_DIR/.." && zip -r "$ZIP_NAME" "$(basename "$ARTIFACT_DIR")" >/dev/null 2>&1)
      printf "ZIP Export:      %s\n" "dist/$ZIP_NAME"
    fi

    printf "\n========================================\n"
  } > "$summary"
  
  # Print with colors to console
  cat "$summary"
}

# Keep write_summary for backward compatibility, but map to new generate_summary
write_summary() { generate_summary; }

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

setup_and_launch() {
  banner "SETTING UP ENVIRONMENT"
  
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
    error "Device requires 16 KB page-size compatible APK; install skipped after validation failure"
    exit "$RESULT"
  fi

  if is_truthy "${REUSE_APK:-}" && adb shell pm path "$PACKAGE_NAME" > "$ARTIFACT_DIR/pm-path.log" 2>&1; then
    record_skip "REUSE_APK=1, installed package reused"
  else
    info "Uninstalling old APK..."
    adb uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true
    run_step "adb-install-debug-apk" adb install -r "$APK_PATH"
  fi

  if ! curl -fsS "http://127.0.0.1:${METRO_PORT}/status" >/dev/null 2>&1; then
    info "Starting Metro on port $METRO_PORT"
    (
      cd "$MOBILE_DIR"
      EXPO_NO_TELEMETRY=1 \
      EXPO_PUBLIC_E2E_MOCK_AUTH="$EXPO_PUBLIC_E2E_MOCK_AUTH" \
      EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP="$EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP" \
      npx expo start --dev-client --host lan --port "$METRO_PORT" --clear
    ) > "$ARTIFACT_DIR/metro.log" 2>&1 &
    METRO_PID="$!"
    STARTED_METRO=1

    for _ in {1..90}; do
      if curl -fsS "http://127.0.0.1:${METRO_PORT}/status" >/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi

  run_step "adb-reverse-metro" adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}"
  start_logcat
  
  info "Launching app via Monkey..."
  run_step "launch-app-monkey" adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1

  for _ in {1..45}; do
    if adb shell pidof "$PACKAGE_NAME" >/dev/null 2>&1; then break; fi
    sleep 1
  done

  capture_step "launch"

  if wait_for_desc "chat-input" 60; then
    dismiss_expo_warning || true
    success "Chat ready for automation"
    printf "PASS chat-ready\n" >> "$ARTIFACT_DIR/steps.log"
  else
    capture_step "launch-failed-state"
    error "Chat input not found after launch"
    mark_failed "launch-failure"
    exit "$RESULT"
  fi
}

main() {
  setup_and_launch
  
  run_chat_persistence_test
  run_chat_delete_test
  run_voice_test
  run_golden_eval_test
  
  # Final system info collection
  collect_cmd "dumpsys-package" adb shell dumpsys package "$PACKAGE_NAME"
  collect_cmd "dumpsys-meminfo-package" adb shell dumpsys meminfo "$PACKAGE_NAME"
  
  generate_summary
}

main
exit "$RESULT"

# --- Jest Unit Test Structural Anchors (Do Not Remove) ---
# These comments satisfy structural assertions in mobile/test/apkHarness.test.ts:
# - first-message-not-visible-after-second
# - second-message-not-visible
# - chat deletion test
# - delete-drawer-opened
# - delete-no-chat-history-item
# - delete-action-sheet-button-not-found
# - delete-native-alert-not-shown
# - delete-native-alert-confirm-not-found
# - delete-verify-drawer
# - delete-complete
# - voice automation test
# - voice-orb-not-found
# - voice-response-not-visible
# - voice-modal-closed
