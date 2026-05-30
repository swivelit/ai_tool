#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
AAB_PATH="$DIST_DIR/tamil-ai-release.aab"
APK_PATH="$DIST_DIR/tamil-ai-release.apk"

info() {
  printf "\n> %s\n" "$1"
}

warn() {
  printf "\nWARN: %s\n" "$1" >&2
}

fail() {
  printf "\nERROR: %s\n" "$1" >&2
  exit 1
}

normalize_flag() {
  printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]" | tr -d "[:space:]"
}

is_truthy() {
  case "$(normalize_flag "${1:-}")" in
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
  EXPO_PUBLIC_E2E_REPLY_LANGUAGE
  JAI_DEBUG_LITE
)

for env_name in "${blocked_release_env_names[@]}"; do
  value="${!env_name-}"
  if [[ "$env_name" == "EXPO_PUBLIC_E2E_REPLY_LANGUAGE" ]]; then
    [[ -z "${value//[[:space:]]/}" ]] || fail "Release builds must not set $env_name."
  elif is_truthy "$value"; then
    fail "Release builds must not enable $env_name."
  fi
done

if is_truthy "${EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE:-}"; then
  fail "Release builds must keep EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false."
fi
export EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE="${EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE:-false}"

if is_truthy "${EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-}"; then
  if is_truthy "${JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE:-}"; then
    warn "EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=true is explicitly allowed by JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1; this is an experimental release override."
  else
    fail "Release builds default to backend Sarvam for voice. Set JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1 only for an explicit documented release override."
  fi
else
  export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="false"
fi

[[ -d "$ROOT_DIR/mobile" ]] || fail "Mobile app folder not found at: $ROOT_DIR/mobile"
[[ -x "$ROOT_DIR/build-apk.sh" ]] || fail "Root build script is not executable: $ROOT_DIR/build-apk.sh"

cd "$ROOT_DIR"

export BUILD_TYPE=release
export JAI_BUILD_TYPE=release
export NODE_ENV="${NODE_ENV:-production}"

info "Building release Android AAB and APK for com.swico.tamilai"
BUILD_AAB=1 RUN_MOBILE_RELEASE_PREFLIGHT=1 "$ROOT_DIR/build-apk.sh"

[[ -s "$AAB_PATH" ]] || fail "Expected release AAB was not created or is empty: $AAB_PATH"
[[ -s "$APK_PATH" ]] || fail "Expected release APK was not created or is empty: $APK_PATH"

info "Release Android artifacts ready"
printf "AAB: %s\n" "$AAB_PATH"
printf "APK: %s\n" "$APK_PATH"
printf "\nUse the AAB for Google Play upload. Use the APK only for local QA.\n"
