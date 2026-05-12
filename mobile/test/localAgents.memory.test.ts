import { beforeEach, describe, expect, it, vi } from "vitest";
import * as FileSystem from "expo-file-system/legacy";
import models from "../data/config/models.json";

import memoryRules from "../data/config/memory_rules.json";
import orchestratorRoutes from "../data/config/orchestrator_routes.json";
import profilerSlots from "../data/config/profiler_slots.json";
import prompts from "../data/config/prompts.json";
import { __idleQueueTestUtils } from "../lib/localIdleQueue";

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
  apiPostBackendOnly: apiPostMock,
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

function testEmbedding(values: Record<number, number>) {
  const vector = Array.from({ length: 1024 }, () => 0);
  Object.entries(values).forEach(([index, value]) => {
    vector[Number(index)] = value;
  });
  return vector;
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

function queueChatCompletion(content: string) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
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

async function flushLocalLearningJobs() {
  const { flushLocalLearningJobsForTests } = await import("../lib/localAgents");
  await flushLocalLearningJobsForTests();
}

describe("local memory and semantic cache", () => {
  beforeEach(() => {
    __idleQueueTestUtils.clear();
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
      runtime: { ...models.runtime, mode: "local_adapter" },
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
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const first = await runLocalAssistantTurn({
      userId: 31,
      message: "What do I like?",
      replyLanguage: "en",
    });

    expect(first.cacheHit).toBe(false);
    expect(first.route).toBe("profile");
    await flushLocalLearningJobs();

    queueEmbeddingResponse([testEmbedding({ 0: 0.99, 1: 0.01 })]);

    const second = await runLocalAssistantTurn({
      userId: 31,
      message: "Which hobbies do I have?",
      replyLanguage: "en",
    });

    expect(second.route).toBe("semantic_cache");
    expect(second.source).toBe("semantic_cache");
    expect(second.cacheHit).toBe(true);
    expect(second.meta?.matchedQuestion).toBe("What do I like?");
    expect(second.meta?.semanticCache?.confidence).toBeGreaterThanOrEqual(0.92);
    expect(apiPostMock).not.toHaveBeenCalled();
    await flushLocalLearningJobs();
    expect(readJson(`${dataRoot}/cache/semantic_cache.json`).hits).toHaveLength(1);
  });

  it("returns source-aware RAG metadata and prefers fresher time-sensitive chunks", async () => {
    writeJson(`${dataRoot}/rag/runtime/340_chunks.json`, [
      {
        id: "policy_old_0",
        sourceId: "policy-old",
        sourceType: "doc",
        text: "Old forecast note: expect rain tomorrow.",
        embedding: testEmbedding({ 0: 1 }),
        metadata: {
          source_name: "Old forecast",
          path: "/notes/weather-old.md",
          category: "weather",
          freshness_date: "2026-01-01T00:00:00.000Z",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "policy_new_0",
        sourceId: "policy-new",
        sourceType: "doc",
        text: "Fresh forecast note: expect clear skies tomorrow.",
        embedding: testEmbedding({ 0: 1 }),
        metadata: {
          source_name: "Fresh forecast",
          path: "/notes/weather-new.md",
          category: "weather",
          freshness_date: "2026-04-28T00:00:00.000Z",
        },
        updatedAt: "2026-04-28T00:00:00.000Z",
      },
    ]);
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);

    const { searchLocalRag } = await import("../lib/localAgents");
    const hits = await searchLocalRag(340, "weather tomorrow", 2);

    expect(hits[0]).toEqual(
      expect.objectContaining({
        source_name: "Fresh forecast",
        chunk_id: "policy_new_0",
        path: "/notes/weather-new.md",
        category: "weather",
        freshness_date: "2026-04-28T00:00:00.000Z",
        confidence: expect.any(Number),
        score: expect.any(Number),
      }),
    );
    expect(hits[0].sourceMetadata).toEqual(
      expect.objectContaining({
        source_name: "Fresh forecast",
        chunk_id: "policy_new_0",
        relevance_score: expect.any(Number),
      }),
    );
  });

  it("filters stale RAG chunks for time-sensitive retrieval", async () => {
    writeJson(`${dataRoot}/rag/runtime/341_chunks.json`, [
      {
        id: "stale_weather",
        sourceId: "weather-cache",
        sourceType: "doc",
        text: "Stale weather: heavy rain now.",
        embedding: testEmbedding({ 0: 1 }),
        metadata: {
          source_name: "Expired weather cache",
          category: "weather",
          expires_at: "2026-01-01T00:00:00.000Z",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "fresh_weather",
        sourceId: "weather-note",
        sourceType: "doc",
        text: "Fresh weather note: clear today.",
        embedding: testEmbedding({ 0: 1 }),
        metadata: {
          source_name: "Fresh weather note",
          category: "weather",
          freshness_date: "2026-04-28T00:00:00.000Z",
        },
        updatedAt: "2026-04-28T00:00:00.000Z",
      },
    ]);
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);

    const { searchLocalRag } = await import("../lib/localAgents");
    const hits = await searchLocalRag(341, "current weather today", 5);

    expect(hits.map((hit) => hit.chunk_id)).toEqual(["fresh_weather"]);
  });

  it("includes used RAG sources in assistant response metadata", async () => {
    writeJson(`${dataRoot}/rag/runtime/342_chunks.json`, [
      {
        id: "handbook_0",
        sourceId: "handbook",
        sourceType: "doc",
        text: "The handbook says remote work needs manager approval.",
        embedding: testEmbedding({ 0: 1 }),
        metadata: {
          source_name: "Employee handbook",
          path: "/docs/handbook.md",
          category: "work",
          freshness_date: "2026-04-20T00:00:00.000Z",
        },
        updatedAt: "2026-04-20T00:00:00.000Z",
      },
    ]);
    queueChatCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "offline_reasoning",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);
    queueChatCompletion("Based on the handbook, ask your manager first.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 342,
      message: "What does the handbook say about remote work?",
      replyLanguage: "en",
    });

    expect(result.route).toBe("local_answer");
    expect(result.meta?.rag?.usedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_name: "Employee handbook",
          chunk_id: "handbook_0",
          path: "/docs/handbook.md",
          category: "work",
        }),
      ]),
    );
    expect(result.meta?.sources).toEqual(result.meta?.rag?.usedSources);
  });

  it("rewrites follow-up RAG queries using recent context", async () => {
    writeJsonl(`${dataRoot}/conversations/343.jsonl`, [
      {
        role: "user",
        content: "What does the policy say about Chennai office visits?",
        createdAt: "2026-04-28T09:00:00.000Z",
      },
      {
        role: "assistant",
        content: "It says to check the office schedule.",
        createdAt: "2026-04-28T09:00:05.000Z",
      },
    ]);
    writeJson(`${dataRoot}/rag/runtime/343_chunks.json`, [
      {
        id: "policy_0",
        sourceId: "office-policy",
        sourceType: "doc",
        text: "Tomorrow's Chennai office visit requires badge access.",
        embedding: testEmbedding({ 0: 1 }),
        metadata: {
          source_name: "Office policy",
          path: "/docs/office-policy.md",
          category: "office",
        },
        updatedAt: "2026-04-28T00:00:00.000Z",
      },
    ]);
    queueChatCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "offline_reasoning",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);
    queueChatCompletion("Tomorrow's visit needs badge access.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 343,
      message: "what about tomorrow for the same policy",
      replyLanguage: "en",
    });

    expect(result.route).toBe("local_answer");
    expect(result.meta?.rag?.rewrittenQuery).toContain(
      "What does the policy say about Chennai office visits?",
    );
    expect(result.meta?.rag?.rewrittenQuery).toContain("what about tomorrow");
  });

  it("normalizes unexpected provider embedding dimensions before storing cache entries", async () => {
    writeJson(`${dataRoot}/profiles/310/answers.json`, {
      hobbies: ["music"],
      preferred_language: "english",
    });
    writeJson(`${dataRoot}/profiles/310/summary.json`, { summary: "Enjoys music." });

    queueAlignmentResponse("You told me your hobbies include music.");
    queueEmbeddingResponse([[1, 0, 0]]);

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 310,
      message: "What do I like?",
      replyLanguage: "en",
    });
    await flushLocalLearningJobs();

    const store = readJson(`${dataRoot}/cache/semantic_cache.json`);
    expect(store.entries[0].embedding).toHaveLength(1024);
  });

  it("clears one user's semantic cache data without corrupting the shared store", async () => {
    writeJson(`${dataRoot}/cache/semantic_cache.json`, {
      version: 2,
      entries: [
        {
          id: "31_a",
          userId: 31,
          sourceQuestion: "What do I like?",
          normalizedQuestion: "what do i like",
          canonicalAnswer: "Music",
          englishAnswer: "Music",
          route: "profile",
          intent: "assistant",
          embedding: testEmbedding({ 0: 1 }),
          createdAt: "2026-04-26T00:00:00Z",
          updatedAt: "2026-04-26T00:00:00Z",
          expiresAt: null,
        },
        {
          id: "99_a",
          userId: 99,
          sourceQuestion: "What is my name?",
          normalizedQuestion: "what is my name",
          canonicalAnswer: "Hari",
          englishAnswer: "Hari",
          route: "profile",
          intent: "assistant",
          embedding: testEmbedding({ 1: 1 }),
          createdAt: "2026-04-26T00:00:00Z",
          updatedAt: "2026-04-26T00:00:00Z",
          expiresAt: null,
        },
      ],
      hits: [
        {
          userId: 31,
          sourceQuestion: "What do I like?",
          matchedQuestion: "Which hobbies do I have?",
          similarity: 0.99,
          timestamp: "2026-04-26T00:00:00Z",
          alignmentReapplied: false,
          route: "profile",
        },
        {
          userId: 99,
          sourceQuestion: "What is my name?",
          matchedQuestion: "Tell me my name",
          similarity: 0.98,
          timestamp: "2026-04-26T00:00:00Z",
          alignmentReapplied: false,
          route: "profile",
        },
      ],
    });

    const { clearLocalAgentDataForUser } = await import("../lib/localAgents");
    await clearLocalAgentDataForUser(31);

    const store = readJson(`${dataRoot}/cache/semantic_cache.json`);
    expect(store.version).toBe(2);
    expect(store.entries.map((row: any) => row.userId)).toEqual([99]);
    expect(store.hits.map((row: any) => row.userId)).toEqual([99]);
  });

  it("misses the semantic cache for unrelated questions", async () => {
    writeJson(`${dataRoot}/profiles/32/answers.json`, {
      hobbies: ["music", "travel"],
      preferred_language: "english",
      name: "Hari",
    });
    writeJson(`${dataRoot}/profiles/32/summary.json`, { summary: "Enjoys music and travel." });

    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 32,
      message: "What do I like?",
      replyLanguage: "en",
    });
    await flushLocalLearningJobs();

    queueEmbeddingResponse([testEmbedding({ 1: 1 })]);
    queueAlignmentResponse("Your name is Hari.");
    queueEmbeddingResponse([testEmbedding({ 1: 1 })]);
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
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 33,
      message: "What do I like?",
      replyLanguage: "en",
    });
    await flushLocalLearningJobs();

    queueEmbeddingResponse([testEmbedding({ 0: 0.93, 1: 0.3675595 })]);
    queueAlignmentResponse("You told me your hobbies include music, travel.");
    queueEmbeddingResponse([testEmbedding({ 0: 0.93, 1: 0.3675595 })]);
    const borderline = await runLocalAssistantTurn({
      userId: 33,
      message: "What do I like again?",
      replyLanguage: "en",
    });

    expect(borderline.route).toBe("profile");
    expect(borderline.cacheHit).toBe(false);
  });

  it("rejects low-confidence exact semantic cache entries", async () => {
    writeJson(`${dataRoot}/cache/semantic_cache.json`, {
      version: 2,
      entries: [
        {
          id: "low_conf",
          userId: 344,
          sourceQuestion: "What is my name?",
          normalizedQuestion: "what is my name",
          canonicalAnswer: "Cached low confidence name.",
          englishAnswer: "Cached low confidence name.",
          lastPresentedAnswer: "Cached low confidence name.",
          route: "profile",
          intent: "assistant",
          embedding: testEmbedding({ 0: 1 }),
          confidence: 0.5,
          createdAt: "2026-04-26T00:00:00Z",
          updatedAt: "2026-04-26T00:00:00Z",
          expiresAt: null,
        },
      ],
      hits: [],
    });
    queueAlignmentResponse("Your name is Hari.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 344,
      message: "What is my name?",
      replyLanguage: "en",
      userProfile: { name: "Hari" },
    });

    expect(result.route).toBe("profile");
    expect(result.cacheHit).toBe(false);
    expect(result.assistantText).toContain("Hari");
    expect(result.assistantText).not.toContain("Cached low confidence name");
  });

  it("does not use semantic cache for live/current-data questions", async () => {
    writeJson(`${dataRoot}/cache/semantic_cache.json`, {
      version: 2,
      entries: [
        {
          id: "stale_news",
          userId: 345,
          sourceQuestion: "What is the latest news about EVs?",
          normalizedQuestion: "what is the latest news about evs",
          canonicalAnswer: "Cached stale news.",
          englishAnswer: "Cached stale news.",
          lastPresentedAnswer: "Cached stale news.",
          route: "local_answer",
          intent: "assistant",
          embedding: testEmbedding({ 0: 1 }),
          confidence: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          expiresAt: null,
        },
      ],
      hits: [],
    });
    queueChatCompletion(
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
      userId: 345,
      message: "What is the latest news about EVs?",
      replyLanguage: "en",
    });

    expect(result.route).toBe("clarify");
    expect(result.kind).toBe("cloud_consent_required");
    expect(result.cacheHit).toBe(false);
    expect(result.assistantText).not.toContain("Cached stale news");
    expect(apiPostMock).not.toHaveBeenCalled();
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
    expect(facts.map((row) => row.fact).join(" ")).toContain("Preferred language: English");
    expect(facts.map((row) => row.fact).join(" ")).toContain("Likes: music");
  });

  it("stores new durable memory facts with structured metadata", async () => {
    writeJson(`${dataRoot}/profiles/410/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {},
      history: [],
    });
    writeJsonl(`${dataRoot}/conversations/410.jsonl`, [
      {
        role: "user",
        content: "I live in Chennai.",
        createdAt: "2026-04-09T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Noted.",
        createdAt: "2026-04-09T10:00:05.000Z",
      },
    ]);

    const { consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    const result = await consolidateLocalMemoryOnIdle(410, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    expect(result.ok).toBe(true);
    const facts = readJson(`${dataRoot}/memory/durable_facts/410.json`);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^mem_location_/),
          fact: "Location: Chennai",
          category: "location",
          confidence: expect.any(Number),
          created_at: expect.any(String),
          last_confirmed_at: expect.any(String),
          expires_at: null,
          status: "active",
          source: "heuristic",
          source_turn_id: "2026-04-09T10:00:00.000Z",
        }),
      ]),
    );
  });

  it("does not create duplicate durable facts for repeated facts", async () => {
    writeJson(`${dataRoot}/profiles/411/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {},
      history: [],
    });
    writeJsonl(`${dataRoot}/conversations/411.jsonl`, [
      {
        role: "user",
        content: "I live in Chennai.",
        createdAt: "2026-04-09T10:00:00.000Z",
      },
      {
        role: "user",
        content: "I live in Chennai.",
        createdAt: "2026-04-09T10:01:00.000Z",
      },
    ]);

    const { consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    await consolidateLocalMemoryOnIdle(411, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });
    await consolidateLocalMemoryOnIdle(411, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    const facts = readJson(`${dataRoot}/memory/durable_facts/411.json`);
    expect(
      facts.filter((row: any) => row.fact === "Location: Chennai"),
    ).toHaveLength(1);
    expect(facts[0].status).toBe("active");
  });

  it("marks old location memory stale when a new location contradicts it", async () => {
    writeJson(`${dataRoot}/profiles/412/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {},
      history: [],
    });
    writeJson(`${dataRoot}/memory/durable_facts/412.json`, [
      {
        fact: "Location: Chennai",
        category: "location",
        confidence: 0.95,
        source: "heuristic",
        firstSeenAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        evidence: ["old"],
      },
    ]);
    writeJsonl(`${dataRoot}/conversations/412.jsonl`, [
      {
        role: "user",
        content: "I moved to Bengaluru.",
        createdAt: "2026-04-09T10:00:00.000Z",
      },
    ]);

    const { consolidateLocalMemoryOnIdle, listActiveMemories } = await import(
      "../lib/localAgents"
    );
    await consolidateLocalMemoryOnIdle(412, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    const facts = readJson(`${dataRoot}/memory/durable_facts/412.json`);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fact: "Location: Chennai", status: "stale" }),
        expect.objectContaining({ fact: "Location: Bengaluru", status: "active" }),
      ]),
    );
    expect((await listActiveMemories(412)).map((row) => row.fact)).toEqual([
      "Location: Bengaluru",
    ]);
  });

  it("stales old language preference when the user changes preferred language", async () => {
    writeJson(`${dataRoot}/profiles/413/profiler_state.json`, {
      status: "active",
      confidenceBySlot: {},
      history: [],
    });
    writeJson(`${dataRoot}/memory/durable_facts/413.json`, [
      {
        fact: "Preferred language: Tamil",
        category: "communication_preference",
        confidence: 0.9,
        source: "heuristic",
        firstSeenAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        evidence: ["old"],
      },
    ]);
    writeJsonl(`${dataRoot}/conversations/413.jsonl`, [
      {
        role: "user",
        content: "I prefer English replies.",
        createdAt: "2026-04-09T10:00:00.000Z",
      },
    ]);

    const { consolidateLocalMemoryOnIdle, listActiveMemories } = await import(
      "../lib/localAgents"
    );
    await consolidateLocalMemoryOnIdle(413, {
      force: true,
      userProfile: { replyLanguage: "en" },
    });

    const facts = readJson(`${dataRoot}/memory/durable_facts/413.json`);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: "Preferred language: Tamil",
          status: "stale",
        }),
        expect.objectContaining({
          fact: "Preferred language: English",
          category: "communication_preference",
          status: "active",
        }),
      ]),
    );
    expect((await listActiveMemories(413)).map((row) => row.fact)).toEqual([
      "Preferred language: English",
    ]);
  });

  it("does not let health memory add health disclaimers to unrelated career answers", async () => {
    writeJson(`${dataRoot}/profiles/414/answers.json`, {
      occupation: "software engineer",
      industry_or_field: "technology",
      main_goal: "career_growth",
    });
    writeJson(`${dataRoot}/profiles/414/summary.json`, {
      summary: "Software engineer focused on career growth.",
    });
    writeJson(`${dataRoot}/memory/durable_facts/414.json`, [
      {
        fact: "Health context: diabetes",
        category: "health_context",
        confidence: 0.93,
        source: "heuristic",
        created_at: "2026-04-01T00:00:00.000Z",
        last_confirmed_at: "2026-04-01T00:00:00.000Z",
        expires_at: null,
        status: "active",
        firstSeenAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        evidence: ["explicit health context"],
      },
    ]);

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 414,
      message: "Help me prepare for job applications using my profile",
      replyLanguage: "en",
    });

    expect(result.route).toBe("local_answer");
    expect(result.assistantText).toContain("career");
    expect(result.assistantText).not.toMatch(/doctor|medical|health|diabetes/i);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("does not pass health memories into unrelated local reasoning prompts", async () => {
    writeJson(`${dataRoot}/memory/durable_facts/416.json`, [
      {
        id: "mem_health",
        fact: "Health context: diabetes",
        category: "health_context",
        confidence: 0.93,
        created_at: "2026-04-01T00:00:00.000Z",
        last_confirmed_at: "2026-04-01T00:00:00.000Z",
        expires_at: null,
        status: "active",
        source: "heuristic",
        firstSeenAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        evidence: ["explicit health context"],
      },
    ]);
    queueChatCompletion(
      JSON.stringify({
        route: "local_answer",
        reason: "offline_reasoning",
        confidence: 0.82,
        needs_clarification: false,
        clarification_question: "",
        needs_live_data: false,
        selected_model: "Qwen/Qwen3-8B",
        fallback_allowed: false,
      }),
    );
    queueChatCompletion("Recursion is when a function calls itself.");

    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const result = await runLocalAssistantTurn({
      userId: 416,
      message: "Explain recursion in simple words for a beginner",
      replyLanguage: "en",
    });

    const requestBodies = (global.fetch as any).mock.calls
      .map((call: any[]) => String(call[1]?.body || ""))
      .join("\n");
    expect(result.route).toBe("local_answer");
    expect(requestBodies).not.toContain("Health context: diabetes");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("lists active memories and lets users stale or delete a memory", async () => {
    writeJson(`${dataRoot}/memory/durable_facts/415.json`, [
      {
        id: "mem_location_old",
        fact: "Location: Chennai",
        category: "location",
        confidence: 0.91,
        created_at: "2026-04-01T00:00:00.000Z",
        last_confirmed_at: "2026-04-01T00:00:00.000Z",
        expires_at: null,
        status: "active",
        source: "heuristic",
        firstSeenAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        evidence: ["old"],
      },
      {
        id: "mem_goal",
        fact: "Goal: career growth",
        category: "goal",
        confidence: 0.88,
        created_at: "2026-04-01T00:00:00.000Z",
        last_confirmed_at: "2026-04-01T00:00:00.000Z",
        expires_at: null,
        status: "active",
        source: "heuristic",
        firstSeenAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-01T00:00:00.000Z",
        evidence: ["old"],
      },
    ]);

    const {
      listActiveMemories,
      markLocalMemoryStale,
      deleteLocalMemoryFact,
    } = await import("../lib/localAgents");

    expect((await listActiveMemories(415)).map((row) => row.fact)).toEqual([
      "Location: Chennai",
      "Goal: career growth",
    ]);

    await markLocalMemoryStale(415, "mem_location_old");
    expect((await listActiveMemories(415)).map((row) => row.fact)).toEqual([
      "Goal: career growth",
    ]);

    await deleteLocalMemoryFact(415, "mem_goal");
    expect(await listActiveMemories(415)).toEqual([]);
    const facts = readJson(`${dataRoot}/memory/durable_facts/415.json`);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mem_location_old", status: "stale" }),
        expect.objectContaining({ id: "mem_goal", status: "deleted" }),
      ]),
    );
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

    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 45,
      message: "this",
      replyLanguage: "en",
    });
    await flushLocalLearningJobs();

    expect(readJsonl(`${dataRoot}/memory/daily_summaries/45.jsonl`)).toHaveLength(1);
    vi.mocked(FileSystem.readAsStringAsync).mockClear();

    await runLocalAssistantTurn({
      userId: 45,
      message: "that",
      replyLanguage: "en",
    });
    await flushLocalLearningJobs();

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
    queueEmbeddingResponse([testEmbedding({ 0: 1 })]);
    const { runLocalAssistantTurn, consolidateLocalMemoryOnIdle } = await import("../lib/localAgents");
    await runLocalAssistantTurn({
      userId: 44,
      message: "What do I like?",
      replyLanguage: "en",
    });
    await flushLocalLearningJobs();

    queueEmbeddingResponse([testEmbedding({ 0: 0.99, 1: 0.01 })]);
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

  it("does not silently replace native Qwen embeddings with hash embeddings in native_on_device mode", async () => {
    writeJson(`${dataRoot}/config/models.json`, {
      ...models,
      runtime: { ...models.runtime, mode: "native_on_device" },
      baseUrl: "",
      timeoutMs: 1000,
    });

    const { upsertLocalRagChunks } = await import("../lib/localAgents");
    await expect(
      upsertLocalRagChunks(46, "doc-native", ["store this as a native embedding"]),
    ).rejects.toThrow(/native_on_device|Qwen|hash embeddings/i);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
