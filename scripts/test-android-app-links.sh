#!/usr/bin/env bash
set -euo pipefail

APP_ID="com.goodone.marketplace"
WEB_ORIGIN_INPUT="${WEB_ORIGIN:-}"
WEB_ORIGIN="${WEB_ORIGIN_INPUT:-https://good-one-jlcu.onrender.com}"
API_BASE="${API_BASE:-https://good-one-api.onrender.com/api}"
SHARED_PRODUCT_URL="${SHARED_PRODUCT_URL:-}"
APK_PATH="${APK_PATH:-dist/goodone-debug.apk}"
LOG_PATH="${LOG_PATH:-dist/android-app-links-test-logcat.txt}"
STATE_PATH="dist/android-app-links-state.txt"
PRODUCT_FOCUS_PATH="dist/android-product-link-focus.txt"
VENDOR_FOCUS_PATH="dist/android-vendor-link-focus.txt"
PRODUCT_LOG_PATH="dist/android-product-link-logcat.txt"
VENDOR_LOG_PATH="dist/android-vendor-link-logcat.txt"
PRODUCT_JSON_PATH="dist/android-app-links-product.json"
LIVE_HEADERS_PATH="dist/live-assetlinks-headers.txt"
LIVE_ASSETLINKS_PATH="dist/live-assetlinks.json"
REPO_ASSETLINKS_PATH="client/public/.well-known/assetlinks.json"
APP_LINK_VERIFY_TIMEOUT_SECONDS="${APP_LINK_VERIFY_TIMEOUT_SECONDS:-180}"
APP_LINK_VERIFY_POLL_SECONDS="${APP_LINK_VERIFY_POLL_SECONDS:-10}"

mkdir -p dist "$(dirname "$LOG_PATH")"

if ! command -v adb >/dev/null 2>&1; then
  echo "Android App Links test skipped: adb is not installed or not on PATH."
  exit 0
fi

DEVICE_ID="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
if [ -z "$DEVICE_ID" ]; then
  echo "Android App Links test skipped: no adb device/emulator is connected."
  exit 0
fi

adb_cmd() {
  adb -s "$DEVICE_ID" "$@"
}

parse_product_url() {
  node - "$1" <<'NODE'
const rawUrl = process.argv[2];

try {
  const url = new URL(rawUrl);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  if (url.protocol !== 'https:' || parts.length !== 2 || parts[0] !== 'products' || !parts[1]) {
    throw new Error('expected an HTTPS /products/<id> URL');
  }

  if (/%2f/i.test(parts[1])) {
    throw new Error('product id must not contain an encoded slash');
  }

  console.log(`${parts[1]} ${url.href} ${url.origin}`);
} catch (error) {
  console.error(`Invalid SHARED_PRODUCT_URL: ${error.message}`);
  process.exit(1);
}
NODE
}

parse_product_ids_from_response() {
  node - "$1" <<'NODE'
const fs = require('fs');

const payloadPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

const firstArray = (...values) => values.find((value) => Array.isArray(value)) || [];
const getId = (value) => value?._id || value?.id || value?.uuid || '';
const getVendorId = (product) => (
  product?.vendorId ||
  product?.vendor_id ||
  getId(product?.vendor) ||
  getId(product?.vendorProfile) ||
  getId(product?.seller) ||
  ''
);

const productFromObject = (...values) => values.find((value) => (
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  getId(value) &&
  getVendorId(value)
));

const productFromList = firstArray(
  payload,
  payload.products,
  payload.data,
  payload.data?.products,
  payload.result,
  payload.result?.products
).find((item) => item && item.isActive !== false && getId(item) && getVendorId(item));

const product = productFromObject(
  payload.product,
  payload.data?.product,
  payload.result?.product,
  payload.data,
  payload.result,
  payload
) || productFromList;

if (!product) {
  console.error('No product with a vendor id was found in the API response.');
  process.exit(1);
}

console.log(`${getId(product)} ${getVendorId(product)}`);
NODE
}

fetch_live_assetlinks() {
  : > "$LIVE_HEADERS_PATH"
  : > "$LIVE_ASSETLINKS_PATH"
  curl -fsSL -D "$LIVE_HEADERS_PATH" "$WEB_ORIGIN/.well-known/assetlinks.json" \
    -o "$LIVE_ASSETLINKS_PATH" || true
}

