#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRIVATE_DIR="$ROOT_DIR/private"
KEYSTORE_DIR="$PRIVATE_DIR/keystores"
KEYSTORE_PATH="$KEYSTORE_DIR/swico-upload-key.jks"
SIGNING_PROPERTIES="$ROOT_DIR/release-signing.properties"
KEY_ALIAS="swico-upload"
KEY_DNAME="CN=Swico Upload, OU=Swico, O=Swico, L=Unknown, ST=Unknown, C=US"
SETUP_STORE_PASSWORD_FILE=""
SETUP_KEY_PASSWORD_FILE=""
SETUP_PROPERTIES_TMP=""

info() {
  printf "\n> %s\n" "$1"
}

fail() {
  printf "\nERROR: %s\n" "$1" >&2
  exit 1
}

is_truthy() {
  case "$(printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]" | tr -d "[:space:]")" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

require_keytool() {
  if ! command -v keytool >/dev/null 2>&1; then
    fail "Install Java/JDK first. On macOS, use: brew install openjdk"
  fi
}

read_secret_confirmed() {
  local label="$1"
  local first second

  [[ -r /dev/tty ]] || fail "A terminal is required so passwords can be entered securely."

  while true; do
    printf "%s: " "$label" > /dev/tty
    IFS= read -r -s first < /dev/tty
    printf "\n" > /dev/tty
    printf "Confirm %s: " "$label" > /dev/tty
    IFS= read -r -s second < /dev/tty
    printf "\n" > /dev/tty

    if [[ -z "$first" ]]; then
      printf "Password cannot be empty.\n" > /dev/tty
      continue
    fi
    if [[ "$first" != "$second" ]]; then
      printf "Passwords did not match. Try again.\n" > /dev/tty
      continue
    fi

    printf "%s" "$first"
    return 0
  done
}

write_secret_file() {
  local file_path="$1"
  local value="$2"

  umask 077
  printf "%s\n" "$value" > "$file_path"
  chmod 600 "$file_path" 2>/dev/null || true
}

cleanup_temp_files() {
  rm -f \
    "${SETUP_STORE_PASSWORD_FILE:-}" \
    "${SETUP_KEY_PASSWORD_FILE:-}" \
    "${SETUP_PROPERTIES_TMP:-}"
}

main() {
  local store_password key_password

  trap cleanup_temp_files EXIT

  require_keytool

  if [[ -e "$KEYSTORE_PATH" ]] && ! is_truthy "${FORCE_RECREATE_UPLOAD_KEY:-}"; then
    fail "Upload keystore already exists at $KEYSTORE_PATH. Refusing to overwrite it. Set FORCE_RECREATE_UPLOAD_KEY=true only if you intentionally want to replace this upload key."
  fi

  info "Creating local Android upload-key signing config for Swico"
  printf "Back up private/keystores/swico-upload-key.jks safely. Do not commit it.\n"

  mkdir -p "$KEYSTORE_DIR"
  chmod 700 "$PRIVATE_DIR" "$KEYSTORE_DIR" 2>/dev/null || true

  store_password="$(read_secret_confirmed "Store password")"
  key_password="$(read_secret_confirmed "Key password")"

  SETUP_STORE_PASSWORD_FILE="$(mktemp)"
  SETUP_KEY_PASSWORD_FILE="$(mktemp)"
  write_secret_file "$SETUP_STORE_PASSWORD_FILE" "$store_password"
  write_secret_file "$SETUP_KEY_PASSWORD_FILE" "$key_password"

  if is_truthy "${FORCE_RECREATE_UPLOAD_KEY:-}" && [[ -e "$KEYSTORE_PATH" ]]; then
    rm -f "$KEYSTORE_PATH"
  fi

  keytool -genkeypair \
    -v \
    -keystore "$KEYSTORE_PATH" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "$KEY_DNAME" \
    -storepass:file "$SETUP_STORE_PASSWORD_FILE" \
    -keypass:file "$SETUP_KEY_PASSWORD_FILE"

  chmod 600 "$KEYSTORE_PATH" 2>/dev/null || true

  SETUP_PROPERTIES_TMP="$(mktemp)"
  umask 077
  {
    printf "storeFile=%s\n" "$KEYSTORE_PATH"
    printf "storePassword=%s\n" "$store_password"
    printf "keyAlias=%s\n" "$KEY_ALIAS"
    printf "keyPassword=%s\n" "$key_password"
  } > "$SETUP_PROPERTIES_TMP"
  mv "$SETUP_PROPERTIES_TMP" "$SIGNING_PROPERTIES"
  SETUP_PROPERTIES_TMP=""
  chmod 600 "$SIGNING_PROPERTIES" 2>/dev/null || true

  printf "\nRelease signing config created. Now run ./scripts/build-android_release-apk.sh\n"
  printf "Back up private/keystores/swico-upload-key.jks safely. Do not commit it.\n"
}

main "$@"
