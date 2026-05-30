#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const mobileRoot = path.resolve(__dirname, "..");
const googleServicesFile = path.join(mobileRoot, "google-services.json");
const ANDROID_PACKAGE_NAME = "com.swico.tamilai";
const OLD_ANDROID_PACKAGE_NAME = ["com", "harishajahan", "tamilai"].join(".");

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
  if (packageNames.includes(OLD_ANDROID_PACKAGE_NAME)) {
    fail(
      `google-services.json is for ${OLD_ANDROID_PACKAGE_NAME}, but this build now requires ${ANDROID_PACKAGE_NAME}. Create a new Firebase Android app or update Firebase config, then download a new google-services.json.`,
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

function synthesizeGoogleServicesJsonFromPublicEnv() {
  const missing = missingFirebasePublicEnvNames();
  if (missing.length) {
    return missing;
  }

  const content = {
    project_info: {
      project_number: String(process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "").trim(),
      project_id: String(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || "").trim(),
      storage_bucket: String(process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || "").trim(),
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: String(process.env.EXPO_PUBLIC_FIREBASE_APP_ID || "").trim(),
          android_client_info: {
            package_name: ANDROID_PACKAGE_NAME,
          },
        },
        oauth_client: [],
        api_key: [
          {
            current_key: String(process.env.EXPO_PUBLIC_FIREBASE_API_KEY || "").trim(),
          },
        ],
        services: {
          appinvite_service: {
            other_platform_oauth_client: [],
          },
        },
      },
    ],
    configuration_version: "1",
  };

  validateGoogleServicesConfig(content);
  fs.writeFileSync(googleServicesFile, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `[ensure-google-services-json] Wrote mobile/google-services.json from complete EXPO_PUBLIC_FIREBASE_* environment for ${ANDROID_PACKAGE_NAME}. JSON content was not printed.`,
  );
  return [];
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

const missingPublicFirebaseEnv = synthesizeGoogleServicesJsonFromPublicEnv();
if (missingPublicFirebaseEnv.length === 0) {
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
    [
      "Release/production builds require mobile/google-services.json, one of GOOGLE_SERVICES_JSON_BASE64 / GOOGLE_SERVICES_JSON / FIREBASE_GOOGLE_SERVICES_JSON, or complete EXPO_PUBLIC_FIREBASE_* values that can synthesize the Android config.",
      `Missing Firebase public variable name(s): ${missingPublicFirebaseEnv.join(", ")}`,
      "Do not commit mobile/google-services.json.",
    ].join("\n"),
  );
}

fail(
  "Missing mobile/google-services.json. For local debug, provide GOOGLE_SERVICES_JSON_BASE64 or enable EXPO_PUBLIC_E2E_MOCK_AUTH=1/JAI_DEBUG_LITE=1. For release, configure a real Firebase google services secret.",
);
