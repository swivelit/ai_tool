#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$ROOT_DIR"

if [[ -d "$ROOT_DIR/mobile" ]]; then
  MOBILE_DIR="$ROOT_DIR/mobile"
elif [[ -d "$ROOT_DIR/ai_tool-main/mobile" ]]; then
  REPO_DIR="$ROOT_DIR/ai_tool-main"
  MOBILE_DIR="$REPO_DIR/mobile"
else
  echo "❌ Could not find the mobile app folder."
  echo "   Expected one of:"
  echo "   - ./mobile"
  echo "   - ./ai_tool-main/mobile"
  exit 1
fi

BUILD_TYPE="${BUILD_TYPE:-release}"
BUILD_TYPE="$(printf '%s' "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')"

case "$BUILD_TYPE" in
  debug|release) ;;
  *)
    echo "❌ BUILD_TYPE must be 'debug' or 'release'."
    exit 1
    ;;
esac

APK_NAME="tamil-ai-${BUILD_TYPE}.apk"
DIST_DIR="$REPO_DIR/dist"

info() {
  printf "\n▶ %s\n" "$1"
}

fail() {
  printf "\n❌ %s\n" "$1"
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node 20+ first."
command -v npm >/dev/null 2>&1 || fail "npm is required. Install Node.js first."
command -v java >/dev/null 2>&1 || fail "Java is required. Install JDK 17 first."

JAVA_MAJOR="$(java -version 2>&1 | awk -F '[\".]' '/version/ {print $2; exit}')"
if [[ -n "${JAVA_MAJOR:-}" && "$JAVA_MAJOR" != "17" && "$JAVA_MAJOR" != "21" ]]; then
  echo "⚠️  Detected Java version $JAVA_MAJOR. JDK 17 is safest."
fi

ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$ANDROID_SDK" ]]; then
  for candidate in \
    "$HOME/Library/Android/sdk" \
    "$HOME/Android/Sdk" \
    "/Users/$USER/Library/Android/sdk"
  do
    if [[ -d "$candidate" ]]; then
      ANDROID_SDK="$candidate"
      break
    fi
  done
fi

[[ -n "$ANDROID_SDK" ]] || fail "Android SDK not found. Set ANDROID_SDK_ROOT (or ANDROID_HOME) first."
[[ -d "$ANDROID_SDK/platform-tools" ]] || fail "Android SDK looks incomplete. Missing platform-tools in: $ANDROID_SDK"

export ANDROID_SDK_ROOT="$ANDROID_SDK"
export ANDROID_HOME="$ANDROID_SDK"
export PATH="$ANDROID_SDK/platform-tools:$ANDROID_SDK/emulator:$PATH"

if [[ -n "${API_BASE_URL:-}" ]]; then
  export EXPO_PUBLIC_API_BASE="$API_BASE_URL"
  export EXPO_PUBLIC_API_URL="$API_BASE_URL"
fi

info "Using mobile app at: $MOBILE_DIR"
info "Build type: $BUILD_TYPE"
[[ -n "${API_BASE_URL:-}" ]] && info "API base: $API_BASE_URL"

cd "$MOBILE_DIR"

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  info "Installing mobile dependencies"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

info "Ensuring Expo CLI is available"
npx expo --version >/dev/null

info "Generating native Android project"
npx expo prebuild --platform android --clean --non-interactive

mkdir -p android
cat > android/local.properties <<LOCALPROPS
sdk.dir=${ANDROID_SDK//\\/\\\\}
LOCALPROPS

if [[ "$BUILD_TYPE" == "debug" ]]; then
  GRADLE_TASK="assembleDebug"
  SOURCE_APK="android/app/build/outputs/apk/debug/app-debug.apk"
else
  GRADLE_TASK="assembleRelease"
  SOURCE_APK="android/app/build/outputs/apk/release/app-release.apk"
fi

info "Building APK with Gradle ($GRADLE_TASK)"
cd android
chmod +x gradlew
./gradlew "$GRADLE_TASK"
cd ..

[[ -f "$SOURCE_APK" ]] || fail "APK was not found at: $SOURCE_APK"

mkdir -p "$DIST_DIR"
cp "$SOURCE_APK" "$DIST_DIR/$APK_NAME"

info "APK ready"
echo "Saved to: $DIST_DIR/$APK_NAME"
echo ""
echo "Install it with:"
echo "  adb install -r '$DIST_DIR/$APK_NAME'"
echo "  or copy the APK to your Android phone and open it there"