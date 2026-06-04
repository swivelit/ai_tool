#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client"
IOS_APP_DIR="$CLIENT_DIR/ios/App"
OUTPUT_DIR="$ROOT_DIR/dist/ios-simulator"
DERIVED_DATA_DIR="$OUTPUT_DIR/DerivedData"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
USE_ADMOB_TEST_ADS="${REACT_APP_USE_ADMOB_TEST_ADS:-true}"
IOS_SCHEME="${IOS_SCHEME:-App}"
IOS_SIMULATOR_DESTINATION="${IOS_SIMULATOR_DESTINATION:-generic/platform=iOS Simulator}"
GENERATE_SOURCEMAP="${GENERATE_SOURCEMAP:-false}"

cat <<'BANNER'
========================================
 GoodOne iOS Simulator Build
========================================
BANNER

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: iOS Simulator builds require macOS with Xcode installed."
  exit 1
fi

if [ ! -d "$CLIENT_DIR" ]; then
  echo "ERROR: client directory not found."
  echo "Run this script from the project root or through: cd client && npm run build:ios:simulator"
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

echo ""
echo "Xcode:"
xcodebuild -version

echo ""
echo "Installing frontend dependencies..."
echo "Using npm registry: $NPM_REGISTRY"
cd "$CLIENT_DIR"
if [ "${SKIP_NPM_CI:-false}" = "true" ]; then
  echo "Skipping npm ci because SKIP_NPM_CI=true"
else
  npm ci --no-audit --registry="$NPM_REGISTRY"
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

echo ""
echo "Building iOS Simulator app without code signing..."
mkdir -p "$DERIVED_DATA_DIR"
xcodebuild \
  -workspace App.xcworkspace \
  -scheme "$IOS_SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "$IOS_SIMULATOR_DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_DIR" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO \
  CODE_SIGNING_ALLOWED=NO \
  build

cat <<EOF2

========================================
 iOS Simulator build complete
========================================
Derived data:
$DERIVED_DATA_DIR
EOF2
