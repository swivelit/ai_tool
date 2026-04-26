import { beforeEach, describe, expect, it, vi } from "vitest";
import * as FileSystem from "expo-file-system/legacy";
import models from "../data/config/models.json";

import memoryRules from "../data/config/memory_rules.json";
import orchestratorRoutes from "../data/config/orchestrator_routes.json";
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

function queueEmbeddingResponse(vectors: number[][]) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => ({
      data: vectors.map((embedding) => ({ embedding })),
    }),
  }));
}

function queueAlignmentResponse(finalAnswer: string) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              english_answer: finalAnswer,
              final_answer: finalAnswer,
            }),
          },
        },
      ],
    }),
  }));
}

function writeJson(path: string, payload: any) {
  parentDirs(path).forEach((dir) => mockedState.directories.add(dir));
  mockedState.files.set(path, JSON.stringify(payload, null, 2));
}

function writeJsonl(path: string, rows: any[]) {
  parentDirs(path).forEach((dir) => mockedState.directories.add(dir));
  mockedState.files.set(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function readJson(path: string) {
  return JSON.parse(mockedState.files.get(path) || "null");
}

function readJsonl(path: string) {
  return String(mockedState.files.get(path) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const dataRoot = "file:///mock/data";

describe("local memory and semantic cache", () => {
  beforeEach(() => {
    mockedState.files.clear();
    mockedState.directories = new Set(["file:///mock", "file:///mock/data"]);
    mockedState.fetchQueue.length = 0;
    vi.clearAllMocks();
    writeJson(`${dataRoot}/config/memory_rules.json`, memoryRules);
    writeJson(`${dataRoot}/config/orchestrator_routes.json`, orchestratorRoutes);
    writeJson(`${dataRoot}/config/profiler_slots.json`, profilerSlots);
    writeJson(`${dataRoot}/config/prompts.json`, prompts);
    writeJson(`${dataRoot}/config/models.json`, {
      ...models,
      // Tests need a non-empty, non-loopback URL so local model calls use the mocked fetch queue.
      // Production code intentionally rejects localhost/127.0.0.1 for device safety.
      baseUrl: "http://192.168.1.23:10000/v1",
      timeoutMs: 1000,
    });
  });

  it("hits the semantic cache for paraphrased profile questions", async () => {
    writeJson(`${dataRoot}/profiles/31/answers.json`, {
      hobbies: ["music", "travel"],
      preferred_language: "english",
    });
    writeJson(`${dataRoot}/profiles/31/summary.json`, { summary: "Enjoys music and travel." });

    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([[1, 0, 0]]);

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const first = await runLocalAssistantTurn({
      userId: 31,
      message: "What do I like?",
      replyLanguage: "en",
    });

    expect(first.cacheHit).toBe(false);
    expect(first.route).toBe("profile");

    queueEmbeddingResponse([[0.99, 0.01, 0]]);

    const second = await runLocalAssistantTurn({
      userId: 31,
      message: "Which hobbies do I have?",
      replyLanguage: "en",
    });

    expect(second.route).toBe("semantic_cache");
    expect(second.source).toBe("semantic_cache");
    expect(second.cacheHit).toBe(true);
    expect(second.meta?.matchedQuestion).toBe("What do I like?");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(readJson(`${dataRoot}/cache/semantic_cache.json`).hits).toHaveLength(1);
  });

  it("misses the semantic cache for unrelated questions", async () => {
    writeJson(`${dataRoot}/profiles/32/answers.json`, {
      hobbies: ["music", "travel"],
      preferred_language: "english",
      name: "Hari",
    });
    writeJson(`${dataRoot}/profiles/32/summary.json`, { summary: "Enjoys music and travel." });

    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([[1, 0, 0]]);
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 32,
      message: "What do I like?",
      replyLanguage: "en",
    });

    queueEmbeddingResponse([[0, 1, 0]]);
    queueAlignmentResponse("Your name is Hari.");
    queueEmbeddingResponse([[0, 1, 0]]);
    const second = await runLocalAssistantTurn({
      userId: 32,
      message: "What is my name?",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(second.route).toBe("profile");
    expect(second.cacheHit).toBe(false);
    expect(second.source).not.toBe("semantic_cache");
  });

  it("respects the similarity threshold around borderline matches", async () => {
    writeJson(`${dataRoot}/config/memory_rules.json`, {
      ...memoryRules,
      cache: {
        ...memoryRules.cache,
        similarityThreshold: 0.95,
      },
    });
    writeJson(`${dataRoot}/profiles/33/answers.json`, {
      hobbies: ["music", "travel"],
      preferred_language: "english",
    });
    writeJson(`${dataRoot}/profiles/33/summary.json`, { summary: "Enjoys music and travel." });

    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([[1, 0, 0]]);
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 33,
      message: "What do I like?",
      replyLanguage: "en",
    });

    queueEmbeddingResponse([[0.93, 0.3675595, 0]]);
    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([[0.93, 0.3675595, 0]]);
    const borderline = await runLocalAssistantTurn({
      userId: 33,
      message: "What do I like again?",
      replyLanguage: "en",
    });

    expect(borderline.route).toBe("profile");
    expect(borderline.cacheHit).toBe(false);
  });

  it("extracts durable facts from recent conversation logs", async () => {
    writeJsonl(`${dataRoot}/conversations/41.jsonl`, [
      { role: "user", content: "I work as a software engineer.", createdAt: "2026-04-09T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", createdAt: "2026-04-09T10:00:05.000Z" },
      { role: "user", content: "I prefer English replies and I enjoy music.", createdAt: "2026-04-09T10:01:00.000Z" },
      { role: "assistant", content: "Understood.", createdAt: "2026-04-09T10:01:05.000Z" },
    ]);
    writeJson(`${dataRoot}/profiles/41/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {},
      history: [],
    });

    const { consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    const result = await consolidateLocalMemoryOnIdle(41, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    expect(result.ok).toBe(true);
    const facts = readJson(`${dataRoot}/memory/durable_facts/41.json`) as Array<{ fact: string }>;
    expect(facts.map((row) => row.fact).join(" ")).toContain("Occupation: software engineer");
    expect(facts.map((row) => row.fact).join(" ")).toContain("Preference: English replies and I enjoy music");
  });

  it("updates the local profile conservatively from new durable user facts", async () => {
    writeJson(`${dataRoot}/profiles/42/answers.json`, {
      preferred_language: "",
      occupation: "",
      industry_or_field: "",
    });
    writeJson(`${dataRoot}/profiles/42/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {
        preferred_language: 0,
        occupation: 0,
        industry_or_field: 0,
      },
      history: [],
    });
    writeJsonl(`${dataRoot}/conversations/42.jsonl`, [
      { role: "user", content: "I prefer English and I work as a software engineer.", createdAt: "2026-04-09T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", createdAt: "2026-04-09T10:00:05.000Z" },
      { role: "user", content: "Music helps me focus.", createdAt: "2026-04-09T10:01:00.000Z" },
      { role: "assistant", content: "Understood.", createdAt: "2026-04-09T10:01:05.000Z" },
    ]);

    const { consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    const result = await consolidateLocalMemoryOnIdle(42, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    expect(result.ok).toBe(true);
    const answers = readJson(`${dataRoot}/profiles/42/answers.json`);
    expect(answers.preferred_language).toBe("english");
    expect(answers.occupation).toBe("working_professional");
    expect(answers.industry_or_field).toBe("technology");
  });

  it("persists all memory consolidation artifacts into the phone workspace", async () => {
    writeJson(`${dataRoot}/profiles/43/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {},
      history: [],
    });
    writeJsonl(`${dataRoot}/conversations/43.jsonl`, [
      { role: "user", content: "I prefer English.", createdAt: "2026-04-09T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", createdAt: "2026-04-09T10:00:05.000Z" },
      { role: "user", content: "I work as a software engineer.", createdAt: "2026-04-09T10:01:00.000Z" },
      { role: "assistant", content: "Understood.", createdAt: "2026-04-09T10:01:05.000Z" },
    ]);
    writeJsonl(`${dataRoot}/conversations/43_routes.jsonl`, [
      {
        createdAt: "2026-04-09T10:01:05.000Z",
        message: "I work as a software engineer.",
        decision: { route: "profile" },
      },
    ]);

    const { consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    await consolidateLocalMemoryOnIdle(43, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    expect(readJsonl(`${dataRoot}/memory/daily_summaries/43.jsonl`)).toHaveLength(1);
    expect(readJson(`${dataRoot}/memory/durable_facts/43.json`)).toBeTruthy();
    expect(readJsonl(`${dataRoot}/memory/profile_updates/43.jsonl`)).toHaveLength(1);
    expect(readJson(`${dataRoot}/rag/runtime/43_memory_chunks.json`)).toBeTruthy();
    expect(readJsonl(`${dataRoot}/training/captures/memory.jsonl`)).toHaveLength(1);
  });

  it("skips idle memory consolidation entirely when the last attempt was recent", async () => {
    writeJson(`${dataRoot}/config/memory_rules.json`, {
      ...memoryRules,
      summarization: {
        ...memoryRules.summarization,
        minTurnsBeforeSync: 1,
      },
    });

    queueEmbeddingResponse([[1, 0, 0]]);
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 45,
      message: "this",
      replyLanguage: "en",
    });
    await runLocalAssistantTurn({
      userId: 45,
      message: "that",
      replyLanguage: "en",
    });

    expect(readJsonl(`${dataRoot}/memory/daily_summaries/45.jsonl`)).toHaveLength(1);
    const dailySummaryReads = (FileSystem.readAsStringAsync as any).mock.calls.filter(
      ([path]: [string]) => path === `${dataRoot}/memory/daily_summaries/45.jsonl`
    );
    expect(dailySummaryReads).toHaveLength(0);
  });

  it("does not use OpenAI when local cache or memory can answer", async () => {
    writeJson(`${dataRoot}/profiles/44/answers.json`, {
      preferred_language: "english",
      hobbies: ["music", "travel"],
    });
    writeJson(`${dataRoot}/profiles/44/summary.json`, {
      summary: "Prefers English and enjoys music and travel.",
    });

    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([[1, 0, 0]]);
    const { runLocalAssistantTurn, consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 44,
      message: "What do I like?",
      replyLanguage: "en",
    });

    queueEmbeddingResponse([[0.99, 0.01, 0]]);
    const cached = await runLocalAssistantTurn({
      userId: 44,
      message: "Which hobbies do I have?",
      replyLanguage: "en",
    });

    writeJsonl(`${dataRoot}/conversations/44.jsonl`, [
      { role: "user", content: "I prefer English.", createdAt: "2026-04-09T10:00:00.000Z" },
      { role: "assistant", content: "Noted.", createdAt: "2026-04-09T10:00:05.000Z" },
    ]);
    await consolidateLocalMemoryOnIdle(44, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    expect(cached.cacheHit).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