find_apksigner() {
  if command -v apksigner >/dev/null 2>&1; then
    command -v apksigner
    return 0
  fi

  local sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
  if [ -d "$sdk_dir/build-tools" ]; then
    find "$sdk_dir/build-tools" -name apksigner -type f | sort | tail -n 1
  fi
}

print_apk_certificate_diagnostics() {
  local apksigner_bin
  apksigner_bin="$(find_apksigner || true)"

  if [ -n "$apksigner_bin" ] && [ -f "$APK_PATH" ]; then
    local apk_sha256_hex
    apk_sha256_hex="$("$apksigner_bin" verify --print-certs "$APK_PATH" 2>/dev/null \
      | sed -nE 's/^Signer #[0-9]+ certificate SHA-256 digest: ([0-9A-Fa-f]+)$/\1/p' \
      | head -n 1)"

    if [ -n "$apk_sha256_hex" ]; then
      node - "$apk_sha256_hex" <<'NODE'
const hex = process.argv[2].replace(/:/g, '').toUpperCase();
const fingerprint = (hex.match(/.{2}/g) || []).join(':');
console.log(`APK SHA-256 from apksigner: ${fingerprint}`);
NODE
    else
      echo "APK SHA-256 from apksigner: unavailable"
    fi
  elif [ -f "$APK_PATH" ]; then
    echo "APK SHA-256 from apksigner: unavailable (apksigner not found)"
  else
    echo "APK SHA-256 from apksigner: unavailable ($APK_PATH not found)"
  fi

  if command -v keytool >/dev/null 2>&1 && [ -f "$HOME/.android/debug.keystore" ]; then
    local debug_sha256
    debug_sha256="$(keytool -list -v \
      -keystore "$HOME/.android/debug.keystore" \
      -alias androiddebugkey \
      -storepass android 2>/dev/null \
      | sed -nE 's/^[[:space:]]*SHA256:[[:space:]]*//p' \
      | head -n 1)"

    if [ -n "$debug_sha256" ]; then
      echo "Debug keystore SHA-256 from keytool: $debug_sha256"
    fi
  fi
}

print_app_link_diagnostics() {
  echo ""
  echo "Android App Links diagnostics"
  echo "pm get-app-links:"
  adb_cmd shell pm get-app-links --user cur "$APP_ID" | tee "$STATE_PATH" || true

  fetch_live_assetlinks

  local installed_signatures
  installed_signatures="$(sed -nE 's/.*Signatures: \[([^]]+)\].*/\1/p' "$STATE_PATH" | head -n 1)"

  print_apk_certificate_diagnostics

  node - "$LIVE_HEADERS_PATH" "$LIVE_ASSETLINKS_PATH" "$REPO_ASSETLINKS_PATH" "$installed_signatures" <<'NODE'
const fs = require('fs');

const [headersPath, livePath, repoPath, installedSignaturesRaw] = process.argv.slice(2);

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
};

const readJson = (filePath) => {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { error: error.message };
  }
};

const fingerprints = (data) => (
  Array.isArray(data)
    ? data.flatMap((statement) => statement?.target?.sha256_cert_fingerprints || [])
    : []
);

const packageNames = (data) => (
  Array.isArray(data)
    ? data.map((statement) => statement?.target?.package_name).filter(Boolean)
    : []
);

