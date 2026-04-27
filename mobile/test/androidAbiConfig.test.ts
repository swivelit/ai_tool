import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(mobileRoot, "..");
const require = createRequire(import.meta.url);
const plugin = require(path.join(mobileRoot, "plugins/withJaiOnDeviceModelAssets.js")) as {
  getAndroidNativeAbis: (env?: Record<string, string>) => string[];
  applyAndroidAppAbiFilters: (contents: string, abis?: string[]) => string;
};

function read(relativePath: string) {
  return fs.readFileSync(path.join(mobileRoot, relativePath), "utf8");
}

function readRepo(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runAbiUtil(command: string) {
  const utilsPath = shellQuote(path.join(repoRoot, "scripts/android-abi-utils.sh"));
  return execFileSync("bash", ["-lc", `source ${utilsPath}; ${command}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

describe("Android native ABI filters", () => {
  it("defaults release/local production APK builds to arm64-v8a", () => {
    const buildApk = readRepo("build-apk.sh");
    const abiUtils = readRepo("scripts/android-abi-utils.sh");
    const pluginSource = read("plugins/withJaiOnDeviceModelAssets.js");
    const gradle = read("modules/jai-on-device-model/android/build.gradle");

    expect(abiUtils).toContain('JAI_ANDROID_DEFAULT_ABIS_CSV="arm64-v8a"');
    expect(buildApk).toContain('SELECTED_ANDROID_ABIS="$JAI_ANDROID_DEFAULT_ABIS_CSV"');
    expect(pluginSource).toContain('const DEFAULT_ANDROID_NATIVE_ABIS = ["arm64-v8a"];');
    expect(gradle).toContain("return ['arm64-v8a']");
    expect(plugin.getAndroidNativeAbis({})).toEqual(["arm64-v8a"]);
  });

  it("drives app and native module ABI filters from JAI_ANDROID_ABIS", () => {
    const buildApk = readRepo("build-apk.sh");
    const pluginSource = read("plugins/withJaiOnDeviceModelAssets.js");
    const gradle = read("modules/jai-on-device-model/android/build.gradle");

    expect(buildApk).toContain('export JAI_ANDROID_ABIS="$SELECTED_ANDROID_ABIS"');
    expect(pluginSource).toContain("env.JAI_ANDROID_ABIS || env.ANDROID_ABIS");
    expect(pluginSource).toContain("reactNativeArchitectures");
    expect(pluginSource).toContain("abiFilters ${formatGradleAbiFilters(abis)}");
    expect(gradle).toContain("System.getenv('JAI_ANDROID_ABIS')");
    expect(gradle).toContain("findProperty('reactNativeArchitectures')");
    expect(gradle).toContain("abiFilters(*jaiAndroidAbis)");
    expect(plugin.getAndroidNativeAbis({ JAI_ANDROID_ABIS: "x86_64" })).toEqual(["x86_64"]);
    expect(
      plugin.applyAndroidAppAbiFilters("\nandroid {\n    defaultConfig {\n    }\n}\n", [
        "x86_64",
      ]),
    ).toContain('abiFilters "x86_64"');
  });

  it("detects x86_64 debug targets before building or installing", () => {
    const launchDebug = readRepo("launch-debug_apk.sh");
    const abiUtils = readRepo("scripts/android-abi-utils.sh");

    expect(abiUtils).toContain("adb shell getprop ro.product.cpu.abilist");
    expect(abiUtils).toContain('JAI_ANDROID_SUPPORTED_ABIS_CSV="arm64-v8a,x86_64"');
    expect(runAbiUtil("jai_android_choose_supported_device_abi 'x86_64,arm64-v8a'")).toBe(
      "x86_64",
    );
    expect(launchDebug).toContain("jai_android_read_device_abilist");
    expect(launchDebug).toContain("jai_android_choose_supported_device_abi");
    expect(launchDebug).toContain('export JAI_ANDROID_ABIS="$SELECTED_ANDROID_ABIS"');
    expect(launchDebug).toContain("BUILD_TYPE=debug ./build-apk.sh");
  });

  it("validates generated APK native libraries for the selected ABI set", () => {
    const buildApk = readRepo("build-apk.sh");

    expect(buildApk).toContain("unzip -l");
    expect(buildApk).toContain("libreactnative.so");
    expect(buildApk).toContain("libjai_llama_runtime.so");
    expect(buildApk).toContain("APK contains native libraries for unselected ABI");
    expect(buildApk).toContain("APK native library validation failed");
  });
});
