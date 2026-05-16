import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function backendPayload(answer = "Backend answer.") {
  return {
    ok: true,
    item: {
      id: 900,
      intent: "assistant",
      category: "Other",
      raw_text: "question",
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
    },
  };
}

function localTurn(answer = "Local answer.") {
  return {
    route: "local_answer",
    source: "local_model",
    cacheHit: false,
    intent: "assistant",
    assistantText: answer,
    englishText: answer,
    meta: { stageTimings: { local_reasoner: 100 } },
  };
}

function backendChatCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return (fetchMock.mock.calls as any[][]).filter((call) =>
    String(call[0]).endsWith("/api/chat"),
  );
}

function setupApiHarness(options: {
  cloudFallback?: boolean;
  runLocalAssistantTurn: ReturnType<typeof vi.fn>;
  cancelRequest?: ReturnType<typeof vi.fn>;
  backendAnswer?: string;
  backendDelayMs?: number;
}) {
  const logs: any[] = [];
  const cancelRequest = options.cancelRequest || vi.fn(async () => ({ ok: true }));

  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra: {
          API_BASE: "https://api.example.test",
          LOCAL_TO_BACKEND_FALLBACK_MS: 15_000,
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
    loadCloudFallbackConsent: vi.fn(async () => options.cloudFallback ?? true),
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
      cancelRequest,
    })),
    hasUsableNativeOnDeviceModelBridge: vi.fn((bridge: any) => Boolean(bridge)),
    nativeOnDeviceBridgeMissingMessage: vi.fn(() => "Native bridge missing."),
    LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE: "Voice unavailable.",
    getNativeOnDeviceSpeechToTextCapability: vi.fn(async () => ({ available: false })),
    nativeOnDeviceSttMissingMessage: vi.fn(() => "Voice unavailable."),
  }));
  vi.doMock("../lib/localAgents", () => ({
    runLocalAssistantTurn: options.runLocalAssistantTurn,
  }));
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const fetchMock = vi.fn(async () => {
    if (options.backendDelayMs && options.backendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.backendDelayMs));
    }
    return jsonResponse(backendPayload(options.backendAnswer || "Backend answer."));
  });
  vi.stubGlobal("fetch", fetchMock);

  return { logs, fetchMock, cancelRequest };
}

async function waitForMockCall(mock: ReturnType<typeof vi.fn>) {
  for (let index = 0; index < 20; index += 1) {
    if (mock.mock.calls.length) return;
    await Promise.resolve();
  }
}

