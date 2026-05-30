#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
IOS_DIR="$MOBILE_DIR/ios"
DERIVED_DATA_DIR="$ROOT_DIR/dist/ios-simulator/DerivedData"
IOS_SIMULATOR_DESTINATION="${IOS_SIMULATOR_DESTINATION:-generic/platform=iOS Simulator}"

info() {
  printf "\n> %s\n" "$1"
}

warn() {
  printf "\nWARN: %s\n" "$1" >&2
}

fail() {
  printf "\nERROR: %s\n" "$1" >&2
  exit 1
}

normalize_flag() {
  printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]" | tr -d "[:space:]"
}

is_truthy() {
  case "$(normalize_flag "${1:-}")" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

install_mobile_dependencies() {
  cd "$MOBILE_DIR"

  if is_truthy "${SKIP_NPM_CI:-}"; then
    warn "SKIP_NPM_CI=true; skipping mobile dependency install."
    return 0
  fi

  npm_args=(--include=dev)
  if [[ -n "${NPM_REGISTRY:-}" ]]; then
    npm_args+=(--registry "$NPM_REGISTRY")
  fi

  if [[ -f package-lock.json ]]; then
    if npm ci "${npm_args[@]}"; then
      info "Dependencies installed with npm ci"
    else
      warn "package-lock.json is out of sync with package.json. Falling back to npm install."
      npm install "${npm_args[@]}"
    fi
  else
    npm install "${npm_args[@]}"
  fi
}

run_pod_install() {
  [[ -f "$IOS_DIR/Podfile" ]] || return 0
  command -v pod >/dev/null 2>&1 || fail "CocoaPods is required. Install CocoaPods, then rerun this script."

  info "Installing iOS pods"
  cd "$IOS_DIR"
  if [[ -f Gemfile ]] && command -v bundle >/dev/null 2>&1; then
    bundle exec pod install
  else
    pod install
  fi
}

find_ios_workspace() {
  local workspace
  workspace="$(find "$IOS_DIR" -maxdepth 1 -name "*.xcworkspace" -print -quit)"
  [[ -n "$workspace" ]] || fail "Could not find an Xcode workspace in $IOS_DIR after Expo prebuild."
  printf "%s\n" "$workspace"
}

resolve_ios_scheme() {
  local workspace="$1"
  local workspace_name
  local scheme
  if [[ -n "${IOS_SCHEME:-}" ]]; then
    printf "%s\n" "$IOS_SCHEME"
    return 0
  fi

  workspace_name="$(basename "$workspace" .xcworkspace)"
  if [[ -f "$IOS_DIR/$workspace_name.xcodeproj/xcshareddata/xcschemes/$workspace_name.xcscheme" ]]; then
    printf "%s\n" "$workspace_name"
    return 0
  fi

  if [[ -f "$IOS_DIR/JAI.xcodeproj/xcshareddata/xcschemes/JAI.xcscheme" ]]; then
    printf "%s\n" "JAI"
    return 0
  fi

  scheme="$(xcodebuild -workspace "$workspace" -list 2>/dev/null | awk '
    /^[[:space:]]*Schemes:/ { in_schemes = 1; next }
    in_schemes && NF { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }
  ')"
  [[ -n "$scheme" ]] || scheme="JAI"
  printf "%s\n" "$scheme"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "iOS builds require macOS with Xcode. Shell syntax is valid, but this host cannot run xcodebuild."
fi

command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild is required. Install Xcode and run xcode-select if needed."
command -v node >/dev/null 2>&1 || fail "Node.js is required but was not found in PATH."
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found in PATH."
[[ -d "$MOBILE_DIR" ]] || fail "Mobile app folder not found at: $MOBILE_DIR"

mkdir -p "$DERIVED_DATA_DIR"

install_mobile_dependencies

info "Generating native iOS project with Expo prebuild"
cd "$MOBILE_DIR"
CI=1 npx expo prebuild --platform ios

run_pod_install

IOS_WORKSPACE="$(find_ios_workspace)"
IOS_SCHEME_RESOLVED="$(resolve_ios_scheme "$IOS_WORKSPACE")"

info "Building iOS simulator app"
xcodebuild \
  -workspace "$IOS_WORKSPACE" \
  -scheme "$IOS_SCHEME_RESOLVED" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "$IOS_SIMULATOR_DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_DIR" \
  CODE_SIGNING_ALLOWED=NO \
  build

info "iOS simulator build ready"
printf "Derived data: %s\n" "$DERIVED_DATA_DIR"
