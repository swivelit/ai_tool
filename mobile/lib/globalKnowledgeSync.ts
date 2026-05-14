import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiGet } from "./api";

export const GLOBAL_KNOWLEDGE_CACHE_KEY = "global_knowledge_cache_v1";
export const GLOBAL_KNOWLEDGE_SYNC_META_KEY = "global_knowledge_sync_meta_v1";

type SyncEntryPayload = {
  id?: number | string;
  canonicalQuestion?: string;
  normalizedQuestion?: string;
  answer?: string;
  answerLanguage?: string;
  topic?: string | null;
  answerHash?: string;
  embedding?: number[];
  embeddingNorm?: number;
  confidence?: number;
  safetyLabel?: string;
  updatedAt?: string | null;
  expiresAt?: string | null;
};

type SyncPayload = {
  ok?: boolean;
  entries?: SyncEntryPayload[];
  serverTime?: string;
  count?: number;
};

export type GlobalKnowledgeEntry = {
  id: string;
  canonicalQuestion: string;
  normalizedQuestion: string;
  answer: string;
  answerLanguage: "en" | "ta" | string;
  topic?: string | null;
  answerHash?: string;
  embedding: number[];
  embeddingNorm: number;
  confidence: number;
  safetyLabel: string;
  updatedAt: string;
  expiresAt?: string | null;
};

export type GlobalKnowledgeStore = {
  version: number;
  entries: GlobalKnowledgeEntry[];
  updatedAt?: string | null;
};

export type GlobalKnowledgeSyncMeta = {
  since?: string | null;
  updatedAt?: string | null;
};

export type GlobalKnowledgeLookupHit = {
  entry: GlobalKnowledgeEntry;
  score: number;
  source: "embedding" | "lexical";
};

const LIVE_TERMS = new Set([
  "latest",
  "today",
  "current",
  "live",
  "score",
  "scores",
  "news",
  "breaking",
  "now",
]);

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "are",
  "can",
  "could",
  "do",
  "does",
  "explain",
  "for",
  "give",
  "how",
  "i",
  "is",
  "know",
  "me",
  "of",
  "please",
  "tell",
  "the",
  "to",
  "what",
  "whats",
  "why",
  "you",
]);

function nowIso() {
  return new Date().toISOString();
}

export function normalizeGlobalKnowledgeQuestion(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticTokens(value: unknown) {
  const normalized = normalizeGlobalKnowledgeQuestion(value);
  const seen = new Set<string>();
  const tokens: string[] = [];
  normalized.split(/\s+/).forEach((raw) => {
    let token = raw.trim();
    if (!token || STOPWORDS.has(token)) return;
    if (token.length > 4 && token.endsWith("s")) {
      token = token.slice(0, -1);
    }
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  });
  return tokens;
}

export function isLiveOrCurrentGlobalKnowledgeQuestion(value: unknown) {
  const tokens = semanticTokens(value);
  return tokens.some((token) => LIVE_TERMS.has(token));
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function vectorNorm(vector: number[]) {
  return Math.sqrt(vector.reduce((sum, value) => sum + Number(value || 0) ** 2, 0));
}

function cosine(left: number[], leftNorm: number, right: number[], rightNorm: number) {
  if (!left.length || !right.length) return 0;
  const normA = leftNorm || vectorNorm(left);
  const normB = rightNorm || vectorNorm(right);
  if (!normA || !normB) return 0;
  let dot = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    dot += Number(left[i] || 0) * Number(right[i] || 0);
  }
  return Math.max(0, Math.min(1, dot / (normA * normB)));
}

function lexicalSimilarity(left: string, right: string) {
  const leftTokens = new Set(semanticTokens(left));
  const rightTokens = new Set(semanticTokens(right));
  if (!leftTokens.size && !rightTokens.size) return 1;
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) intersection += 1;
  });
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return intersection / union;
}

function normalizeEntry(raw: SyncEntryPayload): GlobalKnowledgeEntry | null {
  const id = String(raw?.id ?? "").trim();
  const normalizedQuestion = normalizeGlobalKnowledgeQuestion(
    raw?.normalizedQuestion || raw?.canonicalQuestion,
  );
  const answer = String(raw?.answer || "").trim();
  if (!id || !normalizedQuestion || !answer) return null;
  const embedding = Array.isArray(raw.embedding)
    ? raw.embedding.map(Number).filter((value) => Number.isFinite(value))
    : [];
  return {
    id,
    canonicalQuestion:
      String(raw.canonicalQuestion || raw.normalizedQuestion || "").trim() ||
      normalizedQuestion,
    normalizedQuestion,
    answer,
    answerLanguage: String(raw.answerLanguage || "en"),
    topic: raw.topic ?? null,
    answerHash: String(raw.answerHash || ""),
    embedding,
    embeddingNorm:
      Number(raw.embeddingNorm || 0) || (embedding.length ? vectorNorm(embedding) : 0),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0))),
    safetyLabel: String(raw.safetyLabel || "general"),
    updatedAt: String(raw.updatedAt || nowIso()),
    expiresAt: raw.expiresAt || null,
  };
}

