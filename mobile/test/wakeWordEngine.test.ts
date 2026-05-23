import { createHash } from "node:crypto";

import { describe, expect, it, vi, afterEach } from "vitest";

import { normalizeAssistantSettings } from "@/lib/storage";
import {
  ensureWakeModel,
  saveWakeModelBundleBytes,
  startWakeWordListening,
  stopWakeWordListening,
  validateWakeModelBundleConfig,
  wakeModelStateFromApiStatus,
} from "@/lib/wakeWordEngine";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../lib/api");
  vi.doUnmock("../modules/wake-word");
  vi.doUnmock("expo-file-system/legacy");
  vi.doUnmock("expo-modules-core");
  delete (globalThis as any).__JAI_WAKE_WORD_NATIVE_MODULE_FOR_TESTS__;
  vi.resetModules();
});

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number) {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function u32(value: number) {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ]);
}

function storedZip(entries: Record<string, Uint8Array | string>) {
  return concatBytes(
    Object.entries(entries).map(([name, raw]) => {
      const nameBytes = utf8(name);
      const content = typeof raw === "string" ? utf8(raw) : raw;
      return concatBytes([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(content.length),
        u32(content.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
        content,
      ]);
    }),
  );
}

function sha(bytes: Uint8Array | string) {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes) : bytes).digest("hex");
}

function makeWakeBundle(
  mutate?: (input: {
    manifest: any;
    files: Record<string, Uint8Array | string>;
  }) => void,
) {
  const files: Record<string, Uint8Array | string> = {
    "hey_elli.onnx": "wake-bytes",
    "melspectrogram.onnx": "mel-bytes",
    "embedding_model.onnx": "embedding-bytes",
  };
  const manifest = {
    phrase_key: "hey-elli",
    wake_phrase: "Hey Elli",
    model_type: "custom",
    model_files: [
      { role: "wake", file: "hey_elli.onnx", bytes: 10, sha256: sha("wake-bytes") },
      { role: "melspectrogram", file: "melspectrogram.onnx", bytes: 9, sha256: sha("mel-bytes") },
      { role: "embedding", file: "embedding_model.onnx", bytes: 15, sha256: sha("embedding-bytes") },
    ],
  };
  mutate?.({ manifest, files });
  return storedZip({
    "manifest.json": JSON.stringify(manifest),
    ...files,
  });
}

async function importWakeWordEngineWithMocks(options: {
  validateResult?: any;
  validateError?: Error;
}) {
  vi.resetModules();
  const validateModelBundle = vi.fn(async (config: any) => {
    if (options.validateError) throw options.validateError;
    return (
      options.validateResult || {
        ok: true,
        realOpenWakeWordModelCompatibility: true,
        modelFilesExist: true,
        manifestRolesPresent: true,
        startConfigModelPathsPresent: true,
        modelShapesAccepted: true,
        model: "hey_elli.onnx",
        phraseKey: "hey-elli",
      }
    );
  });
  const apiGet = vi.fn(async () => ({
    ready: true,
    status: "ready",
    phrase_key: "hey-elli",
    wake_phrase: "Hey Elli",
    model_type: "custom",
    threshold: 0.5,
    sample_rate: 16000,
    frame_ms: 80,
    model_files: [
      { role: "wake", file: "hey_elli.onnx" },
      { role: "melspectrogram", file: "melspectrogram.onnx" },
      { role: "embedding", file: "embedding_model.onnx" },
    ],
  }));
  const bundle = makeWakeBundle();
  const apiFetchRaw = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    arrayBuffer: async () => bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength),
  }));

  vi.doMock("../lib/api", () => ({ apiGet, apiFetchRaw }));
  vi.doMock("expo-file-system/legacy", () => ({
    documentDirectory: "file:///mock/",
    EncodingType: { Base64: "base64", UTF8: "utf8" },
    getInfoAsync: vi.fn(async () => ({ exists: false, isDirectory: false, size: 0 })),
    makeDirectoryAsync: vi.fn(async () => undefined),
    deleteAsync: vi.fn(async () => undefined),
    writeAsStringAsync: vi.fn(async () => undefined),
  }));
  const nativeModule = {
      isAvailable: () => true,
      validateModelBundle,
      stop: vi.fn(async () => ({ ok: true })),
    };
  (globalThis as any).__JAI_WAKE_WORD_NATIVE_MODULE_FOR_TESTS__ = nativeModule;
  vi.doMock("../modules/wake-word", () => ({
    default: nativeModule,
  }));
  vi.doMock("expo-modules-core", () => ({
    requireNativeModule: vi.fn(() => nativeModule),
    EventEmitter: class {
      addListener() {
        return { remove: () => undefined };
      }
    },
  }));

  return {
    module: await import("../lib/wakeWordEngine"),
    apiGet,
    apiFetchRaw,
    validateModelBundle,
  };
}

