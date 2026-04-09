import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";

import { apiPost } from "./api";
import { ensureLocalAgentSeedData, LOCAL_AGENT_DATA_DIR } from "./localAgentBootstrap";

type ReplyLanguage = "en" | "ta";
type ChatRole = "system" | "user" | "assistant";

type OrchestratorRoute =
  | "fast_greeting"
  | "clarify"
  | "profile"
  | "calendar_query"
  | "reminder_create"
  | "weather"
  | "local_answer"
  | "fallback_openai";

type LocalUserProfile = {
  name?: string;
  place?: string;
  assistantName?: string;
  replyLanguage?: ReplyLanguage;
};

export type LocalChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type ProfilerSlot = {
  id: string;
  prompt: string;
  type: "single" | "multi";
  max_choices?: number;
  options: string[];
};

export type LocalProfilerState = {
  status: "idle" | "active" | "complete";
  startedAt?: string;
  lastUpdatedAt?: string;
  currentTargetSlot?: string;
  history: LocalChatMessage[];
};

export type LocalProfilerTurnResult = {
  ok: boolean;
  assistantReply: string;
  answers: Record<string, string | string[]>;
  completedSlots: number;
  totalSlots: number;
  missingSlots: string[];
  done: boolean;
  history: LocalChatMessage[];
  summary?: string;
};

export type LocalTaskRecord = {
  id: string;
  title: string;
  details?: string;
  datetimeText?: string | null;
  isoDatetime?: string | null;
  status: "scheduled" | "draft" | "done";
  createdAt: string;
};

export type LocalRagChunk = {
  id: string;
  sourceId: string;
  sourceType: "profile" | "doc" | "memory" | "manual";
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
  updatedAt: string;
};

export type LocalTrainingSample = {
  id: string;
  agent: "profiler" | "orchestrator" | "alignment" | "memory" | "rag" | string;
  input: string;
  expectedOutput?: string;
  label?: string;
  metadata?: Record<string, any>;
  createdAt: string;
};

export type LocalAssistantTurnResult = {
  route: OrchestratorRoute | "semantic_cache";
  source: "local_model" | "local_rules" | "semantic_cache" | "openai_fallback";
  cacheHit: boolean;
  assistantText: string;
  englishText: string;
  intent: "assistant" | "reminder" | "note" | "clarify";
  title?: string | null;
  details?: string | null;
  datetimeText?: string | null;
  profileSummary?: string;
  meta?: Record<string, any>;
};

type LocalModelConfig = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  models: {
    profiler: string;
    orchestratorMedium: string;
    orchestratorLarge: string;
    aligner: string;
    embedding: string;
  };
  thresholds: {
    semanticCache: number;
    largeModelQuestionChars: number;
  };
};

type OrchestratorConfig = {
  version: number;
  routes: {
    fastGreetingKeywords: string[];
    calendarKeywords: string[];
    reminderKeywords: string[];
    weatherKeywords: string[];
    profileKeywords: string[];
    liveDataKeywords: string[];
    ambiguityKeywords: string[];
  };
};

type AlignmentRules = {
  preserveFacts: boolean;
  avoidNewClaims: boolean;
  matchTone: boolean;
  preferUserLanguage: boolean;
};

type MemoryRules = {
  semanticCacheThreshold: number;
  minTurnsBeforeSync: number;
  minMinutesBetweenSync: number;
  maxTurnsForSync: number;
  maxFactsPerSync: number;
};

type SemanticCacheRow = {
  question: string;
  normalizedQuestion: string;
  answer: string;
  route: string;
  embedding: number[];
  savedAt: string;
};

type MemorySyncRow = {
  syncedAt: string;
  summary: string;
  facts: string[];
  profile_updates: Record<string, any>;
};

type PromptCatalog = {
  profilerOpeningSystem: string;
  profilerTurnSystem: string;
  profileSummarySystem: string;
  orchestratorSystem: string;
  reminderExtractorSystem: string;
  alignmentSystem: string;
  memorySyncSystem: string;
  localReasonerSystem: string;
};

type AgentRegistryConfig = {
  version: number;
  agents: {
    profiler: {
      enabled: boolean;
      modelKey: keyof LocalModelConfig["models"];
      description: string;
      trainingFile: string;
    };
    orchestrator: {
      enabled: boolean;
      mediumModelKey: keyof LocalModelConfig["models"];
      largeModelKey: keyof LocalModelConfig["models"];
      description: string;
      trainingFile: string;
    };
    alignment: {
      enabled: boolean;
      modelKey: keyof LocalModelConfig["models"];
      description: string;
      trainingFile: string;
    };
    memory: {
      enabled: boolean;
      embeddingModelKey: keyof LocalModelConfig["models"];
      summarizerModelKey: keyof LocalModelConfig["models"];
      description: string;
      trainingFile: string;
    };
    toolAgents: {
      weather: boolean;
      calendar: boolean;
      profile: boolean;
    };
  };
};

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

const DEFAULT_MODEL_CONFIG: LocalModelConfig = {
  baseUrl: "http://127.0.0.1:10000/v1",
  apiKey: "local-phone",
  timeoutMs: 45000,
  models: {
    profiler: "google/gemma-3-4b-it",
    orchestratorMedium: "Qwen/Qwen3-8B",
    orchestratorLarge: "Qwen/Qwen3-14B",
    aligner: "google/gemma-3-4b-it",
    embedding: "Qwen/Qwen3-Embedding-0.6B",
  },
  thresholds: {
    semanticCache: 0.95,
    largeModelQuestionChars: 180,
  },
};

const DEFAULT_PROFILER_SLOTS: ProfilerSlot[] = [
  {
    id: "preferred_language",
    prompt: "Which language should I mostly use with you?",
    type: "single",
    options: ["english", "tamil", "other"],
  },
  {
    id: "communication_tone",
    prompt: "How should I talk to you most of the time?",
    type: "single",
    options: ["warm", "short_direct", "friendly_casual"],
  },
  {
    id: "main_goal",
    prompt: "What matters most to you right now?",
    type: "single",
    options: ["career_growth", "peace_of_mind", "learning"],
  },
];

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  version: 1,
  routes: {
    fastGreetingKeywords: ["hi", "hello", "hey", "vanakkam", "thanks"],
    calendarKeywords: ["schedule", "agenda", "calendar", "reminders"],
    reminderKeywords: ["remind me", "set a reminder", "add reminder"],
    weatherKeywords: ["weather", "temperature", "rain", "forecast"],
    profileKeywords: ["my name", "my goal", "my language", "my hobbies"],
    liveDataKeywords: ["latest", "news", "current", "today", "live", "browse"],
    ambiguityKeywords: ["this", "that", "it", "they", "there", "here", "he", "she"],
  },
};

const DEFAULT_ALIGNMENT_RULES: AlignmentRules = {
  preserveFacts: true,
  avoidNewClaims: true,
  matchTone: true,
  preferUserLanguage: true,
};

const DEFAULT_MEMORY_RULES: MemoryRules = {
  semanticCacheThreshold: 0.95,
  minTurnsBeforeSync: 6,
  minMinutesBetweenSync: 15,
  maxTurnsForSync: 18,
  maxFactsPerSync: 6,
};

const DEFAULT_PROMPTS: PromptCatalog = {
  profilerOpeningSystem:
    "You are the Profiler Agent. Start naturally in {{reply_language_name}} and collect: {{slot_ids}}.",
  profilerTurnSystem:
    "You are the Profiler Agent. Return JSON with assistant_reply, updates, missing_slots, completed.",
  profileSummarySystem:
    "Write a compact factual English profile summary. Do not invent details.",
  orchestratorSystem: "Choose one route and return JSON only.",
  reminderExtractorSystem:
    "Extract reminder title, details, datetime_text, and assistant_reply as JSON.",
  alignmentSystem:
    "Rewrite the answer to match user tone and language without changing facts.",
  memorySyncSystem:
    "Summarize recent durable user facts and profile_updates as JSON.",
  localReasonerSystem:
    "Use only local context. Reply __OPENAI_FALLBACK__ if live public data is required.",
};

