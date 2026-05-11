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
    chatTemplate: "gemma3",
  },
  "Qwen/Qwen3-Embedding-0.6B": {
    id: "Qwen/Qwen3-Embedding-0.6B",
    backend: "llama_cpp",
    format: "gguf",
    quantization: "Q8_0",
    modelPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
    promptFormat: "embedding",
    embedding: true,
  },
};

describe("local model runtime architecture", () => {
  afterEach(() => {
    vi.useRealTimers();
    setNativeOnDeviceModelBridgeForTests(null);
    vi.unstubAllEnvs();
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
      modelDelivery: { mode: "bundled_assets" },
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
      modelDelivery: { mode: "bundled_assets" },
      modelAssets: nativeAssets,
    });

    const chat = await runtime.completeChat({
      model: "google/gemma-3-4b-it",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 123,
    });
    const embeddings = await runtime.embedTexts({
      model: "Qwen/Qwen3-Embedding-0.6B",
      texts: ["hello"],
    });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(completeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google/gemma-3-4b-it",
        maxTokens: 123,
        prompt: expect.stringContaining("<start_of_turn>user"),
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

  it("uses timeoutMs for native completeChat and rejects on timeout without backend calls", async () => {
    vi.useFakeTimers();
    const cancelRequest = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setNativeOnDeviceModelBridgeForTests({
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(() => new Promise(() => undefined)),
      embedTexts: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] }] })),
      cancelRequest,
    });

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      timeoutMs: 25,
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelDelivery: { mode: "bundled_assets" },
      modelAssets: nativeAssets,
    });

    const pending = runtime.completeChat({
      model: "google/gemma-3-4b-it",
      messages: [{ role: "user", content: "slow" }],
      requestId: "chat-timeout-test",
      maxTokens: 64,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "LOCAL_TURN_TIMEOUT",
      timeoutMs: 25,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(26);

    await assertion;
    expect(cancelRequest).toHaveBeenCalledWith("chat-timeout-test");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses timeoutMs for native embedTexts and rejects on timeout", async () => {
    vi.useFakeTimers();
    setNativeOnDeviceModelBridgeForTests({
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(async () => ({ text: "ok" })),
      embedTexts: vi.fn(() => new Promise(() => undefined)),
    });

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      timeoutMs: 25,
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelDelivery: { mode: "bundled_assets" },
      modelAssets: nativeAssets,
    });

    const pending = runtime.embedTexts({
      model: "Qwen/Qwen3-Embedding-0.6B",
      texts: ["slow"],
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "LOCAL_TURN_TIMEOUT",
      timeoutMs: 25,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(26);

    await assertion;
    vi.useRealTimers();
  });

  it("ignores a late native result after timeout", async () => {
    vi.useFakeTimers();
    let resolveNative: (value: unknown) => void = () => undefined;
    setNativeOnDeviceModelBridgeForTests({
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveNative = resolve;
          }),
      ),
      embedTexts: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] }] })),
    });

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      timeoutMs: 25,
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelDelivery: { mode: "bundled_assets" },
      modelAssets: nativeAssets,
    });

    const pending = runtime.completeChat({
      model: "google/gemma-3-4b-it",
      messages: [{ role: "user", content: "slow" }],
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "LOCAL_TURN_TIMEOUT",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(26);
    resolveNative({ text: "too late" });

    await assertion;
    vi.useRealTimers();
  });



  it("passes downloaded file:// model paths to the native runtime", async () => {
    vi.resetModules();

    const downloadedFiles = new Set([
      "file:///mock/models/gemma-3-4b-it-q4_k_m.gguf",
      "file:///mock/models/qwen3-embedding-0.6b-q8_0.gguf",
    ]);

    vi.doMock("expo-constants", () => ({
      default: { expoConfig: { extra: {} } },
    }));
    vi.doMock("expo-file-system/legacy", () => ({
      documentDirectory: "file:///mock/",
      EncodingType: { Base64: "base64" },
      getInfoAsync: vi.fn(async (uri: string) => ({
        exists: downloadedFiles.has(uri),
        size: downloadedFiles.has(uri) ? 123 : 0,
      })),
      makeDirectoryAsync: vi.fn(async () => undefined),
      deleteAsync: vi.fn(async () => undefined),
      moveAsync: vi.fn(async () => undefined),
      readAsStringAsync: vi.fn(async () => ""),
      createDownloadResumable: vi.fn(),
    }));

    const bridge = {
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(async () => ({ text: "Native answer." })),
      embedTexts: vi.fn(async () => ({ data: [{ embedding: [0.4, 0.6] }] })),
    };

    const { setNativeOnDeviceModelBridgeForTests } = await import("../lib/nativeOnDeviceModelBridge");
    setNativeOnDeviceModelBridgeForTests(bridge);
    const { createLocalModelRuntime } = await import("../lib/localModelRuntime");

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelRoot: "document://models",
      modelAssets: {
        ...nativeAssets,
        "Qwen/Qwen3-8B": {
          id: "Qwen/Qwen3-8B",
          backend: "llama_cpp",
          format: "gguf",
          modelPath: "models/qwen3-8b-q4_k_m.gguf",
          chatTemplate: "qwen3",
        },
        "Qwen/Qwen3-14B": {
          id: "Qwen/Qwen3-14B",
          backend: "llama_cpp",
          format: "gguf",
          modelPath: "models/qwen3-14b-q4_k_m.gguf",
          chatTemplate: "qwen3",
        },
      },
      modelDelivery: {
        mode: "download_on_first_launch",
        storageRoot: "document://models",
        defaultTier: "lite",
        modelTiers: {
          lite: {
            requiredModelIds: [
              "google/gemma-3-4b-it",
              "Qwen/Qwen3-Embedding-0.6B",
            ],
          },
          standard: {
            requiredModelIds: ["Qwen/Qwen3-8B", "Qwen/Qwen3-Embedding-0.6B"],
            minRamBytes: 8 * 1024 * 1024 * 1024,
            minFreeStorageBytes: 8 * 1024 * 1024 * 1024,
          },
          pro: {
            requiredModelIds: ["Qwen/Qwen3-14B", "Qwen/Qwen3-Embedding-0.6B"],
            minRamBytes: 16 * 1024 * 1024 * 1024,
            minFreeStorageBytes: 16 * 1024 * 1024 * 1024,
          },
        },
        models: [
          { id: "google/gemma-3-4b-it", fileName: "gemma-3-4b-it-q4_k_m.gguf", downloadUrl: "https://cdn.example.test/gemma.gguf", localPath: "models/gemma-3-4b-it-q4_k_m.gguf", required: true, requiredForTiers: ["lite"] },
          { id: "Qwen/Qwen3-8B", fileName: "qwen3-8b-q4_k_m.gguf", downloadUrl: "https://cdn.example.test/qwen8.gguf", localPath: "models/qwen3-8b-q4_k_m.gguf", required: false, requiredForTiers: ["standard"] },
          { id: "Qwen/Qwen3-14B", fileName: "qwen3-14b-q4_k_m.gguf", downloadUrl: "https://cdn.example.test/qwen14.gguf", localPath: "models/qwen3-14b-q4_k_m.gguf", required: false, requiredForTiers: ["pro"] },
          { id: "Qwen/Qwen3-Embedding-0.6B", fileName: "qwen3-embedding-0.6b-q8_0.gguf", downloadUrl: "https://cdn.example.test/embed.gguf", localPath: "models/qwen3-embedding-0.6b-q8_0.gguf", required: true, requiredForTiers: ["lite", "standard", "pro"] },
        ],
      },
    });

    await runtime.completeChat({
      model: "google/gemma-3-4b-it",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(bridge.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRoot: "document://models",
        models: expect.objectContaining({
          "google/gemma-3-4b-it": expect.objectContaining({
            modelPath: "file:///mock/models/gemma-3-4b-it-q4_k_m.gguf",
          }),
        }),
      }),
    );
    const initArg = (bridge.initialize as any).mock.calls[0][0] as any;
    expect(initArg.models["Qwen/Qwen3-14B"]).toBeUndefined();
    expect(initArg.models["Qwen/Qwen3-8B"]).toBeUndefined();
    expect(bridge.completeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({
          modelPath: "file:///mock/models/gemma-3-4b-it-q4_k_m.gguf",
        }),
      }),
    );
  });

  it("passes inferred Standard tier deviceInfo into native downloaded asset resolution", async () => {
    vi.resetModules();

    const downloadedFiles = new Set([
      "file:///mock/models/qwen3-8b-q4_k_m.gguf",
      "file:///mock/models/qwen3-embedding-0.6b-q8_0.gguf",
    ]);

    vi.doMock("expo-constants", () => ({
      default: { expoConfig: { extra: {} } },
    }));
    vi.doMock("expo-file-system/legacy", () => ({
      documentDirectory: "file:///mock/",
      EncodingType: { Base64: "base64" },
      getInfoAsync: vi.fn(async (uri: string) => ({
        exists: downloadedFiles.has(uri),
        size: downloadedFiles.has(uri) ? 123 : 0,
      })),
      makeDirectoryAsync: vi.fn(async () => undefined),
      deleteAsync: vi.fn(async () => undefined),
      moveAsync: vi.fn(async () => undefined),
      readAsStringAsync: vi.fn(async () => ""),
      createDownloadResumable: vi.fn(),
    }));

    const bridge = {
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(async () => ({ text: "Standard tier native answer." })),
      embedTexts: vi.fn(async () => ({ data: [{ embedding: [0.4, 0.6] }] })),
    };

    const { setNativeOnDeviceModelBridgeForTests } = await import("../lib/nativeOnDeviceModelBridge");
    setNativeOnDeviceModelBridgeForTests(bridge);
    const { createLocalModelRuntime } = await import("../lib/localModelRuntime");

    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelRoot: "document://models",
      deviceInfo: {
        totalMemoryBytes: 12 * 1024 * 1024 * 1024,
        freeStorageBytes: 12 * 1024 * 1024 * 1024,
      },
      modelAssets: {
        ...nativeAssets,
        "Qwen/Qwen3-8B": {
          id: "Qwen/Qwen3-8B",
          backend: "llama_cpp",
          format: "gguf",
          modelPath: "models/qwen3-8b-q4_k_m.gguf",
          chatTemplate: "qwen3",
        },
      },
      modelDelivery: {
        mode: "download_on_first_launch",
        storageRoot: "document://models",
        defaultTier: "lite",
        modelTiers: {
          lite: {
            requiredModelIds: [
              "google/gemma-3-4b-it",
              "Qwen/Qwen3-Embedding-0.6B",
            ],
          },
          standard: {
            requiredModelIds: ["Qwen/Qwen3-8B", "Qwen/Qwen3-Embedding-0.6B"],
            minRamBytes: 8 * 1024 * 1024 * 1024,
            minFreeStorageBytes: 8 * 1024 * 1024 * 1024,
          },
        },
        models: [
          { id: "google/gemma-3-4b-it", fileName: "gemma-3-4b-it-q4_k_m.gguf", downloadUrl: "https://cdn.example.test/gemma.gguf", localPath: "models/gemma-3-4b-it-q4_k_m.gguf", required: true, requiredForTiers: ["lite"] },
          { id: "Qwen/Qwen3-8B", fileName: "qwen3-8b-q4_k_m.gguf", downloadUrl: "https://cdn.example.test/qwen8.gguf", localPath: "models/qwen3-8b-q4_k_m.gguf", required: false, requiredForTiers: ["standard"] },
          { id: "Qwen/Qwen3-Embedding-0.6B", fileName: "qwen3-embedding-0.6b-q8_0.gguf", downloadUrl: "https://cdn.example.test/embed.gguf", localPath: "models/qwen3-embedding-0.6b-q8_0.gguf", required: true, requiredForTiers: ["lite", "standard"] },
        ],
      },
    });

    await runtime.completeChat({
      model: "Qwen/Qwen3-8B",
      messages: [{ role: "user", content: "hello" }],
    });

    const initArg = (bridge.initialize as any).mock.calls[0][0] as any;
    expect(initArg.models["Qwen/Qwen3-8B"].modelPath).toBe(
      "file:///mock/models/qwen3-8b-q4_k_m.gguf",
    );
    expect(initArg.models["google/gemma-3-4b-it"]).toBeUndefined();
    expect(bridge.completeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "Qwen/Qwen3-8B",
        asset: expect.objectContaining({
          modelPath: "file:///mock/models/qwen3-8b-q4_k_m.gguf",
        }),
      }),
    );
  });

  it("fails clearly when native_on_device has no native binding and never configures backend", async () => {
    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      openAiPolicy: "fallback_only",
      nativeBackend: "llama_cpp",
      nativeModuleName: "JaiOnDeviceModel",
      modelDelivery: { mode: "bundled_assets" },
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
      modelDelivery: { mode: "bundled_assets" },
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
    vi.stubEnv("NODE_ENV", "production");
    const config = {
      mode: "local_adapter" as const,
      baseUrl: "http://192.168.1.23:10000/v1",
      adapterLocation: "external_lan" as const,
    };
    const runtime = createLocalModelRuntime(config);
    expect(runtime.kind).toBe("openai_compatible_local_adapter");
    expect(runtime.isConfigured()).toBe(false);
    expect(getLocalRuntimeConfigError(config, "Local chat")).toContain("development-only");
  });
});
