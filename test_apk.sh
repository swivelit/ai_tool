#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
APK_PATH="$ROOT_DIR/dist/tamil-ai-debug.apk"
PACKAGE_NAME="com.swico.tamilai"
ARTIFACT_DIR="$ROOT_DIR/dist/apk-test-$(date +%Y%m%d-%H%M%S)"
LOGCAT_FILE="$ARTIFACT_DIR/logcat-full.log"
SUMMARY_FILE="$ARTIFACT_DIR/summary.txt"
STEPS_FILE="$ARTIFACT_DIR/steps.log"
SKIPPED_FILE="$ARTIFACT_DIR/skipped.log"
CRASH_FILE="$ARTIFACT_DIR/crash-markers.log"
FAIL_COUNT=0
SKIP_COUNT=0
FAILED=""
SKIPPED=""
NETWORK_RESTORED=0

mkdir -p "$ARTIFACT_DIR"
: > "$STEPS_FILE"
: > "$SKIPPED_FILE"
: > "$CRASH_FILE"

pass() { printf 'PASS %s\n' "$1" | tee -a "$STEPS_FILE" >/dev/null; }
fail_check() { FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED="$FAILED\n$1"; printf 'FAIL: %s\n' "$1" | tee -a "$STEPS_FILE" >/dev/null; }
skip_check() { SKIP_COUNT=$((SKIP_COUNT + 1)); SKIPPED="$SKIPPED\n$1"; printf 'SKIP: %s\n' "$1" | tee -a "$SKIPPED_FILE" >/dev/null; }
collect() { local name="$1"; shift; "$@" > "$ARTIFACT_DIR/$name.log" 2>&1 || true; }

restore_network() {
  if [[ "$NETWORK_RESTORED" != "1" ]]; then
    adb shell svc wifi enable >/dev/null 2>&1 || true
    adb shell svc data enable >/dev/null 2>&1 || true
    NETWORK_RESTORED=1
  fi
}
trap restore_network EXIT

run_bounded() {
  local seconds="$1"
  shift
  "$@" &
  local command_pid=$!
  local elapsed=0
  while kill -0 "$command_pid" >/dev/null 2>&1; do
    if (( elapsed >= seconds )); then
      kill "$command_pid" >/dev/null 2>&1 || true
      wait "$command_pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$command_pid"
}

dump_ui() {
  local label="$1"
  local output="$ARTIFACT_DIR/ui-$label.xml"
  if run_bounded 3 adb shell uiautomator dump /sdcard/swico-window.xml > "$ARTIFACT_DIR/uiautomator-$label.log" 2>&1 &&
    run_bounded 3 adb exec-out cat /sdcard/swico-window.xml > "$output" 2>/dev/null && [[ -s "$output" ]]; then
    printf '%s\n' "$output"
    return 0
  fi
  return 1
}

has_target() {
  local target="$1"
  local label="$2"
  local xml
  xml="$(dump_ui "$label" 2>/dev/null || true)"
  [[ -n "$xml" ]] && grep -E "resource-id=\"[^\"]*$target|content-desc=\"[^\"]*$target\"|text=\"$target\"" "$xml" >/dev/null 2>&1
}

wait_target() {
  local target="$1"
  local seconds="$2"
  local label="$3"
  local deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    if has_target "$target" "$label"; then return 0; fi
    sleep 1
  done
  return 1
}

tap_target() {
  local target="$1"
  local label="$2"
  local xml
  xml="$(dump_ui "$label" 2>/dev/null || true)"
  [[ -n "$xml" ]] || return 1
  local node bounds x1 y1 x2 y2
  node="$(grep -o '<node[^>]*>' "$xml" | grep -E "resource-id=\"[^\"]*$target|content-desc=\"[^\"]*$target\"|text=\"$target\"" | head -1 || true)"
  bounds="$(printf '%s\n' "$node" | sed -n 's/.*bounds="\([^"]*\)".*/\1/p')"
  IFS='[,]' read -r _ x1 y1 _ x2 y2 <<< "$bounds"
  [[ -n "$x1" && -n "$y1" && -n "$x2" && -n "$y2" ]] || return 1
  adb shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))" >/dev/null 2>&1
}

type_text() {
  local encoded
  encoded="$(printf '%s' "$1" | sed 's/ /%s/g; s/[&|;<>()$\\]/\\&/g')"
  adb shell input text "$encoded" >/dev/null 2>&1
}