const DEFAULT_AGENT_REGISTRY: AgentRegistryConfig = {
  version: 1,
  agents: {
    profiler: {
      enabled: true,
      modelKey: "profiler",
      description: "Natural onboarding and profile extraction",
      trainingFile: "training/seed/profiler.jsonl",
    },
    orchestrator: {
      enabled: true,
      mediumModelKey: "orchestratorMedium",
      largeModelKey: "orchestratorLarge",
      description: "Route user intent, tool choice, and local-vs-backend fallback decisions",
      trainingFile: "training/seed/orchestrator.jsonl",
    },
    alignment: {
      enabled: true,
      modelKey: "aligner",
      description: "Rewrite answers to match the user's tone and language",
      trainingFile: "training/seed/alignment.jsonl",
    },
    memory: {
      enabled: true,
      embeddingModelKey: "embedding",
      summarizerModelKey: "orchestratorMedium",
      description: "Semantic cache and long-term profile updates",
      trainingFile: "training/seed/memory.jsonl",
    },
    toolAgents: {
      weather: true,
      calendar: true,
      profile: true,
    },
  },
};

const DEFAULT_WORKSPACE_MANIFEST = {
  version: 3,
  architecture: {
    primaryRuntime: "phone_local_agents",
    backendRole: "mirror_support_openai_fallback",
  },
  checkedInSeedFolders: ["config", "training/seed", "rag/seed"],
  runtimeFolders: [
    "profiles",
    "cache",
    "memory",
    "conversations",
    "tasks",
    "rag/runtime",
    "training/captures",
  ],
  files: [
    "config/models.json",
    "config/profiler_slots.json",
    "config/orchestrator_routes.json",
    "config/alignment_rules.json",
    "config/memory_rules.json",
    "config/prompts.json",
    "config/agent_registry.json",
    "config/workspace_manifest.json",
  ],
};

const DATA_DIR = LOCAL_AGENT_DATA_DIR;
const CONFIG_DIR = `${DATA_DIR}/config`;
const PROFILES_DIR = `${DATA_DIR}/profiles`;
const CACHE_DIR = `${DATA_DIR}/cache`;
const MEMORY_DIR = `${DATA_DIR}/memory`;
const CONVERSATIONS_DIR = `${DATA_DIR}/conversations`;
const TASKS_DIR = `${DATA_DIR}/tasks`;
const RAG_DIR = `${DATA_DIR}/rag/runtime`;
const RAG_SEED_DIR = `${DATA_DIR}/rag/seed`;
const TRAINING_DIR = `${DATA_DIR}/training/captures`;
const TRAINING_SEED_DIR = `${DATA_DIR}/training/seed`;

const MODELS_PATH = `${CONFIG_DIR}/models.json`;
const SLOTS_PATH = `${CONFIG_DIR}/profiler_slots.json`;
const ROUTES_PATH = `${CONFIG_DIR}/orchestrator_routes.json`;
const ALIGNMENT_PATH = `${CONFIG_DIR}/alignment_rules.json`;
const MEMORY_RULES_PATH = `${CONFIG_DIR}/memory_rules.json`;
const PROMPTS_PATH = `${CONFIG_DIR}/prompts.json`;
const AGENT_REGISTRY_PATH = `${CONFIG_DIR}/agent_registry.json`;
const WORKSPACE_MANIFEST_PATH = `${CONFIG_DIR}/workspace_manifest.json`;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value?: string | null) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq<T>(items: T[]) {
  return Array.from(new Set(items));
}

function positiveInt(value: any, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function positiveFloat(value: any, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function simpleHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0).toString(16);
}

function parseJsonLoose<T>(raw: any, fallback: T): T {
  if (raw && typeof raw === "object") return raw as T;
  const text = String(raw || "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(text.slice(objectStart, objectEnd + 1)) as T;
      } catch {
        // keep going
      }
    }
    const arrayStart = text.indexOf("[");
    const arrayEnd = text.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(text.slice(arrayStart, arrayEnd + 1)) as T;
      } catch {
        // keep going
      }
    }
    return fallback;
  }
}

function template(text: string, values: Record<string, any>) {
  return String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}

function trimList(value: any) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function displayValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ");
  return String(value || "").trim();
}

async function exists(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  return Boolean(info.exists);
}

async function ensureDir(path: string) {
  if (!(await exists(path))) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    if (!(await exists(path))) return fallback;
    const raw = await FileSystem.readAsStringAsync(path);
    return parseJsonLoose<T>(raw, fallback);
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, payload: any) {
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory) await ensureDir(directory);
  await FileSystem.writeAsStringAsync(path, JSON.stringify(payload, null, 2), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

async function appendJsonl(path: string, payload: any) {
  const directory = path.split("/").slice(0, -1).join("/");
  if (directory) await ensureDir(directory);
  const line = `${JSON.stringify(payload)}\n`;
  if (!(await exists(path))) {
    await FileSystem.writeAsStringAsync(path, line, { encoding: FileSystem.EncodingType.UTF8 });
    return;
  }
  const current = await FileSystem.readAsStringAsync(path).catch(() => "");
  await FileSystem.writeAsStringAsync(path, `${current}${line}`, { encoding: FileSystem.EncodingType.UTF8 });
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    if (!(await exists(path))) return [];
    const raw = await FileSystem.readAsStringAsync(path);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseJsonLoose<T>(line, null as any))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hashEmbedding(text: string, dims = 256) {
  const out = new Array(dims).fill(0);
  const normalized = normalizeText(text);
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    const idx = (code + i * 31) % dims;
    out[idx] += (code % 17) / 17;
  }
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return out.map((value) => value / norm);
}

function cosine(a: number[], b: number[]) {
  const size = Math.min(a.length, b.length);
  if (!size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < size; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

function answersPath(userId: number) {
  return `${PROFILES_DIR}/${userId}/answers.json`;
}
function summaryPath(userId: number) {
  return `${PROFILES_DIR}/${userId}/summary.json`;
}
function profilerStatePath(userId: number) {
  return `${PROFILES_DIR}/${userId}/profiler_state.json`;
}
function semanticCachePath(userId: number) {
  return `${CACHE_DIR}/${userId}_semantic_cache.json`;
}
function tasksPath(userId: number) {
  return `${TASKS_DIR}/${userId}.json`;
}
function convoPath(userId: number) {
  return `${CONVERSATIONS_DIR}/${userId}.jsonl`;
}
function memoryPath(userId: number) {
  return `${MEMORY_DIR}/${userId}.jsonl`;
}
function profileRagPath(userId: number) {
  return `${RAG_DIR}/${userId}_profile_rag.json`;
}
function ragChunksPath(userId: number) {
  return `${RAG_DIR}/${userId}_chunks.json`;
}
function trainingSamplesPath(agent = "general") {
  const safe = normalizeText(agent).replace(/\s+/g, "_") || "general";
  return `${TRAINING_DIR}/${safe}.jsonl`;
}

function answerValueCount(answers: Record<string, any>) {
  return Object.values(answers).filter((value) =>
    Array.isArray(value) ? value.length > 0 : String(value || "").trim().length > 0
  ).length;
}

function missingSlots(slots: ProfilerSlot[], answers: Record<string, any>) {
  return slots
    .filter((slot) => {
      const value = answers[slot.id];
      return Array.isArray(value) ? value.length === 0 : !String(value || "").trim();
    })
    .map((slot) => slot.id);
}

function nextSlot(slots: ProfilerSlot[], answers: Record<string, any>) {
  const remaining = missingSlots(slots, answers);
  return slots.find((slot) => remaining.includes(slot.id)) || null;
}

function profileFactsText(answers: Record<string, any>) {
  return Object.entries(answers)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : String(value || "").trim()))
    .map(([key, value]) => `${key}: ${displayValue(value as any)}`)
    .join("\n");
}

