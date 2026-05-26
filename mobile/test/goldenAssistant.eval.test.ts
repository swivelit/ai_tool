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
  stt?: any; // ✅ added for voice cases
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
  vi.fn(async () => ({
    ok: true,
  })),
);

// ---------------- MOCKS ----------------

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///mock/",
  EncodingType: { UTF8: "utf8" },
  getInfoAsync: vi.fn(async (path: string) => ({
    exists:
      mockedState.files.has(path) ||
      Array.from(mockedState.files.keys()).some((p) => p.startsWith(path)),
  })),
  makeDirectoryAsync: vi.fn(async (path: string) => {
    mockedState.directories.add(path);
  }),
  writeAsStringAsync: vi.fn(async (path: string, content: string) => {
    mockedState.files.set(path, content);
  }),
  readAsStringAsync: vi.fn(async (path: string) => {
    if (!mockedState.files.has(path)) throw new Error("missing file");
    return mockedState.files.get(path)!;
  }),
  deleteAsync: vi.fn(async (path: string) => {
    mockedState.files.delete(path);
  }),
}));

vi.mock("../lib/api", () => ({
  apiPost: apiPostMock,
}));

// ---------------- HELPERS ----------------

const dataRoot = "file:///mock/data";
const TAMIL_RE = /[\u0B80-\u0BFF]/;

function writeJson(path: string, payload: any) {
  mockedState.files.set(path, JSON.stringify(payload, null, 2));
}

function resetCaseState() {
  __idleQueueTestUtils.clear();
  mockedState.files.clear();
  mockedState.directories = new Set(["file:///mock", "file:///mock/data"]);
  mockedState.fetchQueue.length = 0;
  apiPostMock.mockClear();

  writeJson(`${dataRoot}/config/memory_rules.json`, memoryRules);
  writeJson(`${dataRoot}/config/orchestrator_routes.json`, orchestratorRoutes);
  writeJson(`${dataRoot}/config/profiler_slots.json`, profilerSlots);
  writeJson(`${dataRoot}/config/prompts.json`, prompts);
  writeJson(`${dataRoot}/config/agent_registry.json`, agentRegistry);
  writeJson(`${dataRoot}/config/alignment_rules.json`, alignmentRules);
  writeJson(`${dataRoot}/config/models.json`, models);
}

function resultTools(result: any) {
  const tools = result?.meta?.tools?.results || [];
  if (!Array.isArray(tools)) return [];
  return tools.map((t: any) => (typeof t === "string" ? t : t.tool));
}

// ---------------- EVALUATION ----------------

function evaluateResult(testCase: GoldenCase, result: any, backendCalls: number) {
  const expected = testCase.expected || {};
  const failures: string[] = [];

  const tools = resultTools(result);
  const text = String(result?.assistantText || "");

  // route
  if (expected.route && result.route !== expected.route) {
    failures.push(`${testCase.id}: route mismatch`);
  }

  // tools
  for (const tool of expected.tools || []) {
    if (!tools.includes(tool)) {
      failures.push(`${testCase.id}: missing tool ${tool}`);
    }
  }

  // answer includes
  for (const needle of expected.answerIncludes || []) {
    if (!text.includes(needle)) {
      failures.push(`${testCase.id}: missing "${needle}"`);
    }
  }

  // language check
  if (expected.language === "ta" && !TAMIL_RE.test(text)) {
    failures.push(`${testCase.id}: expected Tamil`);
  }

  if (expected.language === "en" && TAMIL_RE.test(text)) {
    failures.push(`${testCase.id}: unexpected Tamil`);
  }

  // backend calls
  if (expected.noBackendCall && backendCalls > 0) {
    failures.push(`${testCase.id}: backend called`);
  }

  // cloud consent
  if (expected.cloudConsentRequired && result.kind !== "cloud_consent_required") {
    failures.push(`${testCase.id}: missing cloud consent`);
  }

  // cache
  if (typeof expected.cacheHit === "boolean" && result.cacheHit !== expected.cacheHit) {
    failures.push(`${testCase.id}: cache mismatch`);
  }

  // ---------------- TASK 3 NEGATIVE EVALS ----------------

  if (expected.shouldNotInclude) {
    for (const needle of expected.shouldNotInclude) {
      if (text.includes(needle)) {
        failures.push(`${testCase.id}: should NOT include "${needle}"`);
      }
    }
  }

  if (expected.shouldNotCreateReminder) {
    if (tools.includes("createReminder")) {
      failures.push(`${testCase.id}: reminder should NOT be created`);
    }
  }

  // ---------------- TASK 4 VOICE EVALS ----------------

  if (testCase.surface === "mobile_voice_agent") {
    const stt = (testCase as any).stt;

    if (stt?.result === "") {
      if (result.route !== "voice_error") {
        failures.push(`${testCase.id}: expected voice_error (empty transcript)`);
      }
      if (result.errorType !== "empty_transcript") {
        failures.push(`${testCase.id}: missing empty_transcript`);
      }
    }

    if (stt?.error === "service_unavailable") {
      if (result.route !== "voice_error") {
        failures.push(`${testCase.id}: expected voice_error (STT down)`);
      }
      if (result.errorType !== "stt_provider_down") {
        failures.push(`${testCase.id}: missing stt_provider_down`);
      }
    }

    if (stt?.result) {
      if (result.transcript !== stt.result) {
        failures.push(`${testCase.id}: transcript mismatch`);
      }
    }
  }

  return failures;
}

// ---------------- TEST ----------------

describe("golden assistant eval", () => {
  it("passes deterministic mobile local-agent golden cases", async () => {
    const cases = (golden.cases as GoldenCase[]).filter(
      (c) => c.surface === "mobile_local_agent" || c.surface === "mobile_voice_agent"
    );

    const { runLocalAssistantTurn } = await import("../lib/localAgents");

    const rows: EvalRow[] = [];
    const failures: string[] = [];

    for (const testCase of cases) {
      resetCaseState();

      const result = await runLocalAssistantTurn({
        userId: testCase.userId || 1,
        message: testCase.prompt,
        replyLanguage: testCase.replyLanguage,
        userProfile: testCase.userProfile as any,
      });

      const caseFailures = evaluateResult(
        testCase,
        result,
        apiPostMock.mock.calls.length
      );

      failures.push(...caseFailures);

      rows.push({
        id: testCase.id,
        surface: testCase.surface,
        pass: caseFailures.length === 0,
        route: result.route,
        expectedRoute: testCase.expected?.route,
        tools: resultTools(result).join(","),
        expectedTools: (testCase.expected?.tools || []).join(","),
        language: testCase.expected?.language,
        notes: caseFailures.join("; "),
      });
    }

    console.table(rows);
    expect(failures).toEqual([]);
  });
});
