import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

type FakeFile = { content: string; size: number };

type FakeDownload = {
  url: string;
  content: string;
  fail?: boolean | string;
  size?: number;
  progressSamples?: Array<{
    written: number;
    total?: number;
    advanceMs?: number;
  }>;
};

const state = vi.hoisted(() => ({
  files: new Map<string, FakeFile>(),
  downloads: [] as FakeDownload[],
  downloadAttempts: 0,
  readAsStringCalls: 0,
  freeDiskBytes: 20 * 1024 * 1024 * 1024,
  nowMs: 1_000,
}));

function fakeFsModule() {
  return {
    documentDirectory: "file:///mock/",
    EncodingType: { Base64: "base64" },
    getInfoAsync: vi.fn(async (uri: string) => ({
      exists: state.files.has(uri) || uri.endsWith("/"),
      size: state.files.get(uri)?.size ?? 0,
    })),
    makeDirectoryAsync: vi.fn(async () => undefined),
    deleteAsync: vi.fn(async (uri: string) => {
      state.files.delete(uri);
    }),
    moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const file = state.files.get(from);
      if (!file) throw new Error(`Missing temp file ${from}`);
      state.files.set(to, file);
      state.files.delete(from);
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
      state.readAsStringCalls += 1;
      const file = state.files.get(uri);
      if (!file) throw new Error(`Missing file ${uri}`);
      return Buffer.from(file.content).toString("base64");
    }),
    getFreeDiskStorageAsync: vi.fn(async () => state.freeDiskBytes),
    createDownloadResumable: vi.fn((url: string, targetUri: string, _options: any, onProgress: any, resumeData?: string) => ({
      downloadAsync: vi.fn(async () => {
        state.downloadAttempts += 1;
        const next = state.downloads.shift();
        if (!next) throw new Error(`Unexpected download ${url}`);
        if (next.fail) {
          throw new Error(typeof next.fail === "string" ? next.fail : "network failed");
        }
        const samples = next.progressSamples?.length
          ? next.progressSamples
          : [{ written: next.size ?? Buffer.byteLength(next.content) }];
        for (const sample of samples) {
          state.nowMs += sample.advanceMs ?? 0;
          onProgress?.({
            totalBytesWritten: sample.written,
            totalBytesExpectedToWrite: sample.total ?? next.size ?? Buffer.byteLength(next.content),
          });
        }
        const size = next.size ?? samples.at(-1)?.written ?? Buffer.byteLength(next.content);
        state.files.set(targetUri, { content: next.content, size });
        return { uri: targetUri, status: 200 };
      }),
      pauseAsync: vi.fn(async () => ({ resumeData: resumeData || "paused-resume-data" })),
      resumeAsync: vi.fn(async () => ({ uri: targetUri, status: 200 })),
      savable: vi.fn(() => ({
        url,
        fileUri: targetUri,
        options: {},
        resumeData: resumeData || "saved-resume-data",
      })),
    })),
  };
}

const baseModels = [
  {
    id: "google/gemma-3-4b-it",
    fileName: "gemma-3-4b-it-q4_k_m.gguf",
    downloadUrl: "https://cdn.example.test/gemma.gguf",
    localPath: "models/gemma-3-4b-it-q4_k_m.gguf",
    required: true,
    requiredForTiers: ["lite"],
  },
  {
    id: "Qwen/Qwen3-8B",
    fileName: "qwen3-8b-q4_k_m.gguf",
    downloadUrl: "https://cdn.example.test/qwen8.gguf",
    localPath: "models/qwen3-8b-q4_k_m.gguf",
    required: false,
    requiredForTiers: ["standard"],
  },
  {
    id: "Qwen/Qwen3-14B",
    fileName: "qwen3-14b-q4_k_m.gguf",
    downloadUrl: "https://cdn.example.test/qwen14.gguf",
    localPath: "models/qwen3-14b-q4_k_m.gguf",
    required: false,
    requiredForTiers: ["pro"],
  },
  {
    id: "Qwen/Qwen3-Embedding-0.6B",
    fileName: "qwen3-embedding-0.6b-q8_0.gguf",
    downloadUrl: "https://cdn.example.test/embed.gguf",
    localPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
    required: true,
    requiredForTiers: ["lite", "standard", "pro"],
  },
];

