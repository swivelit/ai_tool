#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client"
IOS_APP_DIR="$CLIENT_DIR/ios/App"
OUTPUT_DIR="$ROOT_DIR/dist/ios-device"
DERIVED_DATA_DIR="$OUTPUT_DIR/DerivedData"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
USE_ADMOB_TEST_ADS="${REACT_APP_USE_ADMOB_TEST_ADS:-true}"
GENERATE_SOURCEMAP="${GENERATE_SOURCEMAP:-false}"
IOS_SCHEME="${IOS_SCHEME:-App}"
IOS_CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
IOS_TEAM_ID="${IOS_TEAM_ID:-}"
IOS_DEVICE_ID="${IOS_DEVICE_ID:-}"
IOS_DEVICE_DESTINATION="${IOS_DEVICE_DESTINATION:-}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-}"
DEFAULT_BUNDLE_ID="com.goodone.marketplace"
LAUNCH_BUNDLE_ID="${IOS_BUNDLE_ID:-$DEFAULT_BUNDLE_ID}"
APP_PATH="$DERIVED_DATA_DIR/Build/Products/${IOS_CONFIGURATION}-iphoneos/App.app"

cat <<'BANNER'
========================================
 GoodOne iOS Device Debug Build
========================================
BANNER

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: iOS device builds require macOS with Xcode installed."
  exit 1
fi

if [ ! -d "$CLIENT_DIR" ]; then
  echo "ERROR: client directory not found."
  echo "Run this script from the project root or through: cd client && npm run run:ios:device"
  exit 1
fi

if [ ! -d "$IOS_APP_DIR" ]; then
  echo "ERROR: iOS project not found at client/ios/App."
  echo "Run: cd client && npx cap add ios"
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "ERROR: xcodebuild not found. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "ERROR: xcodebuild is installed but Xcode is not ready. Open Xcode, accept the license, and run first launch setup."
  exit 1
fi

if ! command -v pod >/dev/null 2>&1; then
  echo "ERROR: CocoaPods not found. Install it with: sudo gem install cocoapods"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js and npm, then rerun this script."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx not found. Install Node.js/npm, then rerun this script."
  exit 1
fi

if [ -z "$IOS_TEAM_ID" ]; then
  cat <<'EOF'
IOS_TEAM_ID is not set.

A physical iPhone build must be signed. This script will use Xcode automatic
signing and any local target signing settings already configured on this Mac.
If xcodebuild reports that a development team is required:

  1. Open client/ios/App/App.xcworkspace in Xcode.
  2. Select the App target.
  3. Open Signing & Capabilities.
  4. Sign in with a free Apple Account and select your Personal Team.
  5. Use a local bundle identifier override if the production ID is unavailable:
     IOS_BUNDLE_ID=com.goodone.marketplace.dev.$USER ./scripts/run-ios-device.sh
  6. Do not commit DEVELOPMENT_TEAM or signing changes from project.pbxproj.

TestFlight and App Store distribution require Apple Developer Program membership.
EOF
fi

echo ""
echo "Xcode:"
xcodebuild -version

echo ""
echo "Installing frontend dependencies..."
echo "Using npm registry: $NPM_REGISTRY"
cd "$CLIENT_DIR"
if [ "${SKIP_NPM_CI:-false}" = "true" ]; then
  echo "Skipping npm ci because SKIP_NPM_CI=true"
elif ! npm ci --prefer-offline --no-audit --registry="$NPM_REGISTRY"; then
  if [ -d node_modules ]; then
    echo "WARNING: npm ci failed, but node_modules exists. Continuing with existing dependencies."
    echo "For a clean build, fix npm/network access and rerun without SKIP_NPM_CI."
  else
    echo "ERROR: npm ci failed and node_modules is missing."
    echo "Check your network/proxy/npm registry, then rerun."
    exit 1
  fi
fi

echo ""
echo "Building React app..."
echo "REACT_APP_USE_ADMOB_TEST_ADS=$USE_ADMOB_TEST_ADS"
echo "GENERATE_SOURCEMAP=$GENERATE_SOURCEMAP"
GENERATE_SOURCEMAP="$GENERATE_SOURCEMAP" REACT_APP_USE_ADMOB_TEST_ADS="$USE_ADMOB_TEST_ADS" npm run build

echo ""
echo "Syncing Capacitor iOS..."
npx cap sync ios

echo ""
echo "Installing iOS pods..."
cd "$IOS_APP_DIR"
pod install --repo-update