describe("wakeWordEngine", () => {
  it("does not prepare a production model when native wake detection is unavailable", async () => {
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });
    const model = await ensureWakeModel(settings);
    expect(model.ready).toBe(false);
    expect(model.status).toBe("unsupported");
  });

  it("does not start production wake listening without a ready model", async () => {
    await expect(
      startWakeWordListening(
        {
          status: "pending",
          ready: false,
          wakePhrase: "Hey Elli",
        },
        { onWake: () => undefined },
      ),
    ).rejects.toThrow(/Wake model is not ready/);
  });

  it("does not start production wake listening with an incomplete OpenWakeWord bundle", async () => {
    await expect(
      startWakeWordListening(
        {
          status: "ready",
          ready: true,
          wakePhrase: "Hey Elli",
          phraseKey: "hey-elli",
          modelPaths: {
            wakeModel: "file:///wake.onnx",
          },
        },
        { onWake: () => undefined },
      ),
    ).rejects.toThrow(/mel or embedding/);
  });

  it("preserves pending Hey Elli backend status as Needs model", () => {
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    const model = wakeModelStateFromApiStatus(settings, {
      ready: false,
      status: "pending",
      phrase_key: "hey-elli",
      wake_phrase: "Hey Elli",
      model_type: "custom",
      detail: "Needs model",
    });

    expect(model.ready).toBe(false);
    expect(model.status).toBe("pending");
    expect(model.modelType).toBe("custom");
    expect(model.detail).toBe("Needs model");
  });

  it("validates model bundle roles and native start paths before claiming compatibility", () => {
    const incomplete = validateWakeModelBundleConfig({
      phraseKey: "hey-elli",
      wakePhrase: "Hey Elli",
      modelPaths: {
        wakeModel: "file:///wake.onnx",
        melspectrogramModel: "file:///melspectrogram.onnx",
        embeddingModel: "file:///embedding_model.onnx",
      },
      manifestRoles: ["wake"],
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.manifestRolesPresent).toBe(false);

    const complete = validateWakeModelBundleConfig({
      phraseKey: "hey-elli",
      wakePhrase: "Hey Elli",
      modelPaths: {
        wakeModel: "file:///wake.onnx",
        melspectrogramModel: "file:///melspectrogram.onnx",
        embeddingModel: "file:///embedding_model.onnx",
      },
      manifestRoles: ["wake", "melspectrogram", "embedding"],
    });
    expect(complete).toMatchObject({
      ok: true,
      deterministicTestSeam: false,
      manifestRolesPresent: true,
      startConfigModelPathsPresent: true,
    });
  });

  it("verifies wake bundle integrity before writing model files", async () => {
    const saved = await saveWakeModelBundleBytes(makeWakeBundle());

    expect(saved.modelRoles).toEqual(["wake", "melspectrogram", "embedding"]);
    expect(saved.modelPaths).toMatchObject({
      wakeModel: "file:///mock/wake_word_models/hey-elli/hey_elli.onnx",
      melspectrogramModel: "file:///mock/wake_word_models/hey-elli/melspectrogram.onnx",
      embeddingModel: "file:///mock/wake_word_models/hey-elli/embedding_model.onnx",
    });
  });

  it.each([
    [
      "hash mismatch",
      ({ manifest }: any) => {
        manifest.model_files[0].sha256 = "0".repeat(64);
      },
      /SHA-256 mismatch/,
    ],
    [
      "byte mismatch",
      ({ manifest }: any) => {
        manifest.model_files[0].bytes = 99;
      },
      /byte length mismatch/,
    ],
    [
      "missing role",
      ({ manifest }: any) => {
        manifest.model_files = manifest.model_files.filter((entry: any) => entry.role !== "embedding");
      },
      /must include wake, melspectrogram, and embedding/,
    ],
    [
      "../ path",
      ({ manifest }: any) => {
        manifest.model_files[0].file = "../secret.onnx";
      },
      /unsafe file path/,
    ],
    [
      "absolute path",
      ({ manifest }: any) => {
        manifest.model_files[0].file = "/tmp/secret.onnx";
      },
      /unsafe file path/,
    ],
    [
      "missing file",
      ({ manifest }: any) => {
        manifest.model_files[0].file = "missing.onnx";
        manifest.model_files[0].bytes = 10;
        manifest.model_files[0].sha256 = sha("wake-bytes");
      },
      /missing missing\.onnx/,
    ],
  ])("rejects wake bundle with %s", async (_name, mutate, expected) => {
    await expect(saveWakeModelBundleBytes(makeWakeBundle(mutate as any))).rejects.toThrow(expected);
  });

  it("does not mark a downloaded bundle ready until native validation succeeds", async () => {
    const { module, validateModelBundle } = await importWakeWordEngineWithMocks({});
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    const model = await module.ensureWakeModel(settings);

    expect(model.ready).toBe(true);
    expect(model.status).toBe("ready");
    expect(validateModelBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        phraseKey: "hey-elli",
        modelPaths: expect.objectContaining({
          wakeModel: "file:///mock/wake_word_models/hey-elli/hey_elli.onnx",
          melspectrogramModel: "file:///mock/wake_word_models/hey-elli/melspectrogram.onnx",
          embeddingModel: "file:///mock/wake_word_models/hey-elli/embedding_model.onnx",
        }),
        manifestRoles: ["wake", "melspectrogram", "embedding"],
      }),
    );
  });

  it("does not mark a downloaded bundle ready when native validation fails", async () => {
    const { module, validateModelBundle } = await importWakeWordEngineWithMocks({
      validateError: new Error("JaiWakeWord error [JAI_WAKE_MODEL_UNSUPPORTED]: wake model input shape is unsupported."),
    });
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    const model = await module.ensureWakeModel(settings);

    expect(validateModelBundle).toHaveBeenCalledTimes(1);
    expect(model.ready).toBe(false);
    expect(model.status).toBe("unsupported");
    expect(model.detail).toContain("unsupported");
  });

  it("does not mark a downloaded bundle ready when native validation is skipped", async () => {
    const { module } = await importWakeWordEngineWithMocks({
      validateResult: {
        ok: true,
        deterministicTestSeam: false,
        realOpenWakeWordModelCompatibility: false,
      },
    });
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    const model = await module.ensureWakeModel(settings);

    expect(model.ready).toBe(false);
    expect(model.status).toBe("unsupported");
  });

  it("supports debug E2E mock wake only when explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });
    const model = await ensureWakeModel(settings);
    expect(model.ready).toBe(true);
    expect(model.status).toBe("e2e_mock");

    const onWake = vi.fn();
    await startWakeWordListening(model, { onWake });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stopWakeWordListening();
    expect(onWake).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "e2e_mock",
        phraseKey: "e2e-mock",
      }),
    );
  });

  it("rejects E2E mock wake in production runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    await expect(ensureWakeModel(settings)).rejects.toThrow(/debug\/dev-only/);
  });
});
