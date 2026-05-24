import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const QUESTION_BANK = [
  "Hi elli",
  "Do you know about IPL?",
  "Tell me about Indian Premier League",
  "What is photosynthesis?",
  "Explain quantum computing in simple words",
  "Write a short email asking for a meeting",
  "Do you know about the new election details?",
  "What is the latest IPL score today?",
  "Give me 5 birthday gift ideas for my brother",
  "What is a compiler?",
  "Explain black holes simply",
  "Summarize why the sky is blue",
  "What is fistula?",
  "Create a reminder for tomorrow morning",
  "What is the weather tomorrow?",
];

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function seededSample(values: string[], count: number, seed = 1778790105) {
  const random = seededRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function answerText(payload: any) {
  return String(payload?.assistant?.text || payload?.item?.details || "").trim();
}

function backendChatCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return (fetchMock.mock.calls as any[][]).filter((call) =>
    String(call[0]).endsWith("/api/chat"),
  );
}

function isStableIplKnowledge(question: string) {
  return /indian premier league/i.test(question);
}

function setupArchitectureHarness() {
  const logs: any[] = [];
  const finalAnswersByRequestId = new Map<string, number>();
  const hangingRequestIds = new Set<string>();

  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra: {
          API_BASE: "https://api.example.test",
          LOCAL_TO_BACKEND_FALLBACK_MS: 15_000,
          USE_LOCAL_CHAT_PIPELINE: true,
        },
      },
    },
  }));
  vi.doMock("../lib/firebase", () => ({
    auth: { currentUser: null },
  }));
  vi.doMock("../lib/localAssistantProfile", () => ({
    loadCachedLocalAssistantProfile: vi.fn(async () => null),
    withResolvedReplyLanguage: vi.fn((profile: any, replyLanguage: string) =>
      profile ? { ...profile, replyLanguage } : undefined,
    ),
  }));
  vi.doMock("../lib/localAssistantSettings", () => ({
    loadCloudFallbackConsent: vi.fn(async () => true),
  }));
  vi.doMock("../lib/deviceCapabilities", () => ({
    getCachedDeviceCapabilities: vi.fn(async () => ({ preferredTier: "lite" })),
  }));
  vi.doMock("../lib/chatTelemetry", () => ({
    enqueueClientTurnLog: vi.fn(async (payload: any) => {
      logs.push(payload);
    }),
    flushClientTurnLogs: vi.fn(async () => undefined),
    updateActiveWorkflowStep: vi.fn(async () => undefined),
  }));
  vi.doMock("../lib/nativeOnDeviceModelBridge", () => ({
    DEFAULT_NATIVE_ON_DEVICE_MODULE_NAME: "JaiOnDeviceModel",
    getNativeOnDeviceModelBridge: vi.fn(() => ({
      initialize: vi.fn(),
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
      cancelRequest: vi.fn(async () => ({ ok: true })),
    })),
    hasUsableNativeOnDeviceModelBridge: vi.fn((bridge: any) => Boolean(bridge)),
    nativeOnDeviceBridgeMissingMessage: vi.fn(() => "Native bridge missing."),
    LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE: "Voice unavailable.",
    getNativeOnDeviceSpeechToTextCapability: vi.fn(async () => ({ available: false })),
    nativeOnDeviceSttMissingMessage: vi.fn(() => "Voice unavailable."),
  }));
  const runLocalAssistantTurn = vi.fn((input: any) => {
    const question = String(input?.message || "");
    if (isStableIplKnowledge(question)) {
      return Promise.resolve({
        route: "global_knowledge_cache",
        source: "global_rag",
        cacheHit: true,
        intent: "assistant",
        assistantText: "The Indian Premier League is a professional Twenty20 cricket league in India.",
        englishText: "The Indian Premier League is a professional Twenty20 cricket league in India.",
        meta: {
          responsePath: "global_knowledge_cache",
          stageTimings: { global_knowledge_cache: 12 },
        },
      });
    }
    hangingRequestIds.add(String(input?.requestId || ""));
    return new Promise(() => undefined);
  });
  vi.doMock("../lib/localAgents", () => ({
    runLocalAssistantTurn,
  }));
  vi.spyOn(console, "info").mockImplementation((...args: any[]) => {
    process.stdout.write(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String((init as any)?.body || "{}"));
    const message = String(body.message || "");
    const answer = `Backend deterministic answer for: ${message}`;
    return jsonResponse({
      ok: true,
      item: {
        id: Date.now(),
        intent: "assistant",
        category: "Other",
        raw_text: message,
        details: answer,
        source: "text",
      },
      assistant: {
        text: answer,
        english: answer,
      },
      pipeline: {
        route_taken: "full_pipeline",
        direct_answer_source: "backend_openai",
      },
      meta: {
        route: "full_pipeline",
        source: "backend_openai",
        request_id: body.request_id,
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    logs,
    fetchMock,
    finalAnswersByRequestId,
    hangingRequestIds,
    runLocalAssistantTurn,
  };
}

async function settleArchitectureStart() {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

describe("chat architecture smoke", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("answers 10 seeded random questions without local timeout failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = setupArchitectureHarness();
    const { apiPost } = await import("../lib/api");
    const { requiresImmediateBackendCurrentData } = await import("../lib/currentDataGuards");
    const questions = seededSample(QUESTION_BANK, 10);
    const rows: Array<{
      question: string;
      route: string;
      source: string;
      backendFallbackUsed: boolean;
      durationMs: number;
      answerPreview: string;
      pass: boolean;
    }> = [];

    for (const [index, question] of questions.entries()) {
      const requestId = `smoke_${index}_${question.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      const startedAt = Date.now();
      let thrown: unknown = null;
      let response: any = null;
      let settled = false;
      const responsePromise = apiPost<any>("/api/chat", {
        user_id: 7,
        message: question,
        reply_language: "en",
        request_id: requestId,
      }).then(
        (value) => {
          settled = true;
          response = value;
          return value;
        },
        (error) => {
          settled = true;
          thrown = error;
          return null;
        },
      );

      for (let settleIndex = 0; settleIndex < 8 && !settled; settleIndex += 1) {
        await settleArchitectureStart();
        await vi.advanceTimersByTimeAsync(0);
      }
      if (!settled) {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      await responsePromise;

      const durationMs = Date.now() - startedAt;
      const answer = answerText(response);
      const route = String(response?.pipeline?.route_taken || response?.meta?.route || "");
      const source = String(response?.meta?.source || response?.pipeline?.direct_answer_source || "");
      const backendFallbackUsed = harness.logs.some(
        (entry) =>
          entry.request_id === requestId &&
          entry.event === "client_backend_fallback_started",
      ) || source.includes("backend");
      const isCurrent = requiresImmediateBackendCurrentData(question);
      const localHung = harness.hangingRequestIds.has(requestId);
      const fallbackLog = harness.logs.find(
        (entry) =>
          entry.request_id === requestId &&
          entry.event === "client_backend_fallback_started",
      );
      const pass =
        !thrown &&
        durationMs < 25_000 &&
        answer.length > 0 &&
        !/local_timeout/i.test(answer) &&
        (!isCurrent || backendFallbackUsed || route === "cloud_consent_required") &&
        (!localHung || (backendFallbackUsed && durationMs >= 14_900 && durationMs <= 15_100));

      harness.finalAnswersByRequestId.set(
        requestId,
        (harness.finalAnswersByRequestId.get(requestId) || 0) + 1,
      );
      if (localHung) {
        expect(fallbackLog).toBeTruthy();
      }
      expect(harness.finalAnswersByRequestId.get(requestId)).toBe(1);
      rows.push({
        question,
        route: route || "unknown",
        source: source || "unknown",
        backendFallbackUsed,
        durationMs,
        answerPreview: answer.slice(0, 56),
        pass,
      });
    }

    const table = [
      "question | route/source | backend fallback | durationMs | answerPreview | pass/fail",
      ...rows.map((row) =>
        `${row.question} | ${row.route}/${row.source} | ${row.backendFallbackUsed ? "yes" : "no"} | ${row.durationMs} | ${row.answerPreview} | ${row.pass ? "pass" : "fail"}`,
      ),
    ].join("\n");
    console.info(table);

    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.pass, row.question).toBe(true);
    }
    expect(backendChatCalls(harness.fetchMock).length).toBeGreaterThan(0);
    expect(harness.logs.some((entry) => entry.event === "client_chat_turn_failed")).toBe(false);
    expect(harness.runLocalAssistantTurn.mock.calls.length).toBeGreaterThan(0);
  });

  it("keeps Android hands-free command capture native-owned", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "app", "(chat)", "index.tsx"), "utf8");

    expect(source).toContain("startHandsFreeSession");
    expect(source).toContain("handleNativeHandsFreeCommandAudio");
    expect(source).toContain("submitHandsFreeCommandAudio");
    expect(source).toContain("nativeStateHandlerRef.current(event)");
    expect(source).toContain("nativeCommandHandlerRef.current(event)");
    expect(source).toContain("nativeCommandAudioHandlerRef.current(event)");
    expect(source).toContain("voiceSheetGenerationRef");
    expect(source).toContain("closeGeneration !== voiceSheetGenerationRef.current");
    expect(source).toContain('handsFreeRecognizer.getOwner() !== "handsfree-command"');
    expect(source).toContain("audio/wav");
    expect(source).not.toContain("stopWakeWordListening().then");
    expect(source).not.toContain("startWakeWordListening");
  });
});
