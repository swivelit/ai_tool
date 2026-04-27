import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const moduleRoot = path.join(mobileRoot, "modules", "jai-on-device-model");

const appConfigUrl = pathToFileURL(path.join(mobileRoot, "app.config.ts")).href;
const releaseVerifierPath = path.join(
  mobileRoot,
  "scripts",
  "verify-release-local-first-config.js",
);
const ENV_KEYS_USED_BY_APP_CONFIG = [
  "BUILD_TYPE",
  "EAS_BUILD_PROFILE",
  "JAI_BUILD_PROFILE",
  "JAI_BUILD_TYPE",
  "JAI_REQUIRE_LLAMA_CPP",
  "JAI_LLAMA_CPP_DIR",
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
  });

  it("adds the native llama.cpp verification package script", () => {
    const packageJson = JSON.parse(read("package.json"));
    const verifyScript = read("scripts/verify-native-llama-runtime.js");

    expect(packageJson.scripts["native:prepare"]).toBe(
      "node ./scripts/sync-llama-cpp.js && node ./scripts/verify-release-local-first-config.js",
    );
    expect(packageJson.scripts.prebuild).toBe(
      "npm run native:prepare && expo prebuild",
    );
    expect(packageJson.scripts["eas-build-pre-install"]).toBe(
      "node ./scripts/sync-llama-cpp.js",
    );
    expect(packageJson.scripts["native:verify-llama"]).toBe(
      "node ./scripts/verify-native-llama-runtime.js",
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

  it("marks local release APK builds as llama.cpp-required without making backend primary", () => {
    const buildApk = readRepo("build-apk.sh");

    expect(buildApk).toContain('export JAI_BUILD_TYPE="release"');
    expect(buildApk).toContain('export JAI_REQUIRE_LLAMA_CPP="1"');
    expect(buildApk).toContain('export EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_SHA256="true"');
    expect(buildApk).toContain('export EXPO_PUBLIC_LOCAL_MODEL_REQUIRE_INTEGRITY_METADATA="true"');
    expect(buildApk).toContain('EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE="download_on_first_launch"');
    expect(buildApk).toContain("llama.cpp is required for this production/release native build");
    expect(buildApk).toContain("JAI_LLAMA_CPP_BACKEND_MISSING");
    expect(buildApk).not.toContain("EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false");
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

    expect(appConfig).toContain("isProductionOrReleaseBuild &&");
    expect(appConfig).toContain("isProductionNativeDownloadBuild");
    expect(appConfig).toContain("normalizedModelDeliveryMode");
    expect(appConfig).toContain('normalizedModelDeliveryMode === "download_on_first_launch"');
    expect(appConfig).toContain('const LOCAL_MODEL_REQUIRE_SHA256 = isProductionNativeDownloadBuild');
    expect(appConfig).not.toContain('process.env.EAS_BUILD_PROFILE === "production" ? "true" : "false"');
  });

  it("fails local release APK app.config when model CDN/integrity metadata is missing", async () => {
    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      }),
    ).rejects.toThrow(/download_on_first_launch build is missing EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B/);
  });

  it("allows debug app.config to omit release CDN metadata", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "debug",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
    });

    expect(appConfig.expo.extra.LOCAL_MODEL_RUNTIME_MODE).toBe("native_on_device");
    expect(appConfig.expo.extra.LOCAL_MODEL_REQUIRE_SHA256).toBe("false");
  });

  it("accepts local release app.config only when CDN base, expectedBytes, and sha256 are present", async () => {
    const appConfig = await importAppConfigWithEnv({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      ...validReleaseModelMetadata,
    });

    expect(appConfig.expo.extra.LOCAL_MODEL_CDN_BASE_URL).toBe("https://models.example.test");
    expect(appConfig.expo.extra.LOCAL_MODEL_REQUIRE_SHA256).toBe("true");
    expect(appConfig.expo.extra.EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B).toBe("a".repeat(64));
  });

  it("rejects release download builds with unresolved cdn placeholders", async () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL: _unused, ...metadataWithoutBase } = validReleaseModelMetadata;

    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...metadataWithoutBase,
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
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...metadataWithoutBytes,
      }),
    ).rejects.toThrow(/EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B/);
  });

  it("rejects release download builds with missing sha256", async () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED: _unused, ...metadataWithoutSha } = validReleaseModelMetadata;

    await expect(
      importAppConfigWithEnv({
        BUILD_TYPE: "release",
        EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
        EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
        ...metadataWithoutSha,
      }),
    ).rejects.toThrow(/EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED/);
  });

  it("release verification fails when llama.cpp is missing", () => {
    const result = runReleaseVerifier({
      BUILD_TYPE: "release",
      JAI_LLAMA_CPP_DIR: path.join(os.tmpdir(), "jai-missing-llama-cpp"),
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...validReleaseModelMetadata,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/llama\.cpp CMake project/);
  });

  it("release verification fails when model URLs are unresolved placeholders", () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL: _unused, ...metadataWithoutBase } = validReleaseModelMetadata;
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...metadataWithoutBase,
      EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B: "https://YOUR_MODEL_CDN/models/gemma.gguf",
      EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B: "https://models.example.test/qwen8.gguf",
      EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B: "https://models.example.test/qwen14.gguf",
      EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED: "https://models.example.test/embed.gguf",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/YOUR_MODEL_CDN placeholder/);
  });

  it("release verification fails when expectedBytes are missing", () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B: _unused, ...metadataWithoutBytes } = validReleaseModelMetadata;
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...metadataWithoutBytes,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B/);
  });

  it("release verification fails when sha256 hashes are missing", () => {
    const { EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED: _unused, ...metadataWithoutSha } = validReleaseModelMetadata;
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "true",
      ...metadataWithoutSha,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED/);
  });

  it("release verification fails when EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=false", () => {
    const result = runReleaseVerifierWithMockLlama({
      BUILD_TYPE: "release",
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
      EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
      EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE: "false",
      ...validReleaseModelMetadata,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=true/);
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
