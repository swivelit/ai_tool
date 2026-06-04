#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
IOS_DIR="$MOBILE_DIR/ios"
OUTPUT_DIR="$ROOT_DIR/dist/ios-device"
DERIVED_DATA_DIR="$OUTPUT_DIR/DerivedData"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
IOS_SCHEME="${IOS_SCHEME:-Swico}"
IOS_CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
IOS_TEAM_ID="${IOS_TEAM_ID:-}"
IOS_DEVICE_ID="${IOS_DEVICE_ID:-}"
IOS_DEVICE_DESTINATION="${IOS_DEVICE_DESTINATION:-}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.swico.tamilai}"
APP_PATH="$DERIVED_DATA_DIR/Build/Products/${IOS_CONFIGURATION}-iphoneos/Swico.app"

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
 Swico iOS Device Debug Build
========================================
BANNER

[[ "$(uname -s)" == "Darwin" ]] || fail "iOS device builds require macOS with Xcode installed."
[[ -d "$MOBILE_DIR" ]] || fail "Mobile app folder not found at mobile/."
command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v npx >/dev/null 2>&1 || fail "npx is required."
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild not found. Install Xcode and select it with xcode-select."
command -v pod >/dev/null 2>&1 || fail "CocoaPods not found. Install it with: sudo gem install cocoapods"

if [[ -z "$IOS_TEAM_ID" ]]; then
  cat <<'EOF'
IOS_TEAM_ID is not set.

A physical iPhone build must be signed. This script will use Xcode automatic
signing and any local target signing settings already configured on this Mac.
If xcodebuild reports that a development team is required:

  1. Run: cd mobile && npx expo prebuild --platform ios
  2. Open mobile/ios/*.xcworkspace in Xcode.
  3. Select the Swico target.
  4. Open Signing & Capabilities.
  5. Sign in with an Apple Account and select your Team.
  6. Use a local bundle identifier override if the production ID is unavailable:
     IOS_BUNDLE_ID=com.swico.tamilai.dev.$USER ./scripts/run-ios-device.sh
  7. Do not commit DEVELOPMENT_TEAM or signing changes from project.pbxproj.

TestFlight and App Store distribution require Apple Developer Program membership.
EOF
fi

xcodebuild -version
install_mobile_dependencies
ensure_ios_project
prepare_xcode_container_args

info "Installing iOS pods"
cd "$IOS_DIR"
pod install --repo-update

if [[ -n "$IOS_DEVICE_DESTINATION" ]]; then
  XCODE_DESTINATION="$IOS_DEVICE_DESTINATION"
elif [[ -n "$IOS_DEVICE_ID" ]]; then
  XCODE_DESTINATION="id=$IOS_DEVICE_ID"
else
  XCODE_DESTINATION="generic/platform=iOS"
fi

info "Building signed Debug app for physical iPhone"
printf "Destination: %s\n" "$XCODE_DESTINATION"
mkdir -p "$DERIVED_DATA_DIR"

XCODEBUILD_ARGS=(
  "${XCODE_CONTAINER_ARGS[@]}"
  -scheme "$IOS_SCHEME"
  -configuration "$IOS_CONFIGURATION"
  -sdk iphoneos
  -destination "$XCODE_DESTINATION"
  -derivedDataPath "$DERIVED_DATA_DIR"
  CODE_SIGNING_ALLOWED=YES
  CODE_SIGN_STYLE=Automatic
  PRODUCT_BUNDLE_IDENTIFIER="$IOS_BUNDLE_ID"
)

if [[ -n "$IOS_TEAM_ID" ]]; then
  XCODEBUILD_ARGS+=(DEVELOPMENT_TEAM="$IOS_TEAM_ID")
fi

if ! xcodebuild "${XCODEBUILD_ARGS[@]}" -allowProvisioningUpdates build; then
  if [[ -z "$IOS_TEAM_ID" ]]; then
    cat <<'EOF'

The device Debug build failed and IOS_TEAM_ID was not provided.
Open mobile/ios/*.xcworkspace in Xcode, select the Swico target, choose a Team
under Signing & Capabilities, then rerun this script.
EOF
  fi
  exit 1
fi

if [[ ! -d "$APP_PATH" && -d "$DERIVED_DATA_DIR/Build/Products" ]]; then
  APP_PATH="$(find "$DERIVED_DATA_DIR/Build/Products" -maxdepth 4 -type d -name "*.app" -path "*/${IOS_CONFIGURATION}-iphoneos/*" -print -quit)"
fi

cat <<EOF

iOS device Debug build complete.
Derived data:
$DERIVED_DATA_DIR

App bundle:
$APP_PATH
EOF

if [[ -z "$IOS_DEVICE_ID" ]]; then
  cat <<'EOF'

CLI install/launch was not attempted because IOS_DEVICE_ID is not set.

To run on a physical iPhone:
  1. Connect the iPhone and trust this Mac.
  2. Find its identifier:
     xcrun devicectl list devices
  3. Rerun:
     IOS_DEVICE_ID=YOUR_DEVICE_ID ./scripts/run-ios-device.sh

Or open mobile/ios/*.xcworkspace in Xcode, select the iPhone destination,
confirm Signing & Capabilities, and choose Product > Run.
EOF
  exit 0
fi

if [[ ! -d "$APP_PATH" ]]; then
  printf "WARNING: Built app bundle was not found, so CLI install/launch was skipped.\n"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1 || ! xcrun devicectl help >/dev/null 2>&1; then
  cat <<'EOF'

CLI install/launch was skipped because xcrun devicectl is unavailable.
Open mobile/ios/*.xcworkspace in Xcode, select the connected iPhone,
confirm Signing & Capabilities, and choose Product > Run.
EOF
  exit 0
fi

info "Installing app on iPhone"
xcrun devicectl device install app --device "$IOS_DEVICE_ID" "$APP_PATH" \
  || fail "devicectl install failed. Open the workspace in Xcode and choose Product > Run."

info "Launching com.swico.tamilai on iPhone"
xcrun devicectl device process launch --device "$IOS_DEVICE_ID" "$IOS_BUNDLE_ID" \
  || fail "devicectl launch failed. The app may still be installed; launch it manually or use Xcode Product > Run."

printf "iOS device install and launch complete.\n"
