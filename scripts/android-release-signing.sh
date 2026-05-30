#!/usr/bin/env bash

swico_android_release_signing_instructions() {
  cat >&2 <<'EOF'
Release signing is required for Google Play uploads.

Create a Swico upload key and keep it safe:

  mkdir -p private/keystores
  keytool -genkeypair \
    -v \
    -keystore private/keystores/swico-upload-key.jks \
    -alias swico-upload \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000

Then export signing values before building:

  export SWICO_UPLOAD_STORE_FILE="$PWD/private/keystores/swico-upload-key.jks"
  export SWICO_UPLOAD_KEY_ALIAS="swico-upload"
  export SWICO_UPLOAD_STORE_PASSWORD="YOUR_STORE_PASSWORD"
  export SWICO_UPLOAD_KEY_PASSWORD="YOUR_KEY_PASSWORD"

  ./scripts/build-android_release-apk.sh

Alternatively, create an untracked release-signing.properties file:

  storeFile=/absolute/path/to/swico-upload-key.jks
  storePassword=YOUR_STORE_PASSWORD
  keyAlias=swico-upload
  keyPassword=YOUR_KEY_PASSWORD

The AAB signed with this upload key is the artifact to upload to Google Play:

  dist/tamil-ai-release.aab

Never commit the keystore, release-signing.properties, key.properties, or passwords.
Do not upload debug-signed bundles to Play Console.
EOF
}

swico_android_signing_fail() {
  printf "\nERROR: %s\n\n" "$1" >&2
  swico_android_release_signing_instructions
  return 1
}

swico_android_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

swico_android_load_signing_properties_file() {
  local properties_file="$1"
  local line key value

  SWICO_PROPERTIES_STORE_FILE=""
  SWICO_PROPERTIES_STORE_PASSWORD=""
  SWICO_PROPERTIES_KEY_ALIAS=""
  SWICO_PROPERTIES_KEY_PASSWORD=""

  [[ -f "$properties_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(swico_android_trim "$line")"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" == *"="* ]] || continue

    key="$(swico_android_trim "${line%%=*}")"
    value="$(swico_android_trim "${line#*=}")"

    case "$key" in
      storeFile) SWICO_PROPERTIES_STORE_FILE="$value" ;;
      storePassword) SWICO_PROPERTIES_STORE_PASSWORD="$value" ;;
      keyAlias) SWICO_PROPERTIES_KEY_ALIAS="$value" ;;
      keyPassword) SWICO_PROPERTIES_KEY_PASSWORD="$value" ;;
    esac
  done < "$properties_file"
}

swico_android_resolve_store_file() {
  local root_dir="$1"
  local properties_file="$2"
  local store_file="$3"
  local properties_dir candidate

  [[ -n "${store_file//[[:space:]]/}" ]] || return 1

  case "$store_file" in
    /*)
      printf "%s\n" "$store_file"
      return 0
      ;;
  esac

  candidate="$root_dir/$store_file"
  if [[ -f "$candidate" ]]; then
    printf "%s\n" "$candidate"
    return 0
  fi

  properties_dir="$(dirname "$properties_file")"
  if [[ -d "$properties_dir" ]]; then
    properties_dir="$(cd "$properties_dir" && pwd -P)"
    candidate="$properties_dir/$store_file"
    if [[ -f "$candidate" ]]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  fi

  printf "%s\n" "$root_dir/$store_file"
}

swico_android_require_release_signing() {
  local root_dir="$1"
  local properties_file="${SWICO_UPLOAD_SIGNING_PROPERTIES_FILE:-$root_dir/release-signing.properties}"
  local store_file key_alias store_password key_password store_file_abs store_file_lower

  swico_android_load_signing_properties_file "$properties_file"

  store_file="${SWICO_UPLOAD_STORE_FILE:-$SWICO_PROPERTIES_STORE_FILE}"
  key_alias="${SWICO_UPLOAD_KEY_ALIAS:-$SWICO_PROPERTIES_KEY_ALIAS}"
  store_password="${SWICO_UPLOAD_STORE_PASSWORD:-$SWICO_PROPERTIES_STORE_PASSWORD}"
  key_password="${SWICO_UPLOAD_KEY_PASSWORD:-$SWICO_PROPERTIES_KEY_PASSWORD}"

  if [[ -z "${store_file//[[:space:]]/}" || -z "${key_alias//[[:space:]]/}" || -z "${store_password//[[:space:]]/}" || -z "${key_password//[[:space:]]/}" ]]; then
    swico_android_signing_fail "Missing Swico release signing configuration. Set SWICO_UPLOAD_* env vars or create release-signing.properties."
    return 1
  fi

  store_file_abs="$(swico_android_resolve_store_file "$root_dir" "$properties_file" "$store_file")"
  if [[ ! -f "$store_file_abs" ]]; then
    swico_android_signing_fail "Swico upload keystore was not found at: $store_file_abs"
    return 1
  fi

  store_file_lower="$(printf "%s" "$store_file_abs" | tr "[:upper:]" "[:lower:]")"
  case "$store_file_lower" in
    */debug.keystore|*/.android/debug.keystore)
      swico_android_signing_fail "Release builds must not use the Android debug keystore: $store_file_abs"
      return 1
      ;;
  esac

  export SWICO_UPLOAD_STORE_FILE="$store_file_abs"
  export SWICO_UPLOAD_KEY_ALIAS="$key_alias"
  export SWICO_UPLOAD_STORE_PASSWORD="$store_password"
  export SWICO_UPLOAD_KEY_PASSWORD="$key_password"
}

