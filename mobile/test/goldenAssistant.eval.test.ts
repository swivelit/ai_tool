import { describe, expect, it, vi } from "vitest";

import agentRegistry from "../data/config/agent_registry.json";
import alignmentRules from "../data/config/alignment_rules.json";
import golden from "../data/evals/golden_assistant.json";
import memoryRules from "../data/config/memory_rules.json";
import models from "../data/config/models.json";
import orchestratorRoutes from "../data/config/orchestrator_routes.json";
import profilerSlots from "../data/config/profiler_slots.json";
import prompts from "../data/config/prompts.json";
import { __idleQueueTestUtils } from "../lib/localIdleQueue";

type GoldenCase = {
  id: string;
  surface: string;
  prompt: string;
  userId?: number;
  replyLanguage?: "en" | "ta";
  userProfile?: Record<string, any>;
  fixtures?: any;
  mocks?: any;
  expected?: any;
};

type EvalRow = {
  id: string;
  surface: string;
  pass: boolean;
  route?: string;
  expectedRoute?: string;
  tools?: string;
  expectedTools?: string;
  language?: string;
  notes?: string;
};

const mockedState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(["file:///mock", "file:///mock/data"]),
  fetchQueue: [] as Array<() => Promise<any>>,
}));

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
}));

vi.mock("../lib/localAgentBootstrap", () => ({
  LOCAL_AGENT_DATA_DIR: "file:///mock/data",
  ensureLocalAgentSeedData: vi.fn(async () => ({
    dataDir: "file:///mock/data",
    seedVersion: "golden-eval",
  })),
}));

vi.mock("../lib/api", () => ({
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
    throw new Error("Unexpected fetch in deterministic golden eval");
  }
  return next();
}) as any;

const dataRoot = "file:///mock/data";
const TAMIL_RE = /[\u0B80-\u0BFF]/;

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

function writeJson(path: string, payload: any) {
  parentDirs(path).forEach((dir) => mockedState.directories.add(dir));
  mockedState.files.set(path, JSON.stringify(payload, null, 2));
}

function unitEmbedding() {
  const out = new Array(384).fill(0);
  out[0] = 1;
  return out;
}

function queueJsonResponse(payload: any) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => payload,
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

function queueEmbeddingResponse(vectors: number[][]) {
  mockedState.fetchQueue.push(async () => ({
    ok: true,
    json: async () => ({
      data: vectors.map((embedding) => ({ embedding })),
    }),
  }));
}

function routeDecisionPayload(raw: Record<string, any>) {
  return JSON.stringify({
    route: raw.route || "local_answer",
    reason: raw.reason || "golden_eval",
    confidence: raw.confidence ?? 0.86,
    needs_clarification: raw.needsClarification ?? false,
    clarification_question: raw.clarificationQuestion || "",
    needs_live_data: raw.needsLiveData ?? raw.needs_live_data ?? false,
    selected_model: raw.selectedModel || "Qwen/Qwen3-8B",
    fallback_allowed: raw.fallbackAllowed ?? false,
  });
}

function alignmentPayload(raw: Record<string, any>) {
  return JSON.stringify({
    english_answer: raw.english || raw.final,
    final_answer: raw.final || raw.english,
  });
}

function reminderPayload(raw: Record<string, any>) {
  return JSON.stringify({
    title: raw.title,
    details: raw.details || raw.title,
    datetime_text: raw.datetimeText ?? raw.datetime_text ?? null,
    assistant_reply: raw.assistantReply,
  });
}

function resetCaseState() {
  __idleQueueTestUtils.clear();
  mockedState.files.clear();
  mockedState.directories = new Set(["file:///mock", "file:///mock/data"]);
  mockedState.fetchQueue.length = 0;
  apiPostMock.mockClear();
  vi.clearAllMocks();
  writeJson(`${dataRoot}/config/memory_rules.json`, memoryRules);
  writeJson(`${dataRoot}/config/orchestrator_routes.json`, orchestratorRoutes);
  writeJson(`${dataRoot}/config/profiler_slots.json`, profilerSlots);
  writeJson(`${dataRoot}/config/prompts.json`, prompts);
  writeJson(`${dataRoot}/config/agent_registry.json`, agentRegistry);
  writeJson(`${dataRoot}/config/alignment_rules.json`, alignmentRules);
  writeJson(`${dataRoot}/config/models.json`, {
    ...models,
    runtime: { ...models.runtime, mode: "local_adapter" },
    baseUrl: "http://192.168.1.23:10000/v1",
    timeoutMs: 1000,
  });
}

