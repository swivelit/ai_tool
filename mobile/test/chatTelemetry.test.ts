import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function setupTelemetryMocks(options: {
  token?: string | null;
  preserveBuildEnv?: boolean;
} = {}) {
  const storage = new Map<string, string>();
  vi.resetModules();
  if (!options.preserveBuildEnv) {
    vi.stubEnv("EXPO_PUBLIC_MOBILE_BUILD_ID", "");
    vi.stubEnv("EXPO_PUBLIC_GIT_SHA", "");
    vi.stubEnv("EXPO_PUBLIC_LOCAL_TO_BACKEND_FALLBACK_MS", "");
  }
  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        version: "1.2.3",
        android: { versionCode: 42 },
        extra: {
          API_BASE: "https://api.example.test",
          MOBILE_BUILD_ID: "test-build-extra",
          GIT_SHA: "extra-sha",
          LOCAL_TO_BACKEND_FALLBACK_MS: 15_000,
        },
      },
    },
  }));
  vi.doMock("@react-native-async-storage/async-storage", () => ({
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  }));
  vi.doMock("../lib/firebase", () => ({
    auth: {
      currentUser:
        options.token === null
          ? null
          : {
              getIdToken: vi.fn(async () => options.token || "test-token"),
            },
    },
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return storage;
}

describe("chat telemetry queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("enqueues and flushes client turn logs to /api/client/turn-log", async () => {
    const storage = setupTelemetryMocks();
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { enqueueClientTurnLog, CLIENT_TURN_LOG_QUEUE_KEY } = await import(
      "../lib/chatTelemetry"
    );

    await enqueueClientTurnLog({
      event: "client_local_turn_completed",
      channel: "text",
      question: "hello",
      answer: "hi",
      agent_source: "local_rules",
      route_taken: "fast_greeting",
      cloud_fallback_enabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as any[];
    expect(String(firstCall[0])).toBe(
      "https://api.example.test/api/client/turn-log",
    );
    const body = JSON.parse(String((firstCall[1] as any).body));
    expect(body.event).toBe("client_local_turn_completed");
    expect(body.question).toBe("hello");
    expect(body.answer).toBe("hi");
    expect(body.question_length).toBe(5);
    expect(body.answer_length).toBe(2);
    expect(body.api_base).toBe("https://api.example.test");
    expect(body.app_version).toBe("1.2.3");
    expect(body.mobile_build_id).toBe("test-build-extra");
    expect(body.mobile_git_sha).toBe("extra-sha");
    expect(body.local_to_backend_fallback_ms).toBe(15_000);
    expect(body.cloud_fallback_enabled).toBe(true);
    expect(body.telemetry_delivery).toBe("realtime");
    expect(body.request_id).toBeTruthy();
    expect(storage.get(CLIENT_TURN_LOG_QUEUE_KEY)).toBeUndefined();
  });

  it("uses EXPO_PUBLIC build identity env overrides in client workflow logs", async () => {
    vi.stubEnv("EXPO_PUBLIC_MOBILE_BUILD_ID", "env-build-99");
    vi.stubEnv("EXPO_PUBLIC_GIT_SHA", "env-sha-123");
    vi.stubEnv("EXPO_PUBLIC_LOCAL_TO_BACKEND_FALLBACK_MS", "17000");
    setupTelemetryMocks({ preserveBuildEnv: true });
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { enqueueClientTurnLog } = await import("../lib/chatTelemetry");

    await enqueueClientTurnLog({
      event: "client_backend_fallback_started",
      channel: "text",
      question: "unknown",
      agent_source: "backend_openai",
      route_taken: "fallback_openai",
      fallback_reason: "local_timeout",
      cloud_fallback_enabled: true,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(body.mobile_build_id).toBe("env-build-99");
    expect(body.mobile_git_sha).toBe("env-sha-123");
    expect(body.local_to_backend_fallback_ms).toBe(17_000);
    expect(body.cloud_fallback_enabled).toBe(true);
  });

  it("fails release build telemetry when build identifiers are unknown", async () => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_RELEASE_BUILD", "true");
    vi.stubEnv("EXPO_PUBLIC_MOBILE_BUILD_ID", "");
    vi.stubEnv("EXPO_PUBLIC_GIT_SHA", "");
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            RELEASE_BUILD: "true",
            MOBILE_BUILD_ID: "",
            GIT_SHA: "",
          },
        },
      },
    }));

    const { getMobileBuildInfo } = await import("../lib/mobileBuildInfo");

    expect(() => getMobileBuildInfo()).toThrow(/real mobile build identifiers/i);
  });

  it("does not enable voice-only mode for release/public runtime by default", async () => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_RELEASE_BUILD", "true");
    vi.stubEnv("EXPO_PUBLIC_PUBLIC_BUILD", "true");
    vi.stubEnv("EXPO_PUBLIC_MOBILE_BUILD_ID", "release-build");
    vi.stubEnv("EXPO_PUBLIC_GIT_SHA", "release-sha");
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {},
        },
      },
    }));

    const { getMobileBuildInfo } = await import("../lib/mobileBuildInfo");

    expect(getMobileBuildInfo().voice_only_mode).toBe(false);
  });

  it("honors explicit voice-only mode env", async () => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_VOICE_ONLY_MODE", "true");
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {},
        },
      },
    }));

    const { getMobileBuildInfo } = await import("../lib/mobileBuildInfo");

    expect(getMobileBuildInfo().voice_only_mode).toBe(true);
  });

  it("keeps failed telemetry queued for retry", async () => {
    const storage = setupTelemetryMocks();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false }, 503)));

    const { enqueueClientTurnLog, CLIENT_TURN_LOG_QUEUE_KEY } = await import(
      "../lib/chatTelemetry"
    );

    await enqueueClientTurnLog({
      event: "client_local_turn_completed",
      channel: "text",
      question: "hello",
      answer: "hi",
      agent_source: "local_rules",
      route_taken: "fast_greeting",
    });

    const queued = JSON.parse(storage.get(CLIENT_TURN_LOG_QUEUE_KEY) || "[]");
    expect(queued).toHaveLength(1);
    expect(queued[0].event).toBe("client_local_turn_completed");
  });

  it("removes queued logs after a successful flush", async () => {
    const storage = setupTelemetryMocks();
    storage.set(
      "client_turn_logs_queue_v1",
      JSON.stringify([
        {
          event: "client_backend_fallback_started",
          channel: "text",
          question: "Do you know about IPL?",
          agent_source: "backend_openai",
          route_taken: "fallback_openai",
          fallback_reason: "local_timeout",
        },
      ]),
    );
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { flushClientTurnLogs, CLIENT_TURN_LOG_QUEUE_KEY } = await import(
      "../lib/chatTelemetry"
    );

    await flushClientTurnLogs();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.get(CLIENT_TURN_LOG_QUEUE_KEY)).toBe("[]");
  });

  it("can send startup and voice failure telemetry", async () => {
    setupTelemetryMocks();
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { enqueueClientTurnLog } = await import("../lib/chatTelemetry");

    await enqueueClientTurnLog({
      event: "client_app_started",
      channel: "app",
      agent_source: "mobile",
      route_taken: "startup",
      chat_routing: "local",
      voice_routing: "backend",
    });
    await enqueueClientTurnLog({
      event: "client_voice_prepare_failed",
      channel: "voice",
      agent_source: "mobile",
      route_taken: "voice_prepare",
      voice_phase: "startup_timeout",
      duration_ms: 10_000,
      error_type: "local_timeout",
    });

    const bodies = (fetchMock.mock.calls as any[][]).map((call) =>
      JSON.parse(String((call[1] as any).body)),
    );
    expect(bodies.map((body) => body.event)).toEqual([
      "client_app_started",
      "client_voice_prepare_failed",
    ]);
    expect(bodies[0].api_base).toBe("https://api.example.test");
    expect(bodies[0].chat_routing).toBe("local");
    expect(bodies[0].voice_routing).toBe("backend");
    expect(bodies[1].voice_phase).toBe("startup_timeout");
  });

  it("sends pending local turn crash marker on next boot", async () => {
    const storage = setupTelemetryMocks();
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const {
      markPendingLocalTurn,
      sendPendingCrashMarkerIfPresent,
      PENDING_LOCAL_TURN_MARKER_KEY,
    } = await import("../lib/chatTelemetry");

    await markPendingLocalTurn({
      requestId: "turn-crash-1",
      userId: 42,
      question: "An unknown question that crashed",
    });

    const marker = await sendPendingCrashMarkerIfPresent();

    expect(marker?.request_id).toBe("turn-crash-1");
    expect(marker?.question_hash).toBeTruthy();
    expect(storage.get(PENDING_LOCAL_TURN_MARKER_KEY)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(body.event).toBe("client_turn_crash_suspected");
    expect(body.request_id).toBe("turn-crash-1");
    expect(body.error_type).toBe("pending_local_turn_marker_found");
  });

  it("sets, updates, clears, and reports active workflow crash markers", async () => {
    const storage = setupTelemetryMocks();
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const {
      ACTIVE_WORKFLOW_MARKER_KEY,
      clearActiveWorkflow,
      markActiveWorkflow,
      sendPendingCrashMarkerIfPresent,
      updateActiveWorkflowStep,
    } = await import("../lib/chatTelemetry");

    await markActiveWorkflow({
      requestId: "workflow-1",
      userId: 42,
      question: "Do you know about the new election details?",
      lastStep: "client_chat_turn_started",
    });
    await updateActiveWorkflowStep("workflow-1", "client_local_model_started");

    let marker = JSON.parse(storage.get(ACTIVE_WORKFLOW_MARKER_KEY) || "{}");
    expect(marker.request_id).toBe("workflow-1");
    expect(marker.lastStep).toBe("client_local_model_started");

    await clearActiveWorkflow("workflow-1");
    expect(storage.get(ACTIVE_WORKFLOW_MARKER_KEY)).toBeUndefined();

    await markActiveWorkflow({
      requestId: "workflow-crash-1",
      userId: 42,
      question: "Question that died mid-workflow",
      lastStep: "client_backend_fallback_started",
    });
    marker = await sendPendingCrashMarkerIfPresent();

    expect(marker?.request_id).toBe("workflow-crash-1");
    expect(storage.get(ACTIVE_WORKFLOW_MARKER_KEY)).toBeUndefined();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body));
    expect(body.event).toBe("client_workflow_crash_suspected");
    expect(body.request_id).toBe("workflow-crash-1");
    expect(body.workflow_step).toBe("client_backend_fallback_started");
    expect(body.last_step).toBe("client_backend_fallback_started");
    expect(body.question_preview).toBe("Question that died mid-workflow");
    expect(body.question_hash).toBeTruthy();
    expect(body.error_type).toBe("active_workflow_marker_found");
  });
});
