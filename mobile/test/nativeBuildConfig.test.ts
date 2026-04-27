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

  it("fails Android production native_on_device builds when llama.cpp is missing", () => {
    const gradle = read("modules/jai-on-device-model/android/build.gradle");
    const cmake = read(
      "modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt",
    );

    expect(gradle).toContain("EAS_BUILD_PROFILE");
    expect(gradle).toContain("EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE");
    expect(gradle).toContain("production");
    expect(gradle).toContain("native_on_device");
    expect(gradle).toContain("GradleException");
    expect(gradle).toContain("-DJAI_REQUIRE_LLAMA_CPP=");
    expect(cmake).toContain("JAI_REQUIRE_LLAMA_CPP");
    expect(cmake).toContain("message(FATAL_ERROR");
  });

  it("sets JAI_LLAMA_CPP_AVAILABLE=1 in the iOS podspec when vendored llama.cpp exists", () => {
    const podspec = read("modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec");

    expect(podspec).toContain("vendor/llama.cpp");
    expect(podspec).toContain("include/llama.h");
    expect(podspec).toContain("JAI_LLAMA_CPP_AVAILABLE=1");
    expect(podspec).toContain("JAI_LLAMA_CPP_AVAILABLE=0");
  });

  it("fails iOS production native_on_device builds when llama.cpp is missing", () => {
    const podspec = read("modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec");

    expect(podspec).toContain("EAS_BUILD_PROFILE");
    expect(podspec).toContain("EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE");
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
    expect(podspec).toContain("JAI_LLAMA_CPP_AVAILABLE=0");
    expect(podspec).toContain("production_native_on_device");
  });
});
