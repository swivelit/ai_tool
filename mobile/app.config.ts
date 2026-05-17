import fs from "node:fs";
import path from "node:path";

const APP_SCHEME = "com.harishajahan.tamilai";

const LOCAL_MODEL_BASE_URL = (
  process.env.EXPO_PUBLIC_LOCAL_MODEL_BASE_URL || ""
).trim();

const USE_LOCAL_CHAT_PIPELINE =
  process.env.EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE ?? "false";

const USE_LOCAL_VOICE_PIPELINE =
  process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE ?? "false";

const E2E_MOCK_AUTH = process.env.EXPO_PUBLIC_E2E_MOCK_AUTH || "";
const E2E_SKIP_MODEL_SETUP =
  process.env.EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP || "";

const LOCAL_MODEL_RUNTIME_MODE =
  process.env.EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE || "native_on_device";

const LOCAL_MODEL_ADAPTER_LOCATION =
  process.env.EXPO_PUBLIC_LOCAL_MODEL_ADAPTER_LOCATION || "external_lan";

const LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK =
  process.env.EXPO_PUBLIC_LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK || "false";

const LOCAL_ON_DEVICE_BACKEND =
  process.env.EXPO_PUBLIC_LOCAL_ON_DEVICE_BACKEND || "llama_cpp";

const LOCAL_ON_DEVICE_NATIVE_MODULE =
  process.env.EXPO_PUBLIC_LOCAL_ON_DEVICE_NATIVE_MODULE || "JaiOnDeviceModel";

const LOCAL_ON_DEVICE_MODEL_ROOT =
  process.env.EXPO_PUBLIC_LOCAL_ON_DEVICE_MODEL_ROOT || "document://models";

const LOCAL_MODEL_DELIVERY_MODE =
  process.env.EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE || "download_on_first_launch";

const LOCAL_MODEL_CDN_BASE_URL = (
  process.env.EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL ||
  process.env.EXPO_PUBLIC_MODEL_CDN_BASE_URL ||
  ""
).trim();

const LOCAL_MODEL_URL_GEMMA_4B = process.env.EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B || "";
const LOCAL_MODEL_URL_QWEN_8B = process.env.EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B || "";
const LOCAL_MODEL_URL_QWEN_14B = process.env.EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B || "";
const LOCAL_MODEL_URL_QWEN_EMBED = process.env.EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED || "";

const LOCAL_MODEL_BYTES_GEMMA_4B = process.env.EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B || "";
const LOCAL_MODEL_BYTES_QWEN_8B = process.env.EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B || "";
const LOCAL_MODEL_BYTES_QWEN_14B = process.env.EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B || "";
const LOCAL_MODEL_BYTES_QWEN_EMBED = process.env.EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED || "";
const LOCAL_MODEL_SHA256_GEMMA_4B = process.env.EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B || "";
const LOCAL_MODEL_SHA256_QWEN_8B = process.env.EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B || "";
const LOCAL_MODEL_SHA256_QWEN_14B = process.env.EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B || "";
const LOCAL_MODEL_SHA256_QWEN_EMBED = process.env.EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED || "";

const FIREBASE_PUBLIC_ENV_NAMES = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
];

