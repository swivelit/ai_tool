#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/play-console-fgs-microphone-demo"
PACKAGE_NAME="${PACKAGE_NAME:-com.swico.tamilai}"
DEVICE_VIDEO="/sdcard/swico-fgs-microphone-demo.mp4"
VIDEO_PATH="$OUT_DIR/swico-fgs-microphone-demo.mp4"
README_PATH="$OUT_DIR/README_SUBMISSION.txt"
LAUNCH_MODE="${LAUNCH_MODE:-debug}"
METRO_PORT="${METRO_PORT:-8081}"
VIDEO_SIZE="${VIDEO_SIZE:-720x1616}"
VIDEO_BIT_RATE="${VIDEO_BIT_RATE:-2000000}"
VIDEO_TIME_LIMIT="${VIDEO_TIME_LIMIT:-70}"
SCREEN_WIDTH=""
SCREEN_HEIGHT=""

info() {
  printf "\n▶ %s\n" "$1"
}

fail() {
  printf "\n❌ %s\n" "$1" >&2
  exit 1
}

ensure_adb() {
  command -v adb >/dev/null 2>&1 || fail "adb is required but was not found in PATH."
  adb get-state >/dev/null 2>&1 || fail "No connected Android device/emulator. Start one and verify with: adb devices"
}

read_screen_size() {
  local size
  size="$(adb shell wm size | awk -F': ' '/Physical size/ { print $2 }' | tr -d '\r')"
  SCREEN_WIDTH="${size%x*}"
  SCREEN_HEIGHT="${size#*x}"
  [[ -n "$SCREEN_WIDTH" && -n "$SCREEN_HEIGHT" && "$SCREEN_WIDTH" != "$SCREEN_HEIGHT" ]] \
    || fail "Could not read emulator screen size."
}

capture_screenshot() {
  local name="$1"
  adb shell screencap -p "/sdcard/${name}.png"
  adb pull "/sdcard/${name}.png" "$OUT_DIR/${name}.png" >/dev/null
}

grant_demo_permissions() {
  # Android 13+ blocks app notifications by default on a fresh emulator. The
  # foreground service can run without this grant, but Play review needs the
  # ongoing notification visible in the shade.
  adb shell pm grant "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
}

write_readme() {
  cat > "$README_PATH" <<EOF
Google Play Console FOREGROUND_SERVICE_MICROPHONE evidence package

Video file:
$VIDEO_PATH

Play Console checkbox recommendation:
Use case: Background audio input

Permission-use text to paste into Play Console:

Swico uses the microphone foreground service only when the user starts the hands-free voice assistant mode. The service listens for the configured wake phrase or voice command so the assistant can capture the user’s spoken request and respond without requiring the user to keep touching the screen. The feature is user initiated, visible in the app as a Listening state, and accompanied by an ongoing notification titled “Hands-free voice”. Audio is used only for voice command processing and assistant responses; it is not used for ads or hidden recording.

This task must start immediately because wake phrase and voice command detection is real time. If the microphone foreground task is delayed, paused, or restarted, the assistant may miss the user’s command or stop the hands-free session. When the user stops or closes the voice session, the app stops the hands-free microphone service.
EOF
}

launch_app() {
  if [[ "${SKIP_APK_LAUNCH:-0}" == "1" ]]; then
    info "Skipping repo launch flow because SKIP_APK_LAUNCH=1"
  else
    info "Launching APK with existing repo script (${LAUNCH_MODE})"
    export EXPO_PUBLIC_E2E_MOCK_AUTH="${EXPO_PUBLIC_E2E_MOCK_AUTH:-1}"
    export EXPO_PUBLIC_PLAY_FGS_MICROPHONE_DEMO="${EXPO_PUBLIC_PLAY_FGS_MICROPHONE_DEMO:-1}"
    export EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP="${EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP:-1}"
    unset EXPO_PUBLIC_E2E_MOCK_HANDS_FREE
    unset EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO
    unset RUN_APK_TESTS
    if [[ "$LAUNCH_MODE" == "release" ]]; then
      "$ROOT_DIR/launch-release_apk.sh"
    else
      "$ROOT_DIR/launch-debug_apk.sh"
    fi
  fi

  adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" >/dev/null 2>&1 || true
  grant_demo_permissions
  adb shell am force-stop "$PACKAGE_NAME" >/dev/null 2>&1 || true
  adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1 >/dev/null
}