function testConfig(overrides: Record<string, any> = {}) {
  return {
    modelDelivery: {
      mode: "download_on_first_launch",
      storageRoot: "document://models",
      maxRetries: 1,
      defaultTier: "lite",
      modelTiers: {
        lite: {
          requiredModelIds: [
            "google/gemma-3-4b-it",
            "Qwen/Qwen3-Embedding-0.6B",
          ],
          optionalModelIds: ["Qwen/Qwen3-8B"],
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
      models: baseModels,
      ...overrides,
    },
  };
}

describe("modelDownloadManager", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    state.files.clear();
    state.downloads.length = 0;
    state.downloadAttempts = 0;
    state.readAsStringCalls = 0;
    state.freeDiskBytes = 20 * 1024 * 1024 * 1024;
    state.nowMs = 1_000;
  });

  async function importManager() {
    vi.spyOn(Date, "now").mockImplementation(() => state.nowMs);
    vi.doMock("expo-constants", () => ({
      default: { expoConfig: { extra: {} } },
    }));
    vi.doMock("expo-file-system/legacy", fakeFsModule);
    return import("../lib/modelDownloadManager");
  }

  it("reports missing required GGUF files from app-private storage", async () => {
    const { getModelInstallStatus } = await importManager();
    const status = await getModelInstallStatus({ config: testConfig() });

    expect(status.mode).toBe("download_on_first_launch");
    expect(status.ready).toBe(false);
    expect(status.selectedTier).toBe("lite");
    expect(status.missing.map((entry) => entry.id).sort()).toEqual([
      "Qwen/Qwen3-Embedding-0.6B",
      "google/gemma-3-4b-it",
    ].sort());
    expect(status.storageRoot).toBe("file:///mock/models/");
  });

  it("treats local_adapter_dev as ready without requiring GGUF downloads", async () => {
    const { downloadRequiredModels, getModelInstallStatus } = await importManager();
    const config = testConfig({ mode: "local_adapter_dev" });

    const status = await getModelInstallStatus({ config });
    expect(status.mode).toBe("local_adapter_dev");
    expect(status.ready).toBe(true);
    expect(status.requiredReady).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.invalid).toEqual([]);
    expect(status.required.every((entry) => entry.exists && entry.valid)).toBe(true);

    const downloadStatus = await downloadRequiredModels({ config });
    expect(downloadStatus.ready).toBe(true);
    expect(state.downloadAttempts).toBe(0);
  });

  it("downloads only the Lite pack by default and returns file:// paths", async () => {
    state.downloads.push(
      { url: "https://cdn.example.test/gemma.gguf", content: "gemma" },
      { url: "https://cdn.example.test/embed.gguf", content: "embed" },
    );

    const { downloadRequiredModels, resolveInstalledNativeModelAssets } = await importManager();
    const status = await downloadRequiredModels({ config: testConfig() });

    expect(status.ready).toBe(true);
    expect(status.required.map((entry) => entry.id).sort()).toEqual([
      "Qwen/Qwen3-Embedding-0.6B",
      "google/gemma-3-4b-it",
    ].sort());
    expect(state.downloadAttempts).toBe(2);

    const assets = await resolveInstalledNativeModelAssets(
      {
        "google/gemma-3-4b-it": {
          id: "google/gemma-3-4b-it",
          backend: "llama_cpp",
          format: "gguf",
          modelPath: "models/gemma-3-4b-it-q4_k_m.gguf",
        },
      },
      { config: testConfig() },
    );

    expect(assets["google/gemma-3-4b-it"].modelPath).toBe(
      "file:///mock/models/gemma-3-4b-it-q4_k_m.gguf",
    );
  });

  it("does not re-download valid installed files", async () => {
    for (const model of baseModels) {
      state.files.set(`file:///mock/models/${model.fileName}`, {
        content: "installed",
        size: 9,
      });
    }

    const { downloadRequiredModels } = await importManager();
    const status = await downloadRequiredModels({ config: testConfig() });

    expect(status.ready).toBe(true);
    expect(state.downloadAttempts).toBe(0);
  });

  it("selects Lite for unknown or low device capability and keeps 14B out of the default pack", async () => {
    const { getModelInstallStatus, selectModelTier } = await importManager();

    expect(selectModelTier(testConfig(), {})).toBe("lite");
    expect(
      selectModelTier(testConfig(), {
        preferredTier: "pro",
        totalMemoryBytes: 4 * 1024 * 1024 * 1024,
        freeStorageBytes: 4 * 1024 * 1024 * 1024,
      }),
    ).toBe("lite");

    const status = await getModelInstallStatus({ config: testConfig(), deviceInfo: {} });
    expect(status.required.some((entry) => entry.id === "Qwen/Qwen3-14B")).toBe(false);
  });

  it("selects tiers from RAM and storage capability", async () => {
    const { selectModelTier } = await importManager();

    expect(
      selectModelTier(testConfig(), {
        totalMemoryBytes: 4 * 1024 * 1024 * 1024,
        freeStorageBytes: 32 * 1024 * 1024 * 1024,
      }),
    ).toBe("lite");
    expect(
      selectModelTier(testConfig(), {
        totalMemoryBytes: 8 * 1024 * 1024 * 1024,
        freeStorageBytes: 12 * 1024 * 1024 * 1024,
      }),
    ).toBe("standard");
    expect(
      selectModelTier(testConfig(), {
        totalMemoryBytes: 12 * 1024 * 1024 * 1024,
        freeStorageBytes: 12 * 1024 * 1024 * 1024,
      }),
    ).toBe("standard");
    expect(
      selectModelTier(testConfig(), {
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
        freeStorageBytes: 20 * 1024 * 1024 * 1024,
      }),
    ).toBe("pro");
  });

  it("forces Lite while the device is constrained", async () => {
    const { selectModelTier } = await importManager();
    const capable = {
      totalMemoryBytes: 24 * 1024 * 1024 * 1024,
      freeStorageBytes: 32 * 1024 * 1024 * 1024,
    };

    expect(selectModelTier(testConfig(), { ...capable, lowPowerMode: true })).toBe("lite");
    expect(selectModelTier(testConfig(), { ...capable, thermalState: "serious" })).toBe("lite");
    expect(selectModelTier(testConfig(), { ...capable, thermalState: "critical" })).toBe("lite");
    expect(selectModelTier(testConfig(), { ...capable, batteryLevel: 0.1 })).toBe("lite");
    expect(selectModelTier(testConfig(), { ...capable, lowMemory: true })).toBe("lite");
    expect(selectModelTier(testConfig(), { ...capable, lowRamDevice: true })).toBe("lite");
    expect(
      selectModelTier(testConfig(), {
        ...capable,
        freeStorageBytes: 4 * 1024 * 1024 * 1024,
      }),
    ).toBe("lite");
  });

  it("degrades explicit Pro requests when RAM or storage is not enough", async () => {
    const { selectModelTier } = await importManager();

    expect(
      selectModelTier(testConfig(), {
        preferredTier: "pro",
        totalMemoryBytes: 8 * 1024 * 1024 * 1024,
        freeStorageBytes: 32 * 1024 * 1024 * 1024,
      }),
    ).toBe("standard");
    expect(
      selectModelTier(testConfig(), {
        preferredTier: "pro",
        totalMemoryBytes: 24 * 1024 * 1024 * 1024,
        freeStorageBytes: 32 * 1024 * 1024 * 1024,
      }),
    ).toBe("pro");
  });

  it("downloads only selected tier required IDs and never optional IDs automatically", async () => {
    state.downloads.push(
      { url: "https://cdn.example.test/qwen8.gguf", content: "qwen8" },
      { url: "https://cdn.example.test/embed.gguf", content: "embed" },
    );

    const { downloadRequiredModels } = await importManager();
    const status = await downloadRequiredModels({
      config: testConfig(),
      deviceInfo: {
        totalMemoryBytes: 12 * 1024 * 1024 * 1024,
        freeStorageBytes: 12 * 1024 * 1024 * 1024,
      },
    });

    expect(status.selectedTier).toBe("standard");
    expect(status.required.map((entry) => entry.id).sort()).toEqual([
      "Qwen/Qwen3-8B",
      "Qwen/Qwen3-Embedding-0.6B",
    ].sort());
    expect(status.optional.map((entry) => entry.id)).toContain("google/gemma-3-4b-it");
    expect(state.downloadAttempts).toBe(2);
    expect(state.files.has("file:///mock/models/gemma-3-4b-it-q4_k_m.gguf")).toBe(false);
    expect(state.files.has("file:///mock/models/qwen3-14b-q4_k_m.gguf")).toBe(false);
  });

  it("reports byte-weighted progress and suppresses ETA for tiny startup samples", async () => {
    const progressEvents: any[] = [];
    state.downloads.push(
      { url: "https://cdn.example.test/gemma.gguf", content: "gemma" },
      { url: "https://cdn.example.test/embed.gguf", content: "embed" },
    );

    const { downloadRequiredModels } = await importManager();
    await downloadRequiredModels({
      config: testConfig({
        models: [
          { ...baseModels[0], expectedBytes: 5 },
          { ...baseModels[3], expectedBytes: 5 },
        ],
      }),
      onProgress: (progress) => progressEvents.push(progress),
    });

    const downloading = progressEvents.filter((event) => event.phase === "downloading");
    expect(downloading.some((event) => event.totalBytes === 10)).toBe(true);
    expect(downloading.some((event) => event.downloadedBytes > 0)).toBe(true);
    expect(downloading.every((event) => event.etaSeconds == null)).toBe(true);
    expect(progressEvents.at(-1)).toMatchObject({
      phase: "installed",
      totalProgress: 1,
      totalBytes: 10,
      downloadedBytes: 10,
    });
  });

  it("keeps ETA null for the first tiny progress sample", async () => {
    const MiB = 1024 * 1024;
    const progressEvents: any[] = [];
    state.downloads.push({
      url: "https://cdn.example.test/gemma.gguf",
      content: "",
      size: 100 * MiB,
      progressSamples: [
        { written: 512 * 1024, total: 100 * MiB, advanceMs: 1_000 },
      ],
    });

    const { downloadRequiredModels } = await importManager();
    await downloadRequiredModels({
      config: testConfig({
        models: [{ ...baseModels[0], expectedBytes: 100 * MiB }],
      }),
      onProgress: (progress) => progressEvents.push(progress),
    });

    const downloading = progressEvents.filter((event) => event.phase === "downloading");
    expect(downloading.some((event) => event.downloadedBytes > 0)).toBe(true);
    expect(downloading.every((event) => event.etaSeconds == null)).toBe(true);
  });

  it("keeps ETA null until enough progress history exists", async () => {
    const MiB = 1024 * 1024;
    const progressEvents: any[] = [];
    state.downloads.push({
      url: "https://cdn.example.test/gemma.gguf",
      content: "",
      size: 100 * MiB,
      progressSamples: [
        { written: 4 * MiB, total: 100 * MiB, advanceMs: 3_000 },
        { written: 8 * MiB, total: 100 * MiB, advanceMs: 3_000 },
      ],
    });

    const { downloadRequiredModels } = await importManager();
    await downloadRequiredModels({
      config: testConfig({
        models: [{ ...baseModels[0], expectedBytes: 100 * MiB }],
      }),
      onProgress: (progress) => progressEvents.push(progress),
    });

    const downloading = progressEvents.filter((event) => event.phase === "downloading");
    expect(downloading.every((event) => event.etaSeconds == null)).toBe(true);
  });

  it("reports a reasonable ETA after stable recent samples with known totals", async () => {
    const MiB = 1024 * 1024;
    const progressEvents: any[] = [];
    state.downloads.push({
      url: "https://cdn.example.test/gemma.gguf",
      content: "",
      size: 100 * MiB,
      progressSamples: [
        { written: 8 * MiB, total: 100 * MiB, advanceMs: 4_000 },
        { written: 24 * MiB, total: 100 * MiB, advanceMs: 6_000 },
      ],
    });

    const { downloadRequiredModels } = await importManager();
    await downloadRequiredModels({
      config: testConfig({
        models: [{ ...baseModels[0], expectedBytes: 100 * MiB }],
      }),
      onProgress: (progress) => progressEvents.push(progress),
    });

    const etaEvent = progressEvents.find(
      (event) => event.phase === "downloading" && event.etaSeconds != null,
    );
    expect(etaEvent?.speedBytesPerSecond).toBeGreaterThan(0);
    expect(etaEvent?.etaSeconds).toBeGreaterThan(0);
    expect(etaEvent?.etaSeconds).toBeLessThan(120);
  });

  it("suppresses very slow absurd startup ETA estimates", async () => {
    const MiB = 1024 * 1024;
    const GiB = 1024 * MiB;
    const progressEvents: any[] = [];
    state.freeDiskBytes = 140 * GiB;
    state.downloads.push({
      url: "https://cdn.example.test/gemma.gguf",
      content: "",
      size: 100 * GiB,
      progressSamples: [
        { written: 1 * MiB, total: 100 * GiB, advanceMs: 10_000 },
        { written: 2 * MiB, total: 100 * GiB, advanceMs: 10_000 },
        { written: 3 * MiB, total: 100 * GiB, advanceMs: 10_000 },
      ],
    });

    const { downloadRequiredModels } = await importManager();
    await downloadRequiredModels({
      config: testConfig({
        models: [{ ...baseModels[0], expectedBytes: 100 * GiB }],
      }),
      onProgress: (progress) => progressEvents.push(progress),
    });

    const downloading = progressEvents.filter((event) => event.phase === "downloading");
    expect(downloading.some((event) => event.speedBytesPerSecond > 0)).toBe(true);
    expect(downloading.every((event) => event.etaSeconds == null)).toBe(true);
  });

  it("keeps resumable temp files and state after transient DNS interruptions", async () => {
    const savedStates: any[] = [];
    const targetUri = "file:///mock/models/gemma-3-4b-it-q4_k_m.gguf";
    const tempUri = `${targetUri}.download`;
    state.files.set(tempUri, { content: "partial", size: 7 });
    state.downloads.push({
      url: "https://cdn.example.test/gemma.gguf",
      content: "",
      fail: 'Unable to resolve host "huggingface.co": No address associated with hostname',
    });

    const { downloadRequiredModels, ModelDownloadInterruptedError } = await importManager();
    await expect(
      downloadRequiredModels({
        config: testConfig({
          models: [{ ...baseModels[0], expectedBytes: 10 }],
        }),
        resumableStore: {
          load: async (expected) => ({
            ...expected,
            resumeData: "resume-token",
            savable: { resumeData: "resume-token" },
          }),
          save: async (resumeState) => {
            savedStates.push(resumeState);
          },
        },
      }),
    ).rejects.toBeInstanceOf(ModelDownloadInterruptedError);

    expect(state.files.has(tempUri)).toBe(true);
    expect(savedStates.some((resumeState) => resumeState.resumeData)).toBe(true);
  });

  it("deletes and retries a SHA-256 mismatch", async () => {
    const config = testConfig({
      models: [
        { ...baseModels[0], sha256: "expected-good" },
      ],
    });
    state.downloads.push(
      { url: "https://cdn.example.test/gemma.gguf", content: "bad" },
      { url: "https://cdn.example.test/gemma.gguf", content: "good" },
    );

    const { downloadRequiredModels } = await importManager();
    const status = await downloadRequiredModels({
      config,
      retries: 1,
      hashFileAsync: async (uri) => state.files.get(uri)?.content === "good" ? "expected-good" : "wrong-hash",
    });

    expect(status.ready).toBe(true);
    expect(state.downloadAttempts).toBe(2);
    expect(state.files.get("file:///mock/models/gemma-3-4b-it-q4_k_m.gguf")?.content).toBe("good");
  });

  it("deletes temp files and fails clearly for integrity failures", async () => {
    const tempUri = "file:///mock/models/gemma-3-4b-it-q4_k_m.gguf.download";
    state.downloads.push({
      url: "https://cdn.example.test/gemma.gguf",
      content: "bad",
    });

    const { downloadRequiredModels, ModelInstallError } = await importManager();
    await expect(
      downloadRequiredModels({
        config: testConfig({
          models: [{ ...baseModels[0], sha256: "expected-good" }],
        }),
        retries: 0,
        hashFileAsync: async () => "wrong-hash",
      }),
    ).rejects.toBeInstanceOf(ModelInstallError);

    expect(state.files.has(tempUri)).toBe(false);
  });

  it("fails clearly for placeholder CDN URLs instead of silently falling back", async () => {
    const { downloadRequiredModels, ModelInstallError } = await importManager();

    await expect(
      downloadRequiredModels({
        config: testConfig({
          models: [
            {
              ...baseModels[0],
              downloadUrl: "https://YOUR_MODEL_CDN/models/gemma-3-4b-it-q4_k_m.gguf",
            },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(ModelInstallError);
  });


  it("resolves cdn:// model URLs from the configured public CDN base URL", async () => {
    state.downloads.push({ url: "https://models.example.test/models/gemma-3-4b-it-q4_k_m.gguf", content: "gemma" });

    const { downloadRequiredModels } = await importManager();
    const status = await downloadRequiredModels({
      config: testConfig({
        cdnBaseUrl: "https://models.example.test",
        models: [
          {
            ...baseModels[0],
            downloadUrl: "cdn://models/gemma-3-4b-it-q4_k_m.gguf",
          },
        ],
      }),
    });

    expect(status.ready).toBe(true);
    expect(state.downloadAttempts).toBe(1);
  });


  it("checks free device storage before downloading expected-size GGUF files", async () => {
    state.freeDiskBytes = 1024;

    const { downloadRequiredModels, ModelInstallError } = await importManager();

    await expect(
      downloadRequiredModels({
        config: testConfig({
          minFreeBytesBuffer: 1024,
          models: [
            {
              ...baseModels[0],
              expectedBytes: 2048,
            },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(ModelInstallError);
    expect(state.downloadAttempts).toBe(0);
  });

  it("requires expectedBytes and sha256 when production integrity metadata is enabled", async () => {
    const { downloadRequiredModels, ModelInstallError } = await importManager();

    await expect(
      downloadRequiredModels({
        config: testConfig({
          requireIntegrityMetadataInProduction: true,
          models: [
            {
              ...baseModels[0],
              expectedBytes: null,
              sha256: null,
            },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(ModelInstallError);
  });

  it("uses native sha256File when the bridge provides streaming hashing", async () => {
    const nativeHash = "f".repeat(64);
    const sha256File = vi.fn(async ({ fileUri }: { fileUri: string }) => {
      expect(fileUri).toBe("file:///mock/models/gemma-3-4b-it-q4_k_m.gguf");
      return { sha256: nativeHash };
    });
    vi.stubGlobal("__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__", {
      initialize: vi.fn(),
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
      sha256File,
    });
    state.files.set("file:///mock/models/gemma-3-4b-it-q4_k_m.gguf", {
      content: "large-production-model",
      size: 12 * 1024 * 1024,
    });

    const { getModelInstallStatus } = await importManager();
    const status = await getModelInstallStatus({
      config: testConfig({
        models: [{ ...baseModels[0], expectedBytes: 12 * 1024 * 1024, sha256: nativeHash }],
      }),
    });

    expect(status.ready).toBe(true);
    expect(sha256File).toHaveBeenCalledTimes(1);
    expect(state.readAsStringCalls).toBe(0);
  });

  it("does not full-read large files in JS when native hashing is unavailable", async () => {
    state.files.set("file:///mock/models/gemma-3-4b-it-q4_k_m.gguf", {
      content: "",
      size: 12 * 1024 * 1024,
    });

    const { getModelInstallStatus } = await importManager();
    await expect(
      getModelInstallStatus({
        config: testConfig({
          models: [{ ...baseModels[0], expectedBytes: 12 * 1024 * 1024, sha256: "a".repeat(64) }],
        }),
      }),
    ).rejects.toThrow("Native streaming SHA-256 is required");
    expect(state.readAsStringCalls).toBe(0);
  });

  it("keeps JS SHA-256 fallback for small test fixtures", async () => {
    const content = "small fixture";
    const sha256 = createHash("sha256").update(content).digest("hex");
    state.files.set("file:///mock/models/gemma-3-4b-it-q4_k_m.gguf", {
      content,
      size: Buffer.byteLength(content),
    });

    const { getModelInstallStatus } = await importManager();
    const status = await getModelInstallStatus({
      config: testConfig({
        models: [{ ...baseModels[0], expectedBytes: Buffer.byteLength(content), sha256 }],
      }),
    });

    expect(status.ready).toBe(true);
    expect(state.readAsStringCalls).toBe(1);
  });

  it("validates production integrity metadata for remote entries unless explicitly marked dev-only", async () => {
    const { validateModelDeliveryConfig, ModelInstallError } = await importManager();

    expect(() =>
      validateModelDeliveryConfig(testConfig(), { production: true }),
    ).toThrow(ModelInstallError);

    expect(() =>
      validateModelDeliveryConfig(
        testConfig({
          models: [
            {
              ...baseModels[0],
              expectedBytes: null,
              sha256: null,
              allowMissingIntegrity: true,
            },
          ],
        }),
        { production: true },
      ),
    ).not.toThrow();
  });
});