const headers = readText(headersPath);
const statusLines = headers.split(/\r?\n/).filter((line) => /^HTTP\//i.test(line));
const contentTypes = [...headers.matchAll(/^content-type:\s*(.+)$/gim)].map((match) => match[1].trim());
const finalStatus = statusLines.at(-1) || '(not fetched)';
const finalContentType = contentTypes.at(-1) || '(not found)';
const hasRedirect = statusLines.some((line) => /\s30[1278]\s/.test(line));

const live = readJson(livePath);
const repo = readJson(repoPath);
const liveFingerprints = fingerprints(live.value);
const repoFingerprints = fingerprints(repo.value);
const installedSignatures = String(installedSignaturesRaw || '')
  .split(',')
  .map((signature) => signature.trim())
  .filter(Boolean);

console.log(`Live assetlinks final HTTP: ${finalStatus}`);
console.log(`Live assetlinks content-type: ${finalContentType}`);
console.log(`Live assetlinks redirect seen: ${hasRedirect ? 'yes' : 'no'}`);
console.log(`Installed app SHA-256 from pm get-app-links: ${installedSignatures.join(', ') || '(not found)'}`);
console.log(`Live assetlinks package_name: ${live.error ? `(not valid JSON: ${live.error})` : JSON.stringify(packageNames(live.value))}`);
console.log(`Live assetlinks fingerprints: ${live.error ? `(not valid JSON: ${live.error})` : JSON.stringify(liveFingerprints)}`);
console.log(`Repo assetlinks package_name: ${repo.error ? `(not valid JSON: ${repo.error})` : JSON.stringify(packageNames(repo.value))}`);
console.log(`Repo assetlinks fingerprints: ${repo.error ? `(not valid JSON: ${repo.error})` : JSON.stringify(repoFingerprints)}`);

if (!/json/i.test(finalContentType)) {
  console.log('Live assetlinks content-type is not JSON-compatible.');
}

for (const installedSignature of installedSignatures) {
  if (!liveFingerprints.includes(installedSignature)) {
    console.log(`Missing installed app fingerprint in live assetlinks.json: ${installedSignature}`);
  }
  if (!repoFingerprints.includes(installedSignature)) {
    console.log(`Installed app fingerprint is not in repo assetlinks.json: ${installedSignature}`);
  }
}

if (repo.error) {
  console.log(`Repo assetlinks.json parse error: ${repo.error}`);
}

if (live.error) {
  console.log(`Live assetlinks.json parse error: ${live.error}`);
}
NODE

  echo ""
  echo "Live assetlinks response headers:"
  cat "$LIVE_HEADERS_PATH" || true
}

fail_with_diagnostics() {
  local exit_code="$1"
  shift
  echo "ERROR: $*"
  print_app_link_diagnostics
  exit "$exit_code"
}

print_manual_recovery_instructions() {
  cat <<'EOF'

Manual Android App Links recovery:
  Android Settings -> Apps -> GoodOne -> Open by default -> Open supported links ON -> enable good-one-jlcu.onrender.com.

If the domain remains disabled or opens Chrome after the live assetlinks.json is valid, uninstall and reinstall the app:
  adb uninstall com.goodone.marketplace
  SHARED_PRODUCT_URL="https://good-one-jlcu.onrender.com/products/8522bf8f-9dfc-41f6-b696-805ffc58ebe5" ./launch-debug_apk.sh
EOF
}

check_app_links_verified_state() {
  node - "$STATE_PATH" "$HOST" <<'NODE'
const fs = require('fs');

const [statePath, host] = process.argv.slice(2);
const text = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hostPattern = escapeRegExp(host);
const stateMatch = text.match(new RegExp(`^\\s*${hostPattern}:\\s*([^\\r\\n]+)`, 'm'));
const state = (stateMatch?.[1] || '').trim();
const disabled = new RegExp(`Selection state:[\\s\\S]*?Disabled:[\\s\\S]*?^\\s*${hostPattern}\\s*$`, 'm').test(text);
const verified = /^(verified|approved)$/i.test(state);
const hardFailure = /^(denied|legacy_failure)$/i.test(state);

if (disabled) {
  console.log(`disabled:${state || 'missing'}`);
  process.exit(2);
}

if (verified) {
  console.log(`verified:${state}`);
  process.exit(0);
}

if (hardFailure) {
  console.log(`failed:${state}`);
  process.exit(3);
}

if (state === '1024') {
  console.log('pending:1024');
  process.exit(4);
}

console.log(`pending:${state || 'missing'}`);
process.exit(4);
NODE
}

