import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeOnDeviceRuntimeUnavailableError,
  createLocalModelRuntime,
  getLocalRuntimeConfigError,
  isNativeOnDeviceRuntimeUnavailableError,
} from "../lib/localModelRuntime";
import { setNativeOnDeviceModelBridgeForTests } from "../lib/nativeOnDeviceModelBridge";

const nativeAssets = {
  "google/gemma-3-4b-it": {
    id: "google/gemma-3-4b-it",
    backend: "llama_cpp",
    format: "gguf",
    quantization: "Q4_K_M",
    modelPath: "models/gemma-3-4b-it-q4_k_m.gguf",
  },
  "Qwen/Qwen3-Embedding-0.6B": {
    id: "Qwen/Qwen3-Embedding-0.6B",
    backend: "llama_cpp",
    format: "gguf",
    quantization: "Q8_0",
    modelPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
    embedding: true,
  },
};

describe("local model runtime architecture", () => {
  afterEach(() => {
    setNativeOnDeviceModelBridgeForTests(null);
    vi.restoreAllMocks();
  });

  it("rejects loopback for an external LAN adapter", () => {
    const runtime = createLocalModelRuntime({
      mode: "local_adapter",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapterLocation: "external_lan",
      allowDeviceLoopback: false,
    });

    expect(runtime.kind).toBe("openai_compatible_local_adapter");
    expect(runtime.isConfigured()).toBe(false);
    expect(runtime.describe().configured).toBe(false);
    expect(
      getLocalRuntimeConfigError(
        {
          mode: "local_adapter",
          baseUrl: "http://127.0.0.1:11434/v1",
          adapterLocation: "external_lan",
          allowDeviceLoopback: false,
        },
        "Local chat",
      ),
    ).toContain("adapterLocation=external_lan");
  });

  it("allows loopback only when explicitly configured as device-hosted", () => {
    const runtime = createLocalModelRuntime({
      mode: "local_adapter",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapterLocation: "device_loopback",
      allowDeviceLoopback: true,
    });

    expect(runtime.kind).toBe("openai_compatible_local_adapter");
    expect(runtime.isConfigured()).toBe(true);
    expect(runtime.describe()).toMatchObject({
      mode: "local_adapter",
      primary: "phone_local",
      backendRole: "fallback_only",
      openAiPolicy: "fallback_only",
      allowDeviceLoopback: true,
      adapterLocation: "device_loopback",
      developmentOnly: true,
    });
  });

  it("makes native_on_device the production runtime path", () => {
    setNativeOnDeviceModelBridgeForTests({
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(async () => ({ text: "hello from native" })),
      embedTexts: vi.fn(async () => [[1, 0, 0]]),
    });

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      openAiPolicy: "fallback_only",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelRoot: "asset://models",
      modelAssets: nativeAssets,
    });

    expect(runtime.kind).toBe("native_on_device");
    expect(runtime.isConfigured()).toBe(true);
    expect(runtime.describe()).toMatchObject({
      mode: "native_on_device",
      primary: "phone_local",
      configured: true,
      backendRole: "fallback_only",
      openAiPolicy: "fallback_only",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      developmentOnly: false,
    });
  });

  it("calls the native bridge for chat and embeddings when the binding exists", async () => {
    const initialize = vi.fn(async () => ({ ok: true }));
    const completeChat = vi.fn(async () => ({ text: "Native answer." }));
    const embedTexts = vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] }] }));
    setNativeOnDeviceModelBridgeForTests({
      initialize,
      completeChat,
      embedTexts,
    });

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelRoot: "asset://models",
      modelAssets: nativeAssets,
    });

    const chat = await runtime.completeChat({
      model: "google/gemma-3-4b-it",
      messages: [{ role: "user", content: "hello" }],
    });
    const embeddings = await runtime.embedTexts({
      model: "Qwen/Qwen3-Embedding-0.6B",
      texts: ["hello"],
    });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(completeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google/gemma-3-4b-it",
        asset: expect.objectContaining({ modelPath: "models/gemma-3-4b-it-q4_k_m.gguf" }),
      }),
    );
    expect(chat.choices[0].message.content).toBe("Native answer.");
    expect(embedTexts).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "Qwen/Qwen3-Embedding-0.6B",
        asset: expect.objectContaining({ embedding: true }),
      }),
    );
    expect(embeddings).toEqual([[0.1, 0.2]]);
  });

  it("fails clearly when native_on_device has no native binding and never configures backend", async () => {
    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      openAiPolicy: "fallback_only",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelAssets: nativeAssets,
    });

    expect(runtime.kind).toBe("native_on_device");
    expect(runtime.isConfigured()).toBe(false);
    expect(runtime.describe()).toMatchObject({
      mode: "native_on_device",
      primary: "phone_local",
      configured: false,
      backendRole: "fallback_only",
      openAiPolicy: "fallback_only",
      nativeBackend: "llama_cpp",
    });

    await expect(
      runtime.completeChat({
        model: "google/gemma-3-4b-it",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(NativeOnDeviceRuntimeUnavailableError);

    await expect(
      runtime.completeChat({
        model: "google/gemma-3-4b-it",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("native on-device inference module");

    try {
      await runtime.completeChat({
        model: "google/gemma-3-4b-it",
        messages: [{ role: "user", content: "hello" }],
      });
    } catch (error) {
      expect(isNativeOnDeviceRuntimeUnavailableError(error)).toBe(true);
    }
  });

  it("requires JaiOnDeviceModel to expose initialize/completeChat/embedTexts in native mode", () => {
    setNativeOnDeviceModelBridgeForTests({
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
    } as any);

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelAssets: nativeAssets,
    });

    expect(runtime.kind).toBe("native_on_device");
    expect(runtime.isConfigured()).toBe(false);
    expect(
      getLocalRuntimeConfigError(
        {
          mode: "native_on_device",
          nativeBackend: "llama_cpp",
          nativeModuleName: "JaiOnDeviceModel",
          modelAssets: nativeAssets,
        },
        "Local chat",
      ),
    ).toContain("initialize()");
  });

  it("keeps local_adapter development-only in production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const config = {
        mode: "local_adapter" as const,
        baseUrl: "http://192.168.1.23:10000/v1",
        adapterLocation: "external_lan" as const,
      };
      const runtime = createLocalModelRuntime(config);
      expect(runtime.kind).toBe("openai_compatible_local_adapter");
      expect(runtime.isConfigured()).toBe(false);
      expect(getLocalRuntimeConfigError(config, "Local chat")).toContain("development-only");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
