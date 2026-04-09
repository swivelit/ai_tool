import { beforeEach, describe, expect, it, vi } from "vitest";

import alignmentRules from "../data/config/alignment_rules.json";
import orchestratorRoutes from "../data/config/orchestrator_routes.json";
import prompts from "../data/config/prompts.json";

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

const apiPostMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

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
        filePath.startsWith(`${normalizeDir(path)}/`)
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
}));

vi.mock("../lib/localAgentBootstrap", () => ({
  LOCAL_AGENT_DATA_DIR: "file:///mock/data",
  ensureLocalAgentSeedData: vi.fn(async () => ({
    dataDir: "file:///mock/data",
    seedVersion: "test-seed",
  })),
}));

vi.mock("../lib/api", () => ({
  apiPost: apiPostMock,
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

const dataRoot = "file:///mock/data";

describe("local orchestrator and alignment", () => {
  beforeEach(() => {
    mockedState.files.clear();
    mockedState.directories = new Set(["file:///mock", "file:///mock/data"]);
    mockedState.fetchQueue.length = 0;
    vi.clearAllMocks();
    mockedState.files.set(
      `${dataRoot}/config/orchestrator_routes.json`,
      JSON.stringify(orchestratorRoutes, null, 2)
    );
    mockedState.files.set(
      `${dataRoot}/config/alignment_rules.json`,
      JSON.stringify(alignmentRules, null, 2)
    );
    mockedState.files.set(`${dataRoot}/config/prompts.json`, JSON.stringify(prompts, null, 2));
  });

  it("routes greetings locally with no model round-trip", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 21,
      message: "thanks",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(result.route).toBe("fast_greeting");
    expect(result.source).toBe("local_rules");
    expect(result.assistantText).toContain("Hari");
    expect(mockedState.fetchQueue).toHaveLength(0);
    expect(apiPostMock).not.toHaveBeenCalled();
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
        2
      )
    );
    mockedState.files.set(
      `${dataRoot}/profiles/23/summary.json`,
      JSON.stringify({ summary: "Enjoys music and travel." }, null, 2)
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

  it("routes weather through the live-data tool path", async () => {
    queueJsonResponse({
      results: [{ name: "Chennai", country: "India", latitude: 13.08, longitude: 80.27 }],
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
      })
    );
    queueCompletion("__OPENAI_FALLBACK__");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 25,
      message: "Help with something the local model cannot safely finish.",
      replyLanguage: "en",
    });

    expect(result.source).toBe("openai_fallback");
    expect(result.assistantText).toContain("Backend answer");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(result.meta?.orchestratorDecision?.fallbackAllowed).toBe(true);
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
      })
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
      "openai_fallback_blocked_by_policy"
    );
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
        2
      )
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
      })
    );
    queueCompletion("Hari has a meeting at 3 PM on Tuesday.");
    queueCompletion(
      JSON.stringify({
        english_answer: "Hari has a meeting at 3 PM on Tuesday.",
        final_answer: "Hariக்கு Tuesday 3 PMக்கு meeting இருக்கு.",
      })
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 27,
      message: "Please explain the personal note warmly",
      replyLanguage: "ta",
    });

    expect(result.route).toBe("local_answer");
    expect(result.englishText).toBe("Hari has a meeting at 3 PM on Tuesday.");
    expect(result.assistantText).toContain("3 PM");
    expect(mockedState.files.get(`${dataRoot}/conversations/27_routes.jsonl`)).toContain(
      "\"route\":\"local_answer\""
    );
  });
});
