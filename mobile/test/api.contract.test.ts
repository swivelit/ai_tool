import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function backendChatCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return (fetchMock.mock.calls as any[][]).filter((call) =>
    String(call[0]).endsWith("/api/chat"),
  );
}

function fetchCallsEndingWith(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return (fetchMock.mock.calls as any[][]).filter((call) =>
    String(call[0]).endsWith(suffix),
  );
}

async function settleTelemetry() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function clientTurnLogBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchCallsEndingWith(fetchMock, "/api/client/turn-log").map((call) =>
    JSON.parse(String((call[1] as any)?.body || "{}")),
  );
}

function mockCachedProfile(
  profile: Record<string, any> | null,
  settings?: Record<string, any> | null,
) {
  const storage = new Map<string, string>();
  if (profile) {
    storage.set("user_profile_v1", JSON.stringify(profile));
  }
  if (settings) {
    storage.set("assistant_settings_v1", JSON.stringify(settings));
  }

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

  vi.doMock("expo-secure-store", () => ({
    getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  }));

  return storage;
}

describe("API client contracts", () => {
  afterEach(() => {
    delete (globalThis as any).__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__;
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("routes recorded voice to authenticated backend by default", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: {
          getIdToken: vi.fn(async () => "test-token"),
        },
      },
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (..._args: any[]) =>
      jsonResponse({
        ok: true,
        item: {
          id: 9,
          intent: "assistant",
          category: "Other",
          raw_text: "hello",
          details: "Hello.",
          source: "voice",
        },
        assistant: {
          text: "Hello.",
          english: "Hello.",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm, getClientRoutingDefaults } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;

    expect(getClientRoutingDefaults().voice).toBe("backend");
    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    expect(payload.ok).toBe(true);
    expect(payload.assistant.text).toBe("Hello.");
    const voiceCalls = fetchCallsEndingWith(
      fetchMock,
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
    expect(voiceCalls).toHaveLength(1);
    expect(String(voiceCalls[0][0])).toBe(
      "https://api.example.test/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
  });

  it("does not activate local recorded voice route unless USE_LOCAL_VOICE_PIPELINE is true", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_BASE_URL: "http://192.168.1.23:10000/v1",
            LOCAL_MODEL_RUNTIME_MODE: "local_adapter",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (..._args: any[]) =>
      jsonResponse({
        ok: true,
        item: {
          id: 10,
          intent: "assistant",
          category: "Other",
          raw_text: "backend transcript",
          details: "Backend voice answer.",
          source: "voice",
        },
        assistant: {
          text: "Backend voice answer.",
          english: "Backend voice answer.",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm, getClientRoutingDefaults } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;

    expect(getClientRoutingDefaults().voice).toBe("backend");
    await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    const voiceCalls = fetchCallsEndingWith(
      fetchMock,
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
    expect(voiceCalls).toHaveLength(1);
    expect(String(voiceCalls[0][0])).toBe(
      "https://api.example.test/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
  });

  it("returns the same nested voice contract from the local voice proxy", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_BASE_URL: "http://192.168.1.23:10000/v1",
            LOCAL_MODEL_RUNTIME_MODE: "local_adapter",
            USE_LOCAL_VOICE_PIPELINE: true,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn: vi.fn(async () => ({
        route: "reminder_create",
        source: "local_rules",
        cacheHit: false,
        intent: "reminder",
        title: "Standup",
        datetimeText: "tomorrow 9 AM",
        assistantText: "Okay, I can remind you about Standup.",
        englishText: "Okay, I can remind you about Standup.",
        meta: { parser: "test" },
      })),
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (..._args: any[]) =>
      jsonResponse({
        text: "remind me about standup tomorrow at 9 AM",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm, getClientRoutingDefaults } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;
    expect(getClientRoutingDefaults().voice).toBe("local");
    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    const localVoiceCalls = fetchCallsEndingWith(
      fetchMock,
      "/v1/audio/transcriptions",
    );
    expect(localVoiceCalls).toHaveLength(1);
    expect(String(localVoiceCalls[0][0])).toBe(
      "http://192.168.1.23:10000/v1/audio/transcriptions",
    );
    expect(payload.ok).toBe(true);
    expect(payload.item.intent).toBe("reminder");
    expect(payload.item.source).toBe("voice");
    expect(payload.item.datetime).toBe("tomorrow 9 AM");
    expect(payload.assistant.text).toContain("Standup");
    expect(payload.pipeline.route_taken).toBe("reminder_create");
  });

  it("defaults recorded voice to backend Sarvam route when native STT is missing", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn: vi.fn(async () => ({
        route: "local_answer",
        source: "local_model",
        cacheHit: false,
        intent: "assistant",
        assistantText: "Should not run without STT.",
        englishText: "Should not run without STT.",
        meta: {},
      })),
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (..._args: any[]) =>
      jsonResponse({
        ok: true,
        item: {
          id: 14,
          intent: "assistant",
          category: "Other",
          raw_text: "backend transcript",
          details: "Backend voice answer.",
          source: "voice",
        },
        assistant: { text: "Backend voice answer." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm, getClientRoutingDefaults } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;

    expect(getClientRoutingDefaults().voice).toBe("backend");
    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    expect(payload.ok).toBe(true);
    expect(payload.assistant.text).toBe("Backend voice answer.");
    const voiceCalls = fetchCallsEndingWith(
      fetchMock,
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
    expect(voiceCalls).toHaveLength(1);
    expect(String(voiceCalls[0][0])).toBe(
      "https://api.example.test/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
  });

  it("uses cloud voice fallback only after explicit consent", async () => {
    mockCachedProfile(null, { allowCloudFallback: true });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
            USE_LOCAL_VOICE_PIPELINE: true,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        item: {
          id: 12,
          intent: "assistant",
          category: "Other",
          raw_text: "cloud transcript",
          details: "Cloud voice answer.",
          source: "voice",
        },
        assistant: {
          text: "Cloud voice answer.",
          english: "Cloud voice answer.",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;

    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    const voiceCalls = fetchCallsEndingWith(
      fetchMock,
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
    expect(voiceCalls).toHaveLength(1);
    expect(String((voiceCalls[0] as any[])[0])).toBe(
      "https://api.example.test/api/transcribe-and-analyze?user_id=7&reply_language=en",
    );
    expect(payload.assistant.text).toBe("Cloud voice answer.");
    expect(payload.meta.cloudFallback.kind).toBe("cloud_voice_fallback");
  });

  it("does not leak raw native STT not-implemented errors to voice response", async () => {
    mockCachedProfile(null);
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
            LOCAL_ON_DEVICE_NATIVE_MODULE: "JaiOnDeviceModel",
            USE_LOCAL_VOICE_PIPELINE: true,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    (globalThis as any).__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__ = {
      isAvailable: vi.fn(async () => true),
      isSpeechToTextAvailable: vi.fn(async () => true),
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
      transcribeAudio: vi.fn(async () => {
        const error = new Error("JAI_NATIVE_STT_NOT_IMPLEMENTED");
        (error as any).code = "JAI_NATIVE_STT_NOT_IMPLEMENTED";
        throw error;
      }),
    };
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, assistant: { text: "Backend should not run." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;
    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    expect(payload.ok).toBe(false);
    expect(payload.assistant.text).toContain(
      "Local voice recognition is not available in this build yet.",
    );
    expect(JSON.stringify(payload)).not.toContain("JAI_NATIVE_STT_NOT_IMPLEMENTED");
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("calls native_on_device transcribeAudio before running the local voice assistant turn", async () => {
    mockCachedProfile(null);
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
            LOCAL_ON_DEVICE_NATIVE_MODULE: "JaiOnDeviceModel",
            USE_LOCAL_VOICE_PIPELINE: true,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "Native voice answer.",
      englishText: "Native voice answer.",
      meta: { runtime: "phone_local" },
    }));
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const transcribeAudio = vi.fn(async () => ({
      text: "please explain local voice",
      model: "whisper",
    }));
    (globalThis as any).__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__ = {
      isAvailable: vi.fn(async () => true),
      isSpeechToTextAvailable: vi.fn(async () => true),
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
      transcribeAudio,
    };

    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, assistant: { text: "Backend should not run." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostForm } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;
    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      form,
    );

    expect(transcribeAudio).toHaveBeenCalledWith({
      fileUri: "file:///tmp/audio.m4a",
      model: "whisper",
      language: "en",
    });
    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "please explain local voice",
      replyLanguage: "en",
      userAllowedCloudFallback: false,
    }));
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
    expect(payload.assistant.text).toBe("Native voice answer.");
    expect(payload.meta.stt.endpoint).toBe("JaiOnDeviceModel.transcribeAudio");
  });

  it("routes normal chat into the local agent pipeline by default before backend", async () => {
    mockCachedProfile(null);
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            USE_LOCAL_CHAT_PIPELINE: false,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "Local answer first.",
      englishText: "Local answer first.",
      meta: { runtime: "phone_local" },
    }));
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        assistant: { text: "Backend should not be called." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost, getClientRoutingDefaults } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
      reply_language: "en",
    });

    expect(getClientRoutingDefaults().chat).toBe("local");
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "Explain recursion",
      replyLanguage: "en",
      userAllowedCloudFallback: false,
    }));
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
    expect(payload.assistant.text).toBe("Local answer first.");
    expect(payload.meta.source).toBe("local_chat_proxy");
  });

  it("answers simple chat through the local quick-reply fast path", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "This should not run.",
      englishText: "This should not run.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, assistant: { text: "Backend should not run." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "What are you up to ?",
      reply_language: "en",
    });

    expect(payload.ok).toBe(true);
    expect(payload.meta.source).toBe("local_quick_reply");
    expect(payload.meta.fastPath).toBe(true);
    expect(payload.pipeline.route_taken).toBe("small_talk");
    expect(payload.pipeline.direct_answer_source).toBe("local_rules");
    expect(payload.assistant.text).toContain("right here with you");
    expect(runLocalAssistantTurn).not.toHaveBeenCalled();
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("emits startup telemetry with API base and routing mode", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          version: "9.8.7",
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: {
          getIdToken: vi.fn(async () => "test-token"),
        },
      },
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await import("../lib/api");
    await settleTelemetry();

    const startup = clientTurnLogBodies(fetchMock).reverse().find(
      (body) => body.event === "client_app_started",
    );
    expect(startup).toBeTruthy();
    expect(startup.api_base).toBe("https://api.example.test");
    expect(startup.app_version).toBe("9.8.7");
    expect(startup.chat_routing).toBe("local");
    expect(startup.voice_routing).toBe("backend");
  });

  it("emits local quick reply telemetry", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: {
          getIdToken: vi.fn(async () => "test-token"),
        },
      },
    }));
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn: vi.fn(async () => {
        throw new Error("localAgents should not run for quick replies");
      }),
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "What are you up to ?",
      reply_language: "en",
    });
    await settleTelemetry();

    const localTurn = clientTurnLogBodies(fetchMock).find(
      (body) => body.event === "client_local_turn_completed",
    );
    expect(localTurn).toBeTruthy();
    expect(localTurn.agent_source).toBe("local_rules");
    expect(localTurn.route_taken).toBe("small_talk");
    expect(localTurn.question).toBe("What are you up to ?");
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("does not break chat when client turn telemetry fails", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("telemetry offline");
    }));

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "What can you do?",
      reply_language: "en",
    });

    expect(payload.ok).toBe(true);
    expect(payload.meta.source).toBe("local_quick_reply");
    expect(payload.assistant.text).toBeTruthy();
  });

  it("answers identity through apiPost quick replies without backend fetch", async () => {
    mockCachedProfile({
      userId: 7,
      name: "Hari",
      assistantName: "Kani",
      replyLanguage: "ta",
    });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const localAgentsModuleLoaded = vi.fn();
    const runLocalAssistantTurn = vi.fn(async () => {
      throw new Error("localAgents should not be imported for quick replies");
    });
    vi.doMock("../lib/localAgents", () => {
      localAgentsModuleLoaded();
      return { runLocalAssistantTurn };
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, assistant: { text: "Backend should not run." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "who are you?",
      reply_language: "en",
    });

    expect(payload.ok).toBe(true);
    expect(payload.meta.source).toBe("local_quick_reply");
    expect(payload.pipeline.route_taken).toBe("identity");
    expect(payload.pipeline.direct_answer_source).toBe("local_rules");
    expect(payload.assistant.text).toContain("Kani");
    expect(payload.meta.responsePath).toBe("quick_reply");
    expect(payload.meta.stageTimings).toHaveProperty("quick_profile");
    expect(payload.pipeline.meta.responsePath).toBe("quick_reply");
    expect(localAgentsModuleLoaded).not.toHaveBeenCalled();
    expect(runLocalAssistantTurn).not.toHaveBeenCalled();
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("personalizes greeting quick replies from cached profile without importing localAgents", async () => {
    mockCachedProfile({
      userId: 7,
      name: "Hari",
      assistantName: "Kani",
      replyLanguage: "ta",
    });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const localAgentsModuleLoaded = vi.fn();
    vi.doMock("../lib/localAgents", () => {
      localAgentsModuleLoaded();
      return {
        runLocalAssistantTurn: vi.fn(async () => {
          throw new Error("localAgents should not be imported");
        }),
      };
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, assistant: { text: "Backend should not run." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "vanakkam",
    });

    expect(payload.meta.source).toBe("local_quick_reply");
    expect(payload.assistant.text).toContain("Hari");
    expect(payload.assistant.tamil).toBe(payload.assistant.text);
    expect(payload.pipeline.route_taken).toBe("fast_greeting");
    expect(payload.pipeline.tamil_text).toBe(payload.assistant.text);
    expect(localAgentsModuleLoaded).not.toHaveBeenCalled();
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps guest/no-profile local chat working and uses English for English input", async () => {
    mockCachedProfile(null);
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "English answer.",
      englishText: "English answer.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
    });

    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "Explain recursion",
      replyLanguage: "en",
      userAllowedCloudFallback: false,
    }));
    expect(payload.assistant.english).toBe("English answer.");
    expect(payload.assistant.tamil).toBeUndefined();
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
  });

  it("uses Tamil for Tamil-script local chat when no explicit language exists", async () => {
    mockCachedProfile(null);
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "தமிழ் பதில்.",
      englishText: "Tamil answer.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "நாளைக்கு என்ன செய்யலாம்?",
    });

    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "நாளைக்கு என்ன செய்யலாம்?",
      replyLanguage: "ta",
      userAllowedCloudFallback: false,
    }));
    expect(payload.assistant.tamil).toBe("தமிழ் பதில்.");
  });

  it("uses cached profile language and passes local-safe profile fields into local chat", async () => {
    mockCachedProfile({
      userId: 7,
      name: "Hari",
      place: "Chennai",
      assistantName: "Elli",
      replyLanguage: "ta",
      email: "private@example.test",
      avatarUrl: "https://example.test/avatar.png",
    });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "சரி Hari.",
      englishText: "Okay Hari.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));

    const { apiPost } = await import("../lib/api");
    await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
    });

    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "Explain recursion",
      replyLanguage: "ta",
      userAllowedCloudFallback: false,
      userProfile: {
        name: "Hari",
        place: "Chennai",
        assistantName: "Elli",
        replyLanguage: "ta",
      },
    }));
  });

  it("lets explicit request language override cached profile preference", async () => {
    mockCachedProfile({
      userId: 7,
      name: "Hari",
      place: "Chennai",
      assistantName: "Elli",
      replyLanguage: "ta",
    });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "English answer.",
      englishText: "English answer.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));

    const { apiPost } = await import("../lib/api");
    await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
      reply_language: "en",
    });

    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "Explain recursion",
      replyLanguage: "en",
      userAllowedCloudFallback: false,
      userProfile: {
        name: "Hari",
        place: "Chennai",
        assistantName: "Elli",
        replyLanguage: "en",
      },
    }));
  });

  it("passes explicit cloud fallback setting into local chat", async () => {
    mockCachedProfile(null, { allowCloudFallback: true });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "Local answer.",
      englishText: "Local answer.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));

    const { apiPost } = await import("../lib/api");
    await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
    });

    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "Explain recursion",
      replyLanguage: "en",
      userAllowedCloudFallback: true,
    }));
  });

  it("passes cached profile fields into the local voice assistant turn", async () => {
    mockCachedProfile({
      userId: 7,
      name: "Hari",
      place: "Madurai",
      assistantName: "Elli",
      replyLanguage: "en",
    });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
            LOCAL_ON_DEVICE_NATIVE_MODULE: "JaiOnDeviceModel",
            USE_LOCAL_VOICE_PIPELINE: true,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "weather",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "Weather answer.",
      englishText: "Weather answer.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({ runLocalAssistantTurn }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transcribeAudio = vi.fn(async () => ({
      text: "what is the weather",
      model: "whisper",
    }));
    (globalThis as any).__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__ = {
      isAvailable: vi.fn(async () => true),
      isSpeechToTextAvailable: vi.fn(async () => true),
      initialize: vi.fn(async () => ({ ok: true })),
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
      transcribeAudio,
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));

    const { apiPostForm } = await import("../lib/api");
    const form = {
      _parts: [
        [
          "file",
          {
            uri: "file:///tmp/audio.m4a",
            name: "audio.m4a",
            type: "audio/m4a",
          },
        ],
      ],
    } as unknown as FormData;
    await apiPostForm<any>("/api/transcribe-and-analyze?user_id=7", form);

    expect(transcribeAudio).toHaveBeenCalledWith({
      fileUri: "file:///tmp/audio.m4a",
      model: "whisper",
      language: "en",
    });
    expect(runLocalAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      message: "what is the weather",
      replyLanguage: "en",
      userAllowedCloudFallback: false,
      userProfile: {
        name: "Hari",
        place: "Madurai",
        assistantName: "Elli",
        replyLanguage: "en",
      },
    }));
  });


  it("falls back to backend chat when native_on_device runtime is unavailable and cloud fallback is enabled", async () => {
    mockCachedProfile(null, { allowCloudFallback: true });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    const runLocalAssistantTurn = vi.fn(async () => {
      const error = new Error("Native on-device model runtime is not linked");
      (error as any).code = "NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE";
      throw error;
    });
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        item: {
          id: 501,
          intent: "assistant",
          category: "Other",
          raw_text: "Explain recursion",
          details: "Backend fallback answer.",
          source: "text",
        },
        assistant: { text: "Backend fallback answer.", english: "Backend fallback answer." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost, getClientRoutingDefaults } = await import("../lib/api");

    expect(getClientRoutingDefaults().localRuntimeMode).toBe("native_on_device");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
      reply_language: "en",
    });
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    const chatCalls = backendChatCalls(fetchMock);
    expect(chatCalls).toHaveLength(1);
    expect(payload.assistant.text).toBe("Backend fallback answer.");
    expect(payload.meta.source).toBe("backend_openai_fallback");
    expect(payload.meta.fallback_reason).toBe("local_model_unavailable");
  });

  it("falls back to backend chat when model download/setup fails and cloud fallback is enabled", async () => {
    mockCachedProfile(null, { allowCloudFallback: true });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
            LOCAL_MODEL_DELIVERY_MODE: "download_on_first_launch",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => {
      const error = new Error("Required local GGUF model download failed");
      (error as any).code = "NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE";
      (error as any).setupCode = "LOCAL_MODEL_SETUP_ERROR";
      throw error;
    });
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        item: {
          id: 502,
          intent: "assistant",
          category: "Other",
          raw_text: "Explain recursion",
          details: "Backend model fallback.",
          source: "text",
        },
        assistant: { text: "Backend model fallback." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain recursion",
      reply_language: "en",
    });
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    expect(payload.assistant.text).toBe("Backend model fallback.");
    expect(payload.meta.fallback_reason).toBe("local_model_unavailable");
  });

  it("falls back to backend chat when local chat times out and cloud fallback is enabled", async () => {
    mockCachedProfile(null, { allowCloudFallback: true });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => {
      const error = new Error("Local on-device inference timed out after 60000ms.");
      (error as any).code = "LOCAL_TURN_TIMEOUT";
      throw error;
    });
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        item: {
          id: 503,
          intent: "assistant",
          category: "Other",
          raw_text: "Do you know about ipl ?",
          details: "IPL is a professional Twenty20 cricket league in India.",
          source: "text",
        },
        assistant: { text: "IPL is a professional Twenty20 cricket league in India." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Do you know about ipl ?",
      reply_language: "en",
    });
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(backendChatCalls(fetchMock)).toHaveLength(1);
    expect(payload.assistant.text).toContain("IPL");
    expect(payload.assistant.text).not.toContain("check the local AI files");
    expect(payload.meta.source).toBe("backend_openai_fallback");
    expect(payload.meta.fallback_reason).toBe("local_timeout");
  });

  it("emits backend fallback started and completed telemetry", async () => {
    mockCachedProfile(null, { allowCloudFallback: true });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: {
          getIdToken: vi.fn(async () => "test-token"),
        },
      },
    }));
    const runLocalAssistantTurn = vi.fn(async () => {
      const error = new Error("Local on-device inference timed out after 60000ms.");
      (error as any).code = "LOCAL_TURN_TIMEOUT";
      throw error;
    });
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/client/turn-log")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        ok: true,
        item: {
          id: 504,
          intent: "assistant",
          category: "Other",
          raw_text: "Do you know about ipl ?",
          details: "IPL is a professional Twenty20 cricket league in India.",
          source: "text",
        },
        assistant: { text: "IPL is a professional Twenty20 cricket league in India." },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Do you know about ipl ?",
      reply_language: "en",
    });
    await settleTelemetry();

    const events = clientTurnLogBodies(fetchMock);
    expect(events.some((body) => body.event === "client_backend_fallback_started")).toBe(true);
    const completed = events.find((body) => body.event === "client_backend_fallback_completed");
    expect(completed).toBeTruthy();
    expect(completed.agent_source).toBe("backend_openai");
    expect(completed.route_taken).toBe("fallback_openai");
    expect(completed.fallback_reason).toBe("local_timeout");
    expect(completed.answer).toContain("IPL");
  });

  it("shows cloud fallback consent when local chat times out and cloud fallback is disabled", async () => {
    mockCachedProfile(null, { allowCloudFallback: false });
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: { currentUser: null },
    }));
    const runLocalAssistantTurn = vi.fn(async () => {
      const error = new Error("Local on-device inference timed out after 60000ms.");
      (error as any).code = "LOCAL_TURN_TIMEOUT";
      throw error;
    });
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { CLOUD_FALLBACK_CONSENT_MESSAGE, apiPost } = await import("../lib/api");
    const payload = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Do you know about ipl ?",
      reply_language: "en",
    });

    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(backendChatCalls(fetchMock)).toHaveLength(0);
    expect(payload.assistant.text).toBe(CLOUD_FALLBACK_CONSENT_MESSAGE);
    expect(payload.assistant.text).not.toContain("check the local AI files");
    expect(payload.meta.fallback_reason).toBe("local_timeout");
  });

  it("lets explicit backend fallback bypass the local chat interceptor", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            USE_LOCAL_CHAT_PIPELINE: true,
          },
        },
      },
    }));
    vi.doMock("../lib/firebase", () => ({
      auth: {
        currentUser: null,
      },
    }));
    const runLocalAssistantTurn = vi.fn(async () => ({
      route: "local_answer",
      source: "local_model",
      cacheHit: false,
      intent: "assistant",
      assistantText: "Local answer should not run here.",
      englishText: "Local answer should not run here.",
      meta: {},
    }));
    vi.doMock("../lib/localAgents", () => ({
      runLocalAssistantTurn,
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (..._args: any[]) =>
      jsonResponse({
        ok: true,
        assistant: { text: "Backend fallback answer." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostBackendOnly, getClientRoutingDefaults } = await import(
      "../lib/api"
    );
    const payload = await apiPostBackendOnly<any>("/api/chat", {
      user_id: 7,
      message: "Use fallback",
      reply_language: "en",
    });

    expect(getClientRoutingDefaults().chat).toBe("local");
    expect(runLocalAssistantTurn).not.toHaveBeenCalled();
    const chatCalls = backendChatCalls(fetchMock);
    expect(chatCalls).toHaveLength(1);
    expect(String(chatCalls[0][0])).toBe("https://api.example.test/api/chat");
    expect(payload.assistant.text).toBe("Backend fallback answer.");
  });
});
