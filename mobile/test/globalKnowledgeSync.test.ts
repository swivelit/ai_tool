import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
const apiGetMock = vi.hoisted(() => vi.fn());

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

function unitEmbedding() {
  const out = new Array(96).fill(0);
  out[0] = 1;
  return out;
}

describe("global knowledge sync", () => {
  beforeEach(() => {
    storage.clear();
    apiGetMock.mockReset();
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
    expect(store.entries[0].answer).toContain("compiler");
    expect(apiGetMock).toHaveBeenCalledWith("/api/global-knowledge/sync?limit=250");
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
    expect(hit?.source).toBe("lexical");
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
    expect(hit?.source).toBe("lexical");
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

  it("ignores incompatible synced embedding vectors and rebuilds token-hash embeddings from safe text", async () => {
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

    expect(store.entries[0].embeddingKind).toBe("token_hash_v1");
    expect(store.entries[0].embedding).toHaveLength(96);
    expect(store.entries[0].embedding).not.toEqual([1, 0, 0]);
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
});