function normalizeEnvFlag(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isTruthyEnv(value: unknown) {
  return ["1", "true", "yes", "y", "on"].includes(normalizeEnvFlag(value));
}

const normalizedRuntimeMode = normalizeEnvFlag(LOCAL_MODEL_RUNTIME_MODE);
const normalizedEasProfile = normalizeEnvFlag(process.env.EAS_BUILD_PROFILE);
const normalizedJaiBuildProfile = normalizeEnvFlag(process.env.JAI_BUILD_PROFILE);
const normalizedJaiBuildType = normalizeEnvFlag(
  process.env.JAI_BUILD_TYPE || process.env.BUILD_TYPE,
);
const isNativeOnDeviceRuntime = normalizedRuntimeMode === "native_on_device";
const isProductionOrReleaseBuild =
  normalizedEasProfile === "production" ||
  normalizedEasProfile === "release" ||
  normalizedJaiBuildProfile === "production" ||
  normalizedJaiBuildProfile === "release" ||
  normalizedJaiBuildType === "release" ||
  isTruthyEnv(process.env.JAI_REQUIRE_LLAMA_CPP);

const isProductionNativeOnDeviceBuild =
  isProductionOrReleaseBuild && isNativeOnDeviceRuntime;
const normalizedModelDeliveryMode = normalizeEnvFlag(LOCAL_MODEL_DELIVERY_MODE);
const isProductionNativeDownloadBuild =
  isProductionOrReleaseBuild &&
  isNativeOnDeviceRuntime &&
  normalizedModelDeliveryMode === "download_on_first_launch";
const isReleaseLocalVoicePipelineAllowed = isTruthyEnv(
  process.env.JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE,
);

const enabledE2eEnvNames = [
  ["EXPO_PUBLIC_E2E_MOCK_AUTH", E2E_MOCK_AUTH],
  ["EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP", E2E_SKIP_MODEL_SETUP],
]
  .filter(([, value]) => isTruthyEnv(value))
  .map(([name]) => name);

if (isProductionOrReleaseBuild && enabledE2eEnvNames.length) {
  throw new Error(
    `Release/production builds cannot enable debug E2E flags: ${enabledE2eEnvNames.join(
      ", ",
    )}. Disable mock auth/model setup bypass before building a release APK.`,
  );
}

if (
  isProductionOrReleaseBuild &&
  isTruthyEnv(USE_LOCAL_VOICE_PIPELINE) &&
  !isReleaseLocalVoicePipelineAllowed
) {
  throw new Error(
    "Release/production builds should route recorded voice through backend Sarvam by default. " +
      "EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=true enables local/native STT and requires " +
      "JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1 as an explicit release override.",
  );
}

const missingFirebaseEnvNames = FIREBASE_PUBLIC_ENV_NAMES.filter(
  (name) => !String(process.env[name] || "").trim(),
);

if (isProductionOrReleaseBuild && missingFirebaseEnvNames.length) {
  throw new Error(
    `Release/production native builds require Firebase config. Missing: ${missingFirebaseEnvNames.join(
      ", ",
    )}. Set all EXPO_PUBLIC_FIREBASE_* values before expo config/prebuild/build.`,
  );
}

const LOCAL_MODEL_REQUIRE_SHA256 = isProductionNativeDownloadBuild
  ? "true"
  : process.env.EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_SHA256 ||
    process.env.EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_INTEGRITY_METADATA ||
    "false";

if (isProductionOrReleaseBuild && normalizedRuntimeMode === "local_adapter") {
  throw new Error(
    "Production/release builds cannot use runtime.mode=local_adapter. " +
      "local_adapter is development-only; use EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE=native_on_device.",
  );
}

const MOBILE_ROOT = fs.existsSync(path.join(process.cwd(), "app.config.ts"))
  ? process.cwd()
  : fs.existsSync(path.join(process.cwd(), "mobile", "app.config.ts"))
    ? path.join(process.cwd(), "mobile")
    : process.cwd();

const DEFAULT_LLAMA_CPP_DIR = path.join(
  MOBILE_ROOT,
  "modules",
  "jai-on-device-model",
  "vendor",
  "llama.cpp",
);

const LOCAL_LLAMA_CPP_DIR = process.env.JAI_LLAMA_CPP_DIR
  ? path.resolve(MOBILE_ROOT, process.env.JAI_LLAMA_CPP_DIR)
  : DEFAULT_LLAMA_CPP_DIR;

function hasUsableLlamaCppCheckout(dir: string) {
  return (
    fs.existsSync(path.join(dir, "CMakeLists.txt")) &&
    fs.existsSync(path.join(dir, "include", "llama.h"))
  );
}

if (isProductionNativeOnDeviceBuild && !hasUsableLlamaCppCheckout(LOCAL_LLAMA_CPP_DIR)) {
  throw new Error(
    `Release/production native_on_device build requires llama.cpp at ${DEFAULT_LLAMA_CPP_DIR} ` +
      "or JAI_LLAMA_CPP_DIR. Run `npm run native:sync-llama` from mobile/ or " +
      "`git submodule update --init --recursive` before prebuild/build. " +
      "Refusing to ship with JAI_LLAMA_CPP_AVAILABLE=0.",
  );
}

const CDN_URL_PATTERN = /^cdn:\/\//i;
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(?:MODEL_CDN_BASE_URL|LOCAL_MODEL_CDN_BASE_URL)\s*\}\}/i;
const PLACEHOLDER_URL_PATTERN = /^https:\/\/YOUR_MODEL_CDN\//i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function unresolvedProductionUrlReason(value: string, label: string) {
  const url = String(value || "").trim();
  if (!url) return `${label} is empty`;
  if (PLACEHOLDER_URL_PATTERN.test(url)) return `${label} still uses the YOUR_MODEL_CDN placeholder`;
  if (CDN_URL_PATTERN.test(url)) return `${label} is still a cdn:// placeholder`;
  if (TEMPLATE_TOKEN_PATTERN.test(url)) return `${label} still contains an unresolved CDN template token`;
  if (!/^https?:\/\//i.test(url)) return `${label} must be an http(s) URL`;
  return "";
}