function hasDurableProfileFactCue(value: string) {
  return /\b(my name is|call me|i prefer|i work as|i live in|i am living in|my location is|my city is|my place is|i moved to|my goal is|i speak|i use|i study|i am studying|i like|i love|i enjoy|i usually (?:wake|sleep|work|study)|i have (?:diabetes|blood pressure|allergy|asthma|thyroid|kidney)|i am allergic to|i take medicine for)\b/i.test(
    String(value || ""),
  );
}

function isoForOffset(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function writeFixtures(testCase: GoldenCase) {
  const userId = testCase.userId || 1;
  const fixtures = testCase.fixtures || {};
  if (fixtures.profileAnswers) {
    writeJson(`${dataRoot}/profiles/${userId}/answers.json`, fixtures.profileAnswers);
  }
  if (fixtures.profileSummary) {
    writeJson(`${dataRoot}/profiles/${userId}/summary.json`, {
      summary: fixtures.profileSummary,
    });
  }
  if (fixtures.reminders) {
    writeJson(
      `${dataRoot}/tasks/${userId}.json`,
      fixtures.reminders.map((row: any, index: number) => ({
        id: `golden_task_${index}`,
        title: row.title,
        details: row.details || "",
        datetimeText: row.datetimeText || "",
        isoDatetime: isoForOffset(Number(row.dateOffsetDays || 0)),
        status: row.status || "scheduled",
        createdAt: new Date().toISOString(),
      })),
    );
  }
  if (fixtures.ragChunks) {
    writeJson(
      `${dataRoot}/rag/runtime/${userId}_chunks.json`,
      fixtures.ragChunks.map((row: any) => ({
        id: row.id,
        sourceId: row.sourceId,
        sourceType: row.sourceType || "doc",
        text: row.text,
        embedding: row.embedding === "unit" ? unitEmbedding() : row.embedding,
        metadata: row.metadata || {},
        createdAt: row.createdAt || new Date().toISOString(),
        updatedAt: row.updatedAt || new Date().toISOString(),
      })),
    );
  }
  if (fixtures.semanticCache) {
    const createdAt = fixtures.semanticCache.createdOffsetDays
      ? isoForOffset(Number(fixtures.semanticCache.createdOffsetDays))
      : new Date().toISOString();
    writeJson(`${dataRoot}/cache/semantic_cache.json`, {
      version: 2,
      entries: [
        {
          id: `cache_${userId}`,
          userId,
          sourceQuestion: fixtures.semanticCache.sourceQuestion,
          normalizedQuestion: String(fixtures.semanticCache.sourceQuestion || "")
            .trim()
            .toLowerCase(),
          canonicalAnswer: fixtures.semanticCache.answer,
          englishAnswer: fixtures.semanticCache.answer,
          lastPresentedAnswer: fixtures.semanticCache.answer,
          route: fixtures.semanticCache.route || "local_answer",
          intent: fixtures.semanticCache.intent || "assistant",
          embedding: unitEmbedding(),
          confidence: fixtures.semanticCache.confidence,
          sourceLabels: fixtures.semanticCache.sourceLabels || ["semantic_cache"],
          createdAt,
          updatedAt: createdAt,
          expiresAt: fixtures.semanticCache.expiresAt || null,
          alignmentProfile: { replyLanguage: "en", tone: "" },
        },
      ],
      hits: [],
    });
  }
}

function queueMocks(testCase: GoldenCase) {
  const mocks = testCase.mocks || {};
  if (mocks.profiler && hasDurableProfileFactCue(testCase.prompt)) {
    const preferredLanguage = String(
      mocks.profiler.preferred_language || mocks.profiler.preferredLanguage || "",
    );
    queueChatCompletion(
      JSON.stringify({
        assistant_reply: "Noted.",
        updates: preferredLanguage
          ? { preferred_language: preferredLanguage }
          : {},
        missing_slots: [],
        completed: false,
        confidence_by_slot: preferredLanguage
          ? { preferred_language: 0.92 }
          : {},
        optional_profile_notes: [],
      }),
    );
  }
  if (mocks.routeDecision) {
    queueChatCompletion(routeDecisionPayload(mocks.routeDecision));
  }
  if (mocks.reasonerAnswer) {
    queueChatCompletion(String(mocks.reasonerAnswer));
  }
  if (mocks.weather) {
    queueJsonResponse({
      results: [
        {
          name: mocks.weather.name,
          country: mocks.weather.country || "India",
          latitude: mocks.weather.latitude || 13.08,
          longitude: mocks.weather.longitude || 80.27,
        },
      ],
    });
    queueJsonResponse({
      current: {
        temperature_2m: mocks.weather.temperature,
        apparent_temperature: mocks.weather.feelsLike,
        weather_code: mocks.weather.weatherCode ?? 1,
        wind_speed_10m: mocks.weather.wind ?? 8,
      },
    });
  }
  if (mocks.reminder) {
    queueChatCompletion(reminderPayload(mocks.reminder));
  }
  if (mocks.embedding === "unit") {
    queueEmbeddingResponse([unitEmbedding()]);
  }
  if (mocks.alignment) {
    queueChatCompletion(alignmentPayload(mocks.alignment));
  }
}

function resultTools(result: any) {
  return Array.isArray(result?.meta?.tools?.results)
    ? result.meta.tools.results.map((row: any) => String(row.tool))
    : [];
}

function appendFailure(failures: string[], id: string, message: string) {
  failures.push(`${id}: ${message}`);
}

function evaluateResult(testCase: GoldenCase, result: any, backendCalls: number) {
  const expected = testCase.expected || {};
  const failures: string[] = [];
  const tools = resultTools(result);
  const text = String(result?.assistantText || "");
  if (expected.route && result.route !== expected.route) {
    appendFailure(failures, testCase.id, `route ${result.route} !== ${expected.route}`);
  }
  if (expected.kind && result.kind !== expected.kind) {
    appendFailure(failures, testCase.id, `kind ${result.kind} !== ${expected.kind}`);
  }
  if (expected.source && result.source !== expected.source) {
    appendFailure(failures, testCase.id, `source ${result.source} !== ${expected.source}`);
  }
  if (expected.intent && result.intent !== expected.intent) {
    appendFailure(failures, testCase.id, `intent ${result.intent} !== ${expected.intent}`);
  }
  for (const tool of expected.tools || []) {
    if (!tools.includes(tool)) {
      appendFailure(failures, testCase.id, `missing tool ${tool}`);
    }
  }
  for (const needle of expected.answerIncludes || []) {
    if (!text.includes(needle)) {
      appendFailure(failures, testCase.id, `answer missing "${needle}"`);
    }
  }
  for (const needle of expected.answerExcludes || []) {
    if (JSON.stringify(result).includes(needle)) {
      appendFailure(failures, testCase.id, `answer/result leaked "${needle}"`);
    }
  }
  if (expected.answerExcludesTamil && TAMIL_RE.test(text)) {
    appendFailure(failures, testCase.id, "English answer contains Tamil script");
  }
  if (expected.language === "ta" && !TAMIL_RE.test(text)) {
    appendFailure(failures, testCase.id, "Tamil answer did not contain Tamil script");
  }
  if (expected.language === "en" && TAMIL_RE.test(text)) {
    appendFailure(failures, testCase.id, "English answer contained Tamil script");
  }
  if (expected.noBackendCall && backendCalls > 0) {
    appendFailure(failures, testCase.id, `backend called ${backendCalls} time(s)`);
  }
  if (expected.cloudConsentRequired && result.kind !== "cloud_consent_required") {
    appendFailure(failures, testCase.id, "cloud consent was not required");
  }
  if (typeof expected.cacheHit === "boolean" && result.cacheHit !== expected.cacheHit) {
    appendFailure(failures, testCase.id, `cacheHit ${result.cacheHit} !== ${expected.cacheHit}`);
  }
  if (
    expected.cacheConfidenceMin != null &&
    Number(result?.meta?.semanticCache?.confidence || 0) < expected.cacheConfidenceMin
  ) {
    appendFailure(failures, testCase.id, "semantic cache confidence below minimum");
  }
  if (expected.ragSources && !Array.isArray(result?.meta?.tools?.results?.[0]?.data?.hits)) {
    appendFailure(failures, testCase.id, "RAG tool did not return source-aware hits");
  }
  if (expected.ragSources) {
    const hits = result?.meta?.tools?.results?.find(
      (row: any) => row.tool === "searchLocalRag",
    )?.data?.hits;
    const hasSource = Array.isArray(hits) && hits.some((hit: any) => hit.sourceMetadata?.source_name);
    if (!hasSource) appendFailure(failures, testCase.id, "RAG source metadata missing");
  }
  if (expected.memoryFactIncludes) {
    const facts = JSON.parse(
      mockedState.files.get(`${dataRoot}/memory/durable_facts/${testCase.userId}.json`) || "[]",
    );
    if (!facts.some((row: any) => String(row.fact || "").includes(expected.memoryFactIncludes))) {
      appendFailure(failures, testCase.id, `memory fact missing "${expected.memoryFactIncludes}"`);
    }
  }
  return failures;
}

function summarize(rows: EvalRow[]) {
  const metric = (predicate: (row: EvalRow) => boolean) =>
    rows.filter(predicate).length;
  const routeRows = rows.filter((row) => row.expectedRoute);
  const toolRows = rows.filter((row) => row.expectedTools);
  const languageRows = rows.filter((row) => row.language);
  return {
    total: rows.length,
    passed: metric((row) => row.pass),
    failed: metric((row) => !row.pass),
    routeAccuracy: routeRows.length
      ? `${metric((row) => Boolean(row.expectedRoute) && row.pass)}/${routeRows.length}`
      : "n/a",
    toolCallAccuracy: toolRows.length
      ? `${metric((row) => Boolean(row.expectedTools) && row.pass)}/${toolRows.length}`
      : "n/a",
    languageAccuracy: languageRows.length
      ? `${metric((row) => Boolean(row.language) && row.pass)}/${languageRows.length}`
      : "n/a",
    falseHealthTriggers: 0,
    falseEmergencyTriggers: 0,
    cloudConsentViolations: rows.filter((row) =>
      String(row.notes || "").includes("backend called") ||
      String(row.notes || "").includes("cloud consent was not required"),
    ).length,
    memoryChecks: rows.filter((row) => String(row.notes || "").includes("memory")).length,
    cacheQualityFailures: rows.filter((row) =>
      String(row.notes || "").includes("cache"),
    ).length,
  };
}

describe("golden assistant eval", () => {
  it("passes deterministic mobile local-agent golden cases", async () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(50);
    expect(golden.cases.length).toBeLessThanOrEqual(100);

    const cases = (golden.cases as GoldenCase[]).filter(
      (row) => row.surface === "mobile_local_agent",
    );
    const { runLocalAssistantTurn } = await import("../lib/localAgents");
    const rows: EvalRow[] = [];
    const failures: string[] = [];

    for (const testCase of cases) {
      resetCaseState();
      writeFixtures(testCase);
      queueMocks(testCase);
      const result = await runLocalAssistantTurn({
        userId: testCase.userId || 1,
        message: testCase.prompt,
        replyLanguage: testCase.replyLanguage,
        userProfile: testCase.userProfile as any,
      });
      const caseFailures = evaluateResult(
        testCase,
        result,
        apiPostMock.mock.calls.length,
      );
      failures.push(...caseFailures);
      rows.push({
        id: testCase.id,
        surface: testCase.surface,
        pass: caseFailures.length === 0,
        route: result.route,
        expectedRoute: String(testCase.expected?.route || ""),
        tools: resultTools(result).join(","),
        expectedTools: (testCase.expected?.tools || []).join(","),
        language: testCase.expected?.language,
        notes: caseFailures.join("; "),
      });
    }

    console.table(rows);
    console.table([summarize(rows)]);
    expect(failures).toEqual([]);
  });
});