function languagesSummary(answers: Record<string, any>) {
  const primary = displayValue(answers.preferred_language);
  const secondary = displayValue(answers.secondary_language);
  if (primary && secondary && secondary !== "none" && secondary !== primary) {
    return `${primary} and ${secondary}`;
  }
  return primary || secondary || "";
}

function heuristicProfileAnswer(
  message: string,
  answers: Record<string, any>,
  userProfile?: LocalUserProfile
) {
  const normalized = normalizeText(message);

  if (/\b(my name|what is my name|who am i)\b/.test(normalized) && userProfile?.name) {
    return `Your name is ${userProfile.name}.`;
  }

  if (/\b(my place|where am i from|my hometown|my town)\b/.test(normalized) && userProfile?.place) {
    return `Your place is ${userProfile.place}.`;
  }

  if (/\b(hobbies|what do i like|what do i enjoy)\b/.test(normalized) && answers.hobbies) {
    return `You told me your hobbies include ${displayValue(answers.hobbies)}.`;
  }

  if (/\b(language|languages|what do i speak|which language)\b/.test(normalized)) {
    const langs = languagesSummary(answers);
    if (langs) return `You told me you speak ${langs}.`;
  }

  if (/\b(job|work|occupation|what do i do)\b/.test(normalized) && answers.occupation) {
    const field = displayValue(answers.industry_or_field);
    return field
      ? `You described yourself as ${displayValue(answers.occupation)} in ${field}.`
      : `You described yourself as ${displayValue(answers.occupation)}.`;
  }

  if (/\b(goal|focus|priority|what matters)\b/.test(normalized) && answers.main_goal) {
    return `Right now, your main focus is ${displayValue(answers.main_goal)}.`;
  }

  if (/\b(communication style|tone|how should you talk|how do i like replies)\b/.test(normalized) && answers.communication_tone) {
    const length = displayValue(answers.answer_length);
    return length
      ? `You prefer a ${displayValue(answers.communication_tone)} tone with ${length} answers.`
      : `You prefer a ${displayValue(answers.communication_tone)} tone.`;
  }

  if (/\b(dislike|dont like|don't like|avoid doing)\b/.test(normalized) && answers.dislikes) {
    return `You said you dislike responses that feel ${displayValue(answers.dislikes)}.`;
  }

  if (/\b(who are you|what can you do)\b/.test(normalized)) {
    return `I’m ${userProfile?.assistantName || "Elli"}, your local-first assistant.`;
  }

  return "";
}

async function safeRecordTrainingSample(
  agent: LocalTrainingSample["agent"],
  sample: Omit<LocalTrainingSample, "id" | "agent" | "createdAt">
) {
  try {
    await appendLocalTrainingSample(agent, sample);
  } catch {
    // training capture must never break the user flow
  }
}

export async function ensureLocalAgentData() {
  await ensureLocalAgentSeedData();
  await ensureDir(DATA_DIR);
  await ensureDir(CONFIG_DIR);
  await ensureDir(PROFILES_DIR);
  await ensureDir(CACHE_DIR);
  await ensureDir(MEMORY_DIR);
  await ensureDir(CONVERSATIONS_DIR);
  await ensureDir(TASKS_DIR);
  await ensureDir(RAG_DIR);
  await ensureDir(RAG_SEED_DIR);
  await ensureDir(TRAINING_DIR);
  await ensureDir(TRAINING_SEED_DIR);

  if (!(await exists(MODELS_PATH))) await writeJson(MODELS_PATH, DEFAULT_MODEL_CONFIG);
  if (!(await exists(SLOTS_PATH))) await writeJson(SLOTS_PATH, DEFAULT_PROFILER_SLOTS);
  if (!(await exists(ROUTES_PATH))) await writeJson(ROUTES_PATH, DEFAULT_ORCHESTRATOR_CONFIG);
  if (!(await exists(ALIGNMENT_PATH))) await writeJson(ALIGNMENT_PATH, DEFAULT_ALIGNMENT_RULES);
  if (!(await exists(MEMORY_RULES_PATH))) await writeJson(MEMORY_RULES_PATH, DEFAULT_MEMORY_RULES);
  if (!(await exists(PROMPTS_PATH))) await writeJson(PROMPTS_PATH, DEFAULT_PROMPTS);
  if (!(await exists(AGENT_REGISTRY_PATH))) await writeJson(AGENT_REGISTRY_PATH, DEFAULT_AGENT_REGISTRY);
  if (!(await exists(WORKSPACE_MANIFEST_PATH))) await writeJson(WORKSPACE_MANIFEST_PATH, DEFAULT_WORKSPACE_MANIFEST);
}

async function getModelConfig() {
  await ensureLocalAgentData();
  const fileConfig = await readJson<LocalModelConfig>(MODELS_PATH, DEFAULT_MODEL_CONFIG);
  return {
    ...fileConfig,
    baseUrl: String(extra.LOCAL_MODEL_BASE_URL || fileConfig.baseUrl || DEFAULT_MODEL_CONFIG.baseUrl),
    apiKey: String(extra.LOCAL_MODEL_API_KEY || fileConfig.apiKey || DEFAULT_MODEL_CONFIG.apiKey),
    timeoutMs: Number(extra.LOCAL_MODEL_TIMEOUT_MS || fileConfig.timeoutMs || DEFAULT_MODEL_CONFIG.timeoutMs),
    models: {
      ...DEFAULT_MODEL_CONFIG.models,
      ...(fileConfig.models || {}),
      profiler: String(extra.LOCAL_MODEL_GEMMA_4B || fileConfig.models?.profiler || DEFAULT_MODEL_CONFIG.models.profiler),
      orchestratorMedium: String(
        extra.LOCAL_MODEL_QWEN_8B ||
          fileConfig.models?.orchestratorMedium ||
          DEFAULT_MODEL_CONFIG.models.orchestratorMedium
      ),
      orchestratorLarge: String(
        extra.LOCAL_MODEL_QWEN_14B ||
          fileConfig.models?.orchestratorLarge ||
          DEFAULT_MODEL_CONFIG.models.orchestratorLarge
      ),
      aligner: String(extra.LOCAL_MODEL_GEMMA_4B || fileConfig.models?.aligner || DEFAULT_MODEL_CONFIG.models.aligner),
      embedding: String(
        extra.LOCAL_MODEL_QWEN_EMBED ||
          fileConfig.models?.embedding ||
          DEFAULT_MODEL_CONFIG.models.embedding
      ),
    },
    thresholds: {
      ...DEFAULT_MODEL_CONFIG.thresholds,
      ...(fileConfig.thresholds || {}),
    },
  };
}

async function getProfilerSlots() {
  await ensureLocalAgentData();
  return readJson<ProfilerSlot[]>(SLOTS_PATH, DEFAULT_PROFILER_SLOTS);
}

async function getOrchestratorConfig() {
  await ensureLocalAgentData();
  return readJson<OrchestratorConfig>(ROUTES_PATH, DEFAULT_ORCHESTRATOR_CONFIG);
}

async function getAlignmentRules() {
  await ensureLocalAgentData();
  return readJson<AlignmentRules>(ALIGNMENT_PATH, DEFAULT_ALIGNMENT_RULES);
}

async function getMemoryRules() {
  await ensureLocalAgentData();
  return readJson<MemoryRules>(MEMORY_RULES_PATH, DEFAULT_MEMORY_RULES);
}

async function getPromptCatalog() {
  await ensureLocalAgentData();
  return readJson<PromptCatalog>(PROMPTS_PATH, DEFAULT_PROMPTS);
}

async function getAgentRegistry() {
  await ensureLocalAgentData();
  return readJson<AgentRegistryConfig>(AGENT_REGISTRY_PATH, DEFAULT_AGENT_REGISTRY);
}

async function loadAnswers(userId: number) {
  return readJson<Record<string, string | string[]>>(answersPath(userId), {});
}

async function loadSummary(userId: number) {
  const payload = await readJson<{ summary?: string }>(summaryPath(userId), { summary: "" });
  return String(payload.summary || "").trim();
}

async function saveSummary(userId: number, summary: string) {
  await writeJson(summaryPath(userId), { summary: summary.trim(), updatedAt: nowIso() });
}

async function loadProfilerState(userId: number): Promise<LocalProfilerState> {
  return readJson<LocalProfilerState>(profilerStatePath(userId), { status: "idle", history: [] });
}

async function saveProfilerState(userId: number, state: LocalProfilerState) {
  await writeJson(profilerStatePath(userId), state);
}

async function loadTasks(userId: number) {
  return readJson<LocalTaskRecord[]>(tasksPath(userId), []);
}

async function saveTasks(userId: number, tasks: LocalTaskRecord[]) {
  await writeJson(tasksPath(userId), tasks);
}

async function appendConversation(userId: number, role: ChatRole, content: string) {
  const row: LocalChatMessage = { role, content: content.trim(), createdAt: nowIso() };
  await appendJsonl(convoPath(userId), row);
  return row;
}

async function recentConversation(userId: number, limit = 16) {
  const rows = await readJsonl<LocalChatMessage>(convoPath(userId));
  return rows.slice(-limit);
}

async function loadSemanticCache(userId: number) {
  return readJson<SemanticCacheRow[]>(semanticCachePath(userId), []);
}

async function saveSemanticCache(userId: number, rows: SemanticCacheRow[]) {
  await writeJson(userId ? semanticCachePath(userId) : semanticCachePath(0), rows.slice(-200));
}

async function loadRagChunks(userId: number) {
  const profilePayload = await readJson<{ chunks?: LocalRagChunk[] }>(profileRagPath(userId), { chunks: [] });
  const docChunks = await readJson<LocalRagChunk[]>(ragChunksPath(userId), []);
  return [
    ...(Array.isArray(profilePayload.chunks) ? profilePayload.chunks : []),
    ...(Array.isArray(docChunks) ? docChunks : []),
  ];
}

async function saveRagChunks(userId: number, rows: LocalRagChunk[]) {
  await writeJson(ragChunksPath(userId), rows.slice(-1000));
}

function extractCompletionText(json: any) {
  const direct = json?.choices?.[0]?.message?.content ?? json?.output_text ?? "";
  if (typeof direct === "string") return direct.trim();
  if (Array.isArray(direct)) {
    return direct
      .map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : ""))
      .join("\n")
      .trim();
  }
  return "";
}

