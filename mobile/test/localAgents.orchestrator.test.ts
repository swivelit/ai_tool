import { beforeEach, describe, expect, it, vi } from "vitest";

import agentRegistry from "../data/config/agent_registry.json";
import alignmentRules from "../data/config/alignment_rules.json";
import memoryRules from "../data/config/memory_rules.json";
import models from "../data/config/models.json";
import orchestratorRoutes from "../data/config/orchestrator_routes.json";
import profilerSlots from "../data/config/profiler_slots.json";
import prompts from "../data/config/prompts.json";
import { __idleQueueTestUtils } from "../lib/localIdleQueue";
import { resetNativeInferenceSafetyForTests } from "../lib/nativeInferenceGuard";
import { setNativeOnDeviceModelBridgeForTests } from "../lib/nativeOnDeviceModelBridge";
import AsyncStorage, { __resetAsyncStorageMock } from "./mocks/async-storage";

const mockedState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(["file:///mock", "file:///mock/data"]),
  fetchQueue: [] as Array<() => Promise<any>>,
}));

function normalizeDir(path: string) {
  return path.replace(/\/+$/, "");
}

function parentDirs(path: string) {
  const parts = path.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    dirs.push(`file:///${parts.slice(0, i + 1).join("/")}`);
  }
  return dirs;
}

const apiPostMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    ok: true,
  })),
);

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///mock/",
  EncodingType: {
    UTF8: "utf8",
  },
  getInfoAsync: vi.fn(async (path: string) => ({
    exists:
      mockedState.files.has(path) ||
      mockedState.directories.has(normalizeDir(path)) ||
      Array.from(mockedState.files.keys()).some((filePath) =>
        filePath.startsWith(`${normalizeDir(path)}/`),
      ),
  })),
  makeDirectoryAsync: vi.fn(async (path: string) => {
    mockedState.directories.add(normalizeDir(path));
  }),
  writeAsStringAsync: vi.fn(async (path: string, content: string) => {
    parentDirs(path).forEach((dir) => mockedState.directories.add(dir));
    mockedState.files.set(path, content);
  }),
  readAsStringAsync: vi.fn(async (path: string) => {
    if (!mockedState.files.has(path)) {
      throw new Error(`Missing file: ${path}`);
    }
    return mockedState.files.get(path) as string;
  }),
  deleteAsync: vi.fn(async (path: string) => {
    mockedState.files.delete(path);
  }),
  createDownloadResumable: vi.fn(() => {
    throw new Error("Model download should not start during normal chat.");
  }),
}));

vi.mock("../lib/localAgentBootstrap", () => ({
  LOCAL_AGENT_DATA_DIR: "file:///mock/data",
  ensureLocalAgentSeedData: vi.fn(async () => ({
    dataDir: "file:///mock/data",
    seedVersion: "test-seed",
  })),
}));

vi.mock("../lib/api", () => ({
  BACKEND_CHAT_FALLBACK_TIMEOUT_MS: 90_000,
  CLOUD_FALLBACK_CONSENT_MESSAGE:
    "This needs backend/OpenAI help. Enable cloud fallback to answer this.",
  annotateBackendOpenAiFallbackResponse: (payload: any) => payload,
  apiPost: apiPostMock,
  apiPostBackendOnly: apiPostMock,
  sendClientTurnLog: vi.fn(),
}));

global.fetch = vi.fn(async () => {
  const next = mockedState.fetchQueue.shift();
  if (!next) {
    throw new Error("Unexpected fetch");
  }
  return next();
}) as any;

function queueCompletion(content: string) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  }));
}

function queueJsonResponse(payload: any) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => payload,
  }));
}

function unitEmbedding() {
  const out = new Array(384).fill(0);
  out[0] = 1;
  return out;
}

const dataRoot = "file:///mock/data";

