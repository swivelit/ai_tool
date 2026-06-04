#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE_RELATIVE_PATH="private/keystores/swico-upload-key.jks"
KEYSTORE_PATH="$ROOT_DIR/$KEYSTORE_RELATIVE_PATH"
KEYSTORE_DIR="$(dirname "$KEYSTORE_PATH")"
KEY_ALIAS="swico-upload"
SIGNING_PROPERTIES="$ROOT_DIR/release-signing.properties"

fail() {
  printf "ERROR: %s\n" "$1" >&2
  exit 1
}

prompt_secret() {
  local prompt="$1"
  local var_name="$2"
  local value

  printf "%s" "$prompt" >&2
  read -r -s value
  printf "\n" >&2
  printf -v "$var_name" "%s" "$value"
}

command -v keytool >/dev/null 2>&1 || fail "keytool was not found. Install Java/JDK first. On macOS, use: brew install openjdk"

mkdir -p "$KEYSTORE_DIR"
chmod 700 "$ROOT_DIR/private"
chmod 700 "$KEYSTORE_DIR"

store_password="${SWICO_UPLOAD_STORE_PASSWORD:-}"
key_password="${SWICO_UPLOAD_KEY_PASSWORD:-}"

if [[ -z "$store_password" ]]; then
  prompt_secret "New Swico upload keystore password: " store_password
fi
if [[ -z "$key_password" ]]; then
  prompt_secret "New Swico upload key password: " key_password
fi

[[ -n "$store_password" ]] || fail "Store password cannot be empty."
[[ -n "$key_password" ]] || fail "Key password cannot be empty."

if [[ -f "$KEYSTORE_PATH" ]]; then
  if [[ "${FORCE_RECREATE_UPLOAD_KEY:-false}" == "true" ]]; then
    rm -f "$KEYSTORE_PATH"
  else
    printf "Using existing upload key: %s\n" "$KEYSTORE_RELATIVE_PATH"
  fi
fi

if [[ ! -f "$KEYSTORE_PATH" ]]; then
  keytool -genkeypair \
    -v \
    -keystore "$KEYSTORE_PATH" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$store_password" \
    -keypass "$key_password" \
    -dname "CN=Swico Upload,O=Swico,C=US"
fi

chmod 600 "$KEYSTORE_PATH"

umask 077
{
  printf "storeFile=%s\n" "$KEYSTORE_RELATIVE_PATH"
  printf "storePassword=%s\n" "$store_password"
  printf "keyAlias=%s\n" "$KEY_ALIAS"
  printf "keyPassword=%s\n" "$key_password"
} > "$SIGNING_PROPERTIES"
chmod 600 "$SIGNING_PROPERTIES"

cat <<EOF
Release signing config created. Now run ./scripts/build-android_release-apk.sh

Created:
  $KEYSTORE_RELATIVE_PATH
  release-signing.properties

Back up private/keystores/swico-upload-key.jks safely. Do not commit it.
To replace the upload key later, rerun with FORCE_RECREATE_UPLOAD_KEY=true.
EOF
