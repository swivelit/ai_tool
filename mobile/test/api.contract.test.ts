import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
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

  it("does not make backend primary when the legacy voice pipeline flag is disabled", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            USE_LOCAL_VOICE_PIPELINE: false,
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
    expect(payload.kind).toBe("cloud_consent_required");
    expect(payload.assistant.text).toContain(
      "Local voice recognition is not available in this build yet.",
    );
    expect(JSON.stringify(payload)).not.toContain("JAI_NATIVE_STT_NOT_IMPLEMENTED");
    expect(fetchMock).not.toHaveBeenCalled();
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://192.168.1.23:10000/v1/audio/transcriptions",
    );
    expect(payload.ok).toBe(true);
    expect(payload.item.intent).toBe("reminder");
    expect(payload.item.source).toBe("voice");
    expect(payload.item.datetime).toBe("tomorrow 9 AM");
    expect(payload.assistant.text).toContain("Standup");
    expect(payload.pipeline.route_taken).toBe("reminder_create");
  });

  it("defaults recorded voice to native local-first and does not silently call backend when native STT is missing", async () => {
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

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        assistant: { text: "Backend should not be called." },
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

    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe("cloud_consent_required");
    expect(payload.meta.voice).toMatchObject({
      kind: "cloud_consent_required",
      suggestedAction: "ask_user_consent",
      localAnswerAvailable: false,
    });
    expect(payload.assistant.text).toContain(
      "Local voice recognition is not available in this build yet.",
    );
    expect(JSON.stringify(payload)).not.toContain("speech-to-text bridge");
    expect(fetchMock).not.toHaveBeenCalled();
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as any[])[0])).toBe(
      "https://api.example.test/transcribe-and-analyze?user_id=7&reply_language=en",
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
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.assistant.text).toBe("Local answer first.");
    expect(payload.meta.source).toBe("local_chat_proxy");
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
    expect(fetchMock).not.toHaveBeenCalled();
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


  it("does not silently call backend when native_on_device runtime is unavailable", async () => {
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
        assistant: { text: "Backend should not be called." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost, getClientRoutingDefaults } = await import("../lib/api");

    expect(getClientRoutingDefaults().localRuntimeMode).toBe("native_on_device");
    await expect(
      apiPost<any>("/api/chat", {
        user_id: 7,
        message: "Explain recursion",
        reply_language: "en",
      }),
    ).rejects.toThrow("Native on-device model runtime is not linked");
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not silently call backend when model download/setup fails", async () => {
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
      jsonResponse({ ok: true, assistant: { text: "Backend should not be called." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    await expect(
      apiPost<any>("/api/chat", {
        user_id: 7,
        message: "Hello",
        reply_language: "en",
      }),
    ).rejects.toThrow("Required local GGUF model download failed");
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not silently call backend or TTS when local chat times out", async () => {
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
      jsonResponse({ ok: true, assistant: { text: "Backend should not be called." } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("../lib/api");
    await expect(
      apiPost<any>("/api/chat", {
        user_id: 7,
        message: "Hello",
        reply_language: "en",
      }),
    ).rejects.toThrow("timed out");
    expect(runLocalAssistantTurn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.example.test/api/chat",
    );
    expect(payload.assistant.text).toBe("Backend fallback answer.");
  });
});