describe("phone-local agent configuration", () => {
  it("configures local agents as optional fallback under backend-primary policy", () => {
    expect(models.runtime.primary).toBe("backend");
    expect(models.runtime.mode).toBe("native_on_device");
    expect(models.runtime.backendRole).toBe("primary");
    expect(models.runtime.openAiPolicy).toBe("backend_controlled");
    expect(models.runtime.backendPolicy).toContain("primary");
    expect(models.runtime.nativeRuntime).toBe("NativeOnDeviceModelRuntime");
    expect(models.runtime.nativeImplementationStatus).toMatch(
      /native_build_wired|native_build_verified_by_native_verify_llama/,
    );
    expect(models.runtime.nativeImplementationStatus).toContain("llama_cpp");
    expect(models.runtime.nativeImplementationStatus).toContain("production_gguf_runtime");
    expect(models.runtime.nativeImplementationStatus).toMatch(
      /not_verified_until_native_verify_llama_passes|native_build_verified_by_native_verify_llama/,
    );
    expect(models.runtime.nativeBackend).toBe("llama_cpp");
    expect(models.runtime.adapterDevelopmentOnly).toBe(true);
    expect(models.native.backend).toBe("llama_cpp");
    expect(models.native.bridgeModuleName).toBe("JaiOnDeviceModel");
    expect(models.native.models["google/gemma-3-4b-it"].modelPath).toContain(".gguf");
    expect(models.runtime.adapterRuntime).toBe("OpenAiCompatibleLocalAdapterRuntime");
    expect(agentRegistry.runtime.primary).toBe("backend");
    expect(agentRegistry.runtime.mode).toBe("native_on_device");
    expect(agentRegistry.runtime.backendRole).toBe("primary");
    expect(agentRegistry.runtime.openAiPolicy).toBe("backend_controlled");
    expect(models.models.profiler).toBe("google/gemma-3-4b-it");
    expect(models.models.orchestratorMedium).toBe("google/gemma-3-4b-it");
    expect(models.models.orchestratorLarge).toBe("Qwen/Qwen3-8B");
    expect(models.models.orchestratorPro).toBe("Qwen/Qwen3-14B");
    expect(models.models.aligner).toBe("google/gemma-3-4b-it");
    expect(models.models.embedding).toBe("shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF");
    expect(models.models.summarizer).toBe("google/gemma-3-4b-it");
    expect(agentRegistry.agents.profiler.enabled).toBe(true);
    expect(agentRegistry.agents.orchestrator.enabled).toBe(true);
    expect(agentRegistry.agents.alignment.enabled).toBe(true);
    expect(agentRegistry.agents.memory.enabled).toBe(true);
    expect(agentRegistry.agents.memory.summarizerModelKey).toBe("summarizer");
  });
});