if [ -n "$IOS_DEVICE_DESTINATION" ]; then
  XCODE_DESTINATION="$IOS_DEVICE_DESTINATION"
elif [ -n "$IOS_DEVICE_ID" ]; then
  XCODE_DESTINATION="id=$IOS_DEVICE_ID"
else
  XCODE_DESTINATION="generic/platform=iOS"
fi

echo ""
echo "Building signed Debug app for physical iPhone..."
echo "Destination: $XCODE_DESTINATION"
mkdir -p "$DERIVED_DATA_DIR"

XCODEBUILD_ARGS=(
  -workspace "App.xcworkspace"
  -scheme "$IOS_SCHEME"
  -configuration "$IOS_CONFIGURATION"
  -sdk iphoneos
  -destination "$XCODE_DESTINATION"
  -derivedDataPath "$DERIVED_DATA_DIR"
  ENABLE_USER_SCRIPT_SANDBOXING=NO
  CODE_SIGNING_ALLOWED=YES
  CODE_SIGN_STYLE=Automatic
)

if [ -n "$IOS_TEAM_ID" ]; then
  XCODEBUILD_ARGS+=(DEVELOPMENT_TEAM="$IOS_TEAM_ID")
fi

if [ -n "$IOS_BUNDLE_ID" ]; then
  XCODEBUILD_ARGS+=(PRODUCT_BUNDLE_IDENTIFIER="$IOS_BUNDLE_ID")
fi

if ! xcodebuild "${XCODEBUILD_ARGS[@]}" -allowProvisioningUpdates build; then
  if [ -z "$IOS_TEAM_ID" ]; then
    cat <<'EOF'

The device Debug build failed and IOS_TEAM_ID was not provided.
This usually means Xcode signing has not been configured for a Personal Team.
Open client/ios/App/App.xcworkspace in Xcode, select the App target, choose a
Team under Signing & Capabilities, then rerun this script. Keep any Team ID or
provisioning changes out of git.
EOF
  fi
  exit 1
fi

if [ ! -d "$APP_PATH" ] && [ -d "$DERIVED_DATA_DIR/Build/Products" ]; then
  APP_PATH="$(find "$DERIVED_DATA_DIR/Build/Products" -maxdepth 4 -type d -name "*.app" -path "*/${IOS_CONFIGURATION}-iphoneos/*" | head -n 1)"
fi

cat <<EOF2

========================================
 iOS device Debug build complete
========================================
Derived data:
$DERIVED_DATA_DIR

App bundle:
$APP_PATH
EOF2

if [ -z "$IOS_DEVICE_ID" ]; then
  cat <<'EOF3'

CLI install/launch was not attempted because IOS_DEVICE_ID is not set.

To run on a physical iPhone:
  1. Connect the iPhone and trust this Mac.
  2. Find its identifier:
     xcrun devicectl list devices
  3. Rerun:
     IOS_DEVICE_ID=YOUR_DEVICE_ID ./scripts/run-ios-device.sh

Or open client/ios/App/App.xcworkspace in Xcode, select the iPhone destination,
confirm Signing & Capabilities, and choose Product > Run.
EOF3
  exit 0
fi

if [ ! -d "$APP_PATH" ]; then
  echo ""
  echo "WARNING: Built app bundle was not found, so CLI install/launch was skipped."
  echo "Open client/ios/App/App.xcworkspace in Xcode and choose Product > Run."
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1 || ! xcrun devicectl help >/dev/null 2>&1; then
  cat <<'EOF4'

CLI install/launch was skipped because xcrun devicectl is unavailable.
Open client/ios/App/App.xcworkspace in Xcode, select the connected iPhone,
confirm Signing & Capabilities, and choose Product > Run.
EOF4
  exit 0
fi

echo ""
echo "Installing app on iPhone device $IOS_DEVICE_ID..."
if ! xcrun devicectl device install app --device "$IOS_DEVICE_ID" "$APP_PATH"; then
  echo "WARNING: devicectl install failed. Open the workspace in Xcode and choose Product > Run."
  exit 0
fi

echo ""
echo "Launching $LAUNCH_BUNDLE_ID on iPhone device $IOS_DEVICE_ID..."
if ! xcrun devicectl device process launch --device "$IOS_DEVICE_ID" "$LAUNCH_BUNDLE_ID"; then
  echo "WARNING: devicectl launch failed. The app may still be installed; launch it manually on the iPhone or use Xcode Product > Run."
  exit 0
fi

echo "iOS device install and launch complete."
