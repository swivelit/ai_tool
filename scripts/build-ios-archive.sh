#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
IOS_DIR="$MOBILE_DIR/ios"
OUTPUT_DIR="$ROOT_DIR/dist/ios"
ARCHIVE_PATH="$OUTPUT_DIR/Swico.xcarchive"
IPA_EXPORT_DIR="$OUTPUT_DIR/ipa"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
IOS_SCHEME="${IOS_SCHEME:-Swico}"
IOS_CONFIGURATION="${IOS_CONFIGURATION:-Release}"
IOS_DESTINATION="${IOS_DESTINATION:-generic/platform=iOS}"
IOS_TEAM_ID="${IOS_TEAM_ID:-}"
IOS_ALLOW_LOCAL_SIGNING="${IOS_ALLOW_LOCAL_SIGNING:-false}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.swico.tamilai}"
IOS_EXPORT_OPTIONS_PLIST="${IOS_EXPORT_OPTIONS_PLIST:-}"

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
 Swico iOS Archive Build
========================================
BANNER

[[ "$(uname -s)" == "Darwin" ]] || fail "iOS builds require macOS with Xcode installed."
[[ -d "$MOBILE_DIR" ]] || fail "Mobile app folder not found at mobile/."
command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v npx >/dev/null 2>&1 || fail "npx is required."
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild not found. Install Xcode and select it with xcode-select."
command -v pod >/dev/null 2>&1 || fail "CocoaPods not found. Install it with: sudo gem install cocoapods"

if [[ -z "$IOS_TEAM_ID" && "$IOS_ALLOW_LOCAL_SIGNING" != "true" ]]; then
  cat <<'EOF'
ERROR: IOS_TEAM_ID is not set, so a signed iOS archive cannot start.

Simulator verification, no signing required:
  IOS_BUILD_MODE=simulator ./scripts/build-ios.sh

Local iPhone Debug testing:
  Open mobile/ios/*.xcworkspace in Xcode after Expo prebuild, select the Swico
  target, sign in with an Apple Account, and choose your Team.

TestFlight/App Store archive:
  IOS_TEAM_ID=YOUR_TEAM_ID IOS_BUILD_MODE=archive ./scripts/build-ios.sh

If this Mac already has local Xcode signing configured, rerun with:
  IOS_ALLOW_LOCAL_SIGNING=true ./scripts/build-ios-archive.sh
EOF
  exit 1
fi

if [[ -n "$IOS_EXPORT_OPTIONS_PLIST" && ! -f "$IOS_EXPORT_OPTIONS_PLIST" ]]; then
  fail "IOS_EXPORT_OPTIONS_PLIST was set but file does not exist: $IOS_EXPORT_OPTIONS_PLIST"
fi

xcodebuild -version
install_mobile_dependencies
ensure_ios_project
prepare_xcode_container_args

info "Installing iOS pods"
cd "$IOS_DIR"
pod install --repo-update

info "Archiving iOS app"
mkdir -p "$OUTPUT_DIR"
rm -rf "$ARCHIVE_PATH"

XCODEBUILD_ARGS=(
  "${XCODE_CONTAINER_ARGS[@]}"
  -scheme "$IOS_SCHEME"
  -configuration "$IOS_CONFIGURATION"
  -destination "$IOS_DESTINATION"
  -archivePath "$ARCHIVE_PATH"
  PRODUCT_BUNDLE_IDENTIFIER="$IOS_BUNDLE_ID"
)

if [[ -n "$IOS_TEAM_ID" ]]; then
  XCODEBUILD_ARGS+=(DEVELOPMENT_TEAM="$IOS_TEAM_ID" CODE_SIGN_STYLE=Automatic)
else
  printf "IOS_ALLOW_LOCAL_SIGNING=true: using local Xcode signing settings for archive.\n"
fi

xcodebuild "${XCODEBUILD_ARGS[@]}" -allowProvisioningUpdates archive

cat <<EOF

iOS archive complete.
Archive location:
$ARCHIVE_PATH
EOF

if [[ -n "$IOS_EXPORT_OPTIONS_PLIST" ]]; then
  info "Exporting IPA"
  rm -rf "$IPA_EXPORT_DIR"
  mkdir -p "$IPA_EXPORT_DIR"
  xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$IPA_EXPORT_DIR" \
    -exportOptionsPlist "$IOS_EXPORT_OPTIONS_PLIST" \
    -allowProvisioningUpdates

  printf "\nIPA export complete.\nIPA folder:\n%s\n" "$IPA_EXPORT_DIR"
else
  cat <<'EOF'

IPA export skipped.
To export an IPA, rerun with:
  IOS_EXPORT_OPTIONS_PLIST=/absolute/path/to/ExportOptions.plist ./scripts/build-ios-archive.sh
EOF
fi
