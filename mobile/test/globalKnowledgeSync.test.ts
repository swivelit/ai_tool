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

    const hit = await lookupSyncedGlobalKnowledge("Explain fistula", {
      embedTexts: async () => {
        throw new Error("embedding unavailable");
      },
    });

    expect(hit?.entry.answer).toContain("abnormal connection");
    expect(hit?.source).toBe("lexical");
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
});
