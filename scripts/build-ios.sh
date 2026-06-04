#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_BUILD_MODE="${IOS_BUILD_MODE:-}"
IOS_TEAM_ID="${IOS_TEAM_ID:-}"

run_simulator_build() {
  exec "$SCRIPT_DIR/build-ios-simulator.sh" "$@"
}

run_archive_build() {
  exec "$SCRIPT_DIR/build-ios-archive.sh" "$@"
}

run_device_build() {
  exec "$SCRIPT_DIR/run-ios-device.sh" "$@"
}

if [ -n "$IOS_BUILD_MODE" ]; then
  case "$(printf '%s' "$IOS_BUILD_MODE" | tr '[:upper:]' '[:lower:]')" in
    simulator|sim)
      echo "IOS_BUILD_MODE=simulator: running unsigned iOS Simulator verification."
      run_simulator_build "$@"
      ;;
    archive|release)
      echo "IOS_BUILD_MODE=archive: running signed iOS archive flow."
      run_archive_build "$@"
      ;;
    device|iphone|debug-device)
      echo "IOS_BUILD_MODE=device: running signed physical-device Debug flow."
      run_device_build "$@"
      ;;
    *)
      cat <<EOF
ERROR: Unknown IOS_BUILD_MODE: $IOS_BUILD_MODE

Supported modes:
  simulator  unsigned iOS Simulator build; no Apple signing required
  device     signed Debug build for a physical iPhone
  archive    signed archive for TestFlight/App Store or distribution
EOF
      exit 1
      ;;
  esac
fi

if [ -z "$IOS_TEAM_ID" ]; then
  cat <<'EOF'
IOS_BUILD_MODE is not set and IOS_TEAM_ID is not set.
Defaulting to unsigned iOS Simulator verification.

Simulator verification does not require Apple Developer Program membership,
certificates, provisioning profiles, or a signing team.

Physical iPhone testing requires Xcode signing. A free Apple Account can use a
Personal Team for limited local device testing. TestFlight/App Store archives
require Apple Developer Program membership.

Use explicit modes when needed:
  IOS_BUILD_MODE=simulator ./scripts/build-ios.sh
  IOS_BUILD_MODE=device ./scripts/build-ios.sh
  IOS_BUILD_MODE=archive IOS_TEAM_ID=YOUR_TEAM_ID ./scripts/build-ios.sh
EOF
  run_simulator_build "$@"
fi

cat <<'EOF'
IOS_BUILD_MODE is not set and IOS_TEAM_ID is present.
Preserving the existing signed archive workflow.

For local unsigned verification, run:
  IOS_BUILD_MODE=simulator ./scripts/build-ios.sh
EOF
run_archive_build "$@"