wait_for_app_links_verified() {
  echo ""
  echo "Requesting Android App Links re-verification..."
  adb_cmd shell pm set-app-links --package "$APP_ID" 0 all || true
  adb_cmd shell pm verify-app-links --re-verify "$APP_ID" || true
  # Mirror the manual "Open supported links ON" setting for this test device.
  # If Android still reports the host under Disabled after this, the script
  # fails below and prints manual recovery steps.
  adb_cmd shell pm set-app-links-allowed --user cur --package "$APP_ID" true || true
  adb_cmd shell pm set-app-links-user-selection --user cur --package "$APP_ID" true "$HOST" || true

  local deadline=$((SECONDS + APP_LINK_VERIFY_TIMEOUT_SECONDS))
  local status_output
  local status_code
  local user_selection_recovery_attempted="false"

  while true; do
    adb_cmd shell pm get-app-links --user cur "$APP_ID" | tee "$STATE_PATH" || true

    set +e
    status_output="$(check_app_links_verified_state)"
    status_code=$?
    set -e

    echo "Parsed App Links verification state for $HOST: $status_output"

    if [ "$status_code" -eq 0 ]; then
      return 0
    fi

    if [ "$status_code" -eq 2 ] &&
      [ "$user_selection_recovery_attempted" = "false" ] &&
      [[ "$status_output" =~ ^disabled:(verified|approved)$ ]]; then
      echo "Android verified $HOST but user selection is disabled; enabling the host once and re-checking."
      adb_cmd shell pm set-app-links-allowed --user cur --package "$APP_ID" true || true
      adb_cmd shell pm set-app-links-user-selection --user cur --package "$APP_ID" true "$HOST" || true
      user_selection_recovery_attempted="true"
      sleep 2
      continue
    fi

    if [ "$status_code" -eq 2 ]; then
      echo "ERROR: Android user selection has disabled $HOST for $APP_ID."
      print_manual_recovery_instructions
      return 2
    fi

    if [ "$status_code" -eq 3 ]; then
      echo "ERROR: Android reported App Links verification failure for $HOST: $status_output"
      print_manual_recovery_instructions
      return 3
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "ERROR: timed out waiting ${APP_LINK_VERIFY_TIMEOUT_SECONDS}s for $HOST to become verified or approved."
      print_manual_recovery_instructions
      return 4
    fi

    sleep "$APP_LINK_VERIFY_POLL_SECONDS"
  done
}

echo "Testing Android App Links on adb device $DEVICE_ID"
echo "APP_ID=$APP_ID"
echo "WEB_ORIGIN=$WEB_ORIGIN"
echo "API_BASE=$API_BASE"
if [ -n "$SHARED_PRODUCT_URL" ]; then
  echo "SHARED_PRODUCT_URL=$SHARED_PRODUCT_URL"
fi

if [ -n "$SHARED_PRODUCT_URL" ]; then
  read -r PRODUCT_ID PRODUCT_URL SHARED_ORIGIN < <(parse_product_url "$SHARED_PRODUCT_URL")

  if [ -z "$WEB_ORIGIN_INPUT" ]; then
    WEB_ORIGIN="$SHARED_ORIGIN"
  fi

  echo "Fetching product details for SHARED_PRODUCT_URL..."
  curl -fsS "$API_BASE/products/$PRODUCT_ID" -o "$PRODUCT_JSON_PATH"
  read -r RESPONSE_PRODUCT_ID VENDOR_ID < <(parse_product_ids_from_response "$PRODUCT_JSON_PATH")

  if [ "$RESPONSE_PRODUCT_ID" != "$PRODUCT_ID" ]; then
    echo "ERROR: API returned product id $RESPONSE_PRODUCT_ID for shared product id $PRODUCT_ID"
    exit 1
  fi
else
  echo "Fetching one live product..."
  curl -fsS "$API_BASE/products?limit=1" -o "$PRODUCT_JSON_PATH"
  read -r PRODUCT_ID VENDOR_ID < <(parse_product_ids_from_response "$PRODUCT_JSON_PATH")
  PRODUCT_URL="$WEB_ORIGIN/products/$PRODUCT_ID"
fi

if [ -z "${PRODUCT_ID:-}" ] || [ -z "${VENDOR_ID:-}" ]; then
  echo "ERROR: could not parse PRODUCT_ID and VENDOR_ID from $PRODUCT_JSON_PATH"
  exit 1
fi

