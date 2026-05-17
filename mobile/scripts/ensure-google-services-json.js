#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const mobileRoot = path.resolve(__dirname, "..");
const googleServicesFile = path.join(mobileRoot, "google-services.json");

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(normalize(value));
}

function modeFromArgs() {
  const index = process.argv.indexOf("--mode");
  if (index >= 0 && process.argv[index + 1]) return normalize(process.argv[index + 1]);
  return normalize(process.env.BUILD_TYPE || process.env.JAI_BUILD_TYPE || process.env.EAS_BUILD_PROFILE || "debug");
}

function isReleaseLike(mode) {
  return (
    mode === "release" ||
    mode === "production" ||
    normalize(process.env.BUILD_TYPE) === "release" ||
    normalize(process.env.JAI_BUILD_TYPE) === "release" ||
    ["release", "production"].includes(normalize(process.env.EAS_BUILD_PROFILE)) ||
    ["release", "production"].includes(normalize(process.env.JAI_BUILD_PROFILE))
  );
}

function fail(message) {
  console.error(`\n[ensure-google-services-json] ${message}\n`);
  process.exit(1);
}

function writeJsonFromEnv(name, value, { base64 = false } = {}) {
  let content = "";
  try {
    content = base64 ? Buffer.from(String(value), "base64").toString("utf8") : String(value);
    JSON.parse(content);
  } catch (_error) {
    fail(`${name} is set but does not contain valid google-services JSON.`);
  }
  fs.writeFileSync(googleServicesFile, `${content.trim()}\n`, { mode: 0o600 });
  console.log(`[ensure-google-services-json] Wrote mobile/google-services.json from ${name}. JSON content was not printed.`);
}

const mode = modeFromArgs();

if (fs.existsSync(googleServicesFile)) {
  console.log("[ensure-google-services-json] mobile/google-services.json already exists.");
  process.exit(0);
}

if (process.env.GOOGLE_SERVICES_JSON_BASE64) {
  writeJsonFromEnv("GOOGLE_SERVICES_JSON_BASE64", process.env.GOOGLE_SERVICES_JSON_BASE64, { base64: true });
  process.exit(0);
}

if (process.env.GOOGLE_SERVICES_JSON) {
  writeJsonFromEnv("GOOGLE_SERVICES_JSON", process.env.GOOGLE_SERVICES_JSON);
  process.exit(0);
}

if (process.env.FIREBASE_GOOGLE_SERVICES_JSON) {
  writeJsonFromEnv("FIREBASE_GOOGLE_SERVICES_JSON", process.env.FIREBASE_GOOGLE_SERVICES_JSON);
  process.exit(0);
}

if (!isReleaseLike(mode) && (isTruthy(process.env.EXPO_PUBLIC_E2E_MOCK_AUTH) || isTruthy(process.env.JAI_DEBUG_LITE))) {
  console.log(
    "[ensure-google-services-json] Missing mobile/google-services.json; continuing because debug mock auth/debug-lite is enabled.",
  );
  process.exit(0);
}

if (isReleaseLike(mode)) {
  fail(
    "Release/production builds require mobile/google-services.json or one of GOOGLE_SERVICES_JSON_BASE64, GOOGLE_SERVICES_JSON, FIREBASE_GOOGLE_SERVICES_JSON. Configure this as an EAS/CI secret; do not commit the JSON file.",
  );
}

fail(
  "Missing mobile/google-services.json. For local debug, provide GOOGLE_SERVICES_JSON_BASE64 or enable EXPO_PUBLIC_E2E_MOCK_AUTH=1/JAI_DEBUG_LITE=1. For release, configure a real Firebase google services secret.",
);
