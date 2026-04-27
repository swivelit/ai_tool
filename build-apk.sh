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

runtime_mode_normalized() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

is_truthy() {
  case "$(runtime_mode_normalized "${1:-}")" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

RUNTIME_MODE="$(runtime_mode_normalized "${EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE:-native_on_device}")"
EAS_PROFILE="$(runtime_mode_normalized "${EAS_BUILD_PROFILE:-}")"
JAI_BUILD_PROFILE="$(runtime_mode_normalized "${JAI_BUILD_PROFILE:-}")"

IS_PRODUCTION_OR_RELEASE_BUILD=0
if [[ "$BUILD_TYPE" == "release" || "$EAS_PROFILE" == "production" || "$EAS_PROFILE" == "release" || "$JAI_BUILD_PROFILE" == "production" || "$JAI_BUILD_PROFILE" == "release" ]]; then
  IS_PRODUCTION_OR_RELEASE_BUILD=1
fi

SHOULD_SYNC_LLAMA_CPP=0
if [[ "$BUILD_TYPE" == "release" || "$RUNTIME_MODE" == "native_on_device" || "$IS_PRODUCTION_OR_RELEASE_BUILD" == "1" ]] || is_truthy "${JAI_REQUIRE_LLAMA_CPP:-}"; then
  SHOULD_SYNC_LLAMA_CPP=1
fi

if [[ "$BUILD_TYPE" == "release" ]]; then
  # Local release APKs are production-like for the native runtime even when they
  # are not running on EAS. Gradle/CMake/app.config use these explicit guards to
  # refuse JAI_LLAMA_CPP_AVAILABLE=0 and unresolved GGUF CDN/integrity metadata.
  export JAI_BUILD_TYPE="release"
  export JAI_REQUIRE_LLAMA_CPP="1"
  export EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_SHA256="true"
  export EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_INTEGRITY_METADATA="true"
fi

if [[ -z "${EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE:-}" ]]; then
  export EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE="native_on_device"
fi

if [[ -z "${EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE:-}" ]]; then
  export EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE="download_on_first_launch"
fi

info() {
  printf "\n▶ %s\n" "$1"
}

warn() {
  printf "\n⚠️  %s\n" "$1"
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
info "Runtime mode: ${EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE:-native_on_device}"
if [[ "${JAI_REQUIRE_LLAMA_CPP:-}" == "1" ]]; then
  info "llama.cpp required: yes (production/release native build guard enabled)"
fi
[[ -n "${API_BASE_URL:-}" ]] && info "API base: $API_BASE_URL"

cd "$MOBILE_DIR"

info "Installing mobile dependencies"
if [[ -f package-lock.json ]]; then
  if npm ci; then
    info "Dependencies installed with npm ci"
  else
    warn "package-lock.json is out of sync with package.json. Falling back to npm install to refresh the lockfile."
    npm install
  fi
else
  npm install
fi

info "Ensuring Expo CLI is available"
npx expo --version >/dev/null

if [[ "$SHOULD_SYNC_LLAMA_CPP" == "1" ]]; then
  info "Ensuring llama.cpp native backend is available"
  if npm run native:sync-llama; then
    info "llama.cpp native backend is ready"
  elif [[ "${JAI_REQUIRE_LLAMA_CPP:-}" == "1" || "$IS_PRODUCTION_OR_RELEASE_BUILD" == "1" ]]; then
    fail "llama.cpp is required for this production/release native build. Run npm run native:sync-llama or git submodule update --init --recursive before building."
  else
    warn "llama.cpp sync failed. Continuing because this is not a production/release-required build; native calls will fail clearly with JAI_LLAMA_CPP_BACKEND_MISSING."
  fi
fi

if [[ "${JAI_REQUIRE_LLAMA_CPP:-}" == "1" || "$IS_PRODUCTION_OR_RELEASE_BUILD" == "1" ]]; then
  info "Verifying native llama.cpp build/runtime wiring"
  if npm run native:verify-llama; then
    info "Native llama.cpp build/runtime wiring verified"
  else
    fail "Native llama.cpp verification failed. Run npm run native:sync-llama, then npm run native:verify-llama from mobile/ and fix the reported native build guard/linkage issue."
  fi
fi

info "Validating Expo native/model delivery configuration"
CI=1 npx expo config --type public >/dev/null

info "Generating native Android project (clean prebuild)"
CI=1 npx expo prebuild --platform android --clean

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
echo ""
echo "Examples:"
echo "  ./build-apk.sh"
echo "  BUILD_TYPE=debug ./build-apk.sh"