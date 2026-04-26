import { afterEach, describe, expect, it, vi } from "vitest";

type FakeFile = { content: string; size: number };

type FakeDownload = {
  url: string;
  content: string;
  fail?: boolean;
};

const state = vi.hoisted(() => ({
  files: new Map<string, FakeFile>(),
  downloads: [] as FakeDownload[],
  downloadAttempts: 0,
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
      const file = state.files.get(uri);
      if (!file) throw new Error(`Missing file ${uri}`);
      return Buffer.from(file.content).toString("base64");
    }),
    createDownloadResumable: vi.fn((url: string, targetUri: string, _options: any, onProgress: any) => ({
      downloadAsync: vi.fn(async () => {
        state.downloadAttempts += 1;
        const next = state.downloads.shift();
        if (!next) throw new Error(`Unexpected download ${url}`);
        if (next.fail) throw new Error("network failed");
        const size = Buffer.byteLength(next.content);
        onProgress?.({ totalBytesWritten: size, totalBytesExpectedToWrite: size });
        state.files.set(targetUri, { content: next.content, size });
        return { uri: targetUri, status: 200 };
      }),
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
  },
  {
    id: "Qwen/Qwen3-8B",
    fileName: "qwen3-8b-q4_k_m.gguf",
    downloadUrl: "https://cdn.example.test/qwen8.gguf",
    localPath: "models/qwen3-8b-q4_k_m.gguf",
    required: true,
  },
  {
    id: "Qwen/Qwen3-14B",
    fileName: "qwen3-14b-q4_k_m.gguf",
    downloadUrl: "https://cdn.example.test/qwen14.gguf",
    localPath: "models/qwen3-14b-q4_k_m.gguf",
    required: true,
  },
  {
    id: "Qwen/Qwen3-Embedding-0.6B",
    fileName: "qwen3-embedding-0.6b-q8_0.gguf",
    downloadUrl: "https://cdn.example.test/embed.gguf",
    localPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
    required: true,
  },
];

function testConfig(overrides: Record<string, any> = {}) {
  return {
    modelDelivery: {
      mode: "download_on_first_launch",
      storageRoot: "document://models",
      maxRetries: 1,
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
  });

  async function importManager() {
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
    expect(status.missing).toHaveLength(4);
    expect(status.storageRoot).toBe("file:///mock/models/");
  });

  it("downloads missing models, verifies non-zero size, and returns file:// paths", async () => {
    state.downloads.push(
      { url: "https://cdn.example.test/gemma.gguf", content: "gemma" },
      { url: "https://cdn.example.test/qwen8.gguf", content: "qwen8" },
      { url: "https://cdn.example.test/qwen14.gguf", content: "qwen14" },
      { url: "https://cdn.example.test/embed.gguf", content: "embed" },
    );

    const { downloadRequiredModels, resolveInstalledNativeModelAssets } = await importManager();
    const status = await downloadRequiredModels({ config: testConfig() });

    expect(status.ready).toBe(true);
    expect(state.downloadAttempts).toBe(4);

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
});