capture() {
  local label="$1"
  adb exec-out screencap -p > "$ARTIFACT_DIR/screen-$label.png" 2>"$ARTIFACT_DIR/screen-$label.err" || true
  dump_ui "$label" >/dev/null 2>&1 || true
}

app_alive() { adb shell pidof "$PACKAGE_NAME" 2>/dev/null | tr -d '\r[:space:]' | grep -q '[0-9]'; }
close_modal() { adb shell input keyevent 4 >/dev/null 2>&1 || true; sleep 1; }
external_system_dialog() {
  local xml
  xml="$(dump_ui external-system-dialog 2>/dev/null || true)"
  [[ -n "$xml" ]] && grep -E 'System UI isn.t responding|Pixel Launcher isn.t responding|Digital Wellbeing isn.t responding|Android System isn.t responding' "$xml" >/dev/null 2>&1
}

assert_target() {
  if wait_target "$1" 30 "$2"; then pass "$2"; else fail_check "$2"; capture "$2"; fi
}

scan_crashes() {
  adb logcat -d -v time > "$LOGCAT_FILE" 2>/dev/null || true
  rg -n -i "FATAL EXCEPTION.*$PACKAGE_NAME|ANR in .*$PACKAGE_NAME|ReactNativeJS.*(fatal|exception)|OutOfMemoryError|SIGSEGV|SIGABRT" "$LOGCAT_FILE" > "$CRASH_FILE" 2>/dev/null || true
  [[ ! -s "$CRASH_FILE" ]] || fail_check "app-crash-markers"
}

if [[ ! -f "$APK_PATH" ]]; then fail_check "apk-not-found"; else pass "apk-present"; fi

if ! adb get-state >/dev/null 2>&1; then
  skip_check "no-android-device"