describe("local to backend fallback budget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("uses default cloud fallback after 15 seconds when the local model never resolves", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(() => new Promise(() => undefined));
    const { fetchMock, cancelRequest, logs } = setupApiHarness({
      runLocalAssistantTurn,
      backendAnswer: "Backend answer after budget.",
    });

    const { apiPost } = await import("../lib/api");
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain a difficult topic",
      reply_language: "en",
      request_id: "text_budget_never",
    });
    await waitForMockCall(runLocalAssistantTurn);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(backendChatCalls(fetchMock)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const payload = await resultPromise;

    expect(cancelRequest).toHaveBeenCalledWith("text_budget_never");
    expect(logs.some((entry) => entry.event === "client_local_budget_exceeded")).toBe(true);
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    expect(payload.assistant.text).toBe("Backend answer after budget.");
    expect(payload.meta.fallback_reason).toBe("local_timeout");
  });

  it("keeps backend fallback alive past the normal 30 second API timeout", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(() => new Promise(() => undefined));
    const { fetchMock } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
      backendAnswer: "Backend answer after a slow fallback.",
      backendDelayMs: 45_000,
    });

    const { apiPost } = await import("../lib/api");
    let settled = false;
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Tell me about solo leveling",
      reply_language: "en",
      request_id: "text_slow_backend_fallback",
    }).finally(() => {
      settled = true;
    });
    await waitForMockCall(runLocalAssistantTurn);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    const payload = await resultPromise;

    expect(payload.assistant.text).toBe("Backend answer after a slow fallback.");
    expect(payload.meta.fallback_reason).toBe("local_timeout");
  });

  it("keeps the local answer when the local model resolves at 10 seconds", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(localTurn("Local 10s answer.")), 10_000)),
    );
    const { fetchMock } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
    });

    const { apiPost } = await import("../lib/api");
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
      reply_language: "en",
      request_id: "text_local_10",
    });
    await waitForMockCall(runLocalAssistantTurn);
    await vi.advanceTimersByTimeAsync(10_000);
    const payload = await resultPromise;

    expect(backendChatCalls(fetchMock)).toHaveLength(0);
    expect(payload.assistant.text).toBe("Local 10s answer.");
    expect(payload.meta.source).toBe("local_chat_proxy");
  });

  it("ignores a local answer that arrives after backend fallback started", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(localTurn("Late local answer.")), 16_000)),
    );
    const { fetchMock, logs } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
      backendAnswer: "Backend answer wins.",
    });

    const { apiPost } = await import("../lib/api");
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain a hanging topic",
      reply_language: "en",
      request_id: "text_late_local",
    });
    await waitForMockCall(runLocalAssistantTurn);
    await vi.advanceTimersByTimeAsync(15_000);
    const payload = await resultPromise;

    expect(payload.assistant.text).toBe("Backend answer wins.");
    expect(backendChatCalls(fetchMock)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(logs.some((entry) => entry.event === "client_local_result_ignored_after_backend_fallback")).toBe(true);
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
  });

  it("returns cloud consent after 15 seconds when cloud fallback is explicitly disabled", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(() => new Promise(() => undefined));
    const { fetchMock } = setupApiHarness({
      cloudFallback: false,
      runLocalAssistantTurn,
    });

    const { apiPost } = await import("../lib/api");
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain a difficult topic",
      reply_language: "en",
      request_id: "text_budget_no_cloud",
    });
    await waitForMockCall(runLocalAssistantTurn);
    await vi.advanceTimersByTimeAsync(15_000);
    const payload = await resultPromise;

    expect(payload.kind).toBe("cloud_consent_required");
    expect(payload.meta.cloudFallback.kind).toBe("cloud_consent_required");
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("routes current election questions to backend immediately without quick reply or heavy local model", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(async () => localTurn("Should not run."));
    const { fetchMock, logs } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
      backendAnswer: "Backend election answer.",
    });

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Do you know about the new election details?",
      reply_language: "en",
      request_id: "text_current_election",
    });

    expect(runLocalAssistantTurn).not.toHaveBeenCalled();
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    expect(payload.assistant.text).toBe("Backend election answer.");
    expect(logs.some((entry) => entry.event === "client_quick_reply_miss")).toBe(true);
    expect(logs.some((entry) => entry.event === "client_global_knowledge_lookup_miss")).toBe(true);
    expect(logs.some((entry) => entry.event === "client_current_data_backend_required")).toBe(true);
  });

  it.each([
    ["What is the weather tomorrow?", "text_current_weather"],
    ["What is the latest IPL score today?", "text_current_score"],
    ["Do you know about the new election details?", "text_current_election_2"],
  ])("routes immediate current-data question to backend: %s", async (message, requestId) => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(async () => localTurn("Should not run."));
    const { fetchMock, logs } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
      backendAnswer: "Immediate backend answer.",
    });

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message,
      reply_language: "en",
      request_id: requestId,
    });

    expect(runLocalAssistantTurn).not.toHaveBeenCalled();
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    expect(payload.assistant.text).toBe("Immediate backend answer.");
    expect(logs.some((entry) => entry.event === "client_current_data_backend_required")).toBe(true);
  });

  it.each([
    ["Create a reminder for tomorrow morning", "text_reminder_tomorrow"],
    ["Give me 5 birthday gift ideas for my brother", "text_gift_ideas"],
  ])("does not route non-current task immediately: %s", async (message, requestId) => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(() => new Promise(() => undefined));
    const { fetchMock, logs } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
      backendAnswer: "Backend answer after local budget.",
    });

    const { apiPost } = await import("../lib/api");
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message,
      reply_language: "en",
      request_id: requestId,
    });
    await waitForMockCall(runLocalAssistantTurn);

    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
    expect(logs.some((entry) => entry.event === "client_current_data_backend_required")).toBe(false);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(backendChatCalls(fetchMock)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const payload = await resultPromise;

    expect(payload.assistant.text).toBe("Backend answer after local budget.");
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    expect(logs.some((entry) => entry.event === "client_local_budget_exceeded")).toBe(true);
  });

  it("preserves requestId in the backend fallback body", async () => {
    vi.useFakeTimers();
    const runLocalAssistantTurn = vi.fn(() => new Promise(() => undefined));
    const { fetchMock } = setupApiHarness({
      cloudFallback: true,
      runLocalAssistantTurn,
    });

    const { apiPost } = await import("../lib/api");
    const resultPromise = apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain a difficult topic",
      reply_language: "en",
      request_id: "text_preserved_request",
    });
    await waitForMockCall(runLocalAssistantTurn);
    await vi.advanceTimersByTimeAsync(15_000);
    await resultPromise;

    const body = JSON.parse(String((backendChatCalls(fetchMock)[0][1] as any).body || "{}"));
    expect(body.request_id).toBe("text_preserved_request");
    expect(body.client_fallback_reason).toBe("local_timeout");
    expect(body.client_local_budget_ms).toBe(15_000);
    expect(body.client_original_route).toBe("local_answer");
  });
});
