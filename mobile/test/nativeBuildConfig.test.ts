import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const moduleRoot = path.join(mobileRoot, "modules", "jai-on-device-model");

function read(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, relativePath), "utf8");
}

function readRepo(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, "..", relativePath), "utf8");
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
  });

  it("runs llama.cpp sync before Android prebuild for local release/native builds", () => {
    const buildApk = readRepo("build-apk.sh");
    const syncIndex = buildApk.indexOf("npm run native:sync-llama");
    const prebuildIndex = buildApk.indexOf("npx expo prebuild --platform android --clean");

    expect(buildApk).toContain("SHOULD_SYNC_LLAMA_CPP=0");
    expect(buildApk).toContain('$BUILD_TYPE" == "release"');
    expect(buildApk).toContain('$RUNTIME_MODE" == "native_on_device"');
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(prebuildIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeLessThan(prebuildIndex);
  });

  it("marks local release APK builds as llama.cpp-required without making backend primary", () => {
    const buildApk = readRepo("build-apk.sh");

    expect(buildApk).toContain('export JAI_BUILD_TYPE="release"');
    expect(buildApk).toContain('export JAI_REQUIRE_LLAMA_CPP="1"');
    expect(buildApk).toContain("llama.cpp is required for this production/release native build");
    expect(buildApk).toContain("JAI_LLAMA_CPP_BACKEND_MISSING");
    expect(buildApk).not.toContain("EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false");
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

    expect(podspec).toContain("vendor/llama.cpp");
    expect(podspec).toContain("include/llama.h");
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
