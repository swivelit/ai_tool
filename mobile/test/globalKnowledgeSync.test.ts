import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
const apiGetMock = vi.hoisted(() => vi.fn());
const enqueueClientTurnLogMock = vi.hoisted(() => vi.fn(async () => undefined));

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

vi.mock("../lib/api", () => ({
  apiGet: apiGetMock,
}));

vi.mock("../lib/chatTelemetry", () => ({
  enqueueClientTurnLog: enqueueClientTurnLogMock,
}));

function unitEmbedding() {
  const out = new Array(96).fill(0);
  out[0] = 1;
  return out;
}

describe("global knowledge sync", () => {
  beforeEach(() => {
    storage.clear();
    apiGetMock.mockReset();
    enqueueClientTurnLogMock.mockClear();
  });

  it("stores sync endpoint responses locally", async () => {
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      serverTime: "2026-05-14T00:00:00Z",
      entries: [
        {
          id: 7,
          canonicalQuestion: "What is a compiler?",
          normalizedQuestion: "what is a compiler",
          answer: "A compiler translates source code.",
          answerLanguage: "en",
          embedding: unitEmbedding(),
          embeddingKind: "token_hash_v1",
          embeddingNorm: 1,
          confidence: 0.95,
          safetyLabel: "general",
          updatedAt: "2026-05-14T00:00:00Z",
        },
      ],
    });

    const { loadGlobalKnowledgeStore, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    const result = await syncGlobalKnowledge();
    const store = await loadGlobalKnowledgeStore();

    expect(result.synced).toBe(1);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].scope).toBe("global");
    expect(store.entries[0].answer).toContain("compiler");
    expect(apiGetMock).toHaveBeenCalledWith("/api/global-knowledge/sync?limit=250");
  });

  it("stores same-user sync entries with user scope", async () => {
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      serverTime: "2026-05-14T00:00:00Z",
      entries: [],
      userEntries: [
        {
          id: "user:42",
          scope: "user",
          canonicalQuestion: "What is Spitzola?",
          normalizedQuestion: "what is spitzola",
          answer: "Spitzola is a fictional pizza-style test answer.",
          answerLanguage: "en",
          embedding: unitEmbedding(),
          embeddingKind: "token_hash_v1",
          embeddingNorm: 1,
          confidence: 1,
          safetyLabel: "general",
          source: { kind: "user_qa_cache", hits: 2 },
          updatedAt: "2026-05-14T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
    });

    const { loadGlobalKnowledgeStore, lookupSyncedGlobalKnowledge, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    const result = await syncGlobalKnowledge({ force: true });
    const store = await loadGlobalKnowledgeStore();

    expect(result.synced).toBe(1);
    expect(store.entries[0].id).toBe("user:42");
    expect(store.entries[0].scope).toBe("user");
    expect(store.entries[0].source).toMatchObject({ kind: "user_qa_cache" });
    expect((await lookupSyncedGlobalKnowledge("Tell me about Spitzola"))?.entry.scope).toBe("user");
  });

  it("syncs multiple cursor pages without missing entries", async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({
      id: index + 1,
      canonicalQuestion: `What is paged concept ${index + 1}?`,
      normalizedQuestion: `what is paged concept ${index + 1}`,
      answer: `Paged answer ${index + 1}.`,
      answerLanguage: "en",
      embedding: [],
      embeddingKind: "token_hash_v1",
      embeddingNorm: 0,
      confidence: 0.95,
      safetyLabel: "general",
      updatedAt: `2026-05-14T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    }));
    apiGetMock
      .mockResolvedValueOnce({
        ok: true,
        serverTime: "2026-05-14T00:10:00Z",
        entries: entries.slice(0, 250),
        nextSince: entries[249].updatedAt,
        nextAfterId: 250,
        hasMore: true,
        revokedIds: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        serverTime: "2026-05-14T00:10:01Z",
        entries: entries.slice(250, 500),
        nextSince: entries[499].updatedAt,
        nextAfterId: 500,
        hasMore: true,
        revokedIds: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        serverTime: "2026-05-14T00:10:02Z",
        entries: entries.slice(500),
        nextSince: entries[599].updatedAt,
        nextAfterId: 600,
        hasMore: false,
        revokedIds: [],
      });

    const { loadGlobalKnowledgeStore, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    const result = await syncGlobalKnowledge();
    const store = await loadGlobalKnowledgeStore();

    expect(result.synced).toBe(600);
    expect(result.pages).toBe(3);
    expect(store.entries).toHaveLength(600);
    expect(new Set(store.entries.map((entry) => entry.id)).size).toBe(600);
    expect(apiGetMock).toHaveBeenCalledTimes(3);
    expect(String(apiGetMock.mock.calls[1][0])).toContain("since=");
    expect(String(apiGetMock.mock.calls[1][0])).toContain("afterId=250");
    expect(String(apiGetMock.mock.calls[2][0])).toContain("afterId=500");
  });

  it("removes locally cached entries when sync returns revoked ids", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, loadGlobalKnowledgeStore, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "7",
            canonicalQuestion: "What is a compiler?",
            normalizedQuestion: "what is compiler",
            answer: "Old approved answer.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 0.93,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      serverTime: "2026-05-14T00:05:00Z",
      entries: [],
      revokedIds: [7],
      nextSince: "2026-05-14T00:05:00Z",
      nextAfterId: 7,
      hasMore: false,
    });

    await syncGlobalKnowledge({ force: true });
    const store = await loadGlobalKnowledgeStore();

    expect(store.entries).toHaveLength(0);
  });

  it("finds a similar question from synced knowledge without embeddings", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "compiler",
            canonicalQuestion: "What is a compiler?",
            normalizedQuestion: "what is compiler",
            answer: "Cached compiler answer.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 0.93,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );

    const hit = await lookupSyncedGlobalKnowledge("Explain compiler");

    expect(hit?.entry.answer).toBe("Cached compiler answer.");
    expect(hit?.source).toBe("embedding");
  });

  it("does not crash on empty or malformed local cache", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    expect(await lookupSyncedGlobalKnowledge("Explain compilers")).toBeNull();
    storage.set(GLOBAL_KNOWLEDGE_CACHE_KEY, "{not-json");
    await expect(lookupSyncedGlobalKnowledge("Explain compilers")).resolves.toBeNull();
  });

  it("falls back safely when embedding lookup fails", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "fistula",
            canonicalQuestion: "What is fistula?",
            normalizedQuestion: "what is fistula",
            answer: "A fistula is an abnormal connection.",
            answerLanguage: "en",
            embedding: unitEmbedding(),
            embeddingNorm: 1,
            confidence: 0.93,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );

    const embedTexts = vi.fn(async () => {
        throw new Error("embedding unavailable");
    });
    const hit = await lookupSyncedGlobalKnowledge("Explain fistula", { embedTexts });

    expect(hit?.entry.answer).toContain("abnormal connection");
    expect(hit?.source).toBe("embedding");
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("bypasses live/current queries", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "ipl",
            canonicalQuestion: "latest IPL score today",
            normalizedQuestion: "latest ipl score today",
            answer: "Stale score.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 1,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );

    expect(await lookupSyncedGlobalKnowledge("latest IPL score today")).toBeNull();
  });

  it("respects user entry expiry and safety labels", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "user:expired",
            scope: "user",
            canonicalQuestion: "What is old concept?",
            normalizedQuestion: "what is old concept",
            answer: "Expired answer.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 1,
            safetyLabel: "general",
            updatedAt: "2026-05-01T00:00:00Z",
            expiresAt: "2001-01-01T00:00:00Z",
          },
          {
            id: "user:private",
            scope: "user",
            canonicalQuestion: "What is my secret?",
            normalizedQuestion: "what is my secret",
            answer: "Private answer.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 1,
            safetyLabel: "private",
            updatedAt: "2026-05-01T00:00:00Z",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        ],
      }),
    );

    expect(await lookupSyncedGlobalKnowledge("What is old concept?")).toBeNull();
    expect(await lookupSyncedGlobalKnowledge("What is my secret?")).toBeNull();
  });

  it("avoids returning answers in the wrong reply language", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "compiler-en",
            canonicalQuestion: "What is a compiler?",
            normalizedQuestion: "what is a compiler",
            answer: "A compiler translates source code.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 1,
            safetyLabel: "general",
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
      }),
    );

    expect(await lookupSyncedGlobalKnowledge("Explain compiler", { replyLanguage: "ta" })).toBeNull();
    expect((await lookupSyncedGlobalKnowledge("Explain compiler", { replyLanguage: "en" }))?.entry.answer).toContain("compiler");
  });

  it("bypasses expanded live, price, weather, and recommendation queries", async () => {
    const { isLiveOrCurrentGlobalKnowledgeQuestion } = await import("../lib/globalKnowledgeSync");

    expect(isLiveOrCurrentGlobalKnowledgeQuestion("weather tomorrow")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("USD INR exchange rate")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("best phone deal near me")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("new election details")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("election results")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("latest government update")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("prime minister news")).toBe(true);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("What is IPL?")).toBe(false);
    expect(isLiveOrCurrentGlobalKnowledgeQuestion("What is photosynthesis?")).toBe(false);
  });

  it("bypasses political/current synced entries but still serves stable IPL knowledge", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "election",
            canonicalQuestion: "election results",
            normalizedQuestion: "election results",
            answer: "Stale election answer.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 1,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
          {
            id: "ipl",
            canonicalQuestion: "What is IPL?",
            normalizedQuestion: "what is ipl",
            aliases: ["what is indian premier league"],
            answer: "The Indian Premier League is a professional Twenty20 cricket league in India.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 0.93,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );

    expect(await lookupSyncedGlobalKnowledge("new election details")).toBeNull();
    expect(await lookupSyncedGlobalKnowledge("election results")).toBeNull();
    expect((await lookupSyncedGlobalKnowledge("What is IPL?"))?.entry.answer).toContain("Twenty20");
    expect((await lookupSyncedGlobalKnowledge("Tell me about Indian Premier League"))?.entry.answer).toContain("Twenty20");
  });

  it("matches synced aliases and still bypasses live alias queries", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "ipl",
            canonicalQuestion: "What is IPL?",
            normalizedQuestion: "what is ipl",
            aliases: ["what is indian premier league"],
            observedSafeQuestions: ["explain ipl"],
            answer: "The Indian Premier League is a professional Twenty20 cricket league in India.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 0.93,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );

    const hit = await lookupSyncedGlobalKnowledge("Tell me about Indian Premier League");

    expect(hit?.entry.answer).toContain("Twenty20");
    expect(await lookupSyncedGlobalKnowledge("latest Indian Premier League score")).toBeNull();
  });

  it("uses local token-hash embeddings for synced global knowledge", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, lookupSyncedGlobalKnowledge, tokenHashEmbedding } = await import("../lib/globalKnowledgeSync");
    const embedding = tokenHashEmbedding("what is a compiler");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "compiler",
            canonicalQuestion: "What is a compiler?",
            normalizedQuestion: "what is a compiler",
            answer: "A compiler translates source code.",
            answerLanguage: "en",
            embedding,
            embeddingKind: "token_hash_v1",
            embeddingNorm: Math.sqrt(embedding.reduce((sum, value) => sum + value ** 2, 0)),
            confidence: 0.95,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );
    const embedTexts = vi.fn(async () => [unitEmbedding()]);

    const hit = await lookupSyncedGlobalKnowledge("compiler", {
      embedTexts,
      minSimilarity: 0.2,
    });

    expect(hit?.entry.answer).toContain("translates");
    expect(hit?.source).toBe("embedding");
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("preserves supplied real synced embeddings and stores token-hash fallback fields", async () => {
    const { loadGlobalKnowledgeStore, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      serverTime: "2026-05-14T00:00:00Z",
      entries: [
        {
          id: "native-vector",
          canonicalQuestion: "What is a compiler?",
          normalizedQuestion: "what is a compiler",
          answer: "A compiler translates source code.",
          answerLanguage: "en",
          embedding: [1, 0, 0],
          embeddingKind: "native_qwen_embedding_v1",
          embeddingNorm: 1,
          confidence: 0.95,
          safetyLabel: "general",
          updatedAt: "2026-05-14T00:00:00Z",
        },
      ],
    });

    await syncGlobalKnowledge();
    const store = await loadGlobalKnowledgeStore();

    expect(store.entries[0].embeddingKind).toBe("native_qwen_embedding_v1");
    expect(store.entries[0].embedding).toEqual([1, 0, 0]);
    expect(store.entries[0].tokenHashEmbeddingKind).toBe("token_hash_v1");
    expect(store.entries[0].tokenHashEmbedding).toHaveLength(96);
  });

  it("throttles repeated sync calls", async () => {
    const { syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      serverTime: "2026-05-14T00:00:00Z",
      entries: [],
    });

    const first = await syncGlobalKnowledge();
    const second = await syncGlobalKnowledge();

    expect(first.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("throttled");
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw or clear cache when backend schema is not ready", async () => {
    const { GLOBAL_KNOWLEDGE_CACHE_KEY, GLOBAL_KNOWLEDGE_SYNC_META_KEY, loadGlobalKnowledgeStore, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    storage.set(
      GLOBAL_KNOWLEDGE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "existing",
            canonicalQuestion: "What is cached?",
            normalizedQuestion: "what is cached",
            answer: "Keep me.",
            answerLanguage: "en",
            embedding: [],
            embeddingNorm: 0,
            confidence: 0.9,
            safetyLabel: "general",
            updatedAt: "2026-05-14T00:00:00Z",
          },
        ],
      }),
    );
    apiGetMock.mockResolvedValueOnce({
      ok: false,
      schemaReady: false,
      entries: [],
      revokedIds: [],
      hasMore: false,
      count: 0,
      error: "global_qa_schema_not_ready",
      missingTables: ["global_qa_cache"],
    });

    const result = await syncGlobalKnowledge({ force: true });
    const store = await loadGlobalKnowledgeStore();
    const meta = JSON.parse(storage.get(GLOBAL_KNOWLEDGE_SYNC_META_KEY) || "{}");

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("schema_not_ready");
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].answer).toBe("Keep me.");
    expect(meta.lastAttemptAt).toBeTruthy();
    expect(enqueueClientTurnLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "client_global_knowledge_sync_failed",
        global_sync_status: "schema_not_ready",
        db_schema_ready: false,
      }),
    );
  });

  it("does not throw on 500/503/network sync failures and emits failure telemetry", async () => {
    const { GLOBAL_KNOWLEDGE_SYNC_META_KEY, syncGlobalKnowledge } = await import("../lib/globalKnowledgeSync");
    const error = new Error("GET failed: 503");
    (error as any).name = "ApiError";
    (error as any).status = 503;
    apiGetMock.mockRejectedValueOnce(error);

    const result = await syncGlobalKnowledge({ force: true });
    const meta = JSON.parse(storage.get(GLOBAL_KNOWLEDGE_SYNC_META_KEY) || "{}");

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("sync_failed");
    expect(meta.lastAttemptAt).toBeTruthy();
    expect(enqueueClientTurnLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "client_global_knowledge_sync_failed",
        http_status: 503,
        error_type: "ApiError",
      }),
    );
  });
});
