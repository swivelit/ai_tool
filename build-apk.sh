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

ANDROID_ABI_UTILS="$ROOT_DIR/scripts/android-abi-utils.sh"
[[ -f "$ANDROID_ABI_UTILS" ]] || fail "Android ABI helper not found at: $ANDROID_ABI_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_ABI_UTILS"

ANDROID_16KB_UTILS="$ROOT_DIR/scripts/android-16kb-utils.sh"
[[ -f "$ANDROID_16KB_UTILS" ]] || fail "Android 16 KB validation helper not found at: $ANDROID_16KB_UTILS"
# shellcheck disable=SC1090
source "$ANDROID_16KB_UTILS"

MOBILE_ENV_FILE_KEYS=()
ORIGINAL_MOBILE_ENV_KEYS=()

add_mobile_env_file_key() {
  local env_name="$1"
  local item

  for item in "${MOBILE_ENV_FILE_KEYS[@]:-}"; do
    [[ -z "$item" ]] && continue
    [[ "$item" == "$env_name" ]] && return 0
  done

  MOBILE_ENV_FILE_KEYS+=("$env_name")
}

collect_mobile_env_file_keys() {
  local env_file="$1"
  local line trimmed

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue

    if [[ "$trimmed" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]]; then
      add_mobile_env_file_key "${BASH_REMATCH[2]}"
    fi
  done < "$env_file"
}

remember_original_mobile_env_values() {
  local env_name
  local saved_name

  for env_name in "${MOBILE_ENV_FILE_KEYS[@]:-}"; do
    [[ -z "$env_name" ]] && continue

    if [[ "${!env_name+x}" == "x" ]]; then
      saved_name="ORIGINAL_MOBILE_ENV_VALUE_${env_name}"
      printf -v "$saved_name" "%s" "${!env_name}"
      ORIGINAL_MOBILE_ENV_KEYS+=("$env_name")
    fi
  done
}

restore_original_mobile_env_values() {
  local env_name
  local saved_name

  for env_name in "${ORIGINAL_MOBILE_ENV_KEYS[@]:-}"; do
    [[ -z "$env_name" ]] && continue

    saved_name="ORIGINAL_MOBILE_ENV_VALUE_${env_name}"
    export "$env_name=${!saved_name}"
  done
}

source_mobile_env_file() {
  local env_file="$1"
  local display_path="${env_file#"$REPO_DIR"/}"
  local restore_allexport=0
  local restore_nounset=0

  case "$-" in
    *a*) restore_allexport=1 ;;
    *) set -a ;;
  esac

  case "$-" in
    *u*)
      restore_nounset=1
      set +u
      ;;
  esac

  # shellcheck disable=SC1090
  if ! source "$env_file"; then
    [[ "$restore_nounset" == "1" ]] && set -u
    [[ "$restore_allexport" == "0" ]] && set +a
    fail "Failed to load environment file: $display_path"
  fi

  [[ "$restore_nounset" == "1" ]] && set -u
  [[ "$restore_allexport" == "0" ]] && set +a

  printf "Loaded environment file: %s\n" "$display_path"
}

load_mobile_env_files() {
  local loaded_count=0
  local env_files=()
  local env_file

  for env_file in "$MOBILE_DIR/.env" "$MOBILE_DIR/.env.local"; do
    if [[ -f "$env_file" ]]; then
      collect_mobile_env_file_keys "$env_file"
      env_files+=("$env_file")
    fi
  done

  remember_original_mobile_env_values

  for env_file in "${env_files[@]:-}"; do
    [[ -z "$env_file" ]] && continue

    source_mobile_env_file "$env_file"
    loaded_count=$((loaded_count + 1))
  done

  restore_original_mobile_env_values

  if [[ "$loaded_count" -gt 0 ]]; then
    printf "Environment precedence: mobile/.env < mobile/.env.local < already-exported shell variables\n"
  else
    printf "No mobile environment file found; using already-exported shell variables only.\n"
  fi
}

load_mobile_env_files

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

if [[ -z "${EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE:-}" ]]; then
  # Recorded voice must enter the same local-first pipeline as text chat.
  # Release verification below fails if this is explicitly disabled.
  export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="true"
fi

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

SELECTED_ANDROID_ABIS=""
ANDROID_ABIS_EXPLICIT_VALUE="${JAI_ANDROID_ABIS:-${ANDROID_ABIS:-}}"

if [[ -n "${ANDROID_ABIS_EXPLICIT_VALUE//[[:space:]]/}" ]]; then
  SELECTED_ANDROID_ABIS="$(jai_android_normalize_abi_list "$ANDROID_ABIS_EXPLICIT_VALUE")" \
    || fail "Invalid JAI_ANDROID_ABIS/ANDROID_ABIS value: $ANDROID_ABIS_EXPLICIT_VALUE"
