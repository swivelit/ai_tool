#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APK_PATH="$DIST_DIR/tamil-ai-debug.apk"

info() {
  printf "\n> %s\n" "$1"
}

fail() {
  printf "\nERROR: %s\n" "$1" >&2
  exit 1
}

[[ -d "$ROOT_DIR/mobile" ]] || fail "Mobile app folder not found at: $ROOT_DIR/mobile"
[[ -x "$ROOT_DIR/build-apk.sh" ]] || fail "Root build script is not executable: $ROOT_DIR/build-apk.sh"

cd "$ROOT_DIR"

info "Building debug Android APK for com.swico.tamilai"
BUILD_TYPE=debug "$ROOT_DIR/build-apk.sh"

[[ -s "$APK_PATH" ]] || fail "Expected debug APK was not created or is empty: $APK_PATH"

info "Debug APK ready"
printf "Saved to: %s\n" "$APK_PATH"