drive_demo_flow() {
  info "Driving demo flow with adb input"
  read_screen_size
  local voice_x=$((SCREEN_WIDTH * 884 / 1000))
  local voice_y=$((SCREEN_HEIGHT * 957 / 1000))
  local permission_x=$((SCREEN_WIDTH / 2))
  local permission_y=$((SCREEN_HEIGHT * 515 / 1000))
  local shade_x=$((SCREEN_WIDTH / 2))
  local shade_start_y=$((SCREEN_HEIGHT * 10 / 1000))
  local shade_end_y=$((SCREEN_HEIGHT * 620 / 1000))
  local close_x=$((SCREEN_WIDTH * 722 / 1000))
  local close_y=$((SCREEN_HEIGHT * 918 / 1000))

  sleep 12
  capture_screenshot "app-opened"
  sleep 4

  # Open the visible voice assistant session from the composer.
  adb shell input tap "$voice_x" "$voice_y"
  sleep 2
  if adb shell dumpsys window | grep -qi "permissioncontroller"; then
    adb shell input tap "$permission_x" "$permission_y"
    sleep 3
  fi
  sleep 6
  capture_screenshot "hands-free-started"
  sleep 4

  # Show the foreground service notification.
  adb shell cmd statusbar expand-notifications >/dev/null 2>&1 \
    || adb shell input swipe "$shade_x" "$shade_start_y" "$shade_x" "$shade_end_y" 900
  sleep 3
  capture_screenshot "notification-shade"
  sleep 6

  # Return to the app and close the voice session.
  adb shell cmd statusbar collapse >/dev/null 2>&1 || adb shell input keyevent KEYCODE_BACK
  sleep 2
  adb shell input tap "$close_x" "$close_y"
  sleep 4
  capture_screenshot "stopped-closed"
  sleep 4
}

stop_recording() {
  if [[ -n "${SCREENRECORD_PID:-}" ]]; then
    kill -INT "$SCREENRECORD_PID" >/dev/null 2>&1 || true
    wait "$SCREENRECORD_PID" >/dev/null 2>&1 || true
    SCREENRECORD_PID=""
  fi
}

main() {
  cd "$ROOT_DIR"
  ensure_adb
  mkdir -p "$OUT_DIR"
  rm -f "$VIDEO_PATH"
  adb shell rm -f "$DEVICE_VIDEO" >/dev/null 2>&1 || true

  launch_app

  info "Starting Android screenrecord"
  adb shell screenrecord \
    --time-limit "$VIDEO_TIME_LIMIT" \
    --size "$VIDEO_SIZE" \
    --bit-rate "$VIDEO_BIT_RATE" \
    --bugreport "$DEVICE_VIDEO" &
  SCREENRECORD_PID=$!
  trap stop_recording EXIT INT TERM

  if [[ "${MANUAL_FLOW:-0}" == "1" ]]; then
    info "Manual mode: perform the flow on the emulator, then press Enter here to stop recording."
    read -r
  else
    drive_demo_flow
  fi

  info "Stopping Android screenrecord"
  stop_recording
  trap - EXIT INT TERM

  info "Pulling video"
  adb pull "$DEVICE_VIDEO" "$VIDEO_PATH" >/dev/null
  write_readme

  info "Evidence package written"
  printf "Video: %s\n" "$VIDEO_PATH"
  printf "README: %s\n" "$README_PATH"
}

main "$@"
