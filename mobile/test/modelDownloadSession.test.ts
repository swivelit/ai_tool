import { afterEach, describe, expect, it, vi } from "vitest";

type FakeFile = { content: string; size: number };

type FakeDownloadPlan =
  | { type: "success"; size: number; content?: string }
  | { type: "transient"; message: string; partialSize?: number }
  | { type: "pending"; partialSize?: number; resumeData?: string };

const state = vi.hoisted(() => ({
  files: new Map<string, FakeFile>(),
  plans: [] as FakeDownloadPlan[],
  createCalls: [] as Array<{ url: string; targetUri: string; resumeData?: string }>,
  pauseCalls: 0,
  pendingReject: null as null | ((error: Error) => void),
  storage: new Map<string, string>(),
  nowMs: 1_000,
}));

const model = {
  id: "Qwen/Qwen3-8B",
  fileName: "qwen3-8b-q4_k_m.gguf",
  downloadUrl: "https://cdn.example.test/qwen8.gguf",
  localPath: "models/qwen3-8b-q4_k_m.gguf",
  expectedBytes: 32,
  required: true,
  requiredForTiers: ["lite"],
};

function testConfig() {
  return {
    modelDelivery: {
      mode: "download_on_first_launch",
      storageRoot: "document://models",
      defaultTier: "lite",
      maxRetries: 0,
      modelTiers: {
        lite: {
          requiredModelIds: [model.id],
        },
      },
      models: [model],
    },
  };
}

function storageMock() {
  return {
    getItem: vi.fn(async (key: string) => state.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      state.storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      state.storage.delete(key);
    }),
  };
}

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
    readAsStringAsync: vi.fn(async () => ""),
    getFreeDiskStorageAsync: vi.fn(async () => 20 * 1024 * 1024 * 1024),
    createDownloadResumable: vi.fn((
      url: string,
      targetUri: string,
      _options: unknown,
      onProgress: (progress: Record<string, number>) => void,
      resumeData?: string,
    ) => {
      state.createCalls.push({ url, targetUri, resumeData });
      const plan = state.plans.shift() || { type: "success", size: model.expectedBytes };
      const savable = () => ({
        url,
        fileUri: targetUri,
        options: {},
        resumeData: plan.type === "pending"
          ? plan.resumeData || "background-resume-data"
          : resumeData || "resume-token",
      });
      return {
        downloadAsync: vi.fn(async () => {
          if (plan.type === "pending") {
            const partialSize = plan.partialSize ?? 8;
            onProgress({
              totalBytesWritten: partialSize,
              totalBytesExpectedToWrite: model.expectedBytes,
            });
            state.files.set(targetUri, { content: "partial", size: partialSize });
            return new Promise((_resolve, reject) => {
              state.pendingReject = reject;
            });
          }
          if (plan.type === "transient") {
            if (plan.partialSize) {
              onProgress({
                totalBytesWritten: plan.partialSize,
                totalBytesExpectedToWrite: model.expectedBytes,
              });
              state.files.set(targetUri, { content: "partial", size: plan.partialSize });
            }
            throw new Error(plan.message);
          }
          onProgress({
            totalBytesWritten: plan.size,
            totalBytesExpectedToWrite: model.expectedBytes,
          });
          state.files.set(targetUri, {
            content: plan.content || "x".repeat(plan.size),
            size: plan.size,
          });
          return { uri: targetUri, status: 200 };
        }),
        pauseAsync: vi.fn(async () => {
          state.pauseCalls += 1;
          state.pendingReject?.(new Error("app/background pause"));
          state.pendingReject = null;
          return savable();
        }),
        resumeAsync: vi.fn(async () => ({ uri: targetUri, status: 200 })),
        savable: vi.fn(savable),
      };
    }),
  };
}

async function importSession() {
  vi.spyOn(Date, "now").mockImplementation(() => state.nowMs);
  vi.doMock("expo-constants", () => ({
    default: { expoConfig: { extra: {} } },
  }));
  vi.doMock("expo-file-system/legacy", fakeFsModule);
  vi.doMock("@react-native-async-storage/async-storage", () => ({
    default: storageMock(),
  }));
  return import("../lib/modelDownloadSession");
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("modelDownloadSession", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    state.files.clear();
    state.plans.length = 0;
    state.createCalls.length = 0;
    state.pauseCalls = 0;
    state.pendingReject = null;
    state.storage.clear();
    state.nowMs = 1_000;
  });

  it("stores resumable state after a transient DNS interruption and resumes with resumeData", async () => {
    state.plans.push(
      {
        type: "transient",
        partialSize: 8,
        message: 'Unable to resolve host "huggingface.co": No address associated with hostname',
      },
      { type: "success", size: model.expectedBytes },
    );

    const { createModelDownloadSession } = await importSession();
    const session = createModelDownloadSession({ storage: storageMock() });

    await session.start({ config: testConfig() });
    const interrupted = session.getSnapshot();
    expect(interrupted.status).toBe("reconnecting");
    expect(interrupted.canRetry).toBe(true);
    expect(interrupted.userMessage).not.toMatch(/huggingface|qwen3-8b|\.gguf/i);
    expect(interrupted.developerError).toMatch(/huggingface\.co/i);
    expect(state.files.has("file:///mock/models/qwen3-8b-q4_k_m.gguf.download")).toBe(true);
    expect([...state.storage.values()].some((value) => value.includes("resume-token"))).toBe(true);

    await session.resume();
    expect(session.getSnapshot().ready).toBe(true);
    expect(state.createCalls[1].resumeData).toBe("resume-token");
  });

  it("pauses on background, stores savable state, and resumes the same active target", async () => {
    state.plans.push(
      { type: "pending", partialSize: 8, resumeData: "background-resume-data" },
      { type: "success", size: model.expectedBytes },
    );

    const { createModelDownloadSession } = await importSession();
    const session = createModelDownloadSession({ storage: storageMock() });
    const startPromise = session.start({ config: testConfig() });
    for (let i = 0; i < 5 && state.createCalls.length === 0; i += 1) {
      await flush();
    }

    await session.pause("background");
    await startPromise;

    expect(state.pauseCalls).toBe(1);
    expect(session.getSnapshot().status).toBe("paused");
    expect([...state.storage.values()].some((value) => value.includes("background-resume-data"))).toBe(true);

    await session.resume();
    expect(session.getSnapshot().ready).toBe(true);
    expect(state.createCalls[1].targetUri).toBe("file:///mock/models/qwen3-8b-q4_k_m.gguf.download");
    expect(state.createCalls[1].resumeData).toBe("background-resume-data");
  });

  it("deduplicates repeated start calls while a download is active", async () => {
    state.plans.push({ type: "success", size: model.expectedBytes });

    const { createModelDownloadSession } = await importSession();
    const session = createModelDownloadSession({ storage: storageMock() });
    const first = session.start({ config: testConfig() });
    const second = session.start({ config: testConfig() });

    await Promise.all([first, second]);

    expect(session.getSnapshot().ready).toBe(true);
    expect(state.createCalls).toHaveLength(1);
  });
});
