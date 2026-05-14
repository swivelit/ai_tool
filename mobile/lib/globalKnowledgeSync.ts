import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiGet } from "./api";

export const GLOBAL_KNOWLEDGE_CACHE_KEY = "global_knowledge_cache_v1";
export const GLOBAL_KNOWLEDGE_SYNC_META_KEY = "global_knowledge_sync_meta_v1";
export const GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND = "token_hash_v1";
export const GLOBAL_KNOWLEDGE_SYNC_THROTTLE_MS = 5 * 60 * 1000;
export const GLOBAL_KNOWLEDGE_FOREGROUND_STALE_MS = 6 * 60 * 60 * 1000;

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
  embeddingKind?: string;
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
  embeddingKind: string;
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
  lastAttemptAt?: string | null;
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

function utf8Bytes(value: string) {
  const Encoder = (globalThis as any).TextEncoder;
  if (typeof Encoder === "function") {
    return new Encoder().encode(value) as Uint8Array;
  }
  const encoded = unescape(encodeURIComponent(value));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    out[i] = encoded.charCodeAt(i);
  }
  return out;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Bytes(value: string) {
  const input = utf8Bytes(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    outputView.setUint32(index * 4, word, false);
  });
  return output;
}

export function tokenHashEmbedding(value: unknown, dims = 96) {
  const vector = new Array(dims).fill(0);
  semanticTokens(value).forEach((token) => {
    const digest = sha256Bytes(token);
    const index = (((digest[0] || 0) << 8) | (digest[1] || 0)) % dims;
    const sign = (digest[2] || 0) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  });
  return vector;
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
  const rawEmbeddingKind = String(raw.embeddingKind || "").trim();
  const embeddingKind =
    rawEmbeddingKind === GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND
      ? GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND
      : "";
  const embedding = embeddingKind && Array.isArray(raw.embedding)
    ? raw.embedding.map(Number).filter((value) => Number.isFinite(value))
    : [];
  const hasSuppliedEmbedding = Array.isArray(raw.embedding) && raw.embedding.length > 0;
  const effectiveEmbedding =
    embeddingKind === GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND && embedding.length
      ? embedding
      : rawEmbeddingKind && hasSuppliedEmbedding
        ? tokenHashEmbedding(normalizedQuestion)
        : [];
  const suppliedTokenHashNorm =
    embeddingKind === GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND && embedding.length
      ? Number(raw.embeddingNorm || 0)
      : 0;
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
    embedding: effectiveEmbedding,
    embeddingNorm:
      suppliedTokenHashNorm || (effectiveEmbedding.length ? vectorNorm(effectiveEmbedding) : 0),
    embeddingKind: effectiveEmbedding.length ? GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND : "",
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

function parseTimeMs(value?: string | null) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

let inFlightSync: Promise<any> | null = null;

export async function syncGlobalKnowledge(
  options: { limit?: number; force?: boolean; minIntervalMs?: number } = {},
) {
  if (inFlightSync && !options.force) {
    return inFlightSync;
  }
  const meta = await loadSyncMeta();
  const minIntervalMs = Math.max(
    0,
    Number(options.minIntervalMs ?? GLOBAL_KNOWLEDGE_SYNC_THROTTLE_MS),
  );
  const lastAttemptAt = parseTimeMs(meta.lastAttemptAt || meta.updatedAt || null);
  if (!options.force && minIntervalMs > 0 && lastAttemptAt && Date.now() - lastAttemptAt < minIntervalMs) {
    return {
      ok: true,
      skipped: true,
      reason: "throttled",
      synced: 0,
      total: (await loadGlobalKnowledgeStore()).entries.length,
      updatedAt: meta.updatedAt || null,
    };
  }
  const attemptAt = nowIso();
  await saveSyncMeta({ ...meta, lastAttemptAt: attemptAt });

  const limit = Math.max(1, Math.min(Number(options.limit || 250), 500));
  const since = options.force ? "" : String(meta.since || "");
  const params = new URLSearchParams({ limit: String(limit) });
  if (since) params.set("since", since);
  inFlightSync = (async () => {
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
    await saveSyncMeta({ since: updatedAt, updatedAt, lastAttemptAt: attemptAt });
    return { ok: true, synced: incoming.length, total: next.entries.length, updatedAt };
  })();
  try {
    return await inFlightSync;
  } finally {
    inFlightSync = null;
  }
}

export async function syncGlobalKnowledgeIfStale(
  options: { limit?: number; staleMs?: number; minIntervalMs?: number } = {},
) {
  const meta = await loadSyncMeta();
  const staleMs = Math.max(0, Number(options.staleMs ?? GLOBAL_KNOWLEDGE_FOREGROUND_STALE_MS));
  const updatedAt = parseTimeMs(meta.updatedAt || null);
  if (updatedAt && Date.now() - updatedAt < staleMs) {
    const store = await loadGlobalKnowledgeStore();
    return {
      ok: true,
      skipped: true,
      reason: "not_stale",
      synced: 0,
      total: store.entries.length,
      updatedAt: meta.updatedAt || null,
    };
  }
  return syncGlobalKnowledge({
    limit: options.limit,
    minIntervalMs: options.minIntervalMs,
  });
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
    nativeEmbeddingKind?: string;
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
  const queryEmbedding = tokenHashEmbedding(normalizedQuestion);
  const queryEmbeddingNorm = vectorNorm(queryEmbedding);

  let bestEntry: GlobalKnowledgeEntry | null = null;
  let bestScore = 0;
  let bestSource: "embedding" | "lexical" = "lexical";
  entries.forEach((entry) => {
    const lexical = lexicalSimilarity(normalizedQuestion, entry.normalizedQuestion);
    const embeddingScore =
      entry.embeddingKind === GLOBAL_KNOWLEDGE_TOKEN_HASH_EMBEDDING_KIND && entry.embedding.length
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
  inFlightSync = null;
  await Promise.all([
    AsyncStorage.removeItem(GLOBAL_KNOWLEDGE_CACHE_KEY),
    AsyncStorage.removeItem(GLOBAL_KNOWLEDGE_SYNC_META_KEY),
  ]);
}
