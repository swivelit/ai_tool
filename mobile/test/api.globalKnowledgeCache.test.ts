import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
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

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        API_BASE: "https://api.example.test",
        USE_LOCAL_CHAT_PIPELINE: false,
      },
    },
  },
}));

vi.mock("../lib/firebase", () => ({
  auth: { currentUser: null },
}));

vi.mock("../lib/chatTelemetry", () => ({
  enqueueClientTurnLog: vi.fn(async () => undefined),
  flushClientTurnLogs: vi.fn(async () => undefined),
  updateActiveWorkflowStep: vi.fn(async () => undefined),
}));

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
      route_taken: "openai_general",
      direct_answer_source: "openai",
    },
    meta: {
      route: "openai_general",
      source: "openai",
    },
  };
}

function seedSyncedEntry(overrides: Record<string, any> = {}) {
  storage.set(
    "global_knowledge_cache_v1",
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: "compiler",
          scope: "global",
          canonicalQuestion: "What is a compiler?",
          normalizedQuestion: "what is a compiler",
          aliases: ["explain compiler"],
          answer: "A compiler translates source code.",
          answerLanguage: "en",
          embedding: [],
          embeddingNorm: 0,
          confidence: 1,
          safetyLabel: "general",
          updatedAt: "2026-05-01T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
          ...overrides,
        },
      ],
    }),
  );
}

function installFetchMock(answer = "Backend answer.") {
  const fetchMock = vi.fn(async (url: string) => {
    const target = String(url);
    if (target.includes("/api/global-knowledge/sync")) {
      return jsonResponse({
        ok: true,
        serverTime: "2026-05-22T00:00:00Z",
        entries: [],
        userEntries: [],
        revokedIds: [],
        hasMore: false,
      });
    }
    return jsonResponse(backendPayload(answer));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/chat"));
}

async function waitForSyncFetch(fetchMock: ReturnType<typeof vi.fn>) {
  for (let index = 0; index < 20; index += 1) {
    if (fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/global-knowledge/sync"))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("api synced global knowledge cache", () => {
  beforeEach(() => {
    storage.clear();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("serves a confident synced hit before calling the backend", async () => {
    seedSyncedEntry();
    const fetchMock = installFetchMock();
    const { apiPost } = await import("../lib/api");

    const response = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "Explain compiler",
      reply_language: "en",
      request_id: "cache_hit",
    });

    expect(response.assistant.text).toContain("translates source code");
    expect(response.pipeline.route_taken).toBe("global_knowledge_cache");
    expect(response.meta.cacheHit).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bypasses local cache for live/current questions", async () => {
    seedSyncedEntry({
      canonicalQuestion: "latest IPL score today",
      normalizedQuestion: "latest ipl score today",
      aliases: [],
      answer: "Stale score.",
    });
    const fetchMock = installFetchMock("Fresh backend answer.");
    const { apiPost } = await import("../lib/api");

    const response = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "latest IPL score today",
      reply_language: "en",
    });

    expect(response.assistant.text).toBe("Fresh backend answer.");
    expect(chatCalls(fetchMock)).toHaveLength(1);
  });

  it("calls backend when synced similarity is too low", async () => {
    seedSyncedEntry();
    const fetchMock = installFetchMock("Photosynthesis backend answer.");
    const { apiPost } = await import("../lib/api");

    const response = await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "What is photosynthesis?",
      reply_language: "en",
    });

    expect(response.assistant.text).toBe("Photosynthesis backend answer.");
    expect(chatCalls(fetchMock)).toHaveLength(1);
  });

  it("requests lightweight global sync after successful backend chat", async () => {
    const fetchMock = installFetchMock("Backend answer.");
    const { apiPost } = await import("../lib/api");

    await apiPost<any>("/api/chat", {
      user_id: 7,
      message: "What is recursion?",
      reply_language: "en",
    });
    await waitForSyncFetch(fetchMock);

    expect(chatCalls(fetchMock)).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/global-knowledge/sync?limit=25")),
    ).toBe(true);
  });
});
