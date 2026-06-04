#!/usr/bin/env bash

SWICO_ANDROID_RELEASE_STORE_FILE=""
SWICO_ANDROID_RELEASE_KEY_ALIAS=""
SWICO_ANDROID_RELEASE_STORE_PASSWORD=""
SWICO_ANDROID_RELEASE_KEY_PASSWORD=""

swico_android_signing_properties_file() {
  local repo_dir="$1"
  printf "%s\n" "${SWICO_UPLOAD_SIGNING_PROPERTIES_FILE:-$repo_dir/release-signing.properties}"
}

swico_android_read_property() {
  local properties_file="$1"
  local requested_key="$2"
  local line key value trimmed

  [[ -f "$properties_file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    key="${trimmed%%=*}"
    [[ "$key" == "$trimmed" ]] && continue
    value="${trimmed#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$key" == "$requested_key" ]]; then
      printf "%s\n" "$value"
      return 0
    fi
  done < "$properties_file"

  return 1
}

swico_android_resolve_release_signing() {
  local repo_dir="$1"
  local properties_file
  local properties_dir
  local store_file

  properties_file="$(swico_android_signing_properties_file "$repo_dir")"
  properties_dir="$(cd "$(dirname "$properties_file")" 2>/dev/null && pwd || printf "%s" "$repo_dir")"

  SWICO_ANDROID_RELEASE_STORE_FILE="${SWICO_UPLOAD_STORE_FILE:-}"
  SWICO_ANDROID_RELEASE_KEY_ALIAS="${SWICO_UPLOAD_KEY_ALIAS:-}"
  SWICO_ANDROID_RELEASE_STORE_PASSWORD="${SWICO_UPLOAD_STORE_PASSWORD:-}"
  SWICO_ANDROID_RELEASE_KEY_PASSWORD="${SWICO_UPLOAD_KEY_PASSWORD:-}"

  if [[ -f "$properties_file" ]]; then
    [[ -n "$SWICO_ANDROID_RELEASE_STORE_FILE" ]] \
      || SWICO_ANDROID_RELEASE_STORE_FILE="$(swico_android_read_property "$properties_file" "SWICO_UPLOAD_STORE_FILE" || swico_android_read_property "$properties_file" "storeFile" || true)"
    [[ -n "$SWICO_ANDROID_RELEASE_KEY_ALIAS" ]] \
      || SWICO_ANDROID_RELEASE_KEY_ALIAS="$(swico_android_read_property "$properties_file" "SWICO_UPLOAD_KEY_ALIAS" || swico_android_read_property "$properties_file" "keyAlias" || true)"
    [[ -n "$SWICO_ANDROID_RELEASE_STORE_PASSWORD" ]] \
      || SWICO_ANDROID_RELEASE_STORE_PASSWORD="$(swico_android_read_property "$properties_file" "SWICO_UPLOAD_STORE_PASSWORD" || swico_android_read_property "$properties_file" "storePassword" || true)"
    [[ -n "$SWICO_ANDROID_RELEASE_KEY_PASSWORD" ]] \
      || SWICO_ANDROID_RELEASE_KEY_PASSWORD="$(swico_android_read_property "$properties_file" "SWICO_UPLOAD_KEY_PASSWORD" || swico_android_read_property "$properties_file" "keyPassword" || true)"
  fi

  store_file="$SWICO_ANDROID_RELEASE_STORE_FILE"
  if [[ -n "$store_file" && "$store_file" != /* ]]; then
    if [[ -f "$repo_dir/$store_file" ]]; then
      store_file="$repo_dir/$store_file"
    else
      store_file="$properties_dir/$store_file"
    fi
  fi
  SWICO_ANDROID_RELEASE_STORE_FILE="$store_file"
}

swico_android_release_signing_missing_message() {
  local repo_dir="$1"
  local properties_file

  properties_file="$(swico_android_signing_properties_file "$repo_dir")"
  cat >&2 <<EOF
Release signing is required for Google Play uploads.

Set these environment variables:
  SWICO_UPLOAD_STORE_FILE=/absolute/path/to/private/keystores/swico-upload-key.jks
  SWICO_UPLOAD_KEY_ALIAS=swico-upload
  SWICO_UPLOAD_STORE_PASSWORD=<store password>
  SWICO_UPLOAD_KEY_PASSWORD=<key password>

Or create the ignored local file:
  $properties_file

You can create a local Swico upload key with:
  ./scripts/setup-android-release-signing.sh

Manual keytool command:
  keytool -genkeypair -v -keystore private/keystores/swico-upload-key.jks -alias swico-upload -keyalg RSA -keysize 2048 -validity 10000

Expected Google Play artifact after a successful build:
  dist/tamil-ai-release.aab

Do not use debug signing. If Play Console says the AAB was signed in debug mode, delete that failed upload, configure the Swico upload key, rebuild, and upload the new AAB.
EOF
}

swico_android_require_release_signing() {
  local repo_dir="$1"
  local missing=0

  swico_android_resolve_release_signing "$repo_dir"

  [[ -n "$SWICO_ANDROID_RELEASE_STORE_FILE" ]] || missing=1
  [[ -n "$SWICO_ANDROID_RELEASE_KEY_ALIAS" ]] || missing=1
  [[ -n "$SWICO_ANDROID_RELEASE_STORE_PASSWORD" ]] || missing=1
  [[ -n "$SWICO_ANDROID_RELEASE_KEY_PASSWORD" ]] || missing=1

  if [[ "$missing" == "1" ]]; then
    swico_android_release_signing_missing_message "$repo_dir"
    return 1
  fi

  if [[ ! -f "$SWICO_ANDROID_RELEASE_STORE_FILE" ]]; then
    printf "Release signing keystore was not found: %s\n\n" "$SWICO_ANDROID_RELEASE_STORE_FILE" >&2
    swico_android_release_signing_missing_message "$repo_dir"
    return 1
  fi
}

swico_android_escape_properties_value() {
  printf "%s" "$1" | sed 's/\\/\\\\/g'
}

swico_android_write_generated_key_properties() {
  local repo_dir="$1"
  local android_dir="$repo_dir/mobile/android"
  local key_properties="$android_dir/key.properties"

  [[ -d "$android_dir" ]] || {
    printf "Generated Android project not found at %s. Run Expo prebuild first.\n" "$android_dir" >&2
    return 1
  }

  umask 077
  {
    printf "storeFile=%s\n" "$(swico_android_escape_properties_value "$SWICO_ANDROID_RELEASE_STORE_FILE")"
    printf "storePassword=%s\n" "$(swico_android_escape_properties_value "$SWICO_ANDROID_RELEASE_STORE_PASSWORD")"
    printf "keyAlias=%s\n" "$(swico_android_escape_properties_value "$SWICO_ANDROID_RELEASE_KEY_ALIAS")"
    printf "keyPassword=%s\n" "$(swico_android_escape_properties_value "$SWICO_ANDROID_RELEASE_KEY_PASSWORD")"
  } > "$key_properties"
  chmod 600 "$key_properties"
}

swico_android_configure_generated_gradle_release_signing() {
  local repo_dir="$1"
  local gradle_file="$repo_dir/mobile/android/app/build.gradle"
  local patcher="$repo_dir/scripts/patch-android-release-signing.mjs"

  swico_android_require_release_signing "$repo_dir" || return 1
  swico_android_write_generated_key_properties "$repo_dir" || return 1

  [[ -f "$patcher" ]] || {
    printf "Missing release signing Gradle patcher: %s\n" "$patcher" >&2
    return 1
  }

  node "$patcher" "$gradle_file"
}

swico_android_find_apksigner() {
  local android_sdk="${1:-}"
  local candidate

  if command -v apksigner >/dev/null 2>&1; then
    command -v apksigner
    return 0
  fi

  for candidate in "$android_sdk"/build-tools/*/apksigner; do
    if [[ -x "$candidate" ]]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  printf "apksigner is required to validate the release APK certificate. Install Android SDK Build-Tools.\n" >&2
  return 1
}

swico_android_reject_debug_certificate_output() {
  local label="$1"
  local output_file="$2"

  if grep -E "CN=Android[[:space:]]+Debug|Android[[:space:]]+Debug|debug.keystore" "$output_file" >/dev/null 2>&1; then
    printf "%s appears to be signed with an Android Debug certificate. Do not upload debug-signed artifacts.\n" "$label" >&2
    return 1
  fi
}

swico_android_validate_release_artifacts() {
  local repo_dir="$1"
  local aab_path="$2"
  local apk_path="$3"
  local android_sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  local apksigner_bin
  local tmp_dir

  [[ -s "$aab_path" ]] || {
    printf "Release AAB was not found or is empty: %s\n" "$aab_path" >&2
    return 1
  }
  [[ -s "$apk_path" ]] || {
    printf "Release APK was not found or is empty: %s\n" "$apk_path" >&2
    return 1
  }

  tmp_dir="$(mktemp -d)"

  if command -v jarsigner >/dev/null 2>&1; then
    jarsigner -verify -verbose -certs "$aab_path" > "$tmp_dir/aab-jarsigner.log" 2>&1 || {
      cat "$tmp_dir/aab-jarsigner.log" >&2
      rm -rf "$tmp_dir"
      return 1
    }
    swico_android_reject_debug_certificate_output "Release AAB" "$tmp_dir/aab-jarsigner.log" || {
      rm -rf "$tmp_dir"
      return 1
    }
  else
    printf "jarsigner is required to validate the release AAB signature. Install a JDK.\n" >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  if command -v keytool >/dev/null 2>&1; then
    keytool -printcert -jarfile "$aab_path" > "$tmp_dir/aab-keytool.log" 2>&1 || true
    swico_android_reject_debug_certificate_output "Release AAB" "$tmp_dir/aab-keytool.log" || {
      rm -rf "$tmp_dir"
      return 1
    }
  fi

  apksigner_bin="$(swico_android_find_apksigner "$android_sdk")" || {
    rm -rf "$tmp_dir"
    return 1
  }
  "$apksigner_bin" verify --verbose --print-certs "$apk_path" > "$tmp_dir/apk-apksigner.log" 2>&1 || {
    cat "$tmp_dir/apk-apksigner.log" >&2
    rm -rf "$tmp_dir"
    return 1
  }
  swico_android_reject_debug_certificate_output "Release APK" "$tmp_dir/apk-apksigner.log" || {
    rm -rf "$tmp_dir"
    return 1
  }

  rm -rf "$tmp_dir"
}
