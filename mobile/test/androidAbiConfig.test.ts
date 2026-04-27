import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, relativePath), "utf8");
}

describe("Android native ABI filters", () => {
  it("generates app Gradle config for arm64-v8a only", () => {
    const plugin = read("plugins/withJaiOnDeviceModelAssets.js");

    expect(plugin).toContain('const ANDROID_NATIVE_ABIS = ["arm64-v8a"];');
    expect(plugin).toContain("withGradleProperties");
    expect(plugin).toContain("reactNativeArchitectures");
    expect(plugin).toContain('abiFilters "arm64-v8a"');
    expect(plugin).not.toContain("armeabi-v7a");
    expect(plugin).not.toMatch(/["']x86["']/);
  });

  it("filters the JaiOnDeviceModel CMake build to arm64-v8a", () => {
    const gradle = read("modules/jai-on-device-model/android/build.gradle");

    expect(gradle).toContain("ndk {");
    expect(gradle).toContain("abiFilters 'arm64-v8a'");
    expect(gradle).not.toContain("armeabi-v7a");
    expect(gradle).not.toMatch(/["']x86["']/);
  });
});
