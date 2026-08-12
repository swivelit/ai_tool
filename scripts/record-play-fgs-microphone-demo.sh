#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_PATH="${1:-$ROOT_DIR/dist/tamil-ai-release.apk}"
AAPT="${AAPT:-}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

if [[ ! -f "$APK_PATH" ]]; then
  fail "APK not found: $APK_PATH"
fi

if [[ -z "$AAPT" ]]; then
  if command -v aapt >/dev/null 2>&1; then
    AAPT="$(command -v aapt)"
  elif [[ -n "${ANDROID_HOME:-}" && -x "$ANDROID_HOME/build-tools/36.0.0/aapt" ]]; then
    AAPT="$ANDROID_HOME/build-tools/36.0.0/aapt"
  else
    fail "aapt is required to inspect the APK manifest. Set AAPT=/path/to/aapt."
  fi
fi

permissions="$($AAPT dump permissions "$APK_PATH")"
for permission in \
  android.permission.FOREGROUND_SERVICE_MICROPHONE \
  android.permission.FOREGROUND_SERVICE; do
  if printf '%s\n' "$permissions" | grep -Fq "$permission"; then
    fail "$permission is present in $APK_PATH"
  fi
done

if printf '%s\n' "$permissions" | grep -Fq 'android.permission.RECORD_AUDIO'; then
  printf 'RECORD_AUDIO=present\n'
else
  fail 'android.permission.RECORD_AUDIO is missing from the APK'
fi

printf 'FOREGROUND_SERVICE_MICROPHONE=absent\n'
printf 'FOREGROUND_SERVICE=absent\n'
printf 'This verifier replaces the obsolete foreground-microphone Play evidence demo.\n'
