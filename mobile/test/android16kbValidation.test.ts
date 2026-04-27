import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(mobileRoot, "..");
const utilsPath = path.join(repoRoot, "scripts/android-16kb-utils.sh");
const require = createRequire(import.meta.url);
const plugin = require(path.join(mobileRoot, "plugins/withJaiOnDeviceModelAssets.js")) as {
  applyAndroidFlexiblePageSizeCMakeArgument: (contents: string) => string;
};

function readRepo(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runShell(command: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", ["-c", command], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("Android 16 KB native library validation", () => {
  it("wires 16 KB CMake/linker flags into source-built Android targets", () => {
    const customCMake = readRepo(
      "mobile/modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt",
    );
    const customGradle = readRepo("mobile/modules/jai-on-device-model/android/build.gradle");
    const pluginOutput = plugin.applyAndroidFlexiblePageSizeCMakeArgument(
      "\nandroid {\n    defaultConfig {\n    }\n}\n",
    );

    expect(customCMake).toContain("target_link_options(jai_llama_runtime PRIVATE");
    expect(customCMake).toContain("-Wl,-z,max-page-size=16384");
    expect(customCMake).toContain("-Wl,-z,common-page-size=16384");
    expect(customGradle).toContain("-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON");
    expect(pluginOutput).toContain("-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON");
  });

  it("allows debug 16 KB validation skip only with the explicit env var", () => {
    const sourceUtils = `source ${shellQuote(utilsPath)}`;

    const defaultDebug = runShell(`${sourceUtils}; jai_android_can_skip_16kb_validation debug`);
    expect(defaultDebug.status).not.toBe(0);

    const explicitDebug = runShell(`${sourceUtils}; jai_android_can_skip_16kb_validation debug`, {
      JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG: "1",
    });
    expect(explicitDebug.status).toBe(0);
  });

  it("does not allow release builds to skip 16 KB validation", () => {
    const result = runShell(
      `source ${shellQuote(utilsPath)}; jai_android_can_skip_16kb_validation release`,
      {
        JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG: "1",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release/production builds cannot skip");
  });

  it("reports clear missing zipalign and readelf tooling errors", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jai-android-16kb-tools-"));
    const emptyBin = path.join(tmpRoot, "bin");
    const emptySdk = path.join(tmpRoot, "sdk");
    fs.mkdirSync(emptyBin);
    fs.mkdirSync(emptySdk);

    const missingZipalign = runShell(
      `source ${shellQuote(utilsPath)}; jai_android_find_zipalign ${shellQuote(emptySdk)}`,
      { PATH: emptyBin },
    );
    expect(missingZipalign.status).not.toBe(0);
    expect(missingZipalign.stderr).toContain(
      "Missing zipalign. Install Android SDK Build-Tools",
    );
    expect(missingZipalign.stderr).toContain("build-tools/<version>/zipalign");

    const missingReadelf = runShell(
      `source ${shellQuote(utilsPath)}; jai_android_find_readelf ${shellQuote(emptySdk)}`,
      { PATH: emptyBin },
    );
    expect(missingReadelf.status).not.toBe(0);
    expect(missingReadelf.stderr).toContain("Missing llvm-readelf/readelf");
    expect(missingReadelf.stderr).toContain("ndk/<version>/toolchains/llvm");
  });

  it("names failing .so files and ABIs in ELF LOAD alignment output", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jai-android-16kb-elf-"));
    const fakeReadelf = path.join(tmpRoot, "llvm-readelf");
    const fakeSo = path.join(tmpRoot, "libbad.so");

    fs.writeFileSync(fakeSo, "not really an elf");
    fs.writeFileSync(
      fakeReadelf,
      [
        "#!/usr/bin/env bash",
        "cat <<'READELF'",
        "Program Headers:",
        "  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align",
        "  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x000100 0x000100 R E 0x1000",
        "READELF",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fakeReadelf, 0o755);

    const result = runShell(
      [
        `source ${shellQuote(utilsPath)}`,
        `jai_android_validate_elf_load_alignment ${shellQuote(fakeReadelf)} ${shellQuote(fakeSo)} lib/x86_64/libbad.so`,
      ].join("; "),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lib/x86_64/libbad.so");
    expect(result.stderr).toContain("ABI x86_64");
    expect(result.stderr).toContain("0x1000");
    expect(result.stderr).toContain("0x4000");
  });
});
