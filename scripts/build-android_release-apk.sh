#!/usr/bin/env bash
set -euo pipefail

APP_ID="com.goodone.marketplace"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client"
ANDROID_DIR="$CLIENT_DIR/android"
OUTPUT_DIR="$ROOT_DIR/dist"

KEY_PROPERTIES="$ANDROID_DIR/key.properties"
ADMOB_RELEASE_ENV_FILE="$CLIENT_DIR/.env.admob.release.local"
ADMOB_SERVICE_FILE="$CLIENT_DIR/src/services/admob.js"

AAB_SOURCE="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

AAB_TARGET="$OUTPUT_DIR/goodone-release.aab"
APK_TARGET="$OUTPUT_DIR/goodone-release.apk"

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"

export_android_version_env() {
  local gradle_file="$ANDROID_DIR/app/build.gradle"
  local version_code
  local version_name

  if [ ! -f "$gradle_file" ]; then
    echo "ERROR: Android Gradle file not found at $gradle_file"
    exit 1
  fi

  version_code="$(sed -nE 's/^[[:space:]]*versionCode[[:space:]]+([0-9]+).*/\1/p' "$gradle_file" | head -n 1)"
  version_name="$(sed -nE 's/^[[:space:]]*versionName[[:space:]]+"([^"]+)".*/\1/p' "$gradle_file" | head -n 1)"

  if [ -z "$version_code" ] || [ -z "$version_name" ]; then
    echo "ERROR: Could not parse versionCode/versionName from $gradle_file"
    exit 1
  fi

  export REACT_APP_ANDROID_VERSION_CODE="$version_code"
  export REACT_APP_ANDROID_VERSION_NAME="$version_name"
}

mask_admob_id() {
  local ad_id="${1:-}"

  if [ -z "$ad_id" ]; then
    echo "missing"
    return
  fi

  local prefix="${ad_id%%/*}"
  local unit="${ad_id#*/}"

  if [ "$prefix" = "$ad_id" ] || [ -z "$unit" ]; then
    echo "configured"
    return
  fi

  local prefix_tail="${prefix: -4}"
  local unit_tail="${unit: -4}"
  echo "ca-app-pub-****${prefix_tail}/****${unit_tail}"
}

is_interstitial_admob_enabled() {
  [ -f "$ADMOB_SERVICE_FILE" ] && grep -q "export const showAdMobInterstitial" "$ADMOB_SERVICE_FILE"
}

require_admob_release_id() {
  local env_name="$1"
  local label="$2"
  local env_value="${!env_name:-}"

  if [ -z "$env_value" ]; then
    cat <<EOF
ERROR: Missing required production AdMob ID: $env_name ($label).

Create or update:
$ADMOB_RELEASE_ENV_FILE

Use this template:
$CLIENT_DIR/.env.admob.release.example
EOF
    exit 1
  fi
}

cat <<'BANNER'
========================================
 GoodOne Android Release Build
========================================
This builds:
- Signed release AAB for Google Play upload
- Signed release APK for local QA only
========================================
BANNER

if [ ! -d "$CLIENT_DIR" ]; then
  echo "ERROR: client directory not found."
  echo "Run this script from the project root."
  exit 1
fi

cd "$ROOT_DIR"

if [ ! -d "$ANDROID_DIR" ]; then
  echo "ERROR: Android project not found at client/android."
  echo "Run: cd client && npx cap add android"
  exit 1
fi

if [ ! -f "$KEY_PROPERTIES" ]; then
  cat <<EOF
ERROR: Release signing file missing:

$KEY_PROPERTIES

Create it from:
$ANDROID_DIR/key.properties.example

Example:
cd "$ANDROID_DIR"
mkdir -p keystores
keytool -genkeypair \\
  -v \\
  -keystore keystores/goodone-upload-key.jks \\
  -alias goodone-upload \\
  -keyalg RSA \\
  -keysize 2048 \\
  -validity 10000

Then create android/key.properties with:
storeFile=../keystores/goodone-upload-key.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=goodone-upload
keyPassword=YOUR_KEY_PASSWORD

Never commit key.properties or the .jks file.
EOF
  exit 1
fi

if grep -q "CHANGE_ME" "$KEY_PROPERTIES"; then
  echo "ERROR: $KEY_PROPERTIES still contains CHANGE_ME values."
  echo "Fill real release signing values before building."
  exit 1
fi

echo ""
echo "Checking Java..."
if command -v /usr/libexec/java_home >/dev/null 2>&1; then
  use_java_version() {
    local requested_version="$1"
    local java_home
    java_home="$(/usr/libexec/java_home -v "$requested_version" 2>/dev/null)" || return 1

    if ! "$java_home/bin/java" -version 2>&1 | grep -Eq "version \"${requested_version}([\".+_-]|$)"; then
      return 1
    fi

    export JAVA_HOME="$java_home"
    export PATH="$JAVA_HOME/bin:$PATH"
    echo "Using Java $requested_version: $JAVA_HOME"
  }

  if use_java_version 21; then
    :
  elif use_java_version 17; then
    :
  else
    echo "WARNING: Java 21/17 not found via /usr/libexec/java_home."
    java -version || true
  fi
else
  java -version || true
fi

echo ""
echo "Loading release AdMob environment..."
cd "$CLIENT_DIR"
if [ -f "$ADMOB_RELEASE_ENV_FILE" ]; then
  echo "Loading $ADMOB_RELEASE_ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  . "$ADMOB_RELEASE_ENV_FILE"
  set +a
else
  echo "WARNING: $ADMOB_RELEASE_ENV_FILE not found."
fi

export REACT_APP_USE_ADMOB_TEST_ADS=false
export_android_version_env

echo "REACT_APP_USE_ADMOB_TEST_ADS=$REACT_APP_USE_ADMOB_TEST_ADS"
echo "REACT_APP_ANDROID_VERSION_CODE=$REACT_APP_ANDROID_VERSION_CODE"
echo "REACT_APP_ANDROID_VERSION_NAME=$REACT_APP_ANDROID_VERSION_NAME"
echo "REACT_APP_ADMOB_ANDROID_BANNER_ID=$(mask_admob_id "${REACT_APP_ADMOB_ANDROID_BANNER_ID:-}")"
echo "REACT_APP_ADMOB_ANDROID_INTERSTITIAL_ID=$(mask_admob_id "${REACT_APP_ADMOB_ANDROID_INTERSTITIAL_ID:-}")"
echo "REACT_APP_ADMOB_ANDROID_REWARDED_ID=$(mask_admob_id "${REACT_APP_ADMOB_ANDROID_REWARDED_ID:-}")"
echo "REACT_APP_ADMOB_ANDROID_APP_OPEN_ID=$(mask_admob_id "${REACT_APP_ADMOB_ANDROID_APP_OPEN_ID:-}")"
echo "Do not upload this AAB if required production AdMob IDs are missing."

require_admob_release_id REACT_APP_ADMOB_ANDROID_BANNER_ID "banner"
if is_interstitial_admob_enabled; then
  require_admob_release_id REACT_APP_ADMOB_ANDROID_INTERSTITIAL_ID "interstitial"
fi

echo ""
echo "Installing frontend dependencies..."
npm ci --prefer-offline --no-audit --registry="$NPM_REGISTRY"

echo ""
echo "Building React production bundle with AdMob production env config..."
npm run build

echo ""
echo "Syncing Capacitor Android..."
npx cap sync android

echo ""
echo "Building signed release AAB and APK..."
cd "$ANDROID_DIR"
./gradlew clean bundleRelease assembleRelease

if [ ! -f "$AAB_SOURCE" ]; then
  echo "ERROR: Release AAB not found at $AAB_SOURCE"
  exit 1
fi

if [ ! -f "$APK_SOURCE" ]; then
  echo "ERROR: Release APK not found at $APK_SOURCE"
  exit 1
fi

echo ""
echo "Copying release artifacts to dist..."
mkdir -p "$OUTPUT_DIR"
cp "$AAB_SOURCE" "$AAB_TARGET"
cp "$APK_SOURCE" "$APK_TARGET"

echo ""
echo "Verifying AAB signature..."
if command -v jarsigner >/dev/null 2>&1; then
  jarsigner -verify -certs "$AAB_TARGET"
else
  echo "WARNING: jarsigner not found; skipping AAB signature verification."
fi

echo ""
echo "Verifying APK signature..."
APK_SIGNER=""
if command -v apksigner >/dev/null 2>&1; then
  APK_SIGNER="$(command -v apksigner)"
else
  for candidate in \
    "${ANDROID_HOME:-}/build-tools"/*/apksigner \
    "${ANDROID_SDK_ROOT:-}/build-tools"/*/apksigner
  do
    if [ -x "$candidate" ]; then
      APK_SIGNER="$candidate"
      break
    fi
  done
fi

if [ -n "$APK_SIGNER" ]; then
  "$APK_SIGNER" verify --verbose "$APK_TARGET"
else
  echo "WARNING: apksigner not found; skipping APK signature verification."
fi

cat <<EOF

========================================
 Release build complete
========================================

Google Play upload artifact:
$AAB_TARGET

Local QA install artifact:
$APK_TARGET

Install release APK locally:
adb install -r "$APK_TARGET"

Uninstall old app first, if needed:
adb uninstall $APP_ID

Important:
- Upload the AAB to Google Play. APK is for local QA only.
- Do not click your own live AdMob ads.
- Use debug builds/test devices for ad testing.

EOF