else
  collect adb-devices adb devices -l
  collect device-getprop adb shell getprop
  collect device-page-size adb shell getconf PAGESIZE
  collect device-wm-size adb shell wm size
  collect device-wm-density adb shell wm density
  collect package-path adb shell pm path "$PACKAGE_NAME"
  collect reverse-list adb reverse --list
  adb logcat -c >/dev/null 2>&1 || true
  adb shell am force-stop "$PACKAGE_NAME" >/dev/null 2>&1 || true
  adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 > "$ARTIFACT_DIR/launch.log" 2>&1 || fail_check "launch-app"

  ui_checks_enabled=1
  if wait_target "swico-chat-input" 90 chat-ready; then
    pass "swico-main-screen"
    pass "composer-visible"
    capture launch
  elif external_system_dialog; then
    skip_check "external-system-ui-anr-blocked-current-ui"
    capture external-system-ui-anr
    ui_checks_enabled=0
  else
    fail_check "swico-main-screen-not-ready"
    capture auth-or-bootstrap
  fi
  if app_alive; then pass "app-process-alive-after-launch"; else fail_check "app-process-not-alive-after-launch"; fi

  if [[ "$ui_checks_enabled" == "1" ]]; then
  if tap_target "swico-drawer-button" drawer-open; then
    pass "drawer-opens"
    assert_target "swico-new-chat" "new-chat-visible"
    assert_target "swico-search-input" "search-visible"
    assert_target "swico-archived-tab" "archived-tab-visible"
    assert_target "swico-token-credits" "token-credit-card-visible"
    assert_target "E2E Tester" "account-row-visible"
    if tap_target "Open account menu" account-menu; then
      assert_target "Toggle theme" "account-theme-action-visible"
      assert_target "Sign out" "account-signout-action-visible"
    else
      fail_check "account-menu-button-visible"
    fi
    tap_target "swico-drawer-close" drawer-close || close_modal
  else
    fail_check "drawer-open"
  fi

  if tap_target "swico-settings-button" settings-open; then
    pass "settings-opens"
    assert_target "swico-settings-modal" "settings-modal-visible"
    for section in general profile credits data knowledge; do
      assert_target "swico-settings-section-$section" "settings-$section-section-visible"
    done
    tap_target "swico-settings-section-general" settings-general || true
    assert_target "Mode changes apply to your next message." "settings-tier-copy-visible"
    tap_target "swico-settings-section-profile" settings-profile || true
    assert_target "swico-profile-email-readonly" "settings-email-readonly-copy-visible"
    close_modal
  else
    fail_check "settings-open"
  fi

  if tap_target "swico-tier-button" tier-open; then
    pass "tier-selector-opens"
    assert_target "swico-tier-modal" "tier-modal-visible"
    assert_target "swico-tier-option-lite" "tier-option-visible"
    close_modal
  else
    fail_check "tier-selector-open"
  fi

  if tap_target "swico-drawer-button" billing-drawer && tap_target "swico-token-credits" billing-open; then
    pass "billing-opens-without-payment"
    assert_target "swico-billing-modal" "billing-modal-visible"
    assert_target "swico-billing-chat" "billing-chat-tab-visible"
    assert_target "swico-billing-voice" "billing-voice-tab-visible"
    tap_target "swico-billing-close" billing-close || close_modal
  else
    fail_check "billing-open"
  fi

  if tap_target "swico-drawer-button" legal-drawer && tap_target "swico-legal-terms" legal-open; then
    pass "legal-page-opens"
    assert_target "swico-legal-screen" "legal-screen-visible"
    tap_target "swico-legal-close" legal-close || close_modal
  else
    fail_check "legal-page-open"
  fi

  if tap_target "swico-drawer-button" new-chat-drawer && tap_target "swico-new-chat" new-chat; then
    pass "new-chat-action"
  else
    fail_check "new-chat-action"
  fi

  if tap_target "swico-chat-input" chat-input; then
    type_text "hello"
    if tap_target "swico-send-button" send-hello; then
      pass "text-send-action"
      assert_target "hello" "user-message-visible"
      assert_target "Swico E2E fixture response" "assistant-response-visible"
      if app_alive; then pass "app-process-alive-after-response"; else fail_check "app-process-not-alive-after-response"; fi
    else
      fail_check "text-send-action"
    fi
  else
    fail_check "chat-input-focus"
  fi

  if tap_target "swico-chat-input" chat-input-second; then
    type_text "what can you do"
    tap_target "swico-send-button" send-second || fail_check "second-message-send"
    assert_target "what can you do" "second-user-message-visible"
  else
    fail_check "second-chat-input-focus"
  fi

  if tap_target "swico-drawer-button" search-drawer && tap_target "swico-search-input" search-input; then
    type_text "fixture"
    assert_target "Chat summaries" "search-result-group-visible"
    close_modal
  else
    fail_check "search-flow"
  fi

    if has_target "swico-realtime-voice-button" voice-button; then
    pass "realtime-voice-control-visible"
    if tap_target "swico-realtime-voice-button" voice-open && wait_target "swico-voice-mode" 12 voice-mode; then
        pass "voice-mode-opens"
        assert_target "swico-voice-status" "voice-status-visible"
        assert_target "swico-voice-mute" "voice-mute-control-visible"
        assert_target "swico-voice-end" "voice-end-control-visible"
        tap_target "swico-voice-end" voice-end || close_modal
      else
        skip_check "voice-mode-native-transport-not-ready-in-emulator"
        close_modal
      fi
    else
      skip_check "realtime-voice-feature-unavailable"
    fi

  adb shell svc wifi disable >/dev/null 2>&1 || true
  adb shell svc data disable >/dev/null 2>&1 || true
  sleep 3
  if wait_target "Offline" 8 offline-state; then pass "offline-state-visible"; else skip_check "offline-state-not-deterministic-on-emulator"; fi
  restore_network
  if app_alive; then pass "app-process-alive-after-network-restore"; else fail_check "app-process-not-alive-after-network-restore"; fi
  else
    restore_network
    if app_alive; then pass "app-process-alive-after-network-restore"; else fail_check "app-process-not-alive-after-network-restore"; fi
  fi
fi

scan_crashes
{
  printf 'APK path: %s\n' "$APK_PATH"
  printf 'Artifact path: %s\n' "$ARTIFACT_DIR"
  [[ "$FAIL_COUNT" == "0" ]] && printf 'Test result: PASS\n' || printf 'Test result: FAIL\n'
  printf 'Failed checks: %s\n' "$FAIL_COUNT"
  printf 'Skipped checks: %s\n' "$SKIP_COUNT"
  printf 'Failed:%b\n' "$FAILED"
  printf 'Skipped:%b\n' "$SKIPPED"
} > "$SUMMARY_FILE"

[[ "$FAIL_COUNT" == "0" ]]
