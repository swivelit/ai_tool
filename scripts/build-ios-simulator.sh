#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
IOS_DIR="$MOBILE_DIR/ios"
OUTPUT_DIR="$ROOT_DIR/dist/ios-simulator"
DERIVED_DATA_DIR="$OUTPUT_DIR/DerivedData"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
IOS_SCHEME="${IOS_SCHEME:-Swico}"
IOS_SIMULATOR_DESTINATION="${IOS_SIMULATOR_DESTINATION:-generic/platform=iOS Simulator}"

info() {
  printf "\n▶ %s\n" "$1"
}

fail() {
  printf "ERROR: %s\n" "$1" >&2
  exit 1
}

find_xcode_workspace() {
  find "$IOS_DIR" -maxdepth 1 -name "*.xcworkspace" -print -quit 2>/dev/null
}

find_xcode_project() {
  find "$IOS_DIR" -maxdepth 1 -name "*.xcodeproj" -print -quit 2>/dev/null
}

install_mobile_dependencies() {
  info "Installing mobile dependencies"
  cd "$MOBILE_DIR"
  if [[ "${SKIP_NPM_CI:-false}" == "true" ]]; then
    printf "Skipping npm ci because SKIP_NPM_CI=true\n"
  elif [[ -f package-lock.json ]]; then
    npm ci --include=dev --prefer-offline --no-audit --registry="$NPM_REGISTRY"
  else
    npm install --include=dev --no-audit --registry="$NPM_REGISTRY"
  fi
}

ensure_ios_project() {
  local workspace
  local project

  workspace="$(find_xcode_workspace || true)"
  project="$(find_xcode_project || true)"
  if [[ -n "$workspace" || -n "$project" ]]; then
    return 0
  fi

  info "Generating native iOS project with Expo prebuild"
  cd "$MOBILE_DIR"
  CI=1 npx expo prebuild --platform ios
}

prepare_xcode_container_args() {
  local workspace
  local project

  workspace="$(find_xcode_workspace || true)"
  project="$(find_xcode_project || true)"

  if [[ -n "$workspace" ]]; then
    XCODE_CONTAINER_ARGS=(-workspace "$(basename "$workspace")")
  elif [[ -n "$project" ]]; then
    XCODE_CONTAINER_ARGS=(-project "$(basename "$project")")
  else
    fail "Expo iOS project was not generated under mobile/ios."
  fi
}

cat <<'BANNER'
========================================
 Swico iOS Simulator Build
========================================
BANNER

[[ "$(uname -s)" == "Darwin" ]] || fail "iOS Simulator builds require macOS with Xcode installed."
[[ -d "$MOBILE_DIR" ]] || fail "Mobile app folder not found at mobile/."
command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v npx >/dev/null 2>&1 || fail "npx is required."
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild not found. Install Xcode and select it with xcode-select."
command -v pod >/dev/null 2>&1 || fail "CocoaPods not found. Install it with: sudo gem install cocoapods"

xcodebuild -version
install_mobile_dependencies
ensure_ios_project
prepare_xcode_container_args

info "Installing iOS pods"
cd "$IOS_DIR"
pod install --repo-update

info "Building iOS Simulator app without code signing"
mkdir -p "$DERIVED_DATA_DIR"
xcodebuild \
  "${XCODE_CONTAINER_ARGS[@]}" \
  -scheme "$IOS_SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "$IOS_SIMULATOR_DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_DIR" \
  CODE_SIGNING_ALLOWED=NO \
  build

cat <<EOF

iOS Simulator build complete.
Derived data:
$DERIVED_DATA_DIR
EOF