swico_android_write_release_key_properties() {
  local root_dir="$1"
  local android_dir="$root_dir/mobile/android"
  local key_properties="$android_dir/key.properties"
  local tmp_file

  swico_android_require_release_signing "$root_dir" || return 1
  [[ -d "$android_dir" ]] || {
    printf "Android project not found after Expo prebuild: %s\n" "$android_dir" >&2
    return 1
  }

  tmp_file="$(mktemp "$android_dir/key.properties.XXXXXX")"
  chmod 600 "$tmp_file"
  {
    printf "storeFile=%s\n" "$SWICO_UPLOAD_STORE_FILE"
    printf "storePassword=%s\n" "$SWICO_UPLOAD_STORE_PASSWORD"
    printf "keyAlias=%s\n" "$SWICO_UPLOAD_KEY_ALIAS"
    printf "keyPassword=%s\n" "$SWICO_UPLOAD_KEY_PASSWORD"
  } > "$tmp_file"
  mv "$tmp_file" "$key_properties"
  chmod 600 "$key_properties"
}

swico_android_configure_generated_gradle_release_signing() {
  local root_dir="$1"
  local gradle_file="$root_dir/mobile/android/app/build.gradle"
  local patch_script="$root_dir/scripts/patch-android-release-signing.mjs"

  swico_android_write_release_key_properties "$root_dir" || return 1
  [[ -f "$gradle_file" ]] || {
    printf "Generated Gradle file not found: %s\n" "$gradle_file" >&2
    return 1
  }
  [[ -f "$patch_script" ]] || {
    printf "Release signing Gradle patcher not found: %s\n" "$patch_script" >&2
    return 1
  }

  node "$patch_script" "$gradle_file"
}

swico_android_find_apksigner() {
  local android_sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  local candidate best=""

  if [[ -n "${JAI_ANDROID_APKSIGNER:-}" ]]; then
    [[ -x "$JAI_ANDROID_APKSIGNER" ]] || {
      printf "Configured JAI_ANDROID_APKSIGNER is not executable: %s\n" "$JAI_ANDROID_APKSIGNER" >&2
      return 1
    }
    printf "%s\n" "$JAI_ANDROID_APKSIGNER"
    return 0
  fi

  if command -v apksigner >/dev/null 2>&1; then
    command -v apksigner
    return 0
  fi

  if [[ -n "$android_sdk" && -d "$android_sdk/build-tools" ]]; then
    for candidate in "$android_sdk"/build-tools/*/apksigner; do
      [[ -x "$candidate" ]] && best="$candidate"
    done
  fi

  [[ -n "$best" ]] || {
    printf "Missing apksigner. Install Android SDK Build-Tools or set JAI_ANDROID_APKSIGNER.\n" >&2
    return 1
  }

  printf "%s\n" "$best"
}

swico_android_signature_cert_lines() {
  grep -Ei "Owner:|Subject:|certificate DN:|X\\.509|CN=" || true
}

swico_android_reject_debug_certificate_output() {
  local label="$1"
  local output="$2"
  local cert_lines

  cert_lines="$(printf "%s\n" "$output" | swico_android_signature_cert_lines | awk '!seen[$0]++')"
  [[ -n "$cert_lines" ]] || cert_lines="$output"

  if printf "%s\n" "$cert_lines" | grep -Eiq "Android[[:space:]]+Debug|CN=Android[[:space:]]+Debug|debug"; then
    printf "%s appears to be signed with a debug certificate:\n%s\n" "$label" "$cert_lines" >&2
    return 1
  fi
}

swico_android_validate_aab_release_signature() {
  local aab_path="$1"
  local checked=0 output

  [[ -s "$aab_path" ]] || {
    printf "Release AAB missing or empty: %s\n" "$aab_path" >&2
    return 1
  }

  if command -v jarsigner >/dev/null 2>&1; then
    output="$(jarsigner -verify -verbose -certs "$aab_path" 2>&1)" || {
      printf "%s\n" "$output" >&2
      printf "jarsigner failed to verify release AAB: %s\n" "$aab_path" >&2
      return 1
    }
    swico_android_reject_debug_certificate_output "Release AAB" "$output" || return 1
    checked=1
  fi

  if command -v keytool >/dev/null 2>&1; then
    output="$(keytool -printcert -jarfile "$aab_path" 2>&1)" || {
      printf "%s\n" "$output" >&2
      printf "keytool failed to inspect release AAB certificate: %s\n" "$aab_path" >&2
      return 1
    }
    swico_android_reject_debug_certificate_output "Release AAB" "$output" || return 1
    checked=1
  fi

  [[ "$checked" == "1" ]] || {
    printf "Could not validate AAB signing certificate. Install JDK jarsigner/keytool.\n" >&2
    return 1
  }
}

swico_android_validate_apk_release_signature() {
  local apk_path="$1"
  local apksigner_path output

  [[ -s "$apk_path" ]] || {
    printf "Release APK missing or empty: %s\n" "$apk_path" >&2
    return 1
  }

  apksigner_path="$(swico_android_find_apksigner)" || return 1
  output="$("$apksigner_path" verify --verbose --print-certs "$apk_path" 2>&1)" || {
    printf "%s\n" "$output" >&2
    printf "apksigner failed to verify release APK: %s\n" "$apk_path" >&2
    return 1
  }
  swico_android_reject_debug_certificate_output "Release APK" "$output" || return 1
}

swico_android_validate_release_artifacts() {
  local _root_dir="$1"
  local aab_path="$2"
  local apk_path="$3"

  swico_android_validate_aab_release_signature "$aab_path" || return 1
  swico_android_validate_apk_release_signature "$apk_path" || return 1
}
