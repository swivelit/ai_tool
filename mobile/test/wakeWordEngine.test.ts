import { createHash } from "node:crypto";

import { describe, expect, it, vi, afterEach } from "vitest";

import { normalizeAssistantSettings } from "@/lib/storage";
import {
  ensureWakeModel,
  saveWakeModelBundleBytes,
  startHandsFreeSession,
  startWakeWordListening,
  stopHandsFreeSession,
  stopWakeWordListening,
  validateWakeModelBundleConfig,
  wakeModelStateFromApiStatus,
} from "@/lib/wakeWordEngine";

afterEach(() => {
  vi.useRealTimers();
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
  startError?: Error;
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
      configure: vi.fn(async () => ({ ok: true })),
      startSession: vi.fn(async () => ({ ok: true })),
      stopSession: vi.fn(async () => ({ ok: true })),
      cancelCommand: vi.fn(async () => ({ ok: true })),
      notifyTtsStarted: vi.fn(async () => ({ ok: true })),
      notifyTtsCompleted: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => {
        if (options.startError) throw options.startError;
        return { ok: true };
      }),
      validateModelBundle,
      stop: vi.fn(async () => ({ ok: true })),
    };
  const listenerRemoves: Array<ReturnType<typeof vi.fn>> = [];
  const listeners: Record<string, Array<(payload: any) => void>> = {};
  (globalThis as any).__JAI_WAKE_WORD_NATIVE_MODULE_FOR_TESTS__ = nativeModule;
  vi.doMock("../modules/wake-word", () => ({
    default: nativeModule,
  }));
  vi.doMock("expo-modules-core", () => ({
    requireNativeModule: vi.fn(() => nativeModule),
    EventEmitter: class {
      addListener(name: string, callback: (payload: any) => void) {
        const remove = vi.fn();
        listeners[name] = [...(listeners[name] || []), callback];
        listenerRemoves.push(remove);
        return { remove };
      }
    },
  }));

  return {
    module: await import("../lib/wakeWordEngine"),
    apiGet,
    apiFetchRaw,
    validateModelBundle,
    start: nativeModule.start,
    startSession: nativeModule.startSession,
    stopSession: nativeModule.stopSession,
    listenerRemoves,
    listeners,
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
      "missing hash",
      ({ manifest }: any) => {
        delete manifest.model_files[0].sha256;
      },
      /missing SHA-256/,
    ],
    [
      "missing byte length",
      ({ manifest }: any) => {
        delete manifest.model_files[0].bytes;
      },
      /missing byte length/,
    ],
    [
      "invalid hash",
      ({ manifest }: any) => {
        manifest.model_files[0].sha256 = "not-a-sha";
      },
      /invalid SHA-256/,
    ],
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

  it.each([
    ["../escape"],
    ["/tmp/escape"],
    ["a/b"],
    ["a\\b"],
    ["."],
    [""],
    ["x".repeat(65)],
  ])("rejects unsafe wake bundle phrase_key %j", async (phraseKey) => {
    await expect(
      saveWakeModelBundleBytes(
        makeWakeBundle(({ manifest }) => {
          manifest.phrase_key = phraseKey;
        }),
      ),
    ).rejects.toThrow(/unsafe phrase_key/);
  });

  it("accepts a safe wake bundle phrase_key", async () => {
    const saved = await saveWakeModelBundleBytes(
      makeWakeBundle(({ manifest }) => {
        manifest.phrase_key = "hey-elli";
      }),
    );

    expect(saved.modelPaths.wakeModel).toContain("/wake_word_models/hey-elli/hey_elli.onnx");
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

  it("removes native event subscriptions when native start fails", async () => {
    const { module, start, listenerRemoves } = await importWakeWordEngineWithMocks({
      startError: new Error("AudioRecord start failed"),
    });

    await expect(
      module.startWakeWordListening(
        {
          status: "ready",
          ready: true,
          wakePhrase: "Hey Elli",
          phraseKey: "hey-elli",
          modelPaths: {
            wakeModel: "file:///wake.onnx",
            melspectrogramModel: "file:///melspectrogram.onnx",
            embeddingModel: "file:///embedding_model.onnx",
          },
          modelRoles: ["wake", "melspectrogram", "embedding"],
        },
        { onWake: () => undefined },
      ),
    ).rejects.toThrow(/AudioRecord start failed/);

    expect(start).toHaveBeenCalledTimes(1);
    expect(listenerRemoves).toHaveLength(2);
    expect(listenerRemoves.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  });

  it("starts and stops the native hands-free session API", async () => {
    const { module, startSession, stopSession, listenerRemoves } =
      await importWakeWordEngineWithMocks({});

    await module.startHandsFreeSession(
      {
        status: "ready",
        ready: true,
        wakePhrase: "Hey Elli",
        phraseKey: "hey-elli",
        modelPaths: {
          wakeModel: "file:///wake.onnx",
          melspectrogramModel: "file:///melspectrogram.onnx",
          embeddingModel: "file:///embedding_model.onnx",
        },
        modelRoles: ["wake", "melspectrogram", "embedding"],
      },
      { onCommand: () => undefined, onCommandAudio: () => undefined },
    );
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        phraseKey: "hey-elli",
        modelPaths: expect.objectContaining({
          wakeModel: "file:///wake.onnx",
        }),
      }),
    );

    stopSession.mockClear();
    await module.stopHandsFreeSession();

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(listenerRemoves.length).toBeGreaterThanOrEqual(5);
    expect(listenerRemoves.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  });

  it("normalizes typed and legacy native hands-free error payloads", async () => {
    const { module, listeners } = await importWakeWordEngineWithMocks({});
    const onError = vi.fn();

    await module.startHandsFreeSession(
      {
        status: "ready",
        ready: true,
        wakePhrase: "Hey Elli",
        phraseKey: "hey-elli",
        modelPaths: {
          wakeModel: "file:///wake.onnx",
          melspectrogramModel: "file:///melspectrogram.onnx",
          embeddingModel: "file:///embedding_model.onnx",
        },
        modelRoles: ["wake", "melspectrogram", "embedding"],
      },
      { onError },
    );

    listeners.onWakeError?.[0]?.({
      code: "JAI_WAKE_AUDIO_READ_STALLED",
      message: "AudioRecord stalled",
      permanent: false,
      restartable: true,
      sessionActive: true,
      source: "capture",
      timestamp: 1234,
    });
    listeners.onWakeError?.[0]?.({
      message: "legacy wake error",
    });

    expect(onError).toHaveBeenNthCalledWith(1, {
      code: "JAI_WAKE_AUDIO_READ_STALLED",
      message: "AudioRecord stalled",
      permanent: false,
      restartable: true,
      sessionActive: true,
      source: "capture",
      timestamp: 1234,
    });
    expect(onError).toHaveBeenNthCalledWith(2, {
      code: "JAI_WAKE_ERROR",
      message: "legacy wake error",
      permanent: undefined,
      restartable: undefined,
      sessionActive: undefined,
      source: undefined,
      timestamp: undefined,
    });
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

  it("supports debug E2E mock hands-free command events", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");
    vi.stubEnv("EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND", "show my reminders");
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });
    const model = await ensureWakeModel(settings);
    const onCommand = vi.fn();
    const onWake = vi.fn();

    await startHandsFreeSession(model, { onWake, onCommand });
    await vi.advanceTimersByTimeAsync(500);
    await stopHandsFreeSession();

    expect(onWake).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "e2e_mock",
        phraseKey: "e2e-mock",
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "show my reminders",
        empty: false,
      }),
    );
  });

  it("supports debug E2E mock hands-free command audio events", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO", "1");
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });
    const model = await ensureWakeModel(settings);
    const onCommand = vi.fn();
    const onCommandAudio = vi.fn();

    await startHandsFreeSession(model, { onCommand, onCommandAudio });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await stopHandsFreeSession();

    expect(onCommand).not.toHaveBeenCalled();
    expect(onCommandAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        fileUri: expect.stringMatching(/^file:\/\/.*\.wav$/),
        uri: expect.stringMatching(/^file:\/\/.*\.wav$/),
        durationMs: 1000,
        sampleRate: 16000,
        mimeType: "audio/wav",
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