async function localChatRaw(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2
) {
  const cfg = await getModelConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Local model HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function localChatJson(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2
) {
  const json = await localChatRaw(systemPrompt, userPrompt, model, temperature);
  return parseJsonLoose<any>(extractCompletionText(json), {});
}

async function localChatText(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2
) {
  const json = await localChatRaw(systemPrompt, userPrompt, model, temperature);
  return extractCompletionText(json);
}

async function embedTexts(texts: string[]) {
  const cfg = await getModelConfig();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.models.embedding,
        input: texts,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Embedding HTTP ${res.status}`);
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    if (!data.length) throw new Error("Missing embedding data");
    return data.map((item: any, index: number) =>
      Array.isArray(item?.embedding)
        ? item.embedding.map(Number)
        : hashEmbedding(texts[index] || "")
    );
  } catch {
    return texts.map((text) => hashEmbedding(text));
  }
}

async function saveAnswers(userId: number, answers: Record<string, string | string[]>) {
  await writeJson(answersPath(userId), answers);
  const chunks = Object.entries(answers)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : String(value || "").trim()))
    .map(([key, value]) => ({
      id: key,
      sourceId: `profile:${key}`,
      sourceType: "profile" as const,
      text: `${key}: ${displayValue(value as any)}`,
      metadata: { slot: key },
    }));
  const embeddings = chunks.length ? await embedTexts(chunks.map((chunk) => chunk.text)) : [];
  const ragRows: LocalRagChunk[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: Array.isArray(embeddings[index]) ? embeddings[index] : hashEmbedding(chunk.text),
    updatedAt: nowIso(),
  }));
  await writeJson(profileRagPath(userId), { updatedAt: nowIso(), chunks: ragRows });
}

export async function upsertLocalRagChunks(
  userId: number,
  sourceId: string,
  texts: string[],
  opts?: { sourceType?: LocalRagChunk["sourceType"]; metadata?: Record<string, any> }
) {
  await ensureLocalAgentData();
  const cleanTexts = texts.map((text) => String(text || "").trim()).filter(Boolean);
  if (!cleanTexts.length) return [] as LocalRagChunk[];
  const embeddings = await embedTexts(cleanTexts);
  const existing = await readJson<LocalRagChunk[]>(ragChunksPath(userId), []);
  const filtered = existing.filter((row) => row.sourceId !== sourceId);
  const createdAt = nowIso();
  const nextRows: LocalRagChunk[] = cleanTexts.map((text, index) => ({
    id: `${sourceId}_${index}_${simpleHash(text)}`,
    sourceId,
    sourceType: opts?.sourceType || "doc",
    text,
    embedding: Array.isArray(embeddings[index]) ? embeddings[index] : hashEmbedding(text),
    metadata: opts?.metadata || {},
    updatedAt: createdAt,
  }));
  await saveRagChunks(userId, [...filtered, ...nextRows]);
  await safeRecordTrainingSample("rag", {
    input: cleanTexts.join("\n"),
    label: "upsert",
    metadata: { userId, sourceId, sourceType: opts?.sourceType || "doc", count: nextRows.length },
  });
  return nextRows;
}

export async function searchLocalRag(userId: number, query: string, limit = 6) {
  await ensureLocalAgentData();
  const clean = String(query || "").trim();
  if (!clean) return [] as (LocalRagChunk & { score: number })[];
  const rows = await loadRagChunks(userId);
  if (!rows.length) return [] as (LocalRagChunk & { score: number })[];
  const [queryVec] = await embedTexts([clean]);
  return rows
    .map((row) => ({ ...row, score: cosine(queryVec, Array.isArray(row.embedding) ? row.embedding : []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .filter((row) => row.score >= 0.2);
}

export async function appendLocalTrainingSample(
  agent: LocalTrainingSample["agent"],
  sample: Omit<LocalTrainingSample, "id" | "agent" | "createdAt">
) {
  await ensureLocalAgentData();
  const row: LocalTrainingSample = {
    id: `${Date.now()}_${simpleHash(JSON.stringify(sample))}`,
    agent,
    input: String(sample.input || "").trim(),
    expectedOutput: sample.expectedOutput ? String(sample.expectedOutput).trim() : undefined,
    label: sample.label ? String(sample.label).trim() : undefined,
    metadata: sample.metadata || {},
    createdAt: nowIso(),
  };
  await appendJsonl(trainingSamplesPath(agent), row);
  return row;
}

export async function listLocalTrainingSamples(agent = "general") {
  await ensureLocalAgentData();
  return readJsonl<LocalTrainingSample>(trainingSamplesPath(agent));
}

export async function getLocalAgentWorkspaceInfo() {
  await ensureLocalAgentData();
  return {
    dataDir: DATA_DIR,
    configDir: CONFIG_DIR,
    profilesDir: PROFILES_DIR,
    cacheDir: CACHE_DIR,
    memoryDir: MEMORY_DIR,
    conversationsDir: CONVERSATIONS_DIR,
    tasksDir: TASKS_DIR,
    ragDir: RAG_DIR,
    ragSeedDir: RAG_SEED_DIR,
    trainingDir: TRAINING_DIR,
    trainingSeedDir: TRAINING_SEED_DIR,
    manifest: await readJson(WORKSPACE_MANIFEST_PATH, DEFAULT_WORKSPACE_MANIFEST),
    models: await getModelConfig(),
    prompts: await getPromptCatalog(),
    registry: await getAgentRegistry(),
    slots: await getProfilerSlots(),
  };
}

function mergeProfilerUpdates(
  slots: ProfilerSlot[],
  current: Record<string, string | string[]>,
  updates: Record<string, any>
) {
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const merged = { ...current };
  Object.entries(updates || {}).forEach(([key, value]) => {
    const slot = byId.get(key);
    if (!slot) return;
    if (slot.type === "multi") {
      const next = trimList(value);
      if (next.length) merged[key] = uniq(next).slice(0, slot.max_choices || 3);
      return;
    }
    const clean = String(value || "").trim();
    if (clean) merged[key] = clean;
  });
  return merged;
}

function fallbackProfilerTurn(
  message: string,
  slots: ProfilerSlot[],
  answers: Record<string, string | string[]>,
  state: LocalProfilerState,
  replyLanguage: ReplyLanguage
) {
  const slot =
    slots.find((item) => item.id === state.currentTargetSlot) ||
    nextSlot(slots, answers) ||
    slots[0];
  const updated = mergeProfilerUpdates(slots, answers, {
    [slot.id]:
      slot.type === "multi"
        ? String(message)
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : String(message).trim(),
  });
  const remaining = missingSlots(slots, updated);
  const upcoming = slots.find((item) => remaining.includes(item.id));
  return {
    assistant_reply: upcoming
      ? replyLanguage === "ta"
        ? `சரி. இன்னொரு விஷயம் மட்டும் — ${upcoming.prompt}`
        : `Got it. One more thing — ${upcoming.prompt}`
      : replyLanguage === "ta"
        ? "சூப்பர். உங்க ஆரம்ப ப்ரொஃபைல் ரெடி."
        : "Perfect. Your starter profile is ready.",
    updates: { [slot.id]: updated[slot.id] },
    missing_slots: remaining,
    completed: remaining.length === 0,
  };
}

async function syncAnswersToBackend(userId: number, answers: Record<string, string | string[]>) {
  const normalized = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value || "")])
  ) as Record<string, string>;
  try {
    await apiPost(`/users/${userId}/personality`, { answers: normalized });
  } catch {
    // keep local-first even if backend sync fails
  }
}

async function buildProfileSummaryLocally(userId: number, userProfile?: LocalUserProfile) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const answers = await loadAnswers(userId);
  const slots = await getProfilerSlots();
  if (missingSlots(slots, answers).length > 0) return "";
  try {
    const summary = await localChatText(
      prompts.profileSummarySystem,
      JSON.stringify({ user: userProfile || {}, answers }),
      cfg.models.aligner,
      0.1
    );
    if (summary.trim()) {
      await saveSummary(userId, summary.trim());
      return summary.trim();
    }
  } catch {
    // use fallback summary below
  }
  const languages = languagesSummary(answers);
  const fallback = [
    userProfile?.name ? `${userProfile.name} uses this assistant.` : "",
    languages ? `Languages: ${languages}.` : "",
    answers.occupation ? `Occupation: ${displayValue(answers.occupation)}.` : "",
    answers.communication_tone ? `Preferred tone: ${displayValue(answers.communication_tone)}.` : "",
    answers.answer_length ? `Answer length: ${displayValue(answers.answer_length)}.` : "",
    answers.hobbies ? `Hobbies: ${displayValue(answers.hobbies)}.` : "",
    answers.main_goal ? `Main goal: ${displayValue(answers.main_goal)}.` : "",
    answers.dislikes ? `Avoid: ${displayValue(answers.dislikes)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  await saveSummary(userId, fallback);
  return fallback;
}

async function buildProfilerOpening(replyLanguage: ReplyLanguage, userProfile?: LocalUserProfile) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const slots = await getProfilerSlots();
  try {
    const out = await localChatText(
      template(prompts.profilerOpeningSystem, {
        reply_language_name: replyLanguage === "ta" ? "Tamil" : "English",
        slot_ids: slots.map((slot) => slot.id).join(", "),
      }),
      JSON.stringify({ user: userProfile || {}, mission: "collect the user's profile naturally" }),
      cfg.models.profiler,
      0.2
    );
    if (out.trim()) return out.trim();
  } catch {
    // use fallback below
  }
  return replyLanguage === "ta"
    ? `வணக்கம்${userProfile?.name ? ` ${userProfile.name}` : ""}. நம்ம ஒரு சாதாரண உரையாடலாக ஆரம்பிக்கலாம். முதல்ல, உங்களைப் பற்றி கொஞ்சம் சொல்லுங்க.`
    : `Hey${userProfile?.name ? ` ${userProfile.name}` : ""}, let’s start casually. Tell me a little about yourself.`;
}

export async function startProfilerOnPhone(
  userId: number,
  opts?: { replyLanguage?: ReplyLanguage; userProfile?: LocalUserProfile }
): Promise<LocalProfilerTurnResult> {
  await ensureLocalAgentData();
  const slots = await getProfilerSlots();
  const answers = await loadAnswers(userId);
  const summary = await loadSummary(userId);
  const missing = missingSlots(slots, answers);
  const assistantReply = missing.length
    ? await buildProfilerOpening(opts?.replyLanguage === "en" ? "en" : "ta", opts?.userProfile)
    : opts?.replyLanguage === "ta"
      ? "உங்கள் ப்ரொஃபைல் ஏற்கனவே ரெடி. பேசிக்கொண்டே அதை இன்னும் மேம்படுத்தலாம்."
      : "Your profile is already ready. We can still improve it as we chat.";
  const state: LocalProfilerState = {
    status: missing.length ? "active" : "complete",
    startedAt: nowIso(),
    lastUpdatedAt: nowIso(),
    currentTargetSlot: missing[0],
    history: [{ role: "assistant" as const, content: assistantReply, createdAt: nowIso() }],
  };
  await saveProfilerState(userId, state);
  await appendConversation(userId, "assistant", assistantReply);
  await safeRecordTrainingSample("profiler", {
    input: "start_profiler",
    expectedOutput: assistantReply,
    label: "opening",
    metadata: {
      userId,
      replyLanguage: opts?.replyLanguage || "ta",
      missingSlots: missing,
    },
  });
  return {
    ok: true,
    assistantReply,
    answers,
    completedSlots: answerValueCount(answers),
    totalSlots: slots.length,
    missingSlots: missing,
    done: missing.length === 0,
    history: state.history,
    summary,
  };
}

export async function getProfilerStateOnPhone(userId: number) {
  await ensureLocalAgentData();
  const slots = await getProfilerSlots();
  const answers = await loadAnswers(userId);
  const state = await loadProfilerState(userId);
  const summary = await loadSummary(userId);
  return {
    state,
    answers,
    summary,
    completedSlots: answerValueCount(answers),
    totalSlots: slots.length,
    missingSlots: missingSlots(slots, answers),
  };
}

export async function sendProfilerMessageOnPhone(
  userId: number,
  message: string,
  opts?: { replyLanguage?: ReplyLanguage; userProfile?: LocalUserProfile }
): Promise<LocalProfilerTurnResult> {
  await ensureLocalAgentData();
  const trimmed = String(message || "").trim();
  if (!trimmed) throw new Error("Message is required.");
  const replyLanguage: ReplyLanguage = opts?.replyLanguage === "en" ? "en" : "ta";
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const slots = await getProfilerSlots();
  const currentAnswers = await loadAnswers(userId);
  const currentState = await loadProfilerState(userId);
  await appendConversation(userId, "user", trimmed);

  let llmOut: any = null;
  try {
    llmOut = await localChatJson(
      template(prompts.profilerTurnSystem, {
        reply_language_name: replyLanguage === "ta" ? "Tamil" : "English",
      }),
      JSON.stringify({
        latest_user_message: trimmed,
        current_answers: currentAnswers,
        current_target_slot: currentState.currentTargetSlot || null,
        history: currentState.history.slice(-10),
        slots,
      }),
      cfg.models.profiler,
      0.2
    );
  } catch {
    // use fallback below
  }

  if (!llmOut || !llmOut.assistant_reply) {
    llmOut = fallbackProfilerTurn(trimmed, slots, currentAnswers, currentState, replyLanguage);
  }

  const merged = mergeProfilerUpdates(slots, currentAnswers, llmOut.updates || {});
  const remaining = missingSlots(slots, merged);
  const done = remaining.length === 0;
  const assistantReply =
    String(llmOut.assistant_reply || "").trim() ||
    (done
      ? replyLanguage === "ta"
        ? "சூப்பர். உங்க ஆரம்ப ப்ரொஃபைல் ரெடி."
        : "Perfect. Your starter profile is ready."
      : replyLanguage === "ta"
        ? `சரி. இன்னொரு விஷயம் மட்டும் — ${nextSlot(slots, merged)?.prompt || "உங்களைப் பற்றி இன்னும் கொஞ்சம் சொல்லுங்க."}`
        : `Got it. One more thing — ${nextSlot(slots, merged)?.prompt || "Tell me a bit more about yourself."}`);

  const history: LocalChatMessage[] = [
    ...currentState.history,
    { role: "user" as const, content: trimmed, createdAt: nowIso() },
    { role: "assistant" as const, content: assistantReply, createdAt: nowIso() },
  ].slice(-40);

  const nextState: LocalProfilerState = {
    status: done ? "complete" : "active",
    startedAt: currentState.startedAt || nowIso(),
    lastUpdatedAt: nowIso(),
    currentTargetSlot: done ? undefined : remaining[0],
    history,
  };

  await saveAnswers(userId, merged);
  await saveProfilerState(userId, nextState);
  await appendConversation(userId, "assistant", assistantReply);
  await syncAnswersToBackend(userId, merged);
  await safeRecordTrainingSample("profiler", {
    input: trimmed,
    expectedOutput: assistantReply,
    label: done ? "complete" : "turn",
    metadata: {
      userId,
      updates: llmOut.updates || {},
      mergedAnswers: merged,
      remainingSlots: remaining,
      replyLanguage,
    },
  });

  const summary = done
    ? await buildProfileSummaryLocally(userId, { ...opts?.userProfile, replyLanguage })
    : await loadSummary(userId);

  return {
    ok: true,
    assistantReply,
    answers: merged,
    completedSlots: answerValueCount(merged),
    totalSlots: slots.length,
    missingSlots: remaining,
    done,
    history,
    summary,
  };
}

function weatherLocationFromMessage(message: string, userProfile?: { place?: string }) {
  const raw = String(message || "").trim();
  const match =
    raw.match(/\bin\s+([a-zA-Z\s,.-]{2,})$/i) ||
    raw.match(/\bfor\s+([a-zA-Z\s,.-]{2,})$/i) ||
    raw.match(/\bat\s+([a-zA-Z\s,.-]{2,})$/i);
  if (match?.[1]) return match[1].trim();
  return userProfile?.place || "";
}

function weatherLabelFromCode(code: number) {
  const map: Record<number, string> = {
    0: "clear sky",
    1: "mostly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "foggy",
    61: "slight rain",
    63: "moderate rain",
    65: "heavy rain",
    80: "rain showers",
    95: "thunderstorm",
  };
  return map[code] || "unsettled weather";
}

async function fetchWeatherSummary(message: string, userProfile?: { place?: string }) {
  const location = weatherLocationFromMessage(message, userProfile);
  if (!location) return "I need a location to check the weather.";
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
  );
  const geoJson = await geo.json();
  const first = Array.isArray(geoJson?.results) ? geoJson.results[0] : null;
  if (!first) return `I couldn’t find a weather match for ${location}.`;
  const wx = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`
  );
  const wxJson = await wx.json();
  const current = wxJson?.current || {};
  return `Current weather in ${first.name}, ${first.country}: ${current.temperature_2m}°C, feels like ${current.apparent_temperature}°C, ${weatherLabelFromCode(Number(current.weather_code || 0))}, wind ${current.wind_speed_10m} km/h.`;
}

async function buildScheduleAnswer(userId: number, message: string) {
  const normalized = normalizeText(message);
  const all = await loadTasks(userId);
  if (!all.length) return "You do not have any saved reminders yet.";
  const now = new Date();
  const today = now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString();
  let filtered = all.filter((task) => task.status !== "done");
  if (normalized.includes("today")) {
    filtered = filtered.filter((task) => task.isoDatetime && new Date(task.isoDatetime).toDateString() === today);
  } else if (normalized.includes("tomorrow")) {
    filtered = filtered.filter((task) => task.isoDatetime && new Date(task.isoDatetime).toDateString() === tomorrow);
  } else {
    filtered = filtered.filter((task) => !task.isoDatetime || new Date(task.isoDatetime).getTime() >= now.getTime());
  }
  filtered = filtered.slice(0, 5);
  if (!filtered.length) {
    return normalized.includes("today")
      ? "You do not have any reminders scheduled for today."
      : normalized.includes("tomorrow")
        ? "You do not have any reminders scheduled for tomorrow."
        : "You do not have any upcoming reminders saved right now.";
  }
  return [
    "Here are your reminders:",
    ...filtered.map((task) => `- ${task.datetimeText || "Any time"}: ${task.title}${task.details ? ` — ${task.details}` : ""}`),
  ].join("\n");
}

async function parseReminderLocally(message: string, replyLanguage: ReplyLanguage) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  try {
    const out = await localChatJson(
      prompts.reminderExtractorSystem,
      JSON.stringify({ message, reply_language: replyLanguage }),
      cfg.models.orchestratorMedium,
      0.1
    );
    const title = String(out.title || "Reminder").trim() || "Reminder";
    const details = String(out.details || message).trim() || message;
    const datetimeText = out.datetime_text ? String(out.datetime_text).trim() : null;
    const assistantReply =
      String(out.assistant_reply || "").trim() ||
      `Okay, I can set a reminder for ${title}${datetimeText ? ` at ${datetimeText}` : ""}.`;
    return { title, details, datetimeText, assistantReply };
  } catch {
    return {
      title: "Reminder",
      details: message,
      datetimeText: null,
      assistantReply:
        replyLanguage === "ta"
          ? "சரி, இதை ஒரு ரிமைண்டராக வைத்துக்கலாம்."
          : "Okay, I can treat that as a reminder.",
    };
  }
}

function shouldUseLargeReasoner(message: string, config: LocalModelConfig, classification?: any) {
  const normalized = normalizeText(message);
  if (classification?.needs_large_model === true || classification?.needsLargeModel === true) return true;
  if (message.length >= positiveInt(config.thresholds.largeModelQuestionChars, 180)) return true;
  if (/\b(compare|tradeoff|strategy|architect|design|plan|step by step|analyze|analysis|reason)\b/.test(normalized)) return true;
  return false;
}

function fastRouteFromRules(message: string, routes: OrchestratorConfig["routes"]): OrchestratorRoute | null {
  const normalized = normalizeText(message);
  const hasKeyword = (keywords: string[]) =>
    keywords.some((keyword) => {
      const clean = normalizeText(keyword);
      return clean && (normalized === clean || normalized.includes(clean));
    });
  if (hasKeyword(routes.fastGreetingKeywords)) return "fast_greeting";
  if (hasKeyword(routes.reminderKeywords)) return "reminder_create";
  if (hasKeyword(routes.calendarKeywords)) return "calendar_query";
  if (hasKeyword(routes.weatherKeywords)) return "weather";
  if (hasKeyword(routes.profileKeywords)) return "profile";
  if (normalized.length < 16 && hasKeyword(routes.ambiguityKeywords)) return "clarify";
  return null;
}

async function classifyRouteWithModel(
  message: string,
  replyLanguage: ReplyLanguage,
  answers: Record<string, any>,
  profileSummary: string
) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const registry = await getAgentRegistry();
  try {
    const out = await localChatJson(
      prompts.orchestratorSystem,
      JSON.stringify({
        message,
        reply_language: replyLanguage,
        structured_profile: answers,
        profile_summary: profileSummary,
        tool_agents_available: registry.agents.toolAgents,
      }),
      cfg.models.orchestratorMedium,
      0.05
    );
    return {
      route: String(out.route || "local_answer") as OrchestratorRoute,
      reason: String(out.reason || ""),
      clarifyingQuestion: String(out.clarifying_question || "").trim(),
      needsLargeModel: Boolean(out.needs_large_model),
      needsLiveData: Boolean(out.needs_live_data),
    };
  } catch {
    return {
      route: "local_answer" as OrchestratorRoute,
      reason: "fallback",
      clarifyingQuestion: "",
      needsLargeModel: false,
      needsLiveData: false,
    };
  }
}

async function alignAnswer(
  draft: string,
  replyLanguage: ReplyLanguage,
  route: string,
  answers: Record<string, any>,
  profileSummary: string,
  userProfile?: LocalUserProfile
) {
  const cfg = await getModelConfig();
  const rules = await getAlignmentRules();
  const prompts = await getPromptCatalog();
  try {
    const out = await localChatJson(
      prompts.alignmentSystem,
      JSON.stringify({
        rules,
        route,
        draft_answer: draft,
        reply_language: replyLanguage,
        structured_profile: answers,
        profile_summary: profileSummary,
        user: userProfile || {},
      }),
      cfg.models.aligner,
      0.2
    );
    const english = String(out.english_answer || draft).trim() || draft;
    const final = String(out.final_answer || out.english_answer || draft).trim() || draft;
    return { english, final };
  } catch {
    return { english: draft, final: draft };
  }
}

async function lookupSemanticCache(userId: number, message: string) {
  const rules = await getMemoryRules();
  const rows = await loadSemanticCache(userId);
  if (!rows.length) return null;
  const [queryVec] = await embedTexts([message]);
  let best: SemanticCacheRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = cosine(queryVec, Array.isArray(row.embedding) ? row.embedding : []);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (best && bestScore >= positiveFloat(rules.semanticCacheThreshold, 0.95)) {
    return { ...best, score: bestScore };
  }
  return null;
}

async function writeSemanticCache(userId: number, question: string, answer: string, route: string) {
  const rows = await loadSemanticCache(userId);
  const [embedding] = await embedTexts([question]);
  rows.push({
    question,
    normalizedQuestion: normalizeText(question),
    answer,
    route,
    embedding,
    savedAt: nowIso(),
  });
  await saveSemanticCache(userId, rows);
}

async function maybeSyncLocalMemory(userId: number, userProfile?: LocalUserProfile) {
  const rules = await getMemoryRules();
  const registry = await getAgentRegistry();
  if (!registry.agents.memory.enabled) return;

  const turns = await recentConversation(userId, positiveInt(rules.maxTurnsForSync, 18));
  if (turns.length < positiveInt(rules.minTurnsBeforeSync, 6)) return;
  const previous = await readJsonl<MemorySyncRow>(memoryPath(userId));
  const latestSync = previous[previous.length - 1]?.syncedAt;
  if (latestSync) {
    const minutes = (Date.now() - new Date(latestSync).getTime()) / 60000;
    if (minutes < positiveInt(rules.minMinutesBetweenSync, 15)) return;
  }

  const answers = await loadAnswers(userId);
  const slots = await getProfilerSlots();
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();

  try {
    const out = await localChatJson(
      prompts.memorySyncSystem,
      JSON.stringify({
        user: userProfile || {},
        current_answers: answers,
        recent_turns: turns,
        semantic_memory_model: cfg.models.embedding,
      }),
      cfg.models[registry.agents.memory.summarizerModelKey],
      0.1
    );

    const updates = mergeProfilerUpdates(slots, answers, out.profile_updates || {});
    const changed = JSON.stringify(updates) !== JSON.stringify(answers);

    if (changed) {
      await saveAnswers(userId, updates);
      await syncAnswersToBackend(userId, updates);
      await buildProfileSummaryLocally(userId, userProfile);
    }

    const row: MemorySyncRow = {
      syncedAt: nowIso(),
      summary: String(out.summary || "").trim(),
      facts: Array.isArray(out.new_facts)
        ? out.new_facts
            .map((item: any) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, positiveInt(rules.maxFactsPerSync, 6))
        : [],
      profile_updates: out.profile_updates || {},
    };

    await appendJsonl(memoryPath(userId), row);
    await safeRecordTrainingSample("memory", {
      input: JSON.stringify({ recent_turns: turns, current_answers: answers }),
      expectedOutput: JSON.stringify(row),
      label: changed ? "profile_update" : "memory_sync",
      metadata: { userId, embeddingModel: cfg.models.embedding },
    });
  } catch {
    // local-first: skip silently
  }
}

async function buildLocalReasoningDraft(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, any>;
  profileSummary: string;
  userProfile?: LocalUserProfile;
  useLargeModel: boolean;
}) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const memories = await readJsonl<MemorySyncRow>(memoryPath(opts.userId));
  const turns = await recentConversation(opts.userId, 10);
  const ragHits = await searchLocalRag(opts.userId, opts.message, 6);
  const registry = await getAgentRegistry();
  const model = opts.useLargeModel
    ? cfg.models[registry.agents.orchestrator.largeModelKey]
    : cfg.models[registry.agents.orchestrator.mediumModelKey];
  const draft = await localChatText(
    prompts.localReasonerSystem,
    JSON.stringify({
      user_message: opts.message,
      reply_language: opts.replyLanguage,
      structured_profile: opts.answers,
      profile_summary: opts.profileSummary,
      profile_facts: profileFactsText(opts.answers),
      user: opts.userProfile || {},
      recent_memory: memories.slice(-6),
      recent_conversation: turns,
      rag_hits: ragHits.map((row) => ({
        source_id: row.sourceId,
        source_type: row.sourceType,
        text: row.text,
        score: row.score,
        metadata: row.metadata || {},
      })),
    }),
    model,
    0.25
  );
  return draft.trim();
}

export async function saveScheduledTask(
  userId: number,
  task: Omit<LocalTaskRecord, "id" | "createdAt">
) {
  await ensureLocalAgentData();
  const current = await loadTasks(userId);
  const row: LocalTaskRecord = {
    id: `${Date.now()}_${simpleHash(JSON.stringify(task))}`,
    createdAt: nowIso(),
    ...task,
  };
  current.unshift(row);
  await saveTasks(userId, current.slice(0, 500));
  return row;
}

export async function runLocalAssistantTurn(opts: {
  userId: number;
  message: string;
  replyLanguage?: ReplyLanguage;
  userProfile?: LocalUserProfile;
}) {
  await ensureLocalAgentData();
  const userId = opts.userId;
  const message = String(opts.message || "").trim();
  const replyLanguage: ReplyLanguage = opts.replyLanguage === "en" ? "en" : "ta";
  if (!message) throw new Error("Message is required.");

  await appendConversation(userId, "user", message);

  const answers = await loadAnswers(userId);
  const profileSummary =
    (await loadSummary(userId)) ||
    (await buildProfileSummaryLocally(userId, { ...opts.userProfile, replyLanguage }));

  const semantic = await lookupSemanticCache(userId, message);
  if (semantic) {
    await appendConversation(userId, "assistant", semantic.answer);
    await safeRecordTrainingSample("memory", {
      input: message,
      expectedOutput: semantic.answer,
      label: "semantic_cache_hit",
      metadata: { userId, route: semantic.route, score: semantic.score },
    });
    return {
      route: "semantic_cache",
      source: "semantic_cache",
      cacheHit: true,
      assistantText: semantic.answer,
      englishText: semantic.answer,
      intent: "assistant",
      profileSummary,
      meta: {
        score: semantic.score,
        dataFolder: DATA_DIR,
        trainingFolder: TRAINING_DIR,
        ragFolder: RAG_DIR,
      },
    } satisfies LocalAssistantTurnResult;
  }

  const routesConfig = await getOrchestratorConfig();
  const cfg = await getModelConfig();
  const registry = await getAgentRegistry();
  const fast = fastRouteFromRules(message, routesConfig.routes);
  const classified = fast
    ? {
        route: fast,
        reason: "fast_rules",
        clarifyingQuestion: "",
        needsLargeModel: false,
        needsLiveData: false,
      }
    : await classifyRouteWithModel(message, replyLanguage, answers, profileSummary);

  await safeRecordTrainingSample("orchestrator", {
    input: message,
    expectedOutput: JSON.stringify(classified),
    label: fast ? "fast_rule_route" : "model_route",
    metadata: {
      userId,
      replyLanguage,
      profileSummary,
      availableToolAgents: registry.agents.toolAgents,
    },
  });

  let route = classified.route;
  let source: LocalAssistantTurnResult["source"] = fast ? "local_rules" : "local_model";
  let intent: LocalAssistantTurnResult["intent"] = "assistant";
  let title: string | null | undefined;
  let details: string | null | undefined;
  let datetimeText: string | null | undefined;
  let draft = "";
  let english = "";
  let final = "";

  if (
    ![
      "fast_greeting",
      "clarify",
      "profile",
      "calendar_query",
      "reminder_create",
      "weather",
      "local_answer",
      "fallback_openai",
    ].includes(route)
  ) {
    route = "local_answer";
  }

  if (route === "fast_greeting") {
    draft =
      replyLanguage === "ta"
        ? `வணக்கம் ${opts.userProfile?.name || ""}. நான் எப்படி உதவலாம்?`.trim()
        : `Hi ${opts.userProfile?.name || "there"}, how can I help?`;
    english = draft;
    final = draft;
  } else if (route === "clarify") {
    intent = "clarify";
    source = "local_rules";
    draft =
      classified.clarifyingQuestion ||
      (replyLanguage === "ta"
        ? "கொஞ்சம் இன்னும் தெளிவாக சொல்லுங்களேன், சரியான பதில் தர முடியும்."
        : "Could you give me a bit more detail so I can answer accurately?");
    english = draft;
    final = draft;
  } else if (route === "profile") {
    source = "local_rules";
    draft =
      heuristicProfileAnswer(message, answers, opts.userProfile) ||
      (replyLanguage === "ta"
        ? "உங்களைப் பற்றிய சில தகவல்கள் என்கிட்ட இருக்கு. இதை கொஞ்சம் நேராக கேளுங்கள்."
        : "I do have some profile information about you. Ask that a little more directly.");
    const aligned = await alignAnswer(draft, replyLanguage, route, answers, profileSummary, opts.userProfile);
    english = aligned.english;
    final = aligned.final;
  } else if (route === "calendar_query") {
    if (!registry.agents.toolAgents.calendar) {
      route = "fallback_openai";
    } else {
      source = "local_rules";
      draft = await buildScheduleAnswer(userId, message);
      const aligned = await alignAnswer(draft, replyLanguage, route, answers, profileSummary, opts.userProfile);
      english = aligned.english;
      final = aligned.final;
    }
  } else if (route === "reminder_create") {
    intent = "reminder";
    const parsed = await parseReminderLocally(message, replyLanguage);
    title = parsed.title;
    details = parsed.details;
    datetimeText = parsed.datetimeText;
    draft = parsed.assistantReply;
    const aligned = await alignAnswer(draft, replyLanguage, route, answers, profileSummary, opts.userProfile);
    english = aligned.english;
    final = aligned.final;
  } else if (route === "weather") {
    if (!registry.agents.toolAgents.weather) {
      route = "fallback_openai";
    } else {
      try {
        draft = await fetchWeatherSummary(message, opts.userProfile);
        const aligned = await alignAnswer(draft, replyLanguage, route, answers, profileSummary, opts.userProfile);
        english = aligned.english;
        final = aligned.final;
      } catch {
        route = "fallback_openai";
      }
    }
  }

  if (route === "local_answer") {
    const directProfile = heuristicProfileAnswer(message, answers, opts.userProfile);
    if (directProfile) {
      source = "local_rules";
      draft = directProfile;
    } else {
      try {
        draft = await buildLocalReasoningDraft({
          userId,
          message,
          replyLanguage,
          answers,
          profileSummary,
          userProfile: opts.userProfile,
          useLargeModel: shouldUseLargeReasoner(message, cfg, classified),
        });
        if (draft === "__OPENAI_FALLBACK__" || classified.needsLiveData) {
          route = "fallback_openai";
        }
      } catch {
        route = "fallback_openai";
      }
    }

    if (route === "local_answer") {
      const aligned = await alignAnswer(draft, replyLanguage, route, answers, profileSummary, opts.userProfile);
      english = aligned.english;
      final = aligned.final;
    }
  }

  if (route === "fallback_openai") {
    source = "openai_fallback";
    const backend = await apiPost<any>("/api/chat", {
      user_id: userId,
      message,
      reply_language: replyLanguage,
    });
    const backendText =
      String(
        backend?.assistant?.text ||
          backend?.assistant?.english ||
          backend?.details ||
          backend?.raw_text ||
          ""
      ).trim() || "I couldn’t generate a response.";
    const aligned = await alignAnswer(backendText, replyLanguage, route, answers, profileSummary, opts.userProfile);
    english = aligned.english;
    final = aligned.final;
  }

  const assistantText = final || english || draft || "I couldn’t generate a response.";
  await appendConversation(userId, "assistant", assistantText);

  if (assistantText.trim() && route !== "reminder_create" && route !== "clarify") {
    await writeSemanticCache(userId, message, assistantText, route);
  }

  await safeRecordTrainingSample("alignment", {
    input: JSON.stringify({
      route,
      draft,
      english,
      replyLanguage,
      profileSummary,
      answers,
    }),
    expectedOutput: assistantText,
    label: route,
    metadata: { userId, source },
  });

  await maybeSyncLocalMemory(userId, { ...opts.userProfile, replyLanguage });

  return {
    route,
    source,
    cacheHit: false,
    assistantText,
    englishText: english || draft || assistantText,
    intent,
    title,
    details,
    datetimeText,
    profileSummary,
    meta: {
      classified,
      dataFolder: DATA_DIR,
      trainingFolder: TRAINING_DIR,
      ragFolder: RAG_DIR,
      promptConfig: PROMPTS_PATH,
      modelConfig: MODELS_PATH,
    },
  } satisfies LocalAssistantTurnResult;
}
