#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const mobileRoot = path.resolve(__dirname, "..");
const googleServicesFile = path.join(mobileRoot, "google-services.json");
const ANDROID_PACKAGE_NAME = "com.swico.swivel";
const OBSOLETE_ANDROID_PACKAGE_NAMES = [
  "com.swico.tamilai",
  "com.harishajahan.tamilai",
];

const FIREBASE_PUBLIC_ENV_NAMES = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
];

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

function packageNamesFromGoogleServicesConfig(config) {
  const names = new Set();
  const clients = Array.isArray(config?.client) ? config.client : [];
  for (const client of clients) {
    const packageName = client?.client_info?.android_client_info?.package_name;
    if (typeof packageName === "string" && packageName.trim()) {
      names.add(packageName.trim());
    }
  }
  return [...names];
}

function validateGoogleServicesConfig(config) {
  const packageNames = packageNamesFromGoogleServicesConfig(config);
  const obsoletePackageNames = packageNames.filter((packageName) =>
    OBSOLETE_ANDROID_PACKAGE_NAMES.includes(packageName),
  );
  if (obsoletePackageNames.length && !packageNames.includes(ANDROID_PACKAGE_NAME)) {
    fail(
      `google-services.json contains obsolete Android package(s) ${obsoletePackageNames.join(", ")}, but this build requires ${ANDROID_PACKAGE_NAME}. Register ${ANDROID_PACKAGE_NAME} as a new Firebase Android app and download a matching google-services.json.`,
    );
  }

  if (packageNames.includes(ANDROID_PACKAGE_NAME)) {
    return;
  }

  if (packageNames.length === 0) {
    fail(
      `google-services.json does not contain an Android package_name for ${ANDROID_PACKAGE_NAME}. Create a Firebase Android app for ${ANDROID_PACKAGE_NAME}, then download a new google-services.json.`,
    );
  }

  fail(
    `google-services.json is for ${packageNames.join(", ")}, but this build requires ${ANDROID_PACKAGE_NAME}. Create a Firebase Android app for ${ANDROID_PACKAGE_NAME}, then download a new google-services.json.`,
  );
}

function missingFirebasePublicEnvNames() {
  return FIREBASE_PUBLIC_ENV_NAMES.filter((name) => !String(process.env[name] || "").trim());
}

function writeJsonFromEnv(name, value, { base64 = false } = {}) {
  let content = "";
  try {
    content = base64 ? Buffer.from(String(value), "base64").toString("utf8") : String(value);
    validateGoogleServicesConfig(JSON.parse(content));
  } catch (_error) {
    fail(`${name} is set but does not contain valid google-services JSON.`);
  }
  fs.writeFileSync(googleServicesFile, `${content.trim()}\n`, { mode: 0o600 });
  console.log(`[ensure-google-services-json] Wrote mobile/google-services.json from ${name}. JSON content was not printed.`);
}

const mode = modeFromArgs();

if (fs.existsSync(googleServicesFile)) {
  try {
    validateGoogleServicesConfig(JSON.parse(fs.readFileSync(googleServicesFile, "utf8")));
  } catch (_error) {
    fail("mobile/google-services.json exists but does not contain valid google-services JSON.");
  }
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

const missingPublicFirebaseEnv = missingFirebasePublicEnvNames();

if (!isReleaseLike(mode) && (isTruthy(process.env.EXPO_PUBLIC_E2E_MOCK_AUTH) || isTruthy(process.env.JAI_DEBUG_LITE))) {
  console.log(
    "[ensure-google-services-json] Missing mobile/google-services.json; continuing because debug mock auth/debug-lite is enabled.",
  );
  process.exit(0);
}

if (isReleaseLike(mode)) {
  fail(
    [
      `Release/production builds require an authoritative google-services.json for Android package ${ANDROID_PACKAGE_NAME}.`,
      "EXPO_PUBLIC_FIREBASE_* values alone cannot prove that the Firebase Android app registration matches this package and will not be used to synthesize the file.",
      "Provide mobile/google-services.json or one of GOOGLE_SERVICES_JSON_BASE64 / GOOGLE_SERVICES_JSON / FIREBASE_GOOGLE_SERVICES_JSON containing the new Android app.",
      missingPublicFirebaseEnv.length
        ? `Missing Firebase public variable name(s): ${missingPublicFirebaseEnv.join(", ")}`
        : "Firebase public variables are present, but they do not replace the authoritative Android config.",
      "Do not commit mobile/google-services.json.",
    ].join("\n"),
  );
}

fail(
  `Missing authoritative mobile/google-services.json for Android package ${ANDROID_PACKAGE_NAME}. For local debug, provide GOOGLE_SERVICES_JSON_BASE64 / GOOGLE_SERVICES_JSON or enable EXPO_PUBLIC_E2E_MOCK_AUTH=1/JAI_DEBUG_LITE=1. For release, configure a real Firebase google services secret for the new Android app.`,
);