function requireProductionValue(name: string, value: string) {
  if (!isProductionNativeDownloadBuild) return;
  if (String(value || "").trim()) return;
  throw new Error(
    `Release/production native_on_device download_on_first_launch build is missing ${name}. ` +
      "Set it before prebuild/build. Use public CDN URLs or release-generated signed URLs only; do not hardcode secrets.",
  );
}

function requireProductionResolvedUrl(name: string, value: string) {
  if (!isProductionNativeDownloadBuild) return;
  requireProductionValue(name, value);
  const reason = unresolvedProductionUrlReason(value, name);
  if (reason) {
    throw new Error(
      `Release/production native_on_device download_on_first_launch build has unresolved model URL metadata: ${reason}. ` +
        "Configure EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL or all per-model EXPO_PUBLIC_LOCAL_MODEL_URL_* values with real public/signed http(s) URLs.",
    );
  }
}

function requireProductionPositiveInteger(name: string, value: string) {
  if (!isProductionNativeDownloadBuild) return;
  requireProductionValue(name, value);
  const normalized = String(value || "").trim().replace(/_/g, "");
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Release/production native_on_device download_on_first_launch build requires ${name} to be an exact positive integer byte size.`,
    );
  }
}

function requireProductionSha256(name: string, value: string) {
  if (!isProductionNativeDownloadBuild) return;
  requireProductionValue(name, value);
  if (!SHA256_PATTERN.test(String(value || "").trim())) {
    throw new Error(
      `Release/production native_on_device download_on_first_launch build requires ${name} to be a 64-character SHA-256 hex digest.`,
    );
  }
}

if (isProductionNativeDownloadBuild) {
  if (LOCAL_MODEL_CDN_BASE_URL) {
    requireProductionResolvedUrl("EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL", LOCAL_MODEL_CDN_BASE_URL);
  } else {
    requireProductionResolvedUrl("EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B or EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL", LOCAL_MODEL_URL_GEMMA_4B);
    requireProductionResolvedUrl("EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B or EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL", LOCAL_MODEL_URL_QWEN_8B);
    requireProductionResolvedUrl("EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B or EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL", LOCAL_MODEL_URL_QWEN_14B);
    requireProductionResolvedUrl("EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED or EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL", LOCAL_MODEL_URL_QWEN_EMBED);
  }
}

requireProductionPositiveInteger("EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B", LOCAL_MODEL_BYTES_GEMMA_4B);
requireProductionPositiveInteger("EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B", LOCAL_MODEL_BYTES_QWEN_8B);
requireProductionPositiveInteger("EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B", LOCAL_MODEL_BYTES_QWEN_14B);
requireProductionPositiveInteger("EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED", LOCAL_MODEL_BYTES_QWEN_EMBED);
requireProductionSha256("EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B", LOCAL_MODEL_SHA256_GEMMA_4B);
requireProductionSha256("EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B", LOCAL_MODEL_SHA256_QWEN_8B);
requireProductionSha256("EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B", LOCAL_MODEL_SHA256_QWEN_14B);
requireProductionSha256("EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED", LOCAL_MODEL_SHA256_QWEN_EMBED);

const modelDeliveryExtra = {
  LOCAL_MODEL_CDN_BASE_URL,
  EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL: LOCAL_MODEL_CDN_BASE_URL,
  LOCAL_MODEL_REQUIRE_SHA256,
  LOCAL_MODEL_REQUIRE_INTEGRITY_METADATA: LOCAL_MODEL_REQUIRE_SHA256,

  // Public or signed CDN URLs. These values are bundled into the app when using
  // EXPO_PUBLIC_*, so do not put long-lived secrets here. Use public CDN paths
  // or short-lived signed URLs generated by your release pipeline.
  LOCAL_MODEL_URL_GEMMA_4B,
  LOCAL_MODEL_URL_QWEN_8B,
  LOCAL_MODEL_URL_QWEN_14B,
  LOCAL_MODEL_URL_QWEN_EMBED,
  EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B: LOCAL_MODEL_URL_GEMMA_4B,
  EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B: LOCAL_MODEL_URL_QWEN_8B,
  EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B: LOCAL_MODEL_URL_QWEN_14B,
  EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED: LOCAL_MODEL_URL_QWEN_EMBED,

  // Integrity metadata. Production native_on_device builds fail clearly when
  // expected byte sizes or SHA-256 hashes are missing.
  LOCAL_MODEL_BYTES_GEMMA_4B,
  LOCAL_MODEL_BYTES_QWEN_8B,
  LOCAL_MODEL_BYTES_QWEN_14B,
  LOCAL_MODEL_BYTES_QWEN_EMBED,
  LOCAL_MODEL_SHA256_GEMMA_4B,
  LOCAL_MODEL_SHA256_QWEN_8B,
  LOCAL_MODEL_SHA256_QWEN_14B,
  LOCAL_MODEL_SHA256_QWEN_EMBED,
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B: LOCAL_MODEL_BYTES_GEMMA_4B,
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B: LOCAL_MODEL_BYTES_QWEN_8B,
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B: LOCAL_MODEL_BYTES_QWEN_14B,
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED: LOCAL_MODEL_BYTES_QWEN_EMBED,
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B: LOCAL_MODEL_SHA256_GEMMA_4B,
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B: LOCAL_MODEL_SHA256_QWEN_8B,
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B: LOCAL_MODEL_SHA256_QWEN_14B,
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED: LOCAL_MODEL_SHA256_QWEN_EMBED,
};

export default {
  expo: {
    name: "J AI",
    slug: "tamil-ai",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: APP_SCHEME,
    userInterfaceStyle: "automatic",
    newArchEnabled: true,

    extra: {
      APP_SCHEME,
      API_BASE:
        process.env.EXPO_PUBLIC_API_BASE ||
        process.env.EXPO_PUBLIC_API_URL ||
        "https://ai-tool-rrau.onrender.com",
      apiUrl:
        process.env.EXPO_PUBLIC_API_URL ||
        process.env.EXPO_PUBLIC_API_BASE ||
        "https://ai-tool-rrau.onrender.com",

      // phone-local runtime
      // Backend AI router is primary. Local runtime mode remains explicit for
      // optional fallback/development paths:
      // - native_on_device is the intended production path. It requires a
      //   custom Expo dev client/prebuild with the native llama.cpp bridge.
      // - local_adapter is development-only and keeps /chat/completions and
      //   /embeddings as local adapter contracts.
      LOCAL_MODEL_BASE_URL,
      LOCAL_MODEL_RUNTIME_MODE,
      LOCAL_MODEL_ADAPTER_LOCATION,
      LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK,
      LOCAL_MODEL_OPENAI_POLICY: "backend_controlled",
      LOCAL_MODEL_BACKEND_ROLE: "primary",
      LOCAL_ON_DEVICE_BACKEND,
      LOCAL_ON_DEVICE_NATIVE_MODULE,
      LOCAL_ON_DEVICE_MODEL_ROOT,
      LOCAL_MODEL_DELIVERY_MODE,
      ...modelDeliveryExtra,
      // Local chat interception is optional fallback/dev only.
      USE_LOCAL_CHAT_PIPELINE,
      // Recorded voice defaults to the authenticated backend; set this true
      // only for explicit development of phone-local STT.
      USE_LOCAL_VOICE_PIPELINE,
      E2E_MOCK_AUTH,
      E2E_SKIP_MODEL_SETUP,
      EXPO_PUBLIC_E2E_MOCK_AUTH: E2E_MOCK_AUTH,
      EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP: E2E_SKIP_MODEL_SETUP,

      // Do not bundle a bearer token into the mobile app. EXPO_PUBLIC_* values are public.
      // Use Firebase-authenticated backend proxying or a short-lived pairing token instead.
      LOCAL_MODEL_API_KEY: "",
      LOCAL_MODEL_TIMEOUT_MS: Number(
        process.env.EXPO_PUBLIC_LOCAL_MODEL_TIMEOUT_MS || 120000,
      ),

      // local speech-to-text model
      // set this to the exact model name exposed by your local runtime
      LOCAL_STT_MODEL: process.env.EXPO_PUBLIC_LOCAL_STT_MODEL || "whisper",

      // requested local LLM / embedding models
      LOCAL_MODEL_GEMMA_4B:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_GEMMA_4B || "google/gemma-3-4b-it",
      LOCAL_MODEL_QWEN_8B:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_QWEN_8B || "Qwen/Qwen3-8B",
      LOCAL_MODEL_QWEN_14B:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_QWEN_14B || "Qwen/Qwen3-14B",
      LOCAL_MODEL_QWEN_EMBED:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_QWEN_EMBED ||
        "Qwen/Qwen3-Embedding-0.6B",

      firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
      firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
      firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
      firebaseMessagingSenderId:
        process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,

      googleAndroidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
      googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,

      router: {},

      eas: {
        projectId: "43fd64c5-dbf3-4e80-8057-ecbb15689e27",
      },
    },

    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.harishajahan.tamilai",
    },

    android: {
      package: "com.harishajahan.tamilai",
      googleServicesFile: "./google-services.json",
      edgeToEdgeEnabled: true,
      softwareKeyboardLayoutMode: "resize",
      predictiveBackGestureEnabled: false,
      adaptiveIcon: {
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
        backgroundColor: "#E6F4FE",
      },
    },

    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },

    plugins: [
      "expo-router",
      "expo-asset",
      "./plugins/withJaiOnDeviceModelAssets",
      "expo-secure-store",
      "@react-native-google-signin/google-signin",
      [
        "expo-speech-recognition",
        {
          microphonePermission:
            "Allow $(PRODUCT_NAME) to use the microphone for hands-free voice mode.",
          speechRecognitionPermission:
            "Allow $(PRODUCT_NAME) to recognize speech for hands-free voice mode.",
          androidSpeechServicePackages: [
            "com.google.android.googlequicksearchbox",
            "com.google.android.tts",
            "com.google.android.as",
          ],
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
    ],

    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
  },
};