export async function loadGlobalKnowledgeStore(): Promise<GlobalKnowledgeStore> {
  try {
    const store = parseJson<GlobalKnowledgeStore>(
      await AsyncStorage.getItem(GLOBAL_KNOWLEDGE_CACHE_KEY),
      { version: 1, entries: [] },
    );
    const entries = Array.isArray(store.entries)
      ? store.entries
          .map((entry) => normalizeEntry(entry as any))
          .filter(Boolean) as GlobalKnowledgeEntry[]
      : [];
    return { version: 1, entries, updatedAt: store.updatedAt || null };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function saveGlobalKnowledgeStore(store: GlobalKnowledgeStore) {
  await AsyncStorage.setItem(
    GLOBAL_KNOWLEDGE_CACHE_KEY,
    JSON.stringify({
      version: 1,
      entries: store.entries.slice(-1000),
      updatedAt: store.updatedAt || nowIso(),
    }),
  );
}

async function loadSyncMeta(): Promise<GlobalKnowledgeSyncMeta> {
  return parseJson<GlobalKnowledgeSyncMeta>(
    await AsyncStorage.getItem(GLOBAL_KNOWLEDGE_SYNC_META_KEY),
    {},
  );
}

async function saveSyncMeta(meta: GlobalKnowledgeSyncMeta) {
  await AsyncStorage.setItem(GLOBAL_KNOWLEDGE_SYNC_META_KEY, JSON.stringify(meta));
}

export async function syncGlobalKnowledge(options: { limit?: number; force?: boolean } = {}) {
  const meta = await loadSyncMeta();
  const limit = Math.max(1, Math.min(Number(options.limit || 250), 500));
  const since = options.force ? "" : String(meta.since || "");
  const params = new URLSearchParams({ limit: String(limit) });
  if (since) params.set("since", since);
  const payload = await apiGet<SyncPayload>(`/api/global-knowledge/sync?${params.toString()}`);
  const incoming = Array.isArray(payload.entries)
    ? payload.entries.map(normalizeEntry).filter(Boolean) as GlobalKnowledgeEntry[]
    : [];
  const current = await loadGlobalKnowledgeStore();
  const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
  incoming.forEach((entry) => {
    byId.set(entry.id, entry);
  });
  const updatedAt = payload.serverTime || nowIso();
  const next = {
    version: 1,
    entries: Array.from(byId.values()).filter((entry) => !isExpired(entry)),
    updatedAt,
  };
  await saveGlobalKnowledgeStore(next);
  await saveSyncMeta({ since: updatedAt, updatedAt });
  return { ok: true, synced: incoming.length, total: next.entries.length, updatedAt };
}

function isExpired(entry: GlobalKnowledgeEntry) {
  if (!entry.expiresAt) return false;
  const expires = new Date(entry.expiresAt).getTime();
  return Number.isFinite(expires) && expires <= Date.now();
}

export async function lookupSyncedGlobalKnowledge(
  question: string,
  options: {
    minSimilarity?: number;
    embedTexts?: (texts: string[]) => Promise<number[][]>;
  } = {},
): Promise<GlobalKnowledgeLookupHit | null> {
  if (!question.trim() || isLiveOrCurrentGlobalKnowledgeQuestion(question)) {
    return null;
  }
  const store = await loadGlobalKnowledgeStore();
  const entries = store.entries.filter(
    (entry) =>
      !isExpired(entry) &&
      entry.safetyLabel !== "private" &&
      entry.safetyLabel !== "personal_high_risk" &&
      entry.safetyLabel !== "unsafe",
  );
  if (!entries.length) return null;

  const normalizedQuestion = normalizeGlobalKnowledgeQuestion(question);
  const minSimilarity = Math.max(0, Math.min(1, Number(options.minSimilarity || 0.9)));
  let queryEmbedding: number[] | null = null;
  let queryEmbeddingNorm = 0;
  if (options.embedTexts && entries.some((entry) => entry.embedding.length)) {
    try {
      const rows = await options.embedTexts([normalizedQuestion]);
      if (Array.isArray(rows?.[0]) && rows[0].length) {
        queryEmbedding = rows[0].map(Number).filter((value) => Number.isFinite(value));
        queryEmbeddingNorm = vectorNorm(queryEmbedding);
      }
    } catch {
      queryEmbedding = null;
      queryEmbeddingNorm = 0;
    }
  }

  let bestEntry: GlobalKnowledgeEntry | null = null;
  let bestScore = 0;
  let bestSource: "embedding" | "lexical" = "lexical";
  entries.forEach((entry) => {
    const lexical = lexicalSimilarity(normalizedQuestion, entry.normalizedQuestion);
    const embeddingScore =
      queryEmbedding && entry.embedding.length
        ? cosine(queryEmbedding, queryEmbeddingNorm, entry.embedding, entry.embeddingNorm)
        : 0;
    const score = Math.max(lexical, embeddingScore);
    const source = embeddingScore >= lexical && embeddingScore > 0 ? "embedding" : "lexical";
    if (!bestEntry || score > bestScore) {
      bestEntry = entry;
      bestScore = score;
      bestSource = source;
    }
  });
  if (!bestEntry || bestScore < minSimilarity) return null;
  return { entry: bestEntry, score: bestScore, source: bestSource };
}

export async function clearGlobalKnowledgeForTests() {
  await Promise.all([
    AsyncStorage.removeItem(GLOBAL_KNOWLEDGE_CACHE_KEY),
    AsyncStorage.removeItem(GLOBAL_KNOWLEDGE_SYNC_META_KEY),
  ]);
}
