import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDir, "..");
const androidRuntimePath = path.join(
  mobileRoot,
  "modules",
  "jai-on-device-model",
  "android",
  "src",
  "main",
  "cpp",
  "jai_llama_runtime.cpp",
);
const androidModulePath = path.join(
  mobileRoot,
  "modules",
  "jai-on-device-model",
  "android",
  "src",
  "main",
  "java",
  "com",
  "harishajahan",
  "jai",
  "ondevice",
  "JaiOnDeviceModelModule.kt",
);
const iosModulePath = path.join(
  mobileRoot,
  "modules",
  "jai-on-device-model",
  "ios",
  "JaiOnDeviceModelModule.swift",
);
const iosBridgePath = path.join(
  mobileRoot,
  "modules",
  "jai-on-device-model",
  "ios",
  "JaiLlamaCppBridge.mm",
);

function readAndroidRuntime() {
  return fs.readFileSync(androidRuntimePath, "utf8");
}

describe("Android native runtime safety", () => {
  it("does not return generated model text through unsafe Modified UTF-8 JNI conversion", () => {
    const source = readAndroidRuntime();
    const unsafeGeneratedStringReturn = "NewString" + "UTF(generated.c_str())";

    expect(source).not.toContain(unsafeGeneratedStringReturn);
    expect(source).toContain("utf8BytesToJavaString(env, generated)");
    expect(source).toContain("java/nio/charset/StandardCharsets");
    expect(source).toContain("NewByteArray");
    expect(source).toContain("([BLjava/nio/charset/Charset;)V");
  });

  it("defaults to one strongly cached native model", () => {
    const source = readAndroidRuntime();

    expect(source).not.toMatch(/kMaxStrongCachedModels\s*=\s*2\b/);
    expect(source).toMatch(/kMaxStrongCachedModels\s*=\s*1\b/);
    expect(source).toContain("g_model_cache_lru");
    expect(source).toContain("clearModelCache");
  });

  it("exposes cancellation and checks it in native generation loops", () => {
    const androidRuntime = readAndroidRuntime();
    const androidModule = fs.readFileSync(androidModulePath, "utf8");
    const iosModule = fs.readFileSync(iosModulePath, "utf8");
    const iosBridge = fs.readFileSync(iosBridgePath, "utf8");

    expect(androidModule).toContain('AsyncFunction("cancelRequest")');
    expect(iosModule).toContain('AsyncFunction("cancelRequest")');
    expect(androidRuntime).toContain("nativeCancelRequest");
    expect(androidRuntime).toContain("isRequestCancelled(request_id)");
    expect(androidRuntime).toContain("decodeTokens(ctx.get(), prompt_tokens, true, request_id)");
    expect(androidRuntime).toContain("decodeSingleToken(ctx.get(), token, next_pos, request_id)");
    expect(iosBridge).toContain("cancelRequest:");
    expect(iosBridge).toContain("isRequestCancelled(requestId)");
    expect(iosBridge).toContain("decodeTokens(ctx.get(), promptTokens, true, requestId)");
    expect(iosBridge).toContain("decodeSingleToken(ctx.get(), token, nextPos, requestId)");
  });
});