VENDOR_URL="$WEB_ORIGIN/vendors/$VENDOR_ID"
HOST="$(node -e "console.log(new URL(process.argv[1]).host)" "$PRODUCT_URL")"

echo "PRODUCT_ID=$PRODUCT_ID"
echo "VENDOR_ID=$VENDOR_ID"
echo "PRODUCT_URL=$PRODUCT_URL"
echo "VENDOR_URL=$VENDOR_URL"

echo ""
echo "Current Android App Links state:"
adb_cmd shell pm get-app-links --user cur "$APP_ID" || true

if ! wait_for_app_links_verified; then
  fail_with_diagnostics 2 "Android App Links did not verify or approve $HOST for $APP_ID"
fi

print_app_link_diagnostics

echo ""
echo "Explicit package deep-link test..."
adb_cmd shell am force-stop "$APP_ID"
adb_cmd shell logcat -c || true
adb_cmd shell am start -W \
  -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d "$PRODUCT_URL" \
  "$APP_ID"
sleep 6
adb_cmd shell am start -W \
  -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d "$VENDOR_URL" \
  "$APP_ID"
sleep 6
adb_cmd shell logcat -d -v time > "$LOG_PATH" || true

PRODUCT_ROUTE="[GoodOne] Deep link opened: /products/$PRODUCT_ID"
VENDOR_ROUTE="[GoodOne] Deep link opened: /vendors/$VENDOR_ID"

if ! grep -Fq "$PRODUCT_ROUTE" "$LOG_PATH"; then
  echo "Log saved at $LOG_PATH"
  fail_with_diagnostics 1 "explicit product deep link did not route to /products/$PRODUCT_ID"
fi

if ! grep -Fq "$VENDOR_ROUTE" "$LOG_PATH"; then
  echo "Log saved at $LOG_PATH"
  fail_with_diagnostics 1 "explicit vendor deep link did not route to /vendors/$VENDOR_ID"
fi

if grep -iE "AndroidRuntime|FATAL EXCEPTION" "$LOG_PATH"; then
  fail_with_diagnostics 1 "crash signature found in explicit deep-link logcat."
fi

echo "Explicit package deep-link routing passed."

run_implicit_test() {
  local kind="$1"
  local url="$2"
  local expected_route="$3"
  local focus_path="$4"
  local log_path="$5"

  echo ""
  echo "Implicit OS-level $kind App Link test..."
  adb_cmd shell am force-stop "$APP_ID"
  adb_cmd shell logcat -c || true
  adb_cmd shell am start -W \
    -a android.intent.action.VIEW \
    -c android.intent.category.BROWSABLE \
    -d "$url"
  sleep 6
  adb_cmd shell dumpsys window \
    | grep -E "mCurrentFocus|topResumedActivity|mFocusedApp" \
    | tee "$focus_path" || true
  adb_cmd shell logcat -d -v time > "$log_path" || true

  if ! grep -Fq "$APP_ID" "$focus_path"; then
    echo "ERROR: implicit $kind App Link did not focus $APP_ID."
    echo "Focused/current activity:"
    cat "$focus_path" || true
    echo "This is an Android App Links verification problem if the explicit package test passed."
    fail_with_diagnostics 2 "implicit $kind App Link did not focus $APP_ID"
  fi

  if ! grep -Fq "$expected_route" "$log_path"; then
    echo "Log saved at $log_path"
    fail_with_diagnostics 1 "implicit $kind App Link focused $APP_ID but did not log route $expected_route"
  fi

  if grep -iE "AndroidRuntime|FATAL EXCEPTION" "$log_path"; then
    fail_with_diagnostics 1 "crash signature found in implicit $kind App Link logcat."
  fi

  echo "Implicit $kind App Link opened $APP_ID and routed to $expected_route"
}

run_implicit_test "product" "$PRODUCT_URL" "$PRODUCT_ROUTE" "$PRODUCT_FOCUS_PATH" "$PRODUCT_LOG_PATH"
run_implicit_test "vendor" "$VENDOR_URL" "$VENDOR_ROUTE" "$VENDOR_FOCUS_PATH" "$VENDOR_LOG_PATH"

echo ""
echo "Android App Links test passed for host $HOST"