elif [[ "$BUILD_TYPE" == "debug" && "$IS_PRODUCTION_OR_RELEASE_BUILD" != "1" ]] && command -v adb >/dev/null 2>&1 && adb get-state >/dev/null 2>&1; then
  DEVICE_ANDROID_ABILIST="$(jai_android_read_device_abilist)" \
    || fail "Could not read connected Android device ABI list with adb."
  SELECTED_ANDROID_ABIS="$(jai_android_choose_supported_device_abi "$DEVICE_ANDROID_ABILIST")" \
    || fail "Connected Android target reports ABI list '$DEVICE_ANDROID_ABILIST', but this debug build supports only: $JAI_ANDROID_SUPPORTED_ABIS_CSV."
  info "Detected Android target ABIs: $DEVICE_ANDROID_ABILIST"
else
  SELECTED_ANDROID_ABIS="$JAI_ANDROID_DEFAULT_ABIS_CSV"
  if [[ "$BUILD_TYPE" == "debug" && "$IS_PRODUCTION_OR_RELEASE_BUILD" != "1" ]]; then
    warn "No connected Android target detected for debug ABI selection; defaulting to $SELECTED_ANDROID_ABIS."
  fi
fi

export JAI_ANDROID_ABIS="$SELECTED_ANDROID_ABIS"

if [[ -n "${API_BASE_URL:-}" ]]; then
  export EXPO_PUBLIC_API_BASE="$API_BASE_URL"
  export EXPO_PUBLIC_API_URL="$API_BASE_URL"
fi

info "Using mobile app at: $MOBILE_DIR"
info "Build type: $BUILD_TYPE"
info "Android ABIs: $JAI_ANDROID_ABIS"
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
  info "Verifying local-first release configuration"
  if npm run release:verify-local-first; then
    info "Local-first release configuration verified"
  else
    fail "Local-first release verification failed. Configure llama.cpp, the native module, GGUF model URLs, exact byte sizes, SHA-256 hashes, and EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=true."
  fi

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

validate_apk_native_libraries() {
  local apk_path="$1"
  local abi_csv="$2"
  local listing_file
  local abi found_abi missing=0 unexpected=0
  local -a selected_abis=()
  local -a found_abis=()

  command -v unzip >/dev/null 2>&1 || fail "unzip is required to validate native libraries in the APK."

  listing_file="$(mktemp)"
  if ! unzip -l "$apk_path" > "$listing_file"; then
    rm -f "$listing_file"
    fail "Could not inspect APK native libraries with unzip: $apk_path"
  fi

  IFS="," read -ra selected_abis <<< "$abi_csv"
  for abi in "${selected_abis[@]}"; do
    [[ -z "$abi" ]] && continue

    if ! grep -Eq "[[:space:]]lib/${abi}/libreactnative\\.so$" "$listing_file"; then
      printf "Missing lib/%s/libreactnative.so in %s\n" "$abi" "$apk_path" >&2
      missing=1
    fi

    if ! is_truthy "${JAI_ANDROID_SKIP_JAI_RUNTIME_APK_VALIDATION:-}"; then
      if ! grep -Eq "[[:space:]]lib/${abi}/libjai_llama_runtime\\.so$" "$listing_file"; then
        printf "Missing lib/%s/libjai_llama_runtime.so in %s\n" "$abi" "$apk_path" >&2
        missing=1
      fi
    fi
  done

  while IFS= read -r found_abi; do
    [[ -z "$found_abi" ]] && continue
    found_abis+=("$found_abi")
  done < <(awk '{ name=$4; if (name ~ /^lib\// && name ~ /\.so$/) { split(name, parts, "/"); print parts[2] } }' "$listing_file" | sort -u)

  if [[ "${#found_abis[@]}" -gt 0 ]]; then
    for found_abi in "${found_abis[@]}"; do
      if ! jai_android_abi_list_contains "$found_abi" "$abi_csv"; then
        printf "APK contains native libraries for unselected ABI '%s'. Selected ABIs: %s\n" "$found_abi" "$abi_csv" >&2
        unexpected=1
      fi
    done
  fi

  rm -f "$listing_file"

  if [[ "$missing" == "1" || "$unexpected" == "1" ]]; then
    fail "APK native library validation failed. Rebuild with a consistent JAI_ANDROID_ABIS value."
  fi

  if is_truthy "${JAI_ANDROID_SKIP_JAI_RUNTIME_APK_VALIDATION:-}"; then
    warn "Skipped libjai_llama_runtime.so APK validation because JAI_ANDROID_SKIP_JAI_RUNTIME_APK_VALIDATION is truthy."
  fi
}

info "Validating APK native libraries"
validate_apk_native_libraries "$SOURCE_APK" "$JAI_ANDROID_ABIS"

mkdir -p "$DIST_DIR"
cp "$SOURCE_APK" "$DIST_DIR/$APK_NAME"

info "Validating APK 16 KB native library compatibility"
if ! jai_android_validate_apk_16kb_or_allow_debug_skip "$DIST_DIR/$APK_NAME" "$BUILD_TYPE" "$ANDROID_SDK"; then
  fail "APK 16 KB native library validation failed. Rebuild native libraries with 16 KB ELF LOAD alignment; debug builds may set JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG=1 only for temporary local testing."
fi

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
