import { beforeEach, describe, expect, it, vi } from "vitest";
import models from "../data/config/models.json";
import profilerSlots from "../data/config/profiler_slots.json";
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
      Array.from(mockedState.files.keys()).some((filePath) => filePath.startsWith(`${normalizeDir(path)}/`)),
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
  apiPost: vi.fn(async () => ({ ok: true })),
}));

global.fetch = vi.fn(async () => {
  const next = mockedState.fetchQueue.shift();
  if (!next) {
    throw new Error("Unexpected fetch");
  }
  return next();
}) as any;

function queueChatResponse(content: string) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  }));
}

function queueEmbeddingFailure() {
  mockedState.fetchQueue.push(async () => {
    throw new Error("embedding unavailable");
  });
}

function readJson(path: string) {
  return JSON.parse(mockedState.files.get(path) || "null");
}

const dataRoot = "file:///mock/data";

describe("local profiler", () => {
  beforeEach(() => {
    mockedState.files.clear();
    mockedState.directories = new Set(["file:///mock", "file:///mock/data"]);
    mockedState.fetchQueue.length = 0;
    vi.clearAllMocks();
    mockedState.files.set(
      `${dataRoot}/config/profiler_slots.json`,
      JSON.stringify(profilerSlots, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/prompts.json`,
      JSON.stringify(prompts, null, 2),
    );
    mockedState.files.set(
      `${dataRoot}/config/models.json`,
      JSON.stringify(
        {
          ...models,
          runtime: { ...models.runtime, mode: "local_adapter" },
          baseUrl: "http://192.168.1.23:10000/v1",
          timeoutMs: 1000,
        },
        null,
        2,
      ),
    );
  });

  it("starts the profiler and persists state", async () => {
    queueChatResponse("Hey Hari, tell me a little about yourself.");

    const { startProfilerOnPhone } = await import("../lib/localAgents");
    const result = await startProfilerOnPhone(7, {
      replyLanguage: "en",
      userProfile: { name: "Hari", assistantName: "Elli" },
    });

    expect(result.history[0]?.content).toContain("Hari");
    expect(result.totalSlots).toBe(8);
    expect(readJson(`${dataRoot}/profiles/7/profiler_state.json`).status).toBe("active");
    expect(mockedState.files.get(`${dataRoot}/conversations/7.jsonl`)).toContain("assistant");
  });

  it("extracts structured updates from free-form replies with deterministic fallback", async () => {
    queueChatResponse("Tell me a little about yourself.");

    const { startProfilerOnPhone, sendProfilerMessageOnPhone } = await import("../lib/localAgents");
    await startProfilerOnPhone(8, {
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    mockedState.fetchQueue.push(async () => {
      throw new Error("model unavailable");
    });

    const result = await sendProfilerMessageOnPhone(
      8,
      "I prefer English, I work as a software engineer, and I enjoy music and travel.",
      { replyLanguage: "en", userProfile: { name: "Hari" } }
    );

    expect(result.answers.preferred_language).toBe("english");
    expect(result.answers.occupation).toBe("working_professional");
    expect(result.answers.industry_or_field).toBe("technology");
    expect(result.answers.hobbies).toEqual(expect.arrayContaining(["music", "travel"]));
    expect(readJson(`${dataRoot}/profiles/8/profiler_state.json`).confidenceBySlot.preferred_language).toBeGreaterThan(0.7);
  });

  it("recovers from malformed model JSON by falling back to deterministic extraction", async () => {
    queueChatResponse("Tell me a little about yourself.");

    const { startProfilerOnPhone, sendProfilerMessageOnPhone } = await import("../lib/localAgents");
    await startProfilerOnPhone(9, { replyLanguage: "en" });

    queueChatResponse("{ definitely not valid profiler json");

    const result = await sendProfilerMessageOnPhone(9, "Please use English and keep it direct.", {
      replyLanguage: "en",
    });

    expect(result.answers.preferred_language).toBe("english");
    expect(result.answers.communication_tone).toBe("short_direct");
    expect(readJson(`${dataRoot}/profiles/9/profiler_state.json`).lastRunSource).toBe("fallback");
  });

  it("completes after starter profile slots and writes summary plus rag artifacts", async () => {
    const { getLocalAgentWorkspaceInfo, sendProfilerMessageOnPhone } = await import("../lib/localAgents");
    const workspace = await getLocalAgentWorkspaceInfo();
    expect(workspace.slots).toHaveLength(16);

    const prefilledAnswers = {
      preferred_language: "english",
      age_group: "26_35",
      occupation: "working_professional",
      communication_tone: "short_direct",
      answer_length: "short",
      assistant_persona: "coach",
      main_goal: "career_growth",
    };

    mockedState.files.set(`${dataRoot}/profiles/10/answers.json`, JSON.stringify(prefilledAnswers, null, 2));
    mockedState.files.set(
      `${dataRoot}/profiles/10/profiler_state.json`,
      JSON.stringify(
        {
          status: "active",
          currentTargetSlot: "dislikes",
          confidenceBySlot: Object.fromEntries(Object.keys(prefilledAnswers).map((key) => [key, 0.9])),
          history: [],
        },
        null,
        2
      )
    );

    mockedState.fetchQueue.push(async () => {
      throw new Error("model unavailable");
    });
    mockedState.fetchQueue.push(async () => {
      throw new Error("summary unavailable");
    });
    queueEmbeddingFailure();

    const result = await sendProfilerMessageOnPhone(10, "Too many questions and too generic.", {
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(result.done).toBe(true);
    expect(result.totalSlots).toBe(8);
    expect(result.answers.dislikes).toEqual(expect.arrayContaining(["too_many_questions", "too_generic"]));
    expect(result.answers.work_rhythm).toBeUndefined();
    expect(result.assistantReply).toContain("starter profile is ready");
    expect(readJson(`${dataRoot}/profiles/10/summary.json`).summary).toContain("career_growth");
    expect(readJson(`${dataRoot}/profiles/10/summary.json`).summary).toContain("Age group: 26_35");
    expect(readJson(`${dataRoot}/profiles/10/profiler_state.json`).currentTargetSlot).toBeUndefined();
    expect(readJson(`${dataRoot}/rag/runtime/10_profile_rag.json`).chunks.length).toBeGreaterThan(0);
    expect(readJson(`${dataRoot}/rag/runtime/10_chunks.json`).some((row: any) => row.sourceType === "profile")).toBe(true);
  });

  it("does not append late answers or duplicate ready messages after completion", async () => {
    const { sendProfilerMessageOnPhone } = await import("../lib/localAgents");
    const completedAnswers = {
      preferred_language: "english",
      age_group: "26_35",
      occupation: "working_professional",
      communication_tone: "short_direct",
      answer_length: "short",
      assistant_persona: "coach",
      main_goal: "career_growth",
      dislikes: ["too_many_questions"],
    };
    mockedState.files.set(`${dataRoot}/profiles/20/answers.json`, JSON.stringify(completedAnswers, null, 2));
    mockedState.files.set(
      `${dataRoot}/profiles/20/profiler_state.json`,
      JSON.stringify(
        {
          status: "complete",
          currentTargetSlot: "work_rhythm",
          missingSlots: [],
          confidenceBySlot: {},
          history: [
            { role: "assistant", content: "Perfect. Your starter profile is ready. I’ll keep learning naturally as we chat.", createdAt: "1" },
          ],
        },
        null,
        2
      )
    );

    const result = await sendProfilerMessageOnPhone(20, "Afternoon", {
      replyLanguage: "en",
    });

    expect(result.done).toBe(true);
    expect(result.history.some((message) => message.role === "user" && message.content === "Afternoon")).toBe(false);
    expect(result.history.filter((message) => message.content.includes("starter profile is ready"))).toHaveLength(1);
    expect(mockedState.files.get(`${dataRoot}/conversations/20.jsonl`) || "").not.toContain("Afternoon");
  });

  it("keeps setup short after too_many_questions and does not ask optional work rhythm", async () => {
    const { sendProfilerMessageOnPhone } = await import("../lib/localAgents");
    const prefilledAnswers = {
      preferred_language: "english",
      age_group: "26_35",
      occupation: "working_professional",
      communication_tone: "short_direct",
      answer_length: "short",
      assistant_persona: "coach",
    };
    mockedState.files.set(`${dataRoot}/profiles/21/answers.json`, JSON.stringify(prefilledAnswers, null, 2));
    mockedState.files.set(
      `${dataRoot}/profiles/21/profiler_state.json`,
      JSON.stringify(
        {
          status: "active",
          currentTargetSlot: "dislikes",
          missingSlots: ["main_goal", "dislikes"],
          confidenceBySlot: {},
          history: [],
        },
        null,
        2
      )
    );
    mockedState.fetchQueue.push(async () => {
      throw new Error("model unavailable");
    });

    const result = await sendProfilerMessageOnPhone(21, "Too many questions.", {
      replyLanguage: "en",
    });

    expect(result.done).toBe(false);
    expect(result.assistantReply).toContain("I’ll keep setup short");
    expect(result.assistantReply).toContain("Last quick setup question");
    expect(result.assistantReply).toContain("What matters most");
    expect(result.assistantReply).not.toContain("active or available");
    expect(result.missingSlots).toEqual(["main_goal"]);
  });

  it("answers local life-context questions from provided context", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");

    const result = await runLocalAssistantTurn({
      userId: 11,
      message: "How much did I walk today and how long did I use my phone?",
      replyLanguage: "en",
      lifeContext: {
        enabled: true,
        date: "2026-05-28",
        movementSummary: "7,420 steps, about 5.7 km walked (high confidence)",
        screenSummary: "3.5 hours phone screen/app time today (high confidence)",
        shareAppNamesWithAi: false,
        raw: {
          date: "2026-05-28",
          timezone: "Asia/Kolkata",
          permissions: {
            activityRecognition: "granted",
            usageAccess: "granted",
          },
          movement: {
            steps: 7420,
            estimatedDistanceMeters: 5650,
            confidence: "high",
            source: "e2e_mock",
          },
          screen: {
            screenTimeMs: 12600000,
            unlocks: null,
            confidence: "high",
            source: "e2e_mock",
          },
          apps: [],
          generatedAt: "2026-05-28T00:00:00.000Z",
        },
      },
    });

    expect(result.route).toBe("local_answer");
    expect(result.meta?.responsePath).toBe("life_context");
    expect(result.assistantText).toContain("7,420 steps");
    expect(result.assistantText).toContain("5.7 km");
    expect(result.assistantText).toContain("3.5 hours");
    expect(result.assistantText).toContain("foreground screen/app usage");
  });

  it("answers Tamil/Tanglish local life-context questions", async () => {
    const { runLocalAssistantTurn } = await import("../lib/localAgents");

    const result = await runLocalAssistantTurn({
      userId: 12,
      message: "இன்று நான் எவ்வளவு நடந்தேன்? phone evlo neram use panninen?",
      replyLanguage: "ta",
      lifeContext: {
        enabled: true,
        date: "2026-05-28",
        movementSummary: "7,420 steps today (74% of daily goal), ~5.7 km walked (high confidence)",
        screenSummary: "3.5 hours screen time today (healthy, high confidence)",
        topAppsSummary: "Top apps: productivity 1.2 hours (mostly productivity)",
        shareAppNamesWithAi: false,
        raw: {
          date: "2026-05-28",
          timezone: "Asia/Kolkata",
          permissions: {
            activityRecognition: "granted",
            usageAccess: "granted",
          },
          movement: {
            steps: 7420,
            estimatedDistanceMeters: 5650,
            confidence: "high",
            source: "e2e_mock",
          },
          screen: {
            screenTimeMs: 12600000,
            unlocks: null,
            confidence: "high",
            source: "e2e_mock",
          },
          apps: [{ category: "productivity", foregroundTimeMs: 4200000 }],
          generatedAt: "2026-05-28T00:00:00.000Z",
        },
      },
    });

    expect(result.route).toBe("local_answer");
    expect(result.meta?.responsePath).toBe("life_context");
    expect(result.assistantText).toContain("7,420 steps");
    expect(result.assistantText).toContain("3.5 hours");
    expect(result.assistantText).toContain("exact gaze tracking illa");
  });
});
