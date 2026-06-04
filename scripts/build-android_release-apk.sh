#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="com.swico.tamilai"
AAB_PATH="$ROOT_DIR/dist/tamil-ai-release.aab"
APK_PATH="$ROOT_DIR/dist/tamil-ai-release.apk"
SIGNING_UTILS="$ROOT_DIR/scripts/android-release-signing.sh"
RELEASE_SIGNING_VALIDATION_MESSAGE="Release signing validation passed. This AAB is not debug-signed."

fail() {
  printf "ERROR: %s\n" "$1" >&2
  exit 1
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

blocked_release_env_names=(
  EXPO_PUBLIC_E2E_MOCK_AUTH
  EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP
  EXPO_PUBLIC_E2E_MOCK_VOICE_TURN
  EXPO_PUBLIC_E2E_MOCK_HANDS_FREE
  EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO
  EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT
  EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT
  EXPO_PUBLIC_DISABLE_CHAT_AUDIO_INPUT
  EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_GENERAL_CHAT
  EXPO_PUBLIC_ENABLE_UNVERIFIED_NATIVE_EMBEDDINGS
  JAI_DEBUG_LITE
)

blocked_release_value_names=(
  EXPO_PUBLIC_E2E_REPLY_LANGUAGE
  EXPO_PUBLIC_E2E_TAMIL_STYLE
  EXPO_PUBLIC_E2E_VOICE_QUERY
  EXPO_PUBLIC_E2E_VOICE_SURFACE
  EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE
  EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND
)

check_release_env() {
  local env_name

  for env_name in "${blocked_release_env_names[@]}"; do
    if is_truthy "${!env_name:-}"; then
      fail "Release builds must not enable $env_name."
    fi
  done

  for env_name in "${blocked_release_value_names[@]}"; do
    if [[ -n "${!env_name:-}" ]]; then
      fail "Release builds must not set $env_name."
    fi
  done
}

[[ -f "$SIGNING_UTILS" ]] || fail "Missing Android release signing helper: $SIGNING_UTILS"
# shellcheck disable=SC1090
source "$SIGNING_UTILS"

cat <<'BANNER'
========================================
 Swico Android Release Build
========================================
This builds:
- Release AAB for Google Play upload
- Release APK for local QA
========================================
BANNER

check_release_env
swico_android_require_release_signing "$ROOT_DIR"

cd "$ROOT_DIR"
BUILD_TYPE=release BUILD_AAB=1 ./build-apk.sh

swico_android_validate_release_artifacts "$ROOT_DIR" "$AAB_PATH" "$APK_PATH"
printf "%s\n" "$RELEASE_SIGNING_VALIDATION_MESSAGE"

cat <<EOF

Release build complete.

Google Play upload artifact:
$AAB_PATH

Local QA install artifact:
$APK_PATH

Install release APK locally:
  adb install -r "$APK_PATH"
  adb shell monkey -p "$PACKAGE_NAME" -c android.intent.category.LAUNCHER 1
EOF
