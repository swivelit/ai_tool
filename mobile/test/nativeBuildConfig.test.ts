import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const moduleRoot = path.join(mobileRoot, "modules", "jai-on-device-model");
const require = createRequire(import.meta.url);
const nativeLlamaVerifierPath = path.join(
  mobileRoot,
  "scripts",
  "verify-native-llama-runtime.js",
);
const nativeLlamaVerifier = require(nativeLlamaVerifierPath) as {
  PENDING_NATIVE_STATUS: string;
  VERIFIED_NATIVE_STATUS: string;
};

const appConfigUrl = pathToFileURL(path.join(mobileRoot, "app.config.ts")).href;
const releaseVerifierPath = path.join(
  mobileRoot,
  "scripts",
  "verify-release-backend-first-config.js",
);
const ENV_KEYS_USED_BY_APP_CONFIG = [
  "BUILD_TYPE",
  "EAS_BUILD_PROFILE",
  "JAI_BUILD_PROFILE",
  "JAI_BUILD_TYPE",
  "JAI_REQUIRE_LLAMA_CPP",
  "JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE",
  "JAI_SKIP_LOCAL_ENV_FILES",
  "JAI_LLAMA_CPP_DIR",
  "EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK",
  "EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE",
  "EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE",
  "EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE",
  "EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE",
  "EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL",
  "EXPO_PUBLIC_MODEL_CDN_BASE_URL",
  "EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_SHA256",
  "EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_INTEGRITY_METADATA",
  "EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B",
  "EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B",
  "EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B",
  "EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED",
  "EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B",
  "EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B",
  "EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B",
  "EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED",
  "EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B",
  "EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B",
  "EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B",
  "EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED",
  "EXPO_PUBLIC_E2E_MOCK_AUTH",
  "EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP",
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
  "EEXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID",
];

function createMockLlamaCppCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jai-llama-cpp-"));
  fs.mkdirSync(path.join(dir, "include"), { recursive: true });
  fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.22)\n");
  fs.writeFileSync(path.join(dir, "include", "llama.h"), "// test llama.h\n");
  return dir;
}

async function withAppConfigEnv<T>(
  env: Record<string, string | undefined>,
  callback: () => Promise<T>,
) {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS_USED_BY_APP_CONFIG) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function importAppConfigWithEnv(env: Record<string, string | undefined>) {
  const llamaDir = createMockLlamaCppCheckout();
  try {
    return await withAppConfigEnv({ JAI_LLAMA_CPP_DIR: llamaDir, ...env }, async () => {
      const cacheBust = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const imported = await import(`${appConfigUrl}?native-build-config=${cacheBust}`);
      return imported.default;
    });
  } finally {
    fs.rmSync(llamaDir, { recursive: true, force: true });
  }
}

const validReleaseModelMetadata = {
  EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL: "https://models.example.test",
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B: "123456789",
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B: "223456789",
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B: "323456789",
  EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED: "423456789",
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B: "a".repeat(64),
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B: "b".repeat(64),
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B: "c".repeat(64),
  EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED: "d".repeat(64),
};

const validReleaseFirebaseEnv = {
  EXPO_PUBLIC_FIREBASE_API_KEY: "firebase-api-key",
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: "firebase-auth.example.test",
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: "firebase-project",
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: "firebase-project.appspot.com",
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "1234567890",
  EXPO_PUBLIC_FIREBASE_APP_ID: "1:1234567890:android:abcdef",
};

function read(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, relativePath), "utf8");
}

function readRepo(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, "..", relativePath), "utf8");
}

