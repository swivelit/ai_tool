import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe("API client contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("canonicalizes the legacy voice analyze path before calling the backend", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            USE_LOCAL_VOICE_PIPELINE: false,
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
    const payload = await apiPostForm<any>(
      "/api/transcribe-and-analyze?user_id=7&reply_language=en",
      new FormData(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.test/transcribe-and-analyze?user_id=7&reply_language=en",
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
    expect(payload.ok).toBe(true);
    expect(payload.item.source).toBe("voice");
    expect(payload.assistant.text).toBe("Hello.");
  });

  it("returns the same nested voice contract from the local voice proxy", async () => {
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            API_BASE: "https://api.example.test",
            LOCAL_MODEL_BASE_URL: "http://192.168.1.23:10000/v1",
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

  it("routes normal chat into the local agent pipeline by default before backend", async () => {
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
    expect(runLocalAssistantTurn).toHaveBeenCalledWith({
      userId: 7,
      message: "Explain recursion",
      replyLanguage: "en",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.assistant.text).toBe("Local answer first.");
    expect(payload.meta.source).toBe("local_chat_proxy");
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

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        assistant: { text: "Backend fallback answer." },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPostBackendOnly, getClientRoutingDefaults } = await import("../lib/api");
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