describe("local orchestrator and alignment", () => {
  beforeEach(() => {
    resetNativeInferenceSafetyForTests();
    setNativeOnDeviceModelBridgeForTests(null);
    __idleQueueTestUtils.clear();
    __resetAsyncStorageMock();
    mockedState.files.clear();
    mockedState.directories = new Set(["file:///mock", "file:///mock/data"]);
    mockedState.fetchQueue.length = 0;
    vi.clearAllMocks();
    mockedState.files.set(
      `${dataRoot}/config/orchestrator_routes.json`,
      JSON.stringify(orchestratorRoutes, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/alignment_rules.json`,
      JSON.stringify(alignmentRules, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/prompts.json`,
      JSON.stringify(prompts, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/profiler_slots.json`,
      JSON.stringify(profilerSlots, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/memory_rules.json`,
      JSON.stringify(memoryRules, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          // Tests use the explicit development-only local adapter so model calls use the mocked fetch queue.
          runtime: {
            ...models.runtime,
            mode: "local_adapter",
          },
          baseUrl: "http://192.168.1.23:10000/v1",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );
  });

  it("routes greetings locally with no model round-trip", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 21,
      message: "hello",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(result.route).toBe("fast_greeting");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toContain("Hari");
    expect(mockedState.fetchQueue).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("answers small talk instantly with local rules and no backend or model calls", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 211,
      message: "What are you up to ?",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(result.route).toBe("small_talk");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toBe("I'm here and ready whenever you need me.");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(mockedState.fetchQueue).toHaveLength(0);
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("ensure_models");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("profiler");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("semantic_cache");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("local_reasoner");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("alignment");
  });

  it("answers identity instantly without touching the model runtime", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 212,
      message: "who are you?",
      replyLanguage: "en",
      userProfile: { assistantName: "Elli" },
    });

    expect(result.route).toBe("identity");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toContain("Elli");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(mockedState.fetchQueue).toHaveLength(0);
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("model_readiness");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("local_reasoner");
  });

  it("answers IPL knowledge acknowledgement without touching the model runtime", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 214,
      message: "Do you know about IPL?",
      replyLanguage: "en",
    });

    expect(result.route).toBe("knowledge_ack");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toContain("Indian Premier League");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(mockedState.fetchQueue).toHaveLength(0);
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("local_reasoner");
  });

  it("returns simple wellbeing support locally with no model or backend call", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 210,
      message: "I’m feeling so tired!",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(result.route).toBe("wellbeing_support");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toContain("Take a short rest");
    expect(result.assistantText).toContain("medical professional");
    expect(mockedState.fetchQueue).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("returns setup-required locally when required model files are missing", async () => {
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          runtime: {
            ...models.runtime,
            mode: "native_on_device",
          },
          modelDelivery: {
            ...models.modelDelivery,
            mode: "download_on_first_launch",
          },
          baseUrl: "",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );

    const FileSystem = await import("expo-file-system/legacy");
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 213,
      message: "Explain recursion in simple local terms please",
      replyLanguage: "en",
    });

    expect(result.kind).toBe("cloud_consent_required");
    expect(result.route).toBe("fallback_openai");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toBe(
      "This needs backend/OpenAI help. Enable cloud fallback to answer this.",
    );
    expect(result.meta?.source).toBe("cloud_consent_required");
    expect(result.meta?.responsePath).toBe("cloud_consent_required");
    expect(result.meta?.fallback_reason).toBe("local_model_unavailable");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect((FileSystem as any).createDownloadResumable).not.toHaveBeenCalled();
    expect(__idleQueueTestUtils.pendingCount()).toBe(0);
  });

  it("returns setup-required when native diagnostics report a missing llama.cpp backend", async () => {
    setNativeOnDeviceModelBridgeForTests({
      isAvailable: vi.fn(async () => false),
      getRuntimeDiagnostics: vi.fn(async () => ({
        moduleName: "JaiOnDeviceModel",
        nativeLibraryLoaded: false,
        llamaCppBackendAvailable: false,
        speechToTextAvailable: false,
        modelRootReady: false,
        reason: "llama.cpp JNI library libjai_llama_runtime.so is not linked.",
      })),
      initialize: vi.fn(async () => ({ ok: false })),
      completeChat: vi.fn(async () => ({ text: "should not run" })),
      embedTexts: vi.fn(async () => ({ data: [{ embedding: unitEmbedding() }] })),
    });
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          runtime: {
            ...models.runtime,
            mode: "native_on_device",
          },
          modelDelivery: {
            ...models.modelDelivery,
            mode: "bundled_assets",
          },
          baseUrl: "",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 214,
      message: "Explain recursion in simple local terms please",
      replyLanguage: "en",
    });

    expect(result.kind).toBe("cloud_consent_required");
    expect(result.route).toBe("fallback_openai");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toBe(
      "This needs backend/OpenAI help. Enable cloud fallback to answer this.",
    );
    expect(result.meta?.fallback_reason).toBe("local_model_unavailable");
    expect(result.meta?.orchestratorDecision?.reason).toBe(
      "local_model_unavailable",
    );
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("routes normal general questions to backend immediately when native smoke is not verified", async () => {
    const completeChat = vi.fn(async () => ({ text: "unsafe native answer" }));
    const embedTexts = vi.fn(async () => ({ data: [{ embedding: unitEmbedding() }] }));
    setNativeOnDeviceModelBridgeForTests({
      isAvailable: vi.fn(async () => true),
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat,
      embedTexts,
    });
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          runtime: {
            ...models.runtime,
            mode: "native_on_device",
          },
          modelDelivery: {
            ...models.modelDelivery,
            mode: "bundled_assets",
          },
          baseUrl: "",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );
    apiPostMock.mockResolvedValueOnce({
      ok: true,
      item: {
        id: 900,
        intent: "assistant",
        category: "Other",
        raw_text: "Explain recursion",
        details: "Backend safe answer.",
        source: "text",
      },
      assistant: {
        text: "Backend safe answer.",
        english: "Backend safe answer.",
      },
      meta: {
        source: "backend_openai",
      },
    });

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 215,
      message: "Explain recursion in simple terms",
      replyLanguage: "en",
      userAllowedCloudFallback: true,
    });

    expect(result.route).toBe("fallback_openai");
    expect(result.source).toBe("openai_fallback");
    expect(result.assistantText).toBe("Backend safe answer.");
    expect(result.meta?.fallback_reason).toBe("local_model_unavailable");
    expect(result.meta?.original_route).toBe("native_inference_guard");
    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        message: "Explain recursion in simple terms",
        client_fallback_reason: "local_model_unavailable",
        client_original_route: "native_inference_guard",
      }),
      expect.objectContaining({ timeoutMs: 90_000 }),
    );
    expect(completeChat).not.toHaveBeenCalled();
    expect(embedTexts).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns cloud consent instead of native inference when cloud fallback is disabled", async () => {
    const completeChat = vi.fn(async () => ({ text: "unsafe native answer" }));
    const embedTexts = vi.fn(async () => ({ data: [{ embedding: unitEmbedding() }] }));
    setNativeOnDeviceModelBridgeForTests({
      isAvailable: vi.fn(async () => true),
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat,
      embedTexts,
    });
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          runtime: {
            ...models.runtime,
            mode: "native_on_device",
          },
          modelDelivery: {
            ...models.modelDelivery,
            mode: "bundled_assets",
          },
          baseUrl: "",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 216,
      message: "Explain recursion in simple terms",
      replyLanguage: "en",
      userAllowedCloudFallback: false,
    });

    expect(result.kind).toBe("cloud_consent_required");
    expect(result.meta?.fallback_reason).toBe("local_model_unavailable");
    expect(result.meta?.original_route).toBe("native_inference_guard");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(completeChat).not.toHaveBeenCalled();
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("serves semantic cache exact matches without native embeddings", async () => {
    const completeChat = vi.fn(async () => ({ text: "unsafe native answer" }));
    const embedTexts = vi.fn(async () => ({ data: [{ embedding: unitEmbedding() }] }));
    setNativeOnDeviceModelBridgeForTests({
      isAvailable: vi.fn(async () => true),
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat,
      embedTexts,
    });
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          runtime: {
            ...models.runtime,
            mode: "native_on_device",
          },
          modelDelivery: {
            ...models.modelDelivery,
            mode: "bundled_assets",
          },
          baseUrl: "",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );
    mockedState.files.set(
      `${dataRoot}/cache/semantic_cache.json`,
      JSON.stringify({
        version: 2,
        entries: [
          {
            id: "exact_safe",
            userId: 217,
            sourceQuestion: "Explain recursion",
            normalizedQuestion: "explain recursion",
            canonicalAnswer: "Recursion is when a function calls itself.",
            englishAnswer: "Recursion is when a function calls itself.",
            lastPresentedAnswer: "Recursion is when a function calls itself.",
            route: "local_answer",
            intent: "assistant",
            embedding: unitEmbedding(),
            confidence: 1,
            alignmentProfile: { replyLanguage: "en" },
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
            expiresAt: null,
          },
        ],
        hits: [],
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 217,
      message: "Explain recursion",
      replyLanguage: "en",
      userAllowedCloudFallback: true,
    });

    expect(result.route).toBe("semantic_cache");
    expect(result.assistantText).toBe("Recursion is when a function calls itself.");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(completeChat).not.toHaveBeenCalled();
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("selects reasoner models only from the selected installed tier", async () => {
    const { __assistantTestUtils } = await import("../lib/localAgents");
    const complexPrompt =
      "Design a detailed multi step offline reasoning workflow with storage choices, edge cases, testing strategy, and failure handling.";
    const selectReasoner = __assistantTestUtils.selectedReasonerModel;

    expect(
      selectReasoner(models as any, orchestratorRoutes as any, complexPrompt, 0, undefined, {
        selectedTier: "lite",
        installedModelIds: ["google/gemma-3-4b-it", "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF"],
      }),
    ).toBe("google/gemma-3-4b-it");

    expect(
      selectReasoner(models as any, orchestratorRoutes as any, complexPrompt, 0, undefined, {
        selectedTier: "standard",
        installedModelIds: ["Qwen/Qwen3-8B", "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF"],
      }),
    ).toBe("Qwen/Qwen3-8B");

    expect(
      selectReasoner(models as any, orchestratorRoutes as any, complexPrompt, 0, undefined, {
        selectedTier: "standard",
        installedModelIds: [
          "Qwen/Qwen3-8B",
          "Qwen/Qwen3-14B",
          "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF",
        ],
      }),
    ).toBe("Qwen/Qwen3-8B");

    expect(
      selectReasoner(models as any, orchestratorRoutes as any, complexPrompt, 0, undefined, {
        selectedTier: "pro",
        installedModelIds: ["Qwen/Qwen3-14B", "shahidha/Paraphrase-multilingual-MiniLM-L12-v2-GGUF"],
      }),
    ).toBe("Qwen/Qwen3-14B");
  });

  it("routes ambiguous input into a specific clarification question", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 22,
      message: "Tell me about this",
      replyLanguage: "en",
    });

    expect(result.route).toBe("clarify");
    expect(result.intent).toBe("clarify");
    expect(result.assistantText).toContain("refer");
    expect(result.meta?.orchestratorDecision?.needsClarification).toBe(true);
  });

  it("answers profile requests from local profile data", async () => {
    mockedState.files.set(
      `${dataRoot}/profiles/23/answers.json`,
      JSON.stringify(
        {
          hobbies: ["music", "travel"],
          preferred_language: "english",
        },
        null,
        2,
      ),
    );
    mockedState.files.set(
      `${dataRoot}/profiles/23/summary.json`,
      JSON.stringify({ summary: "Enjoys music and travel." }, null, 2),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 23,
      message: "What do I like?",
      replyLanguage: "en",
    });

    expect(result.route).toBe("profile");
    expect(result.assistantText).toContain("music");
    expect(result.assistantText).toContain("travel");
    expect(apiPostMock).not.toHaveBeenCalled();
  });


  it("returns semantic cache hits without calling backend", async () => {
    const embedding = unitEmbedding();
    mockedState.files.set(
      `${dataRoot}/cache/semantic_cache.json`,
      JSON.stringify(
        {
          version: 2,
          entries: [
            {
              id: "cache_28",
              userId: 28,
              sourceQuestion: "Explain local first routing",
              normalizedQuestion: "explain local first routing",
              canonicalAnswer: "Cached local answer.",
              englishAnswer: "Cached local answer.",
              lastPresentedAnswer: "Cached local answer.",
              route: "local_answer",
              intent: "assistant",
              embedding,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              expiresAt: null,
              alignmentProfile: { replyLanguage: "en", tone: "" },
            },
          ],
          hits: [],
        },
        null,
        2,
      ),
    );
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 28,
      message: "Explain local first routing",
      replyLanguage: "en",
    });

    expect(result.route).toBe("semantic_cache");
    expect(result.cacheHit).toBe(true);
    expect(result.assistantText).toBe("Cached local answer.");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(mockedState.fetchQueue).toHaveLength(0);
  });

  it("answers from synced global knowledge before full local model inference", async () => {
    await AsyncStorage.setItem(
      "global_knowledge_cache_v1",
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "global_1",
            canonicalQuestion: "Explain local first routing",
            normalizedQuestion: "explain local first routing",
            answer: "Global synced answer.",
            answerLanguage: "en",
            topic: "local_agents",
            embedding: [],
            embeddingNorm: 0,
            confidence: 0.95,
            safetyLabel: "general",
            updatedAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 281,
      message: "Explain local first routing",
      replyLanguage: "en",
      requestId: "global-cache-test",
    });

    expect(result.route).toBe("global_knowledge_cache");
    expect(result.source).toBe("global_rag");
    expect(result.cacheHit).toBe(true);
    expect(result.assistantText).toBe("Global synced answer.");
    expect(result.meta?.responsePath).toBe("global_knowledge_cache");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns a safe local error when unknown-question inference fails", async () => {
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "general_offline_chat",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    mockedState.fetchQueue.push(async () => {
      throw new Error("local runtime failed");
    });

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 282,
      message: "Tell me something unusual about compilers",
      replyLanguage: "en",
      requestId: "unknown-safe-error",
    });

    expect(result.route).toBe("local_answer");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toBe(
      "I hit a local processing error. Please try again.",
    );
    expect(result.meta?.orchestratorDecision?.reason).toBe(
      "local_processing_error",
    );
    expect(apiPostMock).not.toHaveBeenCalled();
    await expect(
      AsyncStorage.getItem("pending_local_turn_marker_v1"),
    ).resolves.toBeNull();
  });

  it("routes weather through the live-data tool path", async () => {
    queueJsonResponse({
      results: [
        {
          name: "Chennai",
          country: "India",
          latitude: 13.08,
          longitude: 80.27,
        },
      ],
    });
    queueJsonResponse({
      current: {
        temperature_2m: 31,
        apparent_temperature: 35,
        weather_code: 1,
        wind_speed_10m: 12,
      },
    });

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 24,
      message: "What is the weather in Chennai?",
      replyLanguage: "en",
    });

    expect(result.route).toBe("weather");
    expect(result.assistantText).toContain("Chennai");
    expect(result.meta?.orchestratorDecision?.needsLiveData).toBe(true);
    expect(result.meta?.tools?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          tool: "getWeather",
          source: "open-meteo",
        }),
      ]),
    );
    expect(result.meta?.tools?.sourceLabels).toContain("weather");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("routes reminder creation through the typed reminder tool", async () => {
    queueCompletion(
      JSON.stringify({
        title: "Call Sam",
        details: "Call Sam",
        datetime_text: "tomorrow at 9 AM",
        assistant_reply: "Okay, I can set a reminder for Call Sam tomorrow at 9 AM.",
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 241,
      message: "Remind me to call Sam tomorrow at 9 AM",
      replyLanguage: "en",
    });

    expect(result.route).toBe("reminder_create");
    expect(result.intent).toBe("reminder");
    expect(result.title).toBe("Call Sam");
    expect(result.datetimeText).toBe("tomorrow at 9 AM");
    expect(result.meta?.tools?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          tool: "createReminder",
          source: "local_reminder_parser",
        }),
      ]),
    );
    expect(result.meta?.tools?.sourceLabels).toContain("reminders");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("plans a day with both reminder and weather tools", async () => {
    const tomorrowIso = new Date(Date.now() + 86_400_000).toISOString();
    mockedState.files.set(
      `${dataRoot}/tasks/242.json`,
      JSON.stringify(
        [
          {
            id: "task_1",
            title: "Standup",
            details: "Team sync",
            datetimeText: "tomorrow 9 AM",
            isoDatetime: tomorrowIso,
            status: "scheduled",
            createdAt: new Date().toISOString(),
          },
        ],
        null,
        2,
      ),
    );
    queueJsonResponse({
      results: [
        {
          name: "Chennai",
          country: "India",
          latitude: 13.08,
          longitude: 80.27,
        },
      ],
    });
    queueJsonResponse({
      current: {
        temperature_2m: 30,
        apparent_temperature: 34,
        weather_code: 2,
        wind_speed_10m: 9,
      },
    });

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 242,
      message: "Plan my day tomorrow based on reminders and weather",
      replyLanguage: "en",
      userProfile: { place: "Chennai" },
    });

    expect(result.route).toBe("local_answer");
    expect(result.assistantText).toContain("Chennai");
    expect(result.assistantText).toContain("Standup");
    expect(result.meta?.tools?.plan?.complex).toBe(true);
    expect(result.meta?.tools?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, tool: "getWeather" }),
        expect.objectContaining({ ok: true, tool: "listReminders" }),
      ]),
    );
    expect(result.meta?.tools?.verification).toEqual(
      expect.objectContaining({
        cloudFallbackUsed: false,
        language: "en",
      }),
    );
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("discloses missing weather and reminder data for complex local plans", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 243,
      message: "Plan my day tomorrow based on reminders and weather",
      replyLanguage: "en",
    });

    expect(result.route).toBe("local_answer");
    expect(result.assistantText).toContain("Weather data missing");
    expect(result.assistantText).toContain("Reminder data missing");
    expect(result.meta?.tools?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: false, tool: "getWeather" }),
        expect.objectContaining({ ok: false, tool: "listReminders" }),
      ]),
    );
    expect(result.meta?.tools?.verification?.missingData.length).toBeGreaterThan(
      0,
    );
    expect(result.meta?.tools?.verification?.cloudFallbackUsed).toBe(false);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("preserves selected reply language through tool-planned answers", async () => {
    mockedState.files.set(
      `${dataRoot}/profiles/244/answers.json`,
      JSON.stringify(
        {
          occupation: "software engineer",
          industry_or_field: "technology",
        },
        null,
        2,
      ),
    );
    queueCompletion(
      JSON.stringify({
        english_answer:
          "Based on your saved profile: occupation: software engineer; industry_or_field: technology",
        final_answer:
          "உங்கள் saved profileப்படி நீங்கள் technology துறையில் software engineer.",
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 244,
      message: "What is my job?",
      replyLanguage: "ta",
    });

    expect(result.route).toBe("profile");
    expect(result.assistantText).toContain("software engineer");
    expect(result.assistantText).toContain("உங்கள்");
    expect(result.meta?.tools?.verification?.language).toBe("ta");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("routes explicit memory updates through the local memory tool", async () => {
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "memory_update_request",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 246,
      message: "Remember that project code name is JAI",
      replyLanguage: "en",
    });

    const durableFacts = JSON.parse(
      mockedState.files.get(`${dataRoot}/memory/durable_facts/246.json`) || "[]",
    );
    expect(result.route).toBe("profile");
    expect(result.assistantText).toContain("local memory");
    expect(result.meta?.tools?.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          tool: "updateMemory",
          source: "local_memory",
        }),
      ]),
    );
    expect(durableFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: "project code name is JAI",
          category: "other",
          status: "active",
        }),
      ]),
    );
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("does not call tools for general chat", async () => {
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "general_offline_chat",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueCompletion("Compilers translate source code into executable forms.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 245,
      message: "Tell me a fun fact about compilers",
      replyLanguage: "en",
    });

    expect(result.route).toBe("local_answer");
    expect(result.assistantText).toContain("Compilers");
    expect(result.meta?.tools).toBeUndefined();
    expect(result.meta?.profiler?.ran).toBe(false);
    expect(result.meta?.profiler?.source).toBe("skipped");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("profiler");
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("semantic_cache_write");
    const completionPayloads = ((global.fetch as any).mock.calls as any[])
      .map((call) => JSON.parse(String(call[1]?.body || "{}")))
      .filter((payload) => Array.isArray(payload.messages));
    expect(completionPayloads[0].max_tokens).toBe(128);
    expect(completionPayloads[1].max_tokens).toBe(256);
    expect(completionPayloads[2].max_tokens).toBe(192);
    expect(apiPostMock).not.toHaveBeenCalled();

    const pendingLabels = __idleQueueTestUtils
      .pendingJobs()
      .map((job) => job.label);
    expect(pendingLabels).toEqual(
      expect.arrayContaining([
        "orchestrator_training",
        "semantic_cache_write",
        "alignment_training",
      ]),
    );
    expect(
      mockedState.files.get(`${dataRoot}/training/captures/orchestrator.jsonl`),
    ).toBeUndefined();

    queueJsonResponse({ data: [{ embedding: unitEmbedding() }] });
    await __idleQueueTestUtils.flush();

    expect(
      mockedState.files.get(`${dataRoot}/training/captures/orchestrator.jsonl`),
    ).toContain("general_offline_chat");
    expect(
      mockedState.files.get(`${dataRoot}/training/captures/alignment.jsonl`),
    ).toContain("Compilers");
  });

  it("defers profile extraction for durable facts in normal chat", async () => {
    queueJsonResponse({ data: [{ embedding: unitEmbedding() }] });
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "general_offline_chat",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueCompletion("Carnatic music is a rich classical music tradition.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 249,
      message: "By the way, I enjoy Carnatic music.",
      replyLanguage: "en",
    });

    expect(result.route).toBe("local_answer");
    expect(result.meta?.profiler?.ran).toBe(false);
    expect(result.meta?.stageTimings || {}).not.toHaveProperty("profiler");
    expect(
      mockedState.files.get(`${dataRoot}/profiles/249/answers.json`),
    ).toBeUndefined();
    expect(__idleQueueTestUtils.pendingJobs().map((job) => job.label)).toContain(
      "deferred_profile_extraction",
    );

    queueJsonResponse({ data: [{ embedding: unitEmbedding() }] });
    queueCompletion(
      JSON.stringify({
        assistant_reply: "Noted.",
        updates: {
          hobbies: ["music"],
        },
        missing_slots: [],
        completed: false,
        confidence_by_slot: {
          hobbies: 0.86,
        },
        optional_profile_notes: [],
      }),
    );
    await __idleQueueTestUtils.flush();

    const answers = JSON.parse(
      mockedState.files.get(`${dataRoot}/profiles/249/answers.json`) || "{}",
    );
    expect(answers.hobbies).toEqual(["music"]);
  });

  it("keeps complex Lite chats on the Lite installed model", async () => {
    const complexPrompt =
      "Explain compiler optimization techniques thoroughly across parsing, intermediate representation, register allocation, runtime checks, benchmark design, and offline testing strategy for a local demo application without live data.";
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "complex_offline_reasoning",
        confidence: 0.86,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueCompletion("Lite tier answer for a complex offline prompt.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 247,
      message: complexPrompt,
      replyLanguage: "en",
    });

    const fetchPayloads = ((global.fetch as any).mock.calls as any[]).map((call) =>
      JSON.parse(String(call[1]?.body || "{}")),
    );

    expect(result.route).toBe("local_answer");
    expect(result.assistantText).toContain("Lite tier answer");
    expect(result.meta?.orchestratorDecision?.selectedModel).toBe("google/gemma-3-4b-it");
    expect(fetchPayloads[0].model).toBe("google/gemma-3-4b-it");
    expect(fetchPayloads[1].model).toBe("google/gemma-3-4b-it");
    expect(fetchPayloads.map((payload) => payload.model)).not.toContain("Qwen/Qwen3-8B");
    expect(fetchPayloads.map((payload) => payload.model)).not.toContain("Qwen/Qwen3-14B");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI only when the local reasoner explicitly requests it", async () => {
    apiPostMock.mockResolvedValueOnce({
      assistant: {
        text: "Backend answer for a live or unresolved request.",
        english: "Backend answer for a live or unresolved request.",
      },
    });
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "needs_reasoning",
        confidence: 0.78,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-14B",
        fallback_allowed: false,
      }),
    );
    queueCompletion("__OPENAI_FALLBACK__");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 25,
      message: "Help with something the local model cannot safely finish.",
      replyLanguage: "en",
      userAllowedCloudFallback: true,
      requestId: "chat-screen-request-25",
    });

    expect(result.source).toBe("openai_fallback");
    expect(result.assistantText).toContain("Backend answer");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const { BACKEND_CHAT_FALLBACK_TIMEOUT_MS } = await import("../lib/api");
    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        user_id: 25,
        message: "Help with something the local model cannot safely finish.",
        reply_language: "en",
        request_id: "chat-screen-request-25",
      }),
      { timeoutMs: BACKEND_CHAT_FALLBACK_TIMEOUT_MS },
    );
    expect(result.meta?.orchestratorDecision?.fallbackAllowed).toBe(true);
  });

  it("requires cloud consent by default for live/current data fallback", async () => {
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "current_data_required",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: true,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 251,
      message: "What is the latest news about electric vehicles?",
      replyLanguage: "en",
    });

    expect(result.kind).toBe("cloud_consent_required");
    expect(result.route).toBe("clarify");
    expect(result.source).toBe("local_rules");
    expect(result.cloudFallback).toEqual({
      kind: "cloud_consent_required",
      reason: "live_data_needed",
      localAnswerAvailable: false,
      suggestedAction: "ask_user_consent",
    });
    expect(result.meta?.cloudFallback).toEqual(result.cloudFallback);
    expect(result.meta?.orchestratorDecision?.fallbackAllowed).toBe(false);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("routes live IPL score requests to the live-data fallback policy", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 252,
      message: "latest IPL score today",
      replyLanguage: "en",
    });

    expect(result.kind).toBe("cloud_consent_required");
    expect(result.route).toBe("clarify");
    expect(result.source).toBe("local_rules");
    expect(result.cloudFallback?.reason).toBe("live_data_needed");
    expect(result.meta?.orchestratorDecision?.reason).toBe("live_data_needed");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("blocks OpenAI fallback when policy conditions are not met", async () => {
    queueCompletion(
      JSON.stringify({
        route: "fallback_openai",
        reason: "model_asked_for_backend",
        confidence: 0.55,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 26,
      message: "Please use the backend because I said so",
      replyLanguage: "en",
    });

    expect(result.route).toBe("clarify");
    expect(result.intent).toBe("clarify");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(result.meta?.orchestratorDecision?.reason).toBe(
      "openai_fallback_blocked_by_policy",
    );
  });

  it("does not hard-code cloud fallback consent in the local agent", async () => {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:url"),
    ]);
    const source = await readFile(
      fileURLToPath(new URL("../lib/localAgents.ts", import.meta.url).toString()),
      "utf8",
    );

    expect(source).not.toContain("userAllowedCloudFallback: true");
  });

  it("aligns tone and language without changing the factual English mirror", async () => {
    mockedState.files.set(
      `${dataRoot}/profiles/27/answers.json`,
      JSON.stringify(
        {
          communication_tone: "warm",
          preferred_language: "tamil",
        },
        null,
        2,
      ),
    );
    queueCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "offline_reasoning",
        confidence: 0.88,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueCompletion("Hari has a meeting at 3 PM on Tuesday.");
    queueCompletion(
      JSON.stringify({
        english_answer: "Hari has a meeting at 3 PM on Tuesday.",
        final_answer: "Hariக்கு Tuesday 3 PMக்கு meeting இருக்கு.",
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 27,
      message: "Please explain the personal note warmly",
      replyLanguage: "ta",
    });

    expect(result.route).toBe("local_answer");
    expect(result.source).toBe("local_model");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(result.englishText).toBe("Hari has a meeting at 3 PM on Tuesday.");
    expect(result.assistantText).toContain("3 PM");
    expect(
      mockedState.files.get(`${dataRoot}/conversations/27_routes.jsonl`),
    ).toContain('"route":"local_answer"');
  });

  it("runs the Profiler Agent inside normal chat when durable profile facts are detected", async () => {
    queueCompletion(
      JSON.stringify({
        assistant_reply: "Noted.",
        updates: {
          preferred_language: "english",
          occupation: "working_professional",
          industry_or_field: "technology",
        },
        missing_slots: [],
        completed: false,
        confidence_by_slot: {
          preferred_language: 0.92,
          occupation: 0.9,
          industry_or_field: 0.86,
        },
        optional_profile_notes: [],
      }),
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 29,
      message: "thanks, I prefer English and I work as a software engineer.",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    const answers = JSON.parse(
      mockedState.files.get(`${dataRoot}/profiles/29/answers.json`) || "{}",
    );
    expect(result.route).toBe("fast_greeting");
    expect(result.meta?.profiler?.ran).toBe(true);
    expect(result.meta?.stageTimings || {}).toHaveProperty("profiler");
    expect(__idleQueueTestUtils.pendingJobs().map((job) => job.label)).not.toContain(
      "deferred_profile_extraction",
    );
    expect(answers.preferred_language).toBe("english");
    expect(answers.occupation).toBe("working_professional");
    expect(answers.industry_or_field).toBe("technology");
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