function runReleaseVerifier(env: Record<string, string | undefined>) {
  const mergedEnv = { ...process.env };
  for (const key of ENV_KEYS_USED_BY_APP_CONFIG) {
    delete mergedEnv[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = value;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(env, "JAI_SKIP_LOCAL_ENV_FILES")) {
    mergedEnv.JAI_SKIP_LOCAL_ENV_FILES = "1";
  }

  return spawnSync(process.execPath, [releaseVerifierPath], {
    cwd: mobileRoot,
    env: mergedEnv,
    encoding: "utf8",
  });
}

function runReleaseVerifierWithMockLlama(
  env: Record<string, string | undefined>,
) {
  const llamaDir = createMockLlamaCppCheckout();
  try {
    return runReleaseVerifier({
      JAI_LLAMA_CPP_DIR: llamaDir,
      ...env,
    });
  } finally {
    fs.rmSync(llamaDir, { recursive: true, force: true });
  }
}

function createNativeStatusFixture(localAgentsContent: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jai-native-status-"));
  const files = {
    modelConfigFile: path.join(dir, "models.json"),
    agentRegistryFile: path.join(dir, "agent_registry.json"),
    workspaceManifestFile: path.join(dir, "workspace_manifest.json"),
    localAgentsFile: path.join(dir, "localAgents.ts"),
  };

  for (const file of [
    files.modelConfigFile,
    files.agentRegistryFile,
    files.workspaceManifestFile,
  ]) {
    fs.writeFileSync(
      file,
      `${JSON.stringify({ runtime: { nativeImplementationStatus: nativeLlamaVerifier.PENDING_NATIVE_STATUS } }, null, 2)}\n`,
    );
  }
  fs.writeFileSync(files.localAgentsFile, localAgentsContent);

  return { dir, files };
}

function runNativeStatusUpdateFixture(
  files: ReturnType<typeof createNativeStatusFixture>["files"],
) {
  const code = `
const verifier = require(process.argv[1]);
verifier.updateNativeImplementationStatusAfterVerification({
  modelConfigFile: process.argv[2],
  agentRegistryFile: process.argv[3],
  workspaceManifestFile: process.argv[4],
  localAgentsFile: process.argv[5],
});
`;

  return spawnSync(
    process.execPath,
    [
      "-e",
      code,
      nativeLlamaVerifierPath,
      files.modelConfigFile,
      files.agentRegistryFile,
      files.workspaceManifestFile,
      files.localAgentsFile,
    ],
    {
      cwd: mobileRoot,
      encoding: "utf8",
    },
  );
}

describe("native llama.cpp production build config", () => {
  it("documents the vendored llama.cpp path as a submodule/dependency", () => {
    const gitmodulesPath = path.join(mobileRoot, "..", ".gitmodules");
    const gitmodules = fs.existsSync(gitmodulesPath)
      ? fs.readFileSync(gitmodulesPath, "utf8")
      : "";
    const syncScript = read("scripts/sync-llama-cpp.js");

    expect(gitmodules + syncScript).toContain(
      "mobile/modules/jai-on-device-model/vendor/llama.cpp",
    );
    expect(syncScript).toContain("git submodule update");
    expect(syncScript).toContain("hasCommittedGitlink");
    expect(syncScript).toContain("clone fallback");
    expect(syncScript).toContain("f53577432541bb9edc1588c4ef45c66bf07e4468");
    expect(syncScript).toContain("GitHub source ZIPs do not include submodule contents");
  });

  it("adds the native llama.cpp verification package script", () => {
    const packageJson = JSON.parse(read("package.json"));
    const verifyScript = read("scripts/verify-native-llama-runtime.js");

    expect(packageJson.scripts["native:prepare"]).toBe("npm run release:verify-backend-first");
    expect(packageJson.scripts.prebuild).toBe(
      "npm run native:prepare && expo prebuild",
    );
    expect(packageJson.scripts["eas-build-pre-install"]).toBe(
      "node ./scripts/sync-llama-cpp.js",
    );
    expect(packageJson.scripts["native:verify-llama"]).toBe(
      "node ./scripts/verify-native-llama-runtime.js",
    );
    expect(packageJson.scripts.release).toBe("npm run release:verify-backend-first");
    expect(packageJson.scripts["release:verify-backend-first"]).toBe(
      "node ./scripts/verify-release-backend-first-config.js",
    );
    expect(verifyScript).toContain("JAI_REQUIRE_LLAMA_CPP=ON");
    expect(verifyScript).toContain("JAI_LLAMA_CPP_AVAILABLE=1");
    expect(verifyScript).toContain("verifyAndroidCMakeCompile");
    expect(verifyScript).toContain("--target', 'jai_llama_runtime'");
    expect(verifyScript).toContain("libjai_llama_runtime.so");
    expect(verifyScript).toContain("verifyIosNativeCompile");
    expect(verifyScript).toContain("iOS compile verification was skipped because the host is not macOS");
    expect(verifyScript).toContain("--smoke");
    expect(verifyScript).toContain("completeChat + embedTexts");
    expect(verifyScript).toContain("updateNativeImplementationStatusAfterVerification");
  });

  it("sets llama_batch n_tokens before llama_decode in native sources and smoke helper", () => {
    const androidRuntime = read(
      "modules/jai-on-device-model/android/src/main/cpp/jai_llama_runtime.cpp",
    );
    const iosBridge = read("modules/jai-on-device-model/ios/JaiLlamaCppBridge.mm");
    const verifyScript = read("scripts/verify-native-llama-runtime.js");

    for (const source of [androidRuntime, iosBridge, verifyScript]) {
      expect(source).toContain("batch->n_tokens = 0;");
      expect(source).toContain("const int32_t index = batch->n_tokens++;");
      expect(source.indexOf("batch->n_tokens = 0;")).toBeLessThan(
        source.indexOf("llama_decode"),
      );
    }

    expect(androidRuntime).toContain("decodeFailureDetail(\"embedding input\"");
    expect(iosBridge).toContain("decodeFailureDetail(\"embedding input\"");
  });

  it("uses bounded strong native model caches instead of weak-only caches", () => {
    const androidRuntime = read(
      "modules/jai-on-device-model/android/src/main/cpp/jai_llama_runtime.cpp",
    );
    const iosBridge = read("modules/jai-on-device-model/ios/JaiLlamaCppBridge.mm");
    const androidEngine = read(
      "modules/jai-on-device-model/android/src/main/java/com/harishajahan/jai/ondevice/JaiOnDeviceModelEngine.kt",
    );
    const iosModule = read("modules/jai-on-device-model/ios/JaiOnDeviceModelModule.swift");

    for (const source of [androidRuntime, iosBridge]) {
      expect(source).not.toContain("std::weak_ptr<llama_model>");
      expect(source).toContain("std::unordered_map<std::string, LlamaModelPtr> g_model_cache");
      expect(source).toContain("kMaxStrongCachedModels");
      expect(source).toContain("g_model_cache_lru");
      expect(source).toContain("clearModelCache");
      expect(source).toMatch(/requested_?Max?_?Tokens/i);
    }

    expect(androidEngine).toContain("maxTokens");
    expect(androidEngine).toContain("releaseCachedModels");
    expect(iosModule).toContain("maxTokens");
    expect(iosModule).toContain("releaseCachedModels");
  });

  it("fails clearly for EEXPO_PUBLIC_ environment variable typos without printing values", () => {
    const result = runReleaseVerifier({
      EEXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: "do-not-print-this-value",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EEXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID");
    expect(result.stderr).toContain(
      "likely a typo for EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID",
    );
    expect(result.stderr).not.toContain("do-not-print-this-value");
  });

  it("updates nativeImplementationStatus idempotently after native verification", () => {
    const pendingFixture = createNativeStatusFixture(`
export const runtime = {
  nativeImplementationStatus: "${nativeLlamaVerifier.PENDING_NATIVE_STATUS}",
};
`);
    try {
      const result = runNativeStatusUpdateFixture(pendingFixture.files);

      expect(result.status).toBe(0);
      expect(fs.readFileSync(pendingFixture.files.localAgentsFile, "utf8")).toContain(
        `nativeImplementationStatus: "${nativeLlamaVerifier.VERIFIED_NATIVE_STATUS}"`,
      );
      expect(result.stdout + result.stderr).toContain(
        "fallback nativeImplementationStatus updated after verification",
      );
    } finally {
      fs.rmSync(pendingFixture.dir, { recursive: true, force: true });
    }

    const verifiedFixture = createNativeStatusFixture(`
export const runtime = {
  nativeImplementationStatus: "${nativeLlamaVerifier.VERIFIED_NATIVE_STATUS}",
};
`);
    try {
      const result = runNativeStatusUpdateFixture(verifiedFixture.files);

      expect(result.status).toBe(0);
      expect(fs.readFileSync(verifiedFixture.files.localAgentsFile, "utf8")).toContain(
        `nativeImplementationStatus: "${nativeLlamaVerifier.VERIFIED_NATIVE_STATUS}"`,
      );
      expect(result.stdout + result.stderr).toContain(
        "fallback nativeImplementationStatus already verified; no update needed",
      );
    } finally {
      fs.rmSync(verifiedFixture.dir, { recursive: true, force: true });
    }

    const missingFixture = createNativeStatusFixture(`
export const runtime = {
  adapter: "native_on_device",
};
`);
    try {
      const result = runNativeStatusUpdateFixture(missingFixture.files);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(
        /Expected a pending or verified nativeImplementationStatus string literal/,
      );
    } finally {
      fs.rmSync(missingFixture.dir, { recursive: true, force: true });
    }
  });

  it("runs llama.cpp sync and verification before Android prebuild for local release/native builds", () => {
    const buildApk = readRepo("build-apk.sh");
    const syncIndex = buildApk.indexOf("npm run native:sync-llama");
    const verifyIndex = buildApk.indexOf("npm run native:verify-llama");
    const prebuildIndex = buildApk.indexOf("npx expo prebuild --platform android --clean");

    expect(buildApk).toContain("SHOULD_SYNC_LLAMA_CPP=0");
    expect(buildApk).toContain('$BUILD_TYPE" == "release"');
    expect(buildApk).toContain('$RUNTIME_MODE" == "native_on_device"');
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(prebuildIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(prebuildIndex);
  });

  it("marks release APK builds as backend-primary while preserving local model verification", () => {
    const buildApk = readRepo("build-apk.sh");

    expect(buildApk).toContain('export JAI_BUILD_TYPE="release"');
    expect(buildApk).not.toContain('export JAI_REQUIRE_LLAMA_CPP="1"');
    expect(buildApk).toContain('EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK="false"');
    expect(buildApk).toContain("LOCAL_MODEL_FALLBACK_REQUIRED=0");
    expect(buildApk).toContain('export EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_SHA256="${EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_SHA256:-true}"');
    expect(buildApk).toContain('EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE="download_on_first_launch"');
    expect(buildApk).toContain("llama.cpp is required for this explicit local model fallback build");
    expect(buildApk).toContain("JAI_LLAMA_CPP_BACKEND_MISSING");
    expect(buildApk).toContain("EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE");
  });

  it("sets NODE_ENV from the resolved APK build type when unset", () => {
    const buildApk = readRepo("build-apk.sh");
    const releaseDetectionIndex = buildApk.indexOf("IS_PRODUCTION_OR_RELEASE_BUILD=0");
    const nodeEnvIndex = buildApk.indexOf('if [[ -z "${NODE_ENV:-}" ]]; then');

    expect(releaseDetectionIndex).toBeGreaterThanOrEqual(0);
    expect(nodeEnvIndex).toBeGreaterThanOrEqual(0);
    expect(releaseDetectionIndex).toBeLessThan(nodeEnvIndex);
    expect(buildApk).toContain('export NODE_ENV="production"');
    expect(buildApk).toContain('export NODE_ENV="development"');
    expect(buildApk).toContain('info "NODE_ENV: ${NODE_ENV:-<unset>}"');
  });

  it("protects release APK recorded voice routing from accidental local STT opt-in", () => {
    const buildApk = readRepo("build-apk.sh");

    expect(buildApk).toContain('export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="false"');
    expect(buildApk).not.toContain('export EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE="true"');
    expect(buildApk).toContain('if [[ "$IS_PRODUCTION_OR_RELEASE_BUILD" == "1" ]]; then');
    expect(buildApk).toContain("JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE");
    expect(buildApk).toContain("forcing false so recorded voice uses backend Sarvam by default");
    expect(buildApk).toContain("Voice routing: backend Sarvam (default)");
    expect(buildApk).toContain("Voice routing: local/native STT (development opt-in)");
    expect(buildApk).toContain("explicit release override; experimental/development-style");
  });

  it("validates Expo config before Android prebuild so local release metadata failures stop early", () => {
    const buildApk = readRepo("build-apk.sh");
    const configIndex = buildApk.indexOf("npx expo config --type public");
    const prebuildIndex = buildApk.indexOf("npx expo prebuild --platform android --clean");

    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(prebuildIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeLessThan(prebuildIndex);
  });

  it("keys model delivery validation to production/release native_on_device download_on_first_launch builds", () => {
    const appConfig = read("app.config.ts");

    expect(appConfig).toContain("shouldRequireNativeLocalModel &&");
    expect(appConfig).toContain("isProductionNativeDownloadBuild");
    expect(appConfig).toContain("isLocalModelFallbackEnabled");
    expect(appConfig).toContain("normalizedModelDeliveryMode");
    expect(appConfig).toContain('normalizedModelDeliveryMode === "download_on_first_launch"');
    expect(appConfig).toContain('const LOCAL_MODEL_REQUIRE_SHA256 = isProductionNativeDownloadBuild');
    expect(appConfig).not.toContain('process.env.EAS_BUILD_PROFILE === "production" ? "true" : "false"');
  });

  it("allows backend-first release app.config without local model metadata", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      ...validReleaseFirebaseEnv,
    });

    expect(appConfig.expo.extra.ENABLE_LOCAL_MODEL_FALLBACK).toBe("false");
    expect(appConfig.expo.extra.LOCAL_MODEL_REQUIRE_SHA256).toBe("false");
  });

  it("fails explicit local fallback release app.config when model CDN/integrity metadata is missing", async () => {
    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...validReleaseFirebaseEnv,
      }),
    ).rejects.toThrow(/download_on_first_launch build is missing EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B/);
  });

  it("fails release app.config when Firebase env is missing", async () => {
    const {
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: _missingProjectId,
      ...firebaseWithoutProjectId
    } = validReleaseFirebaseEnv;

    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...validReleaseModelMetadata,
        ...firebaseWithoutProjectId,
      }),
    ).rejects.toThrow(/EXPO_PUBLIC_FIREBASE_PROJECT_ID/);
  });

  it("allows backend-first release app.config when local_adapter is disabled", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "local_adapter",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "local_adapter_dev",
      ...validReleaseFirebaseEnv,
    });

    expect(appConfig.expo.extra.LOCAL_MODEL_RUNTIME_MODE).toBe("local_adapter");
    expect(appConfig.expo.extra.ENABLE_LOCAL_MODEL_FALLBACK).toBe("false");
  });

  it("rejects explicit local fallback release app.config when runtime mode is local_adapter", async () => {
    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "local_adapter",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "local_adapter_dev",
        ...validReleaseModelMetadata,
        ...validReleaseFirebaseEnv,
      }),
    ).rejects.toThrow(/Production\/release local model fallback builds cannot use runtime\.mode=local_adapter/);
  });

  it("allows debug app.config to omit release CDN metadata", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "debug",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
    });

    expect(appConfig.expo.extra.LOCAL_MODEL_RUNTIME_MODE).toBe("native_on_device");
    expect(appConfig.expo.extra.LOCAL_MODEL_REQUIRE_SHA256).toBe("false");
    expect(appConfig.expo.extra.USE_LOCAL_VOICE_PIPELINE).toBe("false");
  });

  it("rejects release app.config local voice routing without explicit override", async () => {
    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
        ...validReleaseModelMetadata,
        ...validReleaseFirebaseEnv,
      }),
    ).rejects.toThrow(/backend Sarvam.*JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1/s);
  });

  it("allows release app.config local voice routing only with explicit override", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "release",
      JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE: "1",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(appConfig.expo.extra.USE_LOCAL_VOICE_PIPELINE).toBe("true");
  });

  it("allows debug app.config to opt into local voice routing", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "debug",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
    });

    expect(appConfig.expo.extra.USE_LOCAL_VOICE_PIPELINE).toBe("true");
  });

  it("allows debug app.config to omit Firebase env", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "debug",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
    });

    expect(appConfig.expo.extra.firebaseApiKey).toBeUndefined();
    expect(appConfig.expo.extra.firebaseProjectId).toBeUndefined();
  });

  it("allows debug-lite app.config to use local_adapter_dev without GGUF release metadata", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "debug",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "local_adapter",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "local_adapter_dev",
    });

    expect(appConfig.expo.extra.LOCAL_MODEL_RUNTIME_MODE).toBe("local_adapter");
    expect(appConfig.expo.extra.LOCAL_MODEL_DELIVERY_MODE).toBe("local_adapter_dev");
    expect(appConfig.expo.extra.LOCAL_MODEL_REQUIRE_SHA256).toBe("false");
  });

  it("accepts explicit local fallback release app.config only when CDN base, expectedBytes, and sha256 are present", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(appConfig.expo.extra.LOCAL_MODEL_CDN_BASE_URL).toBe("https://models.example.test");
    expect(appConfig.expo.extra.LOCAL_MODEL_REQUIRE_SHA256).toBe("true");
    expect(appConfig.expo.extra.USE_LOCAL_VOICE_PIPELINE).toBe("false");
    expect(appConfig.expo.extra.EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B).toBe("a".repeat(64));
  });

  it("rejects release download builds with unresolved cdn placeholders", async () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL: _unused, ...metadataWithoutBase } = validReleaseModelMetadata;

    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...metadataWithoutBase,
        ...validReleaseFirebaseEnv,
        EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B: "cdn://models/gemma.gguf",
        EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B: "https://models.example.test/qwen8.gguf",
        EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B: "https://models.example.test/qwen14.gguf",
        EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED: "https://models.example.test/embed.gguf",
      }),
    ).rejects.toThrow(/cdn:\/\/ placeholder/);
  });

  it("rejects release download builds with missing expectedBytes", async () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B: _unused, ...metadataWithoutBytes } = validReleaseModelMetadata;

    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...metadataWithoutBytes,
        ...validReleaseFirebaseEnv,
      }),
    ).rejects.toThrow(/EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B/);
  });

  it("rejects release download builds with missing sha256", async () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED: _unused, ...metadataWithoutSha } = validReleaseModelMetadata;

    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...metadataWithoutSha,
        ...validReleaseFirebaseEnv,
      }),
    ).rejects.toThrow(/EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED/);
  });

  it("release verification does not require llama.cpp for backend-first chat", () => {
    const result = runReleaseVerifier({
      BUILD_TYPE: "release",
      JAI_LLAMA_CPP_DIR: path.join(os.tmpdir(), "jai-missing-llama-cpp"),
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Backend-first release configuration verified/);
  });

  it("release verifier rejects missing Firebase env without printing values", () => {
    const {
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: _missingProjectId,
      ...firebaseWithoutProjectId
    } = validReleaseFirebaseEnv;
    const secretLikeValue = "do-not-print-this-firebase-value";
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...validReleaseModelMetadata,
      ...firebaseWithoutProjectId,
      EXPO_PUBLIC_FIREBASE_API_KEY: secretLikeValue,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID");
    expect(result.stdout + result.stderr).toContain(
      "Only variable names are shown here; values are intentionally omitted.",
    );
    expect(result.stdout + result.stderr).not.toContain(secretLikeValue);
  });

  it("release verification does not require native_on_device for optional local fallback", () => {
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "local_adapter",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "local_adapter_dev",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Backend-first release configuration verified/);
  });

  it("release verification does not require optional local model URLs", () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL: _unused, ...metadataWithoutBase } = validReleaseModelMetadata;
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...metadataWithoutBase,
      ...validReleaseFirebaseEnv,
      EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B: "https://YOUR_MODEL_CDN/models/gemma.gguf",
      EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B: "https://models.example.test/qwen8.gguf",
      EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B: "https://models.example.test/qwen14.gguf",
      EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED: "https://models.example.test/embed.gguf",
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Backend-first release configuration verified/);
  });

  it("release verification does not require optional local model byte metadata", () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B: _unused, ...metadataWithoutBytes } = validReleaseModelMetadata;
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...metadataWithoutBytes,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Backend-first release configuration verified/);
  });

  it("release verification does not require optional local model sha256 metadata", () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED: _unused, ...metadataWithoutSha } = validReleaseModelMetadata;
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...metadataWithoutSha,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Backend-first release configuration verified/);
  });

  it("release verification requires llama.cpp and GGUF metadata for explicit local fallback", () => {
    const result = runReleaseVerifier({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Explicit local model fallback release/);
  });

  it("release verification accepts explicit local fallback with llama.cpp and GGUF metadata", () => {
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK: "true",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/explicit local model fallback release has llama\.cpp and GGUF delivery metadata/);
  });

  it("release verification allows backend recorded voice routing", () => {
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/backend Sarvam routing/);
  });

  it("release verification fails when local voice routing lacks explicit override", () => {
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/backend Sarvam by default/);
    expect(result.stdout + result.stderr).toMatch(/JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1/);
  });

  it("release verification allows local voice routing only with explicit override", () => {
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE: "1",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...validReleaseModelMetadata,
      ...validReleaseFirebaseEnv,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/explicitly allowed/);
    expect(result.stdout + result.stderr).toMatch(/experimental\/development-style/);
  });

  it("sets JAI_LLAMA_CPP_AVAILABLE=1 in Android CMake when vendored llama.cpp exists", () => {
    const cmake = read(
      "modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt",
    );

    expect(cmake).toContain("vendor/llama.cpp");
    expect(cmake).toContain("include/llama.h");
    expect(cmake).toContain("add_subdirectory");
    expect(cmake).toContain("target_link_libraries(jai_llama_runtime PRIVATE llama)");
    expect(cmake).toContain("target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=1)");
  });

  it("fails Android release/production native_on_device builds when llama.cpp is missing", () => {
    const gradle = read("modules/jai-on-device-model/android/build.gradle");
    const cmake = read(
      "modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt",
    );

    expect(gradle).toContain("EAS_BUILD_PROFILE");
    expect(gradle).toContain("EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE");
    expect(gradle).toContain("JAI_BUILD_TYPE");
    expect(gradle).toContain("JAI_REQUIRE_LLAMA_CPP");
    expect(gradle).toContain("requestedReleaseTask");
    expect(gradle).toContain("productionOrReleaseBuild");
    expect(gradle).toContain("native_on_device");
    expect(gradle).toContain("GradleException");
    expect(gradle).toContain("-DJAI_REQUIRE_LLAMA_CPP=");
    expect(cmake).toContain("JAI_REQUIRE_LLAMA_CPP");
    expect(cmake).toContain("message(FATAL_ERROR");
  });

  it("fails app.config release/production native_on_device builds before prebuild when llama.cpp is missing", () => {
    const appConfig = read("app.config.ts");

    expect(appConfig).toContain("JAI_REQUIRE_LLAMA_CPP");
    expect(appConfig).toContain("JAI_BUILD_TYPE");
    expect(appConfig).toContain("isProductionOrReleaseBuild");
    expect(appConfig).toContain("isProductionNativeOnDeviceBuild");
    expect(appConfig).toContain("Refusing to ship with JAI_LLAMA_CPP_AVAILABLE=0");
    expect(appConfig).toContain("local_adapter is development-only");
  });

  it("sets JAI_LLAMA_CPP_AVAILABLE=1 in the iOS podspec when vendored llama.cpp exists", () => {
    const podspec = read("modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec");

    expect(podspec).toContain("File.join(module_root, 'vendor', 'llama.cpp')");
    expect(podspec).toContain("File.join(llama_dir, 'include', 'llama.h')");
    expect(podspec).toContain("JAI_LLAMA_CPP_AVAILABLE=1");
    expect(podspec).toContain("JAI_LLAMA_CPP_AVAILABLE=0");
  });

  it("fails iOS production/native_on_device builds when llama.cpp is missing", () => {
    const podspec = read("modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec");

    expect(podspec).toContain("EAS_BUILD_PROFILE");
    expect(podspec).toContain("EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE");
    expect(podspec).toContain("JAI_REQUIRE_LLAMA_CPP");
    expect(podspec).toContain("production_or_release_build");
    expect(podspec).toContain("production_native_on_device");
    expect(podspec).toContain("raise <<~MSG");
    expect(podspec).toContain("Refusing to compile with JAI_LLAMA_CPP_AVAILABLE=0");
  });

  it("keeps backend-missing behavior restricted to non-production missing-backend builds", () => {
    const readme = fs.readFileSync(path.join(moduleRoot, "README.md"), "utf8");
    const cmake = read(
      "modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt",
    );
    const podspec = read("modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec");

    expect(readme).toContain(
      "JAI_LLAMA_CPP_BACKEND_MISSING` is therefore allowed only in non-production/dev missing-backend builds",
    );
    expect(cmake).toContain("JAI_LLAMA_CPP_AVAILABLE=0");
    expect(cmake).toContain("JAI_REQUIRE_LLAMA_CPP");
    expect(cmake).toContain("development native calls will throw JAI_LLAMA_CPP_BACKEND_MISSING");
    expect(podspec).toContain("JAI_LLAMA_CPP_AVAILABLE=0");
    expect(podspec).toContain("production_native_on_device");
    expect(podspec).toContain("local_adapter is development-only");
  });
});
