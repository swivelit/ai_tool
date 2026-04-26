import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";

import { apiPost, apiPostBackendOnly } from "./api";
import {
  ensureLocalAgentSeedData,
  LOCAL_AGENT_DATA_DIR,
} from "./localAgentBootstrap";
import {
  OPENAI_FALLBACK_SIGNAL,
  createLocalModelRuntime,
  isLoopbackLocalRuntimeBaseUrl,
  normalizeLocalRuntimeBaseUrl,
} from "./localModelRuntime";

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
  missingSlots?: string[];
  confidenceBySlot?: Record<string, number>;
  optionalProfileNotes?: string[];
  lastRunSource?: "model_json" | "model_salvage" | "fallback";
  completionSyncState?:
    | "incomplete"
    | "complete_local_pending_sync"
    | "complete_synced"
    | "sync_failed";
  completedLocallyAt?: string;
  pendingBackendSync?: boolean;
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

type ProfilerModelOutput = {
  assistant_reply: string;
  updates: Record<string, string | string[]>;
  missing_slots: string[];
  completed: boolean;
  confidence_by_slot: Record<string, number>;
  optional_profile_notes?: string[];
};

type ProfilerTurnProcessingResult = {
  output: ProfilerModelOutput;
  source: "model_json" | "model_salvage" | "fallback";
  rawText?: string;
};

type ProfileSummaryRecord = {
  userId: number;
  source: "profiler";
  completed: boolean;
  summary: string;
  facts: string[];
  confidenceBySlot: Record<string, number>;
  optionalProfileNotes: string[];
  updatedAt: string;
};

type ProfileRagRecord = {
  userId: number;
  source: "profiler";
  summary: string;
  facts: string[];
  metadata: Record<string, any>;
  chunks: LocalRagChunk[];
  updatedAt: string;
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
  meta?: Record<string, any> & { orchestratorDecision?: OrchestratorDecision };
};

type LocalModelConfig = {
  version?: number;
  runtime?: {
    primary: "phone_local" | string;
    backendRole?: string;
    backendPolicy?: string;
    localRuntimeInterface?: string;
  };
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  models: {
    profiler: string;
    orchestratorMedium: string;
    orchestratorLarge: string;
    aligner: string;
    embedding: string;
    summarizer: string;
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
    smallTalkKeywords?: string[];
    calendarKeywords: string[];
    reminderKeywords: string[];
    weatherKeywords: string[];
    profileKeywords: string[];
    liveDataKeywords: string[];
    ambiguityKeywords: string[];
    multiStepKeywords?: string[];
  };
  clarificationRules?: {
    shortMessageTokenThreshold?: number;
    pronounOnlyTokenThreshold?: number;
  };
  complexityThresholds?: {
    largeModelQuestionChars?: number;
    largeModelConversationTurns?: number;
  };
  fallbackPolicy?: {
    openAiAllowedWhen?: string[];
  };
};

type AlignmentRules = {
  version?: number;
  preserveFacts: boolean;
  avoidNewClaims: boolean;
  matchTone: boolean;
  preferUserLanguage: boolean;
  fallbackToDraftOnFactDrift?: boolean;
  keepEnglishMirror?: boolean;
  toneByPreference?: Record<string, string>;
};

type OrchestratorDecision = {
  route: OrchestratorRoute;
  reason: string;
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion: string;
  needsLiveData: boolean;
  selectedModel: string;
  fallbackAllowed: boolean;
};

type MemoryRules = {
  version?: number;
  cache: {
    similarityThreshold: number;
    borderlineSimilarityThreshold: number;
    ttlHours: number;
    maxEntries: number;
    maxHitRecords: number;
    skipRoutes: string[];
  };
  durableFacts: {
    confidenceThreshold: number;
    maxFactsPerSync: number;
    transientMarkers: string[];
    importantMarkers: string[];
  };
  summarization: {
    minTurnsBeforeSync: number;
    minMinutesBetweenSync: number;
    maxTurnsForSync: number;
    dailySummaryLimit: number;
  };
  profileUpdates: {
    fillEmptySlotsOnly: boolean;
    minConfidenceForNewSlot: number;
    minConfidenceForOverwrite: number;
    maxExistingConfidenceToOverwrite: number;
  };
};

type SemanticCacheEntry = {
  id: string;
  userId: number;
  sourceQuestion: string;
  normalizedQuestion: string;
  canonicalAnswer: string;
  englishAnswer: string;
  lastPresentedAnswer?: string;
  route: string;
  intent: LocalAssistantTurnResult["intent"];
  embedding: number[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  alignmentProfile?: {
    replyLanguage: ReplyLanguage;
    tone?: string;
  };
};

type SemanticCacheHitRecord = {
  userId: number;
  sourceQuestion: string;
  matchedQuestion: string;
  similarity: number;
  timestamp: string;
  alignmentReapplied: boolean;
  route: string;
};

type SemanticCacheStore = {
  version: number;
  entries: SemanticCacheEntry[];
  hits: SemanticCacheHitRecord[];
};

type DurableFactRecord = {
  fact: string;
  confidence: number;
  category: string;
  source: "model" | "heuristic";
  firstSeenAt: string;
  lastSeenAt: string;
  evidence: string[];
  important?: boolean;
  profileUpdates?: Record<string, any>;
};

type DailySummaryRecord = {
  userId: number;
  createdAt: string;
  windowStartAt?: string;
  windowEndAt?: string;
  summary: string;
  durableFacts: DurableFactRecord[];
  profileUpdates: Record<string, any>;
  source: "model" | "fallback";
  conversationTurnCount: number;
  routeLogCount: number;
};

type ProfileUpdateRecord = {
  userId: number;
  createdAt: string;
  applied: boolean;
  updates: Record<string, any>;
  previousAnswers: Record<string, any>;
  nextAnswers: Record<string, any>;
  reasons: string[];
};

type MemoryConsolidationResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  summary?: DailySummaryRecord;
  durableFacts?: DurableFactRecord[];
  profileUpdate?: ProfileUpdateRecord;
  memoryChunks?: LocalRagChunk[];
};

type MemoryConsolidationModelOutput = {
  summary?: string;
  durable_facts?: Array<{
    fact?: string;
    confidence?: number;
    category?: string;
    important?: boolean;
    evidence?: string[];
    profile_updates?: Record<string, any>;
  }>;
  profile_updates?: Record<string, any>;
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

function normalizeLocalModelBaseUrl(value: unknown) {
  return normalizeLocalRuntimeBaseUrl(value);
}

function isLoopbackLocalModelBaseUrl(value: unknown) {
  return isLoopbackLocalRuntimeBaseUrl(value);
}

const EMBEDDING_DIMS = 1024;

const DEFAULT_MODEL_CONFIG: LocalModelConfig = {
  version: 2,
  runtime: {
    primary: "phone_local",
    backendRole: "fallback_only",
    backendPolicy:
      "OpenAI/backend is never primary; call it only after the local orchestrator or local runtime explicitly requests fallback.",
    localRuntimeInterface: "LocalModelRuntime",
  },
  baseUrl: "",
  apiKey: "",
  timeoutMs: 45000,
  models: {
    profiler: "google/gemma-3-4b-it",
    orchestratorMedium: "Qwen/Qwen3-8B",
    orchestratorLarge: "Qwen/Qwen3-14B",
    aligner: "google/gemma-3-4b-it",
    embedding: "Qwen/Qwen3-Embedding-0.6B",
    summarizer: "Qwen/Qwen3-8B",
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
  version: 3,
  routes: {
    fastGreetingKeywords: ["hi", "hello", "hey", "vanakkam", "thanks"],
    smallTalkKeywords: ["how are you", "what's up", "whats up"],
    calendarKeywords: ["schedule", "agenda", "calendar", "reminders"],
    reminderKeywords: ["remind me", "set a reminder", "add reminder"],
    weatherKeywords: ["weather", "temperature", "rain", "forecast"],
    profileKeywords: ["my name", "my goal", "my language", "my hobbies"],
    liveDataKeywords: ["latest", "news", "current", "today", "live", "browse"],
    ambiguityKeywords: [
      "this",
      "that",
      "it",
      "they",
      "there",
      "here",
      "he",
      "she",
    ],
    multiStepKeywords: ["compare", "tradeoff", "strategy", "analyze", "reason"],
  },
  clarificationRules: {
    shortMessageTokenThreshold: 4,
    pronounOnlyTokenThreshold: 6,
  },
  complexityThresholds: {
    largeModelQuestionChars: 180,
    largeModelConversationTurns: 8,
  },
  fallbackPolicy: {
    openAiAllowedWhen: [
      "local_reasoner_returns___OPENAI_FALLBACK__",
      "orchestrator_needs_live_data",
      "no_safe_local_tool_or_model_path",
    ],
  },
};

const DEFAULT_ALIGNMENT_RULES: AlignmentRules = {
  preserveFacts: true,
  avoidNewClaims: true,
  matchTone: true,
  preferUserLanguage: true,
  fallbackToDraftOnFactDrift: true,
  keepEnglishMirror: true,
  toneByPreference: {
    short_direct: "Keep the answer compact, direct, and low-fluff.",
    warm: "Keep the answer warm and supportive without adding facts.",
    friendly_casual:
      "Keep the answer conversational and casual without becoming vague.",
    detailed:
      "Keep the answer clear and more explanatory, but still grounded to the draft.",
  },
};

const DEFAULT_MEMORY_RULES: MemoryRules = {
  version: 2,
  cache: {
    similarityThreshold: 0.92,
    borderlineSimilarityThreshold: 0.86,
    ttlHours: 168,
    maxEntries: 250,
    maxHitRecords: 500,
    skipRoutes: ["clarify", "reminder_create", "weather", "fallback_openai"],
  },
  durableFacts: {
    confidenceThreshold: 0.78,
    maxFactsPerSync: 6,
    transientMarkers: [
      "today",
      "tomorrow",
      "this week",
      "this month",
      "current",
      "currently",
      "right now",
      "tonight",
      "temporary",
    ],
    importantMarkers: ["important", "remember this", "save this", "note this"],
  },
  summarization: {
    minTurnsBeforeSync: 6,
    minMinutesBetweenSync: 15,
    maxTurnsForSync: 18,
    dailySummaryLimit: 14,
  },
  profileUpdates: {
    fillEmptySlotsOnly: true,
    minConfidenceForNewSlot: 0.82,
    minConfidenceForOverwrite: 0.93,
    maxExistingConfidenceToOverwrite: 0.75,
  },
};

const DEFAULT_PROMPTS: PromptCatalog = {
  profilerOpeningSystem:
    "You are the Profiler Agent using Gemma 3 4B. Start onboarding as a natural chat in {{reply_language_name}}. Do not mention forms or questionnaires. Ask only one thing in the opening turn. Collect these slots over time: {{slot_ids}}.",
  profilerTurnSystem:
    "You are the Profiler Agent using Gemma 3 4B. Continue onboarding as a natural chat in {{reply_language_name}}. Extract structured updates from the latest free-form user reply, avoid re-asking high-confidence known facts, and choose the next best question from the remaining slots. If all slots are collected, stop asking questions. Return JSON only with: assistant_reply, updates, missing_slots, completed, confidence_by_slot, optional_profile_notes.",
  profileSummarySystem:
    "Write a compact factual English profile summary from the provided onboarding facts. Mention only grounded user facts and stable preferences. Do not invent anything.",
  orchestratorSystem:
    "You are the Orchestrator Agent using Qwen 3. Route the request local-first and return JSON only with: route, reason, confidence, needs_clarification, clarification_question, needs_live_data, selected_model, fallback_allowed.",
  reminderExtractorSystem:
    "Extract reminder title, details, datetime_text, and assistant_reply as JSON.",
  alignmentSystem:
    "Rewrite the factual draft to match the user's tone and language without changing facts or adding claims. Return JSON with english_answer and final_answer.",
  memorySyncSystem:
    "You are the local Memory & Cache Agent. Use only the provided recent conversation, route logs, profiler state, and alignment captures. Extract durable user facts conservatively. Ignore transient facts unless the user explicitly marks them important. Return JSON only with: summary, durable_facts[{fact, confidence, category, important, evidence, profile_updates}], profile_updates.",
  localReasonerSystem: `Use only local context. Reply ${OPENAI_FALLBACK_SIGNAL} if live public data is required.`,
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
      description:
        "Route user intent, tool choice, and local-vs-backend fallback decisions",
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
      summarizerModelKey: "summarizer",
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
  version: 4,
  runtime: {
    primary: "phone_local",
    backendPolicy: "fallback_only",
    localRuntimeInterface: "LocalModelRuntime",
  },
  architecture: {
    primaryRuntime: "phone_local_agents",
    backendRole: "fallback_only",
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
  return String(text || "").replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key) => {
      const value = values[key];
      return value == null ? "" : String(value);
    },
  );
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

function clampConfidence(value: any, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function nonEmptyAnswer(value: any) {
  return Array.isArray(value)
    ? value.length > 0
    : String(value || "").trim().length > 0;
}

function languageLabel(language: string) {
  const normalized = normalizeText(language);
  if (normalized === "ta" || normalized === "tamil") return "Tamil";
  if (normalized === "hindi") return "Hindi";
  if (normalized === "telugu") return "Telugu";
  if (normalized === "malayalam") return "Malayalam";
  return "English";
}

function fallbackReplyLanguageCode(language: string) {
  return normalizeText(language) === "tamil" ? "ta" : "en";
}

function cleanupTrailingJson(text: string) {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function repairJsonFragment(fragment: string) {
  const text = cleanupTrailingJson(String(fragment || "").trim());
  if (!text) return text;
  let inString = false;
  let escape = false;
  let braces = 0;
  let brackets = 0;
  for (const char of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") braces += 1;
    if (char === "}") braces = Math.max(0, braces - 1);
    if (char === "[") brackets += 1;
    if (char === "]") brackets = Math.max(0, brackets - 1);
  }
  return cleanupTrailingJson(
    `${text}${"]".repeat(brackets)}${"}".repeat(braces)}`,
  );
}

function parseJsonFragment<T>(fragment: string, fallback: T): T {
  return parseJsonLoose<T>(repairJsonFragment(fragment), fallback);
}

function findFieldValueFragment(text: string, key: string) {
  const match = new RegExp(`["']?${key}["']?\\s*:`, "i").exec(text);
  if (!match || match.index < 0) return null;
  let index = match.index + match[0].length;
  while (/\s/.test(text[index] || "")) index += 1;
  const start = index;
  const first = text[start];
  if (!first) return null;
  if (first === '"') {
    index += 1;
    let escape = false;
    while (index < text.length) {
      const char = text[index];
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        index += 1;
        break;
      }
      index += 1;
    }
    return text.slice(start, index);
  }
  if (first === "{" || first === "[") {
    const stack = [first];
    index += 1;
    let inString = false;
    let escape = false;
    while (index < text.length) {
      const char = text[index];
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = !inString;
      } else if (!inString) {
        if (char === "{" || char === "[") stack.push(char);
        if (char === "}" || char === "]") stack.pop();
        if (!stack.length) {
          index += 1;
          break;
        }
      }
      index += 1;
    }
    return text.slice(start, index);
  }
  while (index < text.length && !/[,\n}]/.test(text[index])) {
    index += 1;
  }
  return text.slice(start, index).trim();
}

function normalizeSlotValue(
  slot: ProfilerSlot,
  value: any,
): string | string[] | undefined {
  if (!nonEmptyAnswer(value)) return undefined;
  if (slot.type === "multi") {
    const normalizedOptions = slot.options.map((option) =>
      normalizeText(option),
    );
    const normalizedValues = trimList(value)
      .map((item) => normalizeText(item).replace(/\s+/g, "_"))
      .map((item) => {
        const matchedIndex = normalizedOptions.findIndex(
          (option) => option === item || option === item.replace(/_/g, " "),
        );
        if (matchedIndex >= 0) return slot.options[matchedIndex];
        return item;
      })
      .filter(Boolean);
    return uniq(normalizedValues).slice(0, slot.max_choices || 4);
  }
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const normalizedRaw = normalizeText(raw).replace(/\s+/g, "_");
  const normalizedOptions = slot.options.map((option) =>
    normalizeText(option).replace(/\s+/g, "_"),
  );
  const matchedIndex = normalizedOptions.findIndex(
    (option) => option === normalizedRaw,
  );
  return matchedIndex >= 0 ? slot.options[matchedIndex] : raw;
}

function slotPriorityAfterUpdate(lastUpdatedSlotIds: string[]) {
  const priorities: string[] = [];
  const add = (slotId: string) => {
    if (!priorities.includes(slotId)) priorities.push(slotId);
  };
  for (const slotId of lastUpdatedSlotIds) {
    if (slotId === "preferred_language") add("secondary_language");
    if (slotId === "occupation") add("industry_or_field");
    if (slotId === "hobbies") add("interests");
    if (slotId === "communication_tone") add("answer_length");
    if (slotId === "personality_style") add("assistant_persona");
    if (slotId === "planning_style") add("work_rhythm");
  }
  return priorities;
}

function chooseNextProfilerSlot(
  slots: ProfilerSlot[],
  answers: Record<string, any>,
  confidenceBySlot: Record<string, number>,
  lastUpdatedSlotIds: string[],
) {
  const remaining = missingSlots(slots, answers);
  if (!remaining.length) return null;
  const prioritized = slotPriorityAfterUpdate(lastUpdatedSlotIds);
  for (const slotId of prioritized) {
    const candidate = slots.find(
      (slot) => slot.id === slotId && remaining.includes(slot.id),
    );
    if (candidate) return candidate;
  }
  const lowConfidenceMissing = slots.find(
    (slot) =>
      remaining.includes(slot.id) &&
      clampConfidence(confidenceBySlot[slot.id], 0) < 0.55,
  );
  return (
    lowConfidenceMissing ||
    slots.find((slot) => remaining.includes(slot.id)) ||
    null
  );
}

function formatSlotFacts(slots: ProfilerSlot[], answers: Record<string, any>) {
  return slots
    .filter((slot) => nonEmptyAnswer(answers[slot.id]))
    .map((slot) => `${slot.id}: ${displayValue(answers[slot.id])}`);
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
    await FileSystem.writeAsStringAsync(path, line, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return;
  }
  const current = await FileSystem.readAsStringAsync(path).catch(() => "");
  await FileSystem.writeAsStringAsync(path, `${current}${line}`, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

async function deleteIfExists(path: string) {
  try {
    if (await exists(path)) {
      await FileSystem.deleteAsync(path, { idempotent: true });
    }
  } catch {
    // Best-effort local privacy cleanup should not break sign-out/delete flows.
  }
}

export async function clearLocalAgentDataForUser(userId: number) {
  await ensureLocalAgentData();

  await Promise.all([
    deleteIfExists(`${PROFILES_DIR}/${userId}`),
    deleteIfExists(tasksPath(userId)),
    deleteIfExists(convoPath(userId)),
    deleteIfExists(routeLogPath(userId)),
    deleteIfExists(dailySummariesPath(userId)),
    deleteIfExists(durableFactsPath(userId)),
    deleteIfExists(profileUpdatesPath(userId)),
    deleteIfExists(profileRagPath(userId)),
    deleteIfExists(ragChunksPath(userId)),
    deleteIfExists(memoryChunksPath(userId)),
  ]);

  const semanticStore = await readJson<SemanticCacheStore>(
    semanticCacheStorePath(),
    {
      version: 2,
      entries: [],
      hits: [],
    },
  );
  const retained = semanticStore.entries.filter(
    (entry) => entry.userId !== userId,
  );
  const retainedHits = (semanticStore.hits || []).filter(
    (hit) => hit.userId !== userId,
  );
  if (
    retained.length !== semanticStore.entries.length ||
    retainedHits.length !== (semanticStore.hits || []).length
  ) {
    await writeJson(semanticCacheStorePath(), {
      version: semanticStore.version || 2,
      entries: retained,
      hits: retainedHits,
    } satisfies SemanticCacheStore);
  }
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

function hashEmbedding(text: string, dims = EMBEDDING_DIMS) {
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

function normalizeEmbeddingVector(embedding: unknown, fallbackText: string) {
  const values = Array.isArray(embedding)
    ? embedding.map(Number).filter(Number.isFinite)
    : [];
  return values.length === EMBEDDING_DIMS
    ? values
    : hashEmbedding(fallbackText);
}

function normalizeStoredEmbedding(embedding: unknown, fallbackText: string) {
  return normalizeEmbeddingVector(embedding, fallbackText);
}

function cosine(a: number[], b: number[]) {
  if (!a.length || !b.length) return 0;
  if (a.length !== b.length) {
    console.warn(
      `[localAgents] embedding dimension mismatch: ${a.length} !== ${b.length}; skipping similarity score.`,
    );
    return 0;
  }

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
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
function semanticCacheStorePath() {
  return `${CACHE_DIR}/semantic_cache.json`;
}
function tasksPath(userId: number) {
  return `${TASKS_DIR}/${userId}.json`;
}
function convoPath(userId: number) {
  return `${CONVERSATIONS_DIR}/${userId}.jsonl`;
}
function routeLogPath(userId: number) {
  return `${CONVERSATIONS_DIR}/${userId}_routes.jsonl`;
}
function dailySummariesPath(userId: number) {
  return `${MEMORY_DIR}/daily_summaries/${userId}.jsonl`;
}
function durableFactsPath(userId: number) {
  return `${MEMORY_DIR}/durable_facts/${userId}.json`;
}
function profileUpdatesPath(userId: number) {
  return `${MEMORY_DIR}/profile_updates/${userId}.jsonl`;
}
function profileRagPath(userId: number) {
  return `${RAG_DIR}/${userId}_profile_rag.json`;
}
function ragChunksPath(userId: number) {
  return `${RAG_DIR}/${userId}_chunks.json`;
}
function memoryChunksPath(userId: number) {
  return `${RAG_DIR}/${userId}_memory_chunks.json`;
}
function trainingSamplesPath(agent = "general") {
  const safe = normalizeText(agent).replace(/\s+/g, "_") || "general";
  return `${TRAINING_DIR}/${safe}.jsonl`;
}

const fileMutationQueues = new Map<string, Promise<unknown>>();
const lastLocalMemoryConsolidationAttemptAt = new Map<number, number>();
const LOCAL_MEMORY_CONSOLIDATION_ATTEMPT_COOLDOWN_MINUTES = positiveInt(
  DEFAULT_MEMORY_RULES.summarization?.minMinutesBetweenSync,
  15,
);

function shouldAttemptLocalMemoryConsolidation(
  userId: number,
  opts?: { force?: boolean; nowMs?: number; cooldownMinutes?: number },
) {
  if (opts?.force) return true;
  const requestedNowMs = opts?.nowMs;
  const nowMs = Number.isFinite(requestedNowMs)
    ? Number(requestedNowMs)
    : Date.now();
  const cooldownMinutes = positiveInt(
    opts?.cooldownMinutes,
    LOCAL_MEMORY_CONSOLIDATION_ATTEMPT_COOLDOWN_MINUTES,
  );
  const cooldownMs = cooldownMinutes * 60_000;
  const lastAttemptAt = lastLocalMemoryConsolidationAttemptAt.get(userId);
  if (typeof lastAttemptAt === "number" && nowMs - lastAttemptAt < cooldownMs) {
    return false;
  }
  lastLocalMemoryConsolidationAttemptAt.set(userId, nowMs);
  return true;
}

function queueFileMutation<T>(
  lockKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = fileMutationQueues.get(lockKey) ?? Promise.resolve();
  const run = previous.then(task);
  fileMutationQueues.set(lockKey, run);
  run
    .finally(() => {
      if (fileMutationQueues.get(lockKey) === run) {
        fileMutationQueues.delete(lockKey);
      }
    })
    .catch(() => undefined);
  return run;
}

function answerValueCount(answers: Record<string, any>) {
  return Object.values(answers).filter((value) =>
    Array.isArray(value)
      ? value.length > 0
      : String(value || "").trim().length > 0,
  ).length;
}

function missingSlots(slots: ProfilerSlot[], answers: Record<string, any>) {
  return slots
    .filter((slot) => {
      const value = answers[slot.id];
      return Array.isArray(value)
        ? value.length === 0
        : !String(value || "").trim();
    })
    .map((slot) => slot.id);
}

function nextSlot(slots: ProfilerSlot[], answers: Record<string, any>) {
  const remaining = missingSlots(slots, answers);
  return slots.find((slot) => remaining.includes(slot.id)) || null;
}

function profileFactsText(answers: Record<string, any>) {
  return Object.entries(answers)
    .filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : String(value || "").trim(),
    )
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
  userProfile?: LocalUserProfile,
) {
  const normalized = normalizeText(message);

  if (
    /\b(my name|what is my name|who am i)\b/.test(normalized) &&
    userProfile?.name
  ) {
    return `Your name is ${userProfile.name}.`;
  }

  if (
    /\b(my place|where am i from|my hometown|my town)\b/.test(normalized) &&
    userProfile?.place
  ) {
    return `Your place is ${userProfile.place}.`;
  }

  if (
    /\b(hobbies|what do i like|what do i enjoy)\b/.test(normalized) &&
    answers.hobbies
  ) {
    return `You told me your hobbies include ${displayValue(answers.hobbies)}.`;
  }

  if (
    /\b(language|languages|what do i speak|which language)\b/.test(normalized)
  ) {
    const langs = languagesSummary(answers);
    if (langs) return `You told me you speak ${langs}.`;
  }

  if (
    /\b(job|work|occupation|what do i do)\b/.test(normalized) &&
    answers.occupation
  ) {
    const field = displayValue(answers.industry_or_field);
    return field
      ? `You described yourself as ${displayValue(answers.occupation)} in ${field}.`
      : `You described yourself as ${displayValue(answers.occupation)}.`;
  }

  if (
    /\b(goal|focus|priority|what matters)\b/.test(normalized) &&
    answers.main_goal
  ) {
    return `Right now, your main focus is ${displayValue(answers.main_goal)}.`;
  }

  if (
    /\b(communication style|tone|how should you talk|how do i like replies)\b/.test(
      normalized,
    ) &&
    answers.communication_tone
  ) {
    const length = displayValue(answers.answer_length);
    return length
      ? `You prefer a ${displayValue(answers.communication_tone)} tone with ${length} answers.`
      : `You prefer a ${displayValue(answers.communication_tone)} tone.`;
  }

  if (
    /\b(dislike|dont like|don't like|avoid doing)\b/.test(normalized) &&
    answers.dislikes
  ) {
    return `You said you dislike responses that feel ${displayValue(answers.dislikes)}.`;
  }

  if (/\b(who are you|what can you do)\b/.test(normalized)) {
    return `I’m ${userProfile?.assistantName || "Elli"}, your local-first assistant.`;
  }

  return "";
}

async function safeRecordTrainingSample(
  agent: LocalTrainingSample["agent"],
  sample: Omit<LocalTrainingSample, "id" | "agent" | "createdAt">,
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

  if (!(await exists(MODELS_PATH)))
    await writeJson(MODELS_PATH, DEFAULT_MODEL_CONFIG);
  if (!(await exists(SLOTS_PATH)))
    await writeJson(SLOTS_PATH, DEFAULT_PROFILER_SLOTS);
  if (!(await exists(ROUTES_PATH)))
    await writeJson(ROUTES_PATH, DEFAULT_ORCHESTRATOR_CONFIG);
  if (!(await exists(ALIGNMENT_PATH)))
    await writeJson(ALIGNMENT_PATH, DEFAULT_ALIGNMENT_RULES);
  if (!(await exists(MEMORY_RULES_PATH)))
    await writeJson(MEMORY_RULES_PATH, DEFAULT_MEMORY_RULES);
  if (!(await exists(PROMPTS_PATH)))
    await writeJson(PROMPTS_PATH, DEFAULT_PROMPTS);
  if (!(await exists(AGENT_REGISTRY_PATH)))
    await writeJson(AGENT_REGISTRY_PATH, DEFAULT_AGENT_REGISTRY);
  if (!(await exists(WORKSPACE_MANIFEST_PATH)))
    await writeJson(WORKSPACE_MANIFEST_PATH, DEFAULT_WORKSPACE_MANIFEST);
}

async function getModelConfig() {
  await ensureLocalAgentData();
  const fileConfig = await readJson<LocalModelConfig>(
    MODELS_PATH,
    DEFAULT_MODEL_CONFIG,
  );
  return {
    ...fileConfig,
    baseUrl: normalizeLocalModelBaseUrl(
      extra.LOCAL_MODEL_BASE_URL ||
        fileConfig.baseUrl ||
        DEFAULT_MODEL_CONFIG.baseUrl,
    ),
    // The app config intentionally does not supply a bundled API key. A local
    // pairing flow may write a short-lived token into models.json; otherwise no
    // Authorization header is sent to the local model service.
    apiKey: String(fileConfig.apiKey || DEFAULT_MODEL_CONFIG.apiKey),
    timeoutMs: Number(
      extra.LOCAL_MODEL_TIMEOUT_MS ||
        fileConfig.timeoutMs ||
        DEFAULT_MODEL_CONFIG.timeoutMs,
    ),
    runtime: {
      ...DEFAULT_MODEL_CONFIG.runtime,
      ...(fileConfig.runtime || {}),
      primary: "phone_local",
      backendRole: "fallback_only",
    },
    models: {
      ...DEFAULT_MODEL_CONFIG.models,
      ...(fileConfig.models || {}),
      profiler: String(
        extra.LOCAL_MODEL_GEMMA_4B ||
          fileConfig.models?.profiler ||
          DEFAULT_MODEL_CONFIG.models.profiler,
      ),
      orchestratorMedium: String(
        extra.LOCAL_MODEL_QWEN_8B ||
          fileConfig.models?.orchestratorMedium ||
          DEFAULT_MODEL_CONFIG.models.orchestratorMedium,
      ),
      orchestratorLarge: String(
        extra.LOCAL_MODEL_QWEN_14B ||
          fileConfig.models?.orchestratorLarge ||
          DEFAULT_MODEL_CONFIG.models.orchestratorLarge,
      ),
      aligner: String(
        extra.LOCAL_MODEL_GEMMA_4B ||
          fileConfig.models?.aligner ||
          DEFAULT_MODEL_CONFIG.models.aligner,
      ),
      embedding: String(
        extra.LOCAL_MODEL_QWEN_EMBED ||
          fileConfig.models?.embedding ||
          DEFAULT_MODEL_CONFIG.models.embedding,
      ),
      summarizer: String(
        extra.LOCAL_MODEL_QWEN_8B ||
          fileConfig.models?.summarizer ||
          DEFAULT_MODEL_CONFIG.models.summarizer,
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
  return readJson<AgentRegistryConfig>(
    AGENT_REGISTRY_PATH,
    DEFAULT_AGENT_REGISTRY,
  );
}

async function loadAnswers(userId: number) {
  return readJson<Record<string, string | string[]>>(answersPath(userId), {});
}

async function loadSummary(userId: number) {
  const payload = await readJson<ProfileSummaryRecord | { summary?: string }>(
    summaryPath(userId),
    { summary: "" },
  );
  return String(payload.summary || "").trim();
}

async function saveSummaryRecord(
  userId: number,
  payload: ProfileSummaryRecord,
) {
  await writeJson(summaryPath(userId), payload);
}

async function loadProfilerState(userId: number): Promise<LocalProfilerState> {
  return readJson<LocalProfilerState>(profilerStatePath(userId), {
    status: "idle",
    history: [],
  });
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

async function appendConversation(
  userId: number,
  role: ChatRole,
  content: string,
) {
  const row: LocalChatMessage = {
    role,
    content: content.trim(),
    createdAt: nowIso(),
  };
  await appendJsonl(convoPath(userId), row);
  return row;
}

async function recentConversation(userId: number, limit = 16) {
  const rows = await readJsonl<LocalChatMessage>(convoPath(userId));
  return rows.slice(-limit);
}

async function loadRouteLogs(userId: number, limit = 32) {
  const rows = await readJsonl<any>(routeLogPath(userId));
  return rows.slice(-limit);
}

async function migrateLegacySemanticCacheIfNeeded(userId?: number) {
  const target = semanticCacheStorePath();
  if (await exists(target)) return;
  const legacyFiles =
    userId != null ? [`${CACHE_DIR}/${userId}_semantic_cache.json`] : [];
  const importedEntries: SemanticCacheEntry[] = [];
  for (const path of legacyFiles) {
    const match = path.match(/\/(\d+)_semantic_cache\.json$/);
    const userId = Number(match?.[1] || 0);
    const rows = await readJson<any[]>(path, []);
    for (const row of rows) {
      const sourceQuestion = String(row?.question || "").trim();
      const canonicalAnswer = String(row?.answer || "").trim();
      if (!sourceQuestion || !canonicalAnswer) continue;
      importedEntries.push({
        id: `${userId}_${simpleHash(`${sourceQuestion}:${canonicalAnswer}`)}`,
        userId,
        sourceQuestion,
        normalizedQuestion: normalizeText(
          row?.normalizedQuestion || sourceQuestion,
        ),
        canonicalAnswer,
        englishAnswer: canonicalAnswer,
        lastPresentedAnswer: canonicalAnswer,
        route: String(row?.route || "local_answer"),
        intent: "assistant",
        embedding: normalizeStoredEmbedding(row?.embedding, sourceQuestion),
        createdAt: String(row?.savedAt || nowIso()),
        updatedAt: String(row?.savedAt || nowIso()),
        expiresAt: null,
        alignmentProfile: { replyLanguage: "en" },
      });
    }
  }
  await writeJson(target, {
    version: 2,
    entries: importedEntries,
    hits: [],
  } satisfies SemanticCacheStore);
}

async function loadSemanticCacheStore(userId?: number) {
  await migrateLegacySemanticCacheIfNeeded(userId);
  return readJson<SemanticCacheStore>(semanticCacheStorePath(), {
    version: 2,
    entries: [],
    hits: [],
  });
}

async function saveSemanticCacheStore(
  store: SemanticCacheStore,
  rules?: MemoryRules,
) {
  const nextRules = rules || (await getMemoryRules());
  const maxEntries = positiveInt(nextRules.cache?.maxEntries, 250);
  const maxHitRecords = positiveInt(nextRules.cache?.maxHitRecords, 500);
  await writeJson(semanticCacheStorePath(), {
    version: 2,
    entries: store.entries.slice(-maxEntries),
    hits: store.hits.slice(-maxHitRecords),
  } satisfies SemanticCacheStore);
}

async function updateSemanticCacheStore(
  userId: number | undefined,
  rules: MemoryRules | undefined,
  mutator: (store: SemanticCacheStore) => void | Promise<void>,
) {
  return queueFileMutation(semanticCacheStorePath(), async () => {
    const store = await loadSemanticCacheStore(userId);
    await mutator(store);
    await saveSemanticCacheStore(store, rules);
    return store;
  });
}

async function loadRagChunks(userId: number) {
  const profilePayload = await readJson<{ chunks?: LocalRagChunk[] }>(
    profileRagPath(userId),
    { chunks: [] },
  );
  const docChunks = await readJson<LocalRagChunk[]>(ragChunksPath(userId), []);
  const memoryChunks = await readJson<LocalRagChunk[]>(
    memoryChunksPath(userId),
    [],
  );
  const merged = [
    ...(Array.isArray(profilePayload.chunks) ? profilePayload.chunks : []),
    ...(Array.isArray(docChunks) ? docChunks : []),
    ...(Array.isArray(memoryChunks) ? memoryChunks : []),
  ];
  const byId = new Map<string, LocalRagChunk>();
  for (const row of merged) {
    if (row?.id) byId.set(String(row.id), row);
  }
  return Array.from(byId.values());
}

async function saveRagChunksUnlocked(userId: number, rows: LocalRagChunk[]) {
  await writeJson(ragChunksPath(userId), rows.slice(-1000));
}

async function saveRagChunks(userId: number, rows: LocalRagChunk[]) {
  await queueFileMutation(ragChunksPath(userId), async () => {
    await saveRagChunksUnlocked(userId, rows);
  });
}

async function updateRagChunks(
  userId: number,
  mutator: (
    rows: LocalRagChunk[],
  ) => LocalRagChunk[] | Promise<LocalRagChunk[]>,
) {
  return queueFileMutation(ragChunksPath(userId), async () => {
    const existing = await readJson<LocalRagChunk[]>(ragChunksPath(userId), []);
    const nextRows = await mutator(Array.isArray(existing) ? existing : []);
    await saveRagChunksUnlocked(userId, nextRows);
    return nextRows;
  });
}

async function loadDurableFacts(userId: number) {
  return readJson<DurableFactRecord[]>(durableFactsPath(userId), []);
}

async function saveDurableFacts(userId: number, rows: DurableFactRecord[]) {
  await writeJson(durableFactsPath(userId), rows);
}

async function loadDailySummaries(userId: number) {
  return readJsonl<DailySummaryRecord>(dailySummariesPath(userId));
}

async function appendDailySummary(userId: number, row: DailySummaryRecord) {
  await appendJsonl(dailySummariesPath(userId), row);
}

async function appendProfileUpdate(userId: number, row: ProfileUpdateRecord) {
  await appendJsonl(profileUpdatesPath(userId), row);
}

async function saveMemoryChunksUnlocked(userId: number, rows: LocalRagChunk[]) {
  await writeJson(memoryChunksPath(userId), rows.slice(-600));
}

async function saveMemoryChunks(userId: number, rows: LocalRagChunk[]) {
  await queueFileMutation(memoryChunksPath(userId), async () => {
    await saveMemoryChunksUnlocked(userId, rows);
  });
}

function extractCompletionText(json: any) {
  const direct =
    json?.choices?.[0]?.message?.content ?? json?.output_text ?? "";
  if (typeof direct === "string") return direct.trim();
  if (Array.isArray(direct)) {
    return direct
      .map((part) =>
        typeof part?.text === "string"
          ? part.text
          : typeof part === "string"
            ? part
            : "",
      )
      .join("\n")
      .trim();
  }
  return "";
}

async function localChatRaw(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2,
) {
  const cfg = await getModelConfig();
  const runtime = createLocalModelRuntime({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  });
  return runtime.completeChat({
    model,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
}

async function localChatJson(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2,
) {
  const json = await localChatRaw(systemPrompt, userPrompt, model, temperature);
  return parseJsonLoose<any>(extractCompletionText(json), {});
}

async function localChatText(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2,
) {
  const json = await localChatRaw(systemPrompt, userPrompt, model, temperature);
  return extractCompletionText(json);
}

async function embedTexts(texts: string[]) {
  const fallback = () => texts.map((text) => hashEmbedding(text));
  const cfg = await getModelConfig();
  const baseUrl = normalizeLocalModelBaseUrl(cfg.baseUrl);

  if (!baseUrl || isLoopbackLocalModelBaseUrl(baseUrl)) {
    return fallback();
  }

  try {
    const runtime = createLocalModelRuntime({
      baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
    const vectors = await runtime.embedTexts({
      model: cfg.models.embedding,
      texts,
    });
    return vectors.map((embedding, index) =>
      normalizeEmbeddingVector(embedding, texts[index] || ""),
    );
  } catch {
    return fallback();
  }
}

function isTransientFact(text: string, rules: MemoryRules) {
  const normalized = normalizeText(text);
  const transientMarkers = rules.durableFacts?.transientMarkers || [];
  const importantMarkers = rules.durableFacts?.importantMarkers || [];
  const markedImportant = importantMarkers.some((marker) => {
    const clean = normalizeText(marker);
    return clean && normalized.includes(clean);
  });
  if (markedImportant) return false;
  return transientMarkers.some((marker) => {
    const clean = normalizeText(marker);
    return clean && normalized.includes(clean);
  });
}

function normalizedValueFingerprint(value: any) {
  if (Array.isArray(value))
    return value.map((item) => normalizeText(item)).join("|");
  return normalizeText(value);
}

function mergeDurableFacts(
  existing: DurableFactRecord[],
  additions: DurableFactRecord[],
) {
  const byFact = new Map(
    existing.map((row) => [normalizeText(row.fact), row] as const),
  );
  for (const row of additions) {
    const key = normalizeText(row.fact);
    if (!key) continue;
    const current = byFact.get(key);
    if (!current) {
      byFact.set(key, row);
      continue;
    }
    byFact.set(key, {
      ...current,
      confidence: Math.max(current.confidence, row.confidence),
      lastSeenAt: row.lastSeenAt,
      important: current.important || row.important,
      evidence: uniq([
        ...(current.evidence || []),
        ...(row.evidence || []),
      ]).slice(-6),
      profileUpdates: {
        ...(current.profileUpdates || {}),
        ...(row.profileUpdates || {}),
      },
    });
  }
  return Array.from(byFact.values()).sort((a, b) =>
    a.fact.localeCompare(b.fact),
  );
}

function buildFallbackMemorySummary(
  facts: DurableFactRecord[],
  turns: LocalChatMessage[],
) {
  if (facts.length) {
    return `Durable user facts: ${facts.map((row) => row.fact).join("; ")}.`;
  }
  const recentUserTurns = turns
    .filter((row) => row.role === "user")
    .map((row) => row.content.trim())
    .filter(Boolean)
    .slice(-2);
  if (recentUserTurns.length) {
    return `Recent conversation focused on: ${recentUserTurns.join(" / ")}.`;
  }
  return "No durable memory updates from this conversation window.";
}

function heuristicMemoryCandidates(
  turns: LocalChatMessage[],
  rules: MemoryRules,
) {
  const userTurns = turns.filter((row) => row.role === "user");
  const candidates: Array<{
    fact: string;
    confidence: number;
    category: string;
    important: boolean;
    evidence: string[];
  }> = [];

  const extract = (
    fact: string,
    confidence: number,
    category: string,
    evidence: string,
    important = false,
  ) => {
    const clean = String(fact || "").trim();
    if (!clean || isTransientFact(clean, rules)) return;
    candidates.push({
      fact: clean,
      confidence,
      category,
      important,
      evidence: [evidence],
    });
  };

  for (const row of userTurns) {
    const content = row.content.trim();
    const important = (rules.durableFacts?.importantMarkers || []).some(
      (marker) => normalizeText(content).includes(normalizeText(marker)),
    );

    const namedPatterns: Array<
      [RegExp, (match: RegExpExecArray) => [string, string, number]]
    > = [
      [
        /\bmy name is ([^.!,\n]+)/i,
        (match) => [`Name: ${match[1].trim()}`, "identity", 0.96],
      ],
      [
        /\bi am(?: a| an)? ([^.!,\n]+)/i,
        (match) => [`Identity: ${match[1].trim()}`, "identity", 0.82],
      ],
      [
        /\bi work as(?: a| an)? ([^.!,\n]+)/i,
        (match) => [`Occupation: ${match[1].trim()}`, "occupation", 0.92],
      ],
      [
        /\bi (?:prefer|want) ([^.!,\n]+)/i,
        (match) => [`Preference: ${match[1].trim()}`, "preference", 0.85],
      ],
      [
        /\bi (?:like|love|enjoy) ([^.!,\n]+)/i,
        (match) => [`Likes: ${match[1].trim()}`, "preference", 0.83],
      ],
      [
        /\bi (?:speak|use) ([^.!,\n]+)/i,
        (match) => [`Languages: ${match[1].trim()}`, "language", 0.84],
      ],
      [
        /\bmy goal is ([^.!,\n]+)/i,
        (match) => [`Goal: ${match[1].trim()}`, "goal", 0.88],
      ],
    ];

    for (const [regex, build] of namedPatterns) {
      const match = regex.exec(content);
      if (!match) continue;
      const [fact, category, confidence] = build(match);
      extract(fact, confidence, category, content, important);
    }
  }

  return candidates;
}

function buildDurableFactsFromHeuristics(
  turns: LocalChatMessage[],
  profileUpdates: Record<string, any>,
  rules: MemoryRules,
) {
  const extracted = heuristicMemoryCandidates(turns, rules)
    .filter(
      (row) =>
        row.confidence >=
        positiveFloat(rules.durableFacts?.confidenceThreshold, 0.78),
    )
    .slice(0, positiveInt(rules.durableFacts?.maxFactsPerSync, 6))
    .map(
      (row): DurableFactRecord => ({
        fact: row.fact,
        confidence: row.confidence,
        category: row.category,
        source: "heuristic",
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        evidence: row.evidence,
        important: row.important,
        profileUpdates,
      }),
    );
  return extracted;
}

function shouldApplyProfileUpdate(
  slotId: string,
  nextValue: any,
  currentAnswers: Record<string, any>,
  currentConfidenceBySlot: Record<string, number>,
  candidateConfidenceBySlot: Record<string, number>,
  rules: MemoryRules,
) {
  const currentValue = currentAnswers[slotId];
  if (!nonEmptyAnswer(nextValue)) return false;
  if (
    normalizedValueFingerprint(currentValue) ===
    normalizedValueFingerprint(nextValue)
  )
    return false;
  const candidateConfidence = clampConfidence(
    candidateConfidenceBySlot[slotId],
    0,
  );
  if (!nonEmptyAnswer(currentValue)) {
    return (
      candidateConfidence >=
      positiveFloat(rules.profileUpdates?.minConfidenceForNewSlot, 0.82)
    );
  }
  if (rules.profileUpdates?.fillEmptySlotsOnly !== false) {
    return false;
  }
  const currentConfidence = clampConfidence(currentConfidenceBySlot[slotId], 0);
  return (
    candidateConfidence >=
      positiveFloat(rules.profileUpdates?.minConfidenceForOverwrite, 0.93) &&
    currentConfidence <=
      positiveFloat(
        rules.profileUpdates?.maxExistingConfidenceToOverwrite,
        0.75,
      )
  );
}

async function saveAnswers(
  userId: number,
  answers: Record<string, string | string[]>,
) {
  await writeJson(answersPath(userId), answers);
}

function slotConfidenceMap(
  slots: ProfilerSlot[],
  previous: Record<string, number>,
  updates: Record<string, number>,
  answers: Record<string, any>,
) {
  return Object.fromEntries(
    slots.map((slot) => {
      const explicit = updates[slot.id];
      const previousValue = clampConfidence(previous[slot.id], 0);
      const fallback = nonEmptyAnswer(answers[slot.id])
        ? Math.max(previousValue, 0.7)
        : 0;
      return [
        slot.id,
        explicit != null
          ? clampConfidence(explicit, fallback || 0.7)
          : fallback,
      ];
    }),
  );
}

function buildSummaryFacts(
  slots: ProfilerSlot[],
  answers: Record<string, any>,
) {
  return slots
    .filter((slot) => nonEmptyAnswer(answers[slot.id]))
    .map((slot) => `${slot.id}: ${displayValue(answers[slot.id])}`);
}

function buildFallbackProfileSummary(
  answers: Record<string, any>,
  userProfile?: LocalUserProfile,
) {
  const facts = [
    userProfile?.name ? `${userProfile.name} uses this assistant.` : "",
    languagesSummary(answers)
      ? `Preferred languages: ${languagesSummary(answers)}.`
      : "",
    answers.occupation
      ? `Occupation: ${displayValue(answers.occupation)}.`
      : "",
    answers.industry_or_field
      ? `Field: ${displayValue(answers.industry_or_field)}.`
      : "",
    answers.communication_tone
      ? `Preferred tone: ${displayValue(answers.communication_tone)}.`
      : "",
    answers.answer_length
      ? `Typical answer length: ${displayValue(answers.answer_length)}.`
      : "",
    answers.assistant_persona
      ? `Assistant persona: ${displayValue(answers.assistant_persona)}.`
      : "",
    answers.hobbies ? `Hobbies: ${displayValue(answers.hobbies)}.` : "",
    answers.interests ? `Interests: ${displayValue(answers.interests)}.` : "",
    answers.main_goal
      ? `Current goal: ${displayValue(answers.main_goal)}.`
      : "",
    answers.dislikes ? `Avoid: ${displayValue(answers.dislikes)}.` : "",
    answers.work_rhythm
      ? `Most active: ${displayValue(answers.work_rhythm)}.`
      : "",
  ].filter(Boolean);
  return facts.join(" ");
}

function profileChunkBlueprints(
  answers: Record<string, any>,
  summary: string,
  optionalProfileNotes: string[],
) {
  return [
    {
      id: "profile_summary",
      text: summary,
      metadata: { kind: "summary", slotIds: Object.keys(answers) },
    },
    {
      id: "profile_identity",
      text: [
        answers.occupation
          ? `Occupation: ${displayValue(answers.occupation)}`
          : "",
        answers.industry_or_field
          ? `Field: ${displayValue(answers.industry_or_field)}`
          : "",
        answers.personality_style
          ? `Style: ${displayValue(answers.personality_style)}`
          : "",
        answers.work_rhythm
          ? `Work rhythm: ${displayValue(answers.work_rhythm)}`
          : "",
      ]
        .filter(Boolean)
        .join(". "),
      metadata: {
        kind: "identity",
        slotIds: [
          "occupation",
          "industry_or_field",
          "personality_style",
          "work_rhythm",
        ],
      },
    },
    {
      id: "profile_preferences",
      text: [
        languagesSummary(answers)
          ? `Languages: ${languagesSummary(answers)}`
          : "",
        answers.communication_tone
          ? `Tone: ${displayValue(answers.communication_tone)}`
          : "",
        answers.answer_length
          ? `Answer length: ${displayValue(answers.answer_length)}`
          : "",
        answers.assistant_persona
          ? `Assistant persona: ${displayValue(answers.assistant_persona)}`
          : "",
        answers.dislikes ? `Avoid: ${displayValue(answers.dislikes)}` : "",
      ]
        .filter(Boolean)
        .join(". "),
      metadata: {
        kind: "preferences",
        slotIds: [
          "preferred_language",
          "secondary_language",
          "communication_tone",
          "answer_length",
          "assistant_persona",
          "dislikes",
        ],
      },
    },
    {
      id: "profile_interests",
      text: [
        answers.hobbies ? `Hobbies: ${displayValue(answers.hobbies)}` : "",
        answers.interests
          ? `Interests: ${displayValue(answers.interests)}`
          : "",
        answers.learning_style
          ? `Learning style: ${displayValue(answers.learning_style)}`
          : "",
        answers.planning_style
          ? `Planning style: ${displayValue(answers.planning_style)}`
          : "",
        answers.main_goal
          ? `Main goal: ${displayValue(answers.main_goal)}`
          : "",
      ]
        .filter(Boolean)
        .join(". "),
      metadata: {
        kind: "interests",
        slotIds: [
          "hobbies",
          "interests",
          "learning_style",
          "planning_style",
          "main_goal",
        ],
      },
    },
    {
      id: "profile_notes",
      text: optionalProfileNotes.join(" "),
      metadata: { kind: "notes", slotIds: [] },
    },
  ].filter((chunk) => String(chunk.text || "").trim());
}

async function persistProfileArtifacts(
  userId: number,
  slots: ProfilerSlot[],
  answers: Record<string, string | string[]>,
  summary: string,
  confidenceBySlot: Record<string, number>,
  optionalProfileNotes: string[],
  replyLanguageName: string,
) {
  const facts = buildSummaryFacts(slots, answers);
  const chunkBlueprints = profileChunkBlueprints(
    answers,
    summary,
    optionalProfileNotes,
  );
  const embeddings = chunkBlueprints.length
    ? await embedTexts(chunkBlueprints.map((chunk) => chunk.text))
    : [];
  const updatedAt = nowIso();
  const chunks: LocalRagChunk[] = chunkBlueprints.map((chunk, index) => ({
    id: `profile:${chunk.id}`,
    sourceId: `profile:${chunk.id}`,
    sourceType: "profile",
    text: chunk.text,
    embedding: Array.isArray(embeddings[index])
      ? embeddings[index]
      : hashEmbedding(chunk.text),
    metadata: {
      ...chunk.metadata,
      userId,
      replyLanguage: replyLanguageName,
      confidenceBySlot,
      generatedBy: "profiler",
    },
    updatedAt,
  }));
  const profileRagRecord: ProfileRagRecord = {
    userId,
    source: "profiler",
    summary,
    facts,
    metadata: {
      generatedBy: "local_profiler",
      replyLanguage: replyLanguageName,
      slotCount: facts.length,
      confidenceBySlot,
      optionalProfileNotes,
    },
    chunks,
    updatedAt,
  };
  await writeJson(profileRagPath(userId), profileRagRecord);
  await updateRagChunks(userId, async (existingRuntimeChunks) => {
    const preserved = existingRuntimeChunks.filter(
      (chunk) => !String(chunk.sourceId || "").startsWith("profile:"),
    );
    return [...preserved, ...chunks];
  });
}

export async function upsertLocalRagChunks(
  userId: number,
  sourceId: string,
  texts: string[],
  opts?: {
    sourceType?: LocalRagChunk["sourceType"];
    metadata?: Record<string, any>;
  },
) {
  await ensureLocalAgentData();
  const cleanTexts = texts
    .map((text) => String(text || "").trim())
    .filter(Boolean);
  if (!cleanTexts.length) return [] as LocalRagChunk[];
  const embeddings = await embedTexts(cleanTexts);
  const createdAt = nowIso();
  const nextRows: LocalRagChunk[] = cleanTexts.map((text, index) => ({
    id: `${sourceId}_${index}_${simpleHash(text)}`,
    sourceId,
    sourceType: opts?.sourceType || "doc",
    text,
    embedding: Array.isArray(embeddings[index])
      ? embeddings[index]
      : hashEmbedding(text),
    metadata: opts?.metadata || {},
    updatedAt: createdAt,
  }));
  await updateRagChunks(userId, async (existing) => {
    const filtered = existing.filter((row) => row.sourceId !== sourceId);
    return [...filtered, ...nextRows];
  });
  await safeRecordTrainingSample("rag", {
    input: cleanTexts.join("\n"),
    label: "upsert",
    metadata: {
      userId,
      sourceId,
      sourceType: opts?.sourceType || "doc",
      count: nextRows.length,
    },
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
    .map((row) => ({
      ...row,
      score: cosine(
        queryVec,
        normalizeStoredEmbedding(row.embedding, row.text),
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .filter((row) => row.score >= 0.2);
}

export async function appendLocalTrainingSample(
  agent: LocalTrainingSample["agent"],
  sample: Omit<LocalTrainingSample, "id" | "agent" | "createdAt">,
) {
  await ensureLocalAgentData();
  const row: LocalTrainingSample = {
    id: `${Date.now()}_${simpleHash(JSON.stringify(sample))}`,
    agent,
    input: String(sample.input || "").trim(),
    expectedOutput: sample.expectedOutput
      ? String(sample.expectedOutput).trim()
      : undefined,
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
    manifest: await readJson(
      WORKSPACE_MANIFEST_PATH,
      DEFAULT_WORKSPACE_MANIFEST,
    ),
    models: await getModelConfig(),
    prompts: await getPromptCatalog(),
    registry: await getAgentRegistry(),
    slots: await getProfilerSlots(),
  };
}

function mergeProfilerUpdates(
  slots: ProfilerSlot[],
  current: Record<string, string | string[]>,
  updates: Record<string, any>,
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

function buildProfilerAssistantReply(
  replyLanguageName: string,
  nextSlotPrompt: string | undefined,
  done: boolean,
) {
  const fallbackCode = fallbackReplyLanguageCode(replyLanguageName);
  if (done) {
    return fallbackCode === "ta"
      ? "சூப்பர். உங்கள் ஆரம்ப ப்ரொஃபைல் தயார். இதை அடுத்த உரையாடல்களில் பயன்படுத்துவேன்."
      : "Perfect. Your starter profile is ready, and I’ll use it in future chats.";
  }
  return fallbackCode === "ta"
    ? `சரி. இன்னொரு விஷயம் மட்டும் — ${nextSlotPrompt || "உங்களைப் பற்றி இன்னும் கொஞ்சம் சொல்லுங்கள்."}`
    : `Got it. One more thing — ${nextSlotPrompt || "Tell me a bit more about yourself."}`;
}

const SLOT_KEYWORD_MAP: Record<string, Record<string, string[]>> = {
  preferred_language: {
    english: ["english", "speak english", "reply in english"],
    tamil: ["tamil", "tamizh"],
    hindi: ["hindi"],
    telugu: ["telugu"],
    malayalam: ["malayalam"],
  },
  secondary_language: {
    none: ["none", "no second language", "only one language"],
    english: ["english"],
    tamil: ["tamil", "tamizh"],
    hindi: ["hindi"],
    telugu: ["telugu"],
    malayalam: ["malayalam"],
  },
  occupation: {
    student: ["student", "studying", "college", "school"],
    working_professional: [
      "working professional",
      "employee",
      "software engineer",
      "engineer",
      "developer",
      "job",
    ],
    business_owner: [
      "business owner",
      "founder",
      "run a business",
      "entrepreneur",
    ],
    freelancer_creator: [
      "freelancer",
      "creator",
      "content creator",
      "consultant",
    ],
    homemaker_caregiver: ["homemaker", "caregiver", "taking care of home"],
    between_roles: [
      "between roles",
      "job hunting",
      "not working right now",
      "career break",
    ],
  },
  industry_or_field: {
    technology: ["technology", "tech", "software", "it", "engineering"],
    business: ["business", "startup", "operations"],
    education: ["education", "teaching", "student"],
    healthcare: ["healthcare", "medical", "doctor", "nurse"],
    design_media: ["design", "media", "creative", "marketing content"],
    sales_marketing: ["sales", "marketing", "growth"],
    operations: ["operations", "supply chain", "admin"],
  },
  hobbies: {
    music: ["music", "songs"],
    movies: ["movies", "films", "cinema"],
    reading: ["reading", "books"],
    gaming: ["gaming", "games"],
    travel: ["travel", "travelling", "trips"],
    fitness: ["fitness", "gym", "workout"],
    cooking: ["cooking", "cook"],
    sports: ["sports", "cricket", "football"],
    art: ["art", "drawing", "painting"],
    technology: ["technology", "tech", "gadgets"],
  },
  interests: {
    ai_technology: ["ai", "technology", "tech", "artificial intelligence"],
    business: ["business", "startup"],
    career: ["career", "job growth"],
    productivity: ["productivity", "planning", "efficiency"],
    finance: ["finance", "money", "investing"],
    health: ["health", "wellness"],
    travel: ["travel"],
    culture: ["culture", "history", "society"],
    education: ["education", "learning"],
    self_growth: ["self growth", "self-improvement", "personal growth"],
  },
  communication_tone: {
    warm: ["warm"],
    respectful: ["respectful", "polite"],
    short_direct: ["short and direct", "direct", "straight to the point"],
    detailed: ["detailed", "deep"],
    friendly_casual: ["casual", "friendly"],
  },
  answer_length: {
    very_short: ["very short", "super short"],
    short: ["short", "brief"],
    medium: ["medium"],
    detailed: ["detailed", "long"],
    depends_on_question: ["depends", "depends on the question"],
  },
  personality_style: {
    calm: ["calm"],
    friendly: ["friendly"],
    practical: ["practical"],
    ambitious: ["ambitious"],
    curious: ["curious"],
    private_reserved: ["private", "reserved", "introvert"],
  },
  assistant_persona: {
    coach: ["coach"],
    planner: ["planner"],
    friend: ["friend"],
    tutor: ["tutor", "teacher"],
    operator: ["operator", "assistant that executes"],
    straight_shooter: ["straight shooter", "blunt", "direct helper"],
  },
  planning_style: {
    very_structured: ["very structured", "structured", "strict plan"],
    light_structure: ["light structure", "some structure"],
    flexible: ["flexible"],
    last_minute: ["last minute"],
    mixed: ["mixed", "depends"],
  },
  learning_style: {
    examples: ["examples"],
    step_by_step: ["step by step"],
    big_picture_first: ["big picture", "overview first"],
    hands_on: ["hands on", "practice"],
    quick_summary: ["quick summary", "summary first"],
  },
  main_goal: {
    career_growth: ["career growth", "career", "promotion"],
    business_growth: ["business growth", "grow my business"],
    study_success: ["study success", "exams", "study"],
    health_balance: ["health", "balance", "wellbeing"],
    relationships_family: ["family", "relationships"],
    peace_of_mind: ["peace of mind", "less stress", "calm"],
    productivity: ["productivity", "be productive"],
    learning: ["learning", "learn more"],
  },
  dislikes: {
    too_long: ["too long", "long replies"],
    too_short: ["too short"],
    too_formal: ["too formal"],
    too_casual: ["too casual"],
    too_many_questions: ["too many questions"],
    too_generic: ["generic"],
    too_pushy: ["pushy"],
    too_much_jargon: ["jargon", "too much jargon"],
  },
  work_rhythm: {
    early_morning: ["early morning", "very early"],
    morning: ["morning"],
    afternoon: ["afternoon"],
    evening: ["evening"],
    late_night: ["late night", "night", "midnight"],
    irregular: ["irregular", "varies", "no fixed schedule"],
  },
};

function matchedOptionsForSlot(slot: ProfilerSlot, normalizedMessage: string) {
  const keywordMap = SLOT_KEYWORD_MAP[slot.id] || {};
  return slot.options.filter((option) =>
    (keywordMap[option] || [option])
      .map((phrase) => normalizeText(phrase))
      .some((phrase) => phrase && normalizedMessage.includes(phrase)),
  );
}

function deterministicProfilerExtraction(
  message: string,
  slots: ProfilerSlot[],
  answers: Record<string, string | string[]>,
  state: LocalProfilerState,
  replyLanguageName: string,
): ProfilerModelOutput {
  const normalizedMessage = normalizeText(message);
  const updates: Record<string, string | string[]> = {};
  const confidenceBySlot: Record<string, number> = {};
  const notes: string[] = [];

  const explicitLanguages = [
    "english",
    "tamil",
    "hindi",
    "telugu",
    "malayalam",
  ].filter((language) => normalizedMessage.includes(language));
  if (
    explicitLanguages.length >= 1 &&
    !nonEmptyAnswer(answers.preferred_language)
  ) {
    updates.preferred_language = explicitLanguages[0];
    confidenceBySlot.preferred_language = normalizedMessage.includes("mostly")
      ? 0.94
      : 0.82;
  }
  if (
    explicitLanguages.length >= 2 &&
    !nonEmptyAnswer(answers.secondary_language)
  ) {
    updates.secondary_language = explicitLanguages[1];
    confidenceBySlot.secondary_language = 0.86;
  }
  if (
    /\bonly (english|tamil|hindi|telugu|malayalam)\b/.test(normalizedMessage) &&
    !nonEmptyAnswer(answers.secondary_language)
  ) {
    updates.secondary_language = "none";
    confidenceBySlot.secondary_language = 0.72;
  }

  for (const slot of slots) {
    if (nonEmptyAnswer(updates[slot.id])) continue;
    const matches = matchedOptionsForSlot(slot, normalizedMessage);
    if (!matches.length) continue;
    updates[slot.id] =
      slot.type === "multi"
        ? matches.slice(0, slot.max_choices || 4)
        : matches[0];
    confidenceBySlot[slot.id] = slot.type === "multi" ? 0.78 : 0.8;
  }

  if (
    normalizedMessage.includes("software") ||
    normalizedMessage.includes("developer") ||
    normalizedMessage.includes("engineer")
  ) {
    if (
      !nonEmptyAnswer(updates.occupation) &&
      !nonEmptyAnswer(answers.occupation)
    ) {
      updates.occupation = "working_professional";
      confidenceBySlot.occupation = 0.85;
    }
    if (
      !nonEmptyAnswer(updates.industry_or_field) &&
      !nonEmptyAnswer(answers.industry_or_field)
    ) {
      updates.industry_or_field = "technology";
      confidenceBySlot.industry_or_field = 0.88;
    }
  }

  if (!Object.keys(updates).length) {
    const fallbackSlot =
      slots.find((slot) => slot.id === state.currentTargetSlot) ||
      chooseNextProfilerSlot(slots, answers, state.confidenceBySlot || {}, []);
    if (fallbackSlot) {
      const normalizedValue = normalizeSlotValue(
        fallbackSlot,
        fallbackSlot.type === "multi" ? trimList(message) : message,
      );
      if (normalizedValue) {
        updates[fallbackSlot.id] = normalizedValue;
        confidenceBySlot[fallbackSlot.id] =
          fallbackSlot.type === "multi" ? 0.52 : 0.48;
      }
    }
  }

  const merged = mergeProfilerUpdates(slots, answers, updates);
  const remaining = missingSlots(slots, merged);
  const nextSlotCandidate = chooseNextProfilerSlot(
    slots,
    merged,
    { ...(state.confidenceBySlot || {}), ...confidenceBySlot },
    Object.keys(updates),
  );

  if (
    /i\b.*\b(work|study|prefer|like|dislike|usually)\b/.test(normalizedMessage)
  ) {
    notes.push(message.trim());
  }

  return {
    assistant_reply: buildProfilerAssistantReply(
      replyLanguageName,
      nextSlotCandidate?.prompt,
      remaining.length === 0,
    ),
    updates,
    missing_slots: remaining,
    completed: remaining.length === 0,
    confidence_by_slot: confidenceBySlot,
    optional_profile_notes: notes.slice(0, 3),
  };
}

function normalizeMemoryProfileUpdates(
  slots: ProfilerSlot[],
  profileUpdates: Record<string, any>,
) {
  const byId = new Map(slots.map((slot) => [slot.id, slot] as const));
  return Object.fromEntries(
    Object.entries(profileUpdates || {})
      .map(([slotId, value]) => {
        const slot = byId.get(slotId);
        if (!slot) return [slotId, undefined] as const;
        return [slotId, normalizeSlotValue(slot, value)] as const;
      })
      .filter(([, value]) => nonEmptyAnswer(value)),
  ) as Record<string, string | string[]>;
}

function salvageProfilerModelOutput(
  rawText: string,
  slots: ProfilerSlot[],
): ProfilerModelOutput | null {
  const clean = String(rawText || "").trim();
  if (!clean) return null;
  const parsed = parseJsonLoose<ProfilerModelOutput | null>(clean, null);
  if (parsed && typeof parsed === "object") {
    return {
      assistant_reply: String(parsed.assistant_reply || "").trim(),
      updates:
        typeof parsed.updates === "object" && parsed.updates
          ? parsed.updates
          : {},
      missing_slots: Array.isArray(parsed.missing_slots)
        ? parsed.missing_slots.map(String)
        : [],
      completed: Boolean(parsed.completed),
      confidence_by_slot:
        parsed.confidence_by_slot &&
        typeof parsed.confidence_by_slot === "object"
          ? Object.fromEntries(
              Object.entries(parsed.confidence_by_slot).map(
                ([slotId, value]) => [slotId, clampConfidence(value, 0.5)],
              ),
            )
          : {},
      optional_profile_notes: Array.isArray(parsed.optional_profile_notes)
        ? parsed.optional_profile_notes
            .map((note) => String(note || "").trim())
            .filter(Boolean)
        : [],
    };
  }

  const updatesFragment = findFieldValueFragment(clean, "updates");
  const missingFragment = findFieldValueFragment(clean, "missing_slots");
  const confidenceFragment = findFieldValueFragment(
    clean,
    "confidence_by_slot",
  );
  const assistantFragment = findFieldValueFragment(clean, "assistant_reply");
  const completedFragment = findFieldValueFragment(clean, "completed");
  const notesFragment = findFieldValueFragment(clean, "optional_profile_notes");

  const assistantMatch = clean.match(
    /["']?assistant_reply["']?\s*:\s*"([^"]*)"/i,
  );
  const assistantReply = String(
    assistantMatch?.[1] ||
      parseJsonFragment<string>(assistantFragment || '""', ""),
  ).trim();
  const updatesRaw = parseJsonFragment<Record<string, any>>(
    updatesFragment || "{}",
    {},
  );
  const confidenceRaw = parseJsonFragment<Record<string, any>>(
    confidenceFragment || "{}",
    {},
  );
  const missingRaw = parseJsonFragment<string[]>(missingFragment || "[]", []);
  const notesRaw = parseJsonFragment<string[]>(notesFragment || "[]", []);
  const completedValue =
    /^true$/i.test(String(completedFragment || "").trim()) ||
    String(completedFragment || "").trim() === "1";
  let normalizedUpdates = Object.fromEntries(
    slots
      .map(
        (slot) =>
          [slot.id, normalizeSlotValue(slot, updatesRaw?.[slot.id])] as const,
      )
      .filter(([, value]) => nonEmptyAnswer(value)),
  ) as Record<string, string | string[]>;
  if (!Object.keys(normalizedUpdates).length) {
    normalizedUpdates = Object.fromEntries(
      slots
        .map((slot) => {
          const slotMatch = clean.match(
            new RegExp(
              `["']${slot.id}["']\\s*:\\s*(\\[[^\\]]*\\]|"[^"]*"|[^,}\\n]+)`,
              "i",
            ),
          );
          const rawValue = slotMatch?.[1] || "";
          const parsedValue =
            rawValue.startsWith("[") || rawValue.startsWith('"')
              ? parseJsonFragment<any>(rawValue, rawValue)
              : rawValue.trim();
          return [slot.id, normalizeSlotValue(slot, parsedValue)] as const;
        })
        .filter(([, value]) => nonEmptyAnswer(value)),
    ) as Record<string, string | string[]>;
  }
  const confidenceBySlot = Object.fromEntries(
    Object.entries(confidenceRaw || {}).map(([slotId, value]) => [
      slotId,
      clampConfidence(value, 0.5),
    ]),
  );
  if (
    !assistantReply &&
    !Object.keys(normalizedUpdates).length &&
    !missingRaw.length
  ) {
    return null;
  }
  return {
    assistant_reply: assistantReply,
    updates: normalizedUpdates,
    missing_slots: missingRaw.map(String),
    completed: completedValue,
    confidence_by_slot: confidenceBySlot,
    optional_profile_notes: notesRaw
      .map((note) => String(note || "").trim())
      .filter(Boolean),
  };
}

async function runProfilerTurnModel(
  trimmed: string,
  replyLanguageName: string,
  currentAnswers: Record<string, string | string[]>,
  currentState: LocalProfilerState,
  slots: ProfilerSlot[],
  userProfile: LocalUserProfile | undefined,
) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  try {
    const raw = await localChatRaw(
      template(prompts.profilerTurnSystem, {
        reply_language_name: replyLanguageName,
      }),
      JSON.stringify({
        latest_user_message: trimmed,
        current_answers: currentAnswers,
        current_confidence_by_slot: currentState.confidenceBySlot || {},
        current_target_slot: currentState.currentTargetSlot || null,
        missing_slots: missingSlots(slots, currentAnswers),
        known_slots: formatSlotFacts(slots, currentAnswers),
        history: currentState.history.slice(-10),
        slots,
        user_profile: userProfile || {},
      }),
      cfg.models.profiler,
      0.2,
    );
    const rawText = extractCompletionText(raw);
    const salvaged = salvageProfilerModelOutput(rawText, slots);
    if (salvaged) {
      return {
        output: salvaged,
        source: parseJsonLoose<any>(rawText, null)
          ? "model_json"
          : "model_salvage",
        rawText,
      } satisfies ProfilerTurnProcessingResult;
    }
  } catch {
    // deterministic fallback below
  }
  return {
    output: deterministicProfilerExtraction(
      trimmed,
      slots,
      currentAnswers,
      currentState,
      replyLanguageName,
    ),
    source: "fallback",
  } satisfies ProfilerTurnProcessingResult;
}

export const __profilerTestUtils = {
  salvageProfilerModelOutput,
  deterministicProfilerExtraction,
  buildProfilerAssistantReply,
};

export const __assistantTestUtils = {
  extractProtectedFactTokens,
  preservesFacts,
  sanitizeDecision,
  generateClarifyingQuestion,
  ruleBasedOrchestratorDecision,
};

export const __memoryTestUtils = {
  isTransientFact,
  heuristicMemoryCandidates,
  buildDurableFactsFromHeuristics,
  mergeDurableFacts,
  shouldApplyProfileUpdate,
};

async function saveLocalOnboardingCompletion(
  userId: number,
  payload: {
    completedLocally: boolean;
    completedAt: string;
    pendingBackendSync: boolean;
    syncFailed?: boolean;
  },
) {
  await writeJson(
    `${PROFILES_DIR}/${userId}/onboarding_completion.json`,
    payload,
  );
}

async function syncAnswersToBackend(
  userId: number,
  answers: Record<string, string | string[]>,
) {
  const normalized = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : String(value ?? ""),
    ]),
  ) as Record<string, string | string[]>;

  await apiPost(`/users/${userId}/personality`, { answers: normalized });
}

export async function retryPendingOnboardingSync(userId: number) {
  await ensureLocalAgentData();
  const answers = await loadAnswers(userId);
  const state = await loadProfilerState(userId);
  await syncAnswersToBackend(userId, answers);
  const completedAt = state.completedLocallyAt || nowIso();
  await saveLocalOnboardingCompletion(userId, {
    completedLocally: true,
    completedAt,
    pendingBackendSync: false,
  });
  await saveProfilerState(userId, {
    ...state,
    completionSyncState: "complete_synced",
    pendingBackendSync: false,
    completedLocallyAt: completedAt,
  });
  return { ok: true };
}

async function buildProfileSummaryLocally(
  userId: number,
  userProfile?: LocalUserProfile,
) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const answers = await loadAnswers(userId);
  const slots = await getProfilerSlots();
  const state = await loadProfilerState(userId);
  if (missingSlots(slots, answers).length > 0) return "";
  const facts = buildSummaryFacts(slots, answers);
  const optionalProfileNotes = Array.isArray(state.optionalProfileNotes)
    ? state.optionalProfileNotes
        .map((note) => String(note || "").trim())
        .filter(Boolean)
    : [];
  let summary = "";
  try {
    summary = await localChatText(
      prompts.profileSummarySystem,
      JSON.stringify({
        user: userProfile || {},
        answers,
        facts,
        optional_profile_notes: optionalProfileNotes,
      }),
      cfg.models.aligner,
      0.1,
    );
    summary = summary.trim();
  } catch {
    summary = "";
  }
  if (!summary) {
    summary = buildFallbackProfileSummary(answers, userProfile);
  }
  await saveSummaryRecord(userId, {
    userId,
    source: "profiler",
    completed: true,
    summary,
    facts,
    confidenceBySlot: state.confidenceBySlot || {},
    optionalProfileNotes,
    updatedAt: nowIso(),
  });
  await persistProfileArtifacts(
    userId,
    slots,
    answers,
    summary,
    state.confidenceBySlot || {},
    optionalProfileNotes,
    languageLabel(
      String(
        answers.preferred_language || userProfile?.replyLanguage || "english",
      ),
    ),
  );
  return summary;
}

async function buildProfilerOpening(
  replyLanguageName: string,
  userProfile?: LocalUserProfile,
) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const slots = await getProfilerSlots();
  try {
    const out = await localChatText(
      template(prompts.profilerOpeningSystem, {
        reply_language_name: replyLanguageName,
        slot_ids: slots.map((slot) => slot.id).join(", "),
      }),
      JSON.stringify({
        user: userProfile || {},
        mission: "collect the user's profile naturally",
      }),
      cfg.models.profiler,
      0.2,
    );
    if (out.trim()) return out.trim();
  } catch {
    // use fallback below
  }
  return fallbackReplyLanguageCode(replyLanguageName) === "ta"
    ? `வணக்கம்${userProfile?.name ? ` ${userProfile.name}` : ""}. நம்ம ஒரு சாதாரண உரையாடலாக ஆரம்பிக்கலாம். முதல்ல, உங்களைப் பற்றி கொஞ்சம் சொல்லுங்க.`
    : `Hey${userProfile?.name ? ` ${userProfile.name}` : ""}, let’s start casually. Tell me a little about yourself.`;
}

export async function startProfilerOnPhone(
  userId: number,
  opts?: { replyLanguage?: ReplyLanguage; userProfile?: LocalUserProfile },
): Promise<LocalProfilerTurnResult> {
  await ensureLocalAgentData();
  const slots = await getProfilerSlots();
  const answers = await loadAnswers(userId);
  const missing = missingSlots(slots, answers);
  const summary =
    missing.length === 0
      ? await buildProfileSummaryLocally(userId, {
          ...opts?.userProfile,
          replyLanguage: fallbackReplyLanguageCode(
            languageLabel(
              String(
                answers.preferred_language || opts?.replyLanguage || "english",
              ),
            ),
          ) as ReplyLanguage,
        })
      : await loadSummary(userId);
  const replyLanguageName = languageLabel(
    String(answers.preferred_language || opts?.replyLanguage || "english"),
  );
  const assistantReply = missing.length
    ? await buildProfilerOpening(replyLanguageName, opts?.userProfile)
    : fallbackReplyLanguageCode(replyLanguageName) === "ta"
      ? "உங்கள் ப்ரொஃபைல் ஏற்கனவே தயார். பேசிக்கொண்டே அதை இன்னும் மேம்படுத்தலாம்."
      : "Your profile is already ready. We can still improve it as we chat.";
  const state: LocalProfilerState = {
    status: missing.length ? "active" : "complete",
    startedAt: nowIso(),
    lastUpdatedAt: nowIso(),
    currentTargetSlot: missing[0],
    missingSlots: missing,
    confidenceBySlot: Object.fromEntries(
      slots.map((slot) => [
        slot.id,
        nonEmptyAnswer(answers[slot.id]) ? 0.7 : 0,
      ]),
    ),
    optionalProfileNotes: [],
    lastRunSource: "model_json",
    history: [
      {
        role: "assistant" as const,
        content: assistantReply,
        createdAt: nowIso(),
      },
    ],
  };
  await saveProfilerState(userId, state);
  await appendConversation(userId, "assistant", assistantReply);
  await safeRecordTrainingSample("profiler", {
    input: "start_profiler",
    expectedOutput: assistantReply,
    label: "opening",
    metadata: {
      userId,
      replyLanguage: replyLanguageName,
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
  opts?: { replyLanguage?: ReplyLanguage; userProfile?: LocalUserProfile },
): Promise<LocalProfilerTurnResult> {
  await ensureLocalAgentData();
  const trimmed = String(message || "").trim();
  if (!trimmed) throw new Error("Message is required.");
  const slots = await getProfilerSlots();
  const currentAnswers = await loadAnswers(userId);
  const currentState = await loadProfilerState(userId);
  const replyLanguageName = languageLabel(
    String(
      currentAnswers.preferred_language || opts?.replyLanguage || "english",
    ),
  );
  await appendConversation(userId, "user", trimmed);
  const processed = await runProfilerTurnModel(
    trimmed,
    replyLanguageName,
    currentAnswers,
    currentState,
    slots,
    {
      ...opts?.userProfile,
      replyLanguage: fallbackReplyLanguageCode(
        replyLanguageName,
      ) as ReplyLanguage,
    },
  );
  const llmOut = processed.output;
  const merged = mergeProfilerUpdates(
    slots,
    currentAnswers,
    llmOut.updates || {},
  );
  const mergedConfidenceBySlot = slotConfidenceMap(
    slots,
    currentState.confidenceBySlot || {},
    llmOut.confidence_by_slot || {},
    merged,
  );
  const remaining = missingSlots(slots, merged);
  const done = remaining.length === 0;
  const chosenNextSlot =
    slots.find(
      (slot) =>
        Array.isArray(llmOut.missing_slots) &&
        llmOut.missing_slots.includes(slot.id),
    ) ||
    chooseNextProfilerSlot(
      slots,
      merged,
      mergedConfidenceBySlot,
      Object.keys(llmOut.updates || {}),
    );
  const assistantReply =
    String(llmOut.assistant_reply || "").trim() ||
    buildProfilerAssistantReply(
      replyLanguageName,
      chosenNextSlot?.prompt,
      done,
    );
  const optionalProfileNotes = uniq(
    [
      ...(currentState.optionalProfileNotes || []),
      ...(llmOut.optional_profile_notes || []).map(String),
    ]
      .map((note) => note.trim())
      .filter(Boolean),
  ).slice(-20);

  const history: LocalChatMessage[] = [
    ...currentState.history,
    { role: "user" as const, content: trimmed, createdAt: nowIso() },
    {
      role: "assistant" as const,
      content: assistantReply,
      createdAt: nowIso(),
    },
  ].slice(-40);

  const nextState: LocalProfilerState = {
    status: done ? "complete" : "active",
    startedAt: currentState.startedAt || nowIso(),
    lastUpdatedAt: nowIso(),
    currentTargetSlot: done ? undefined : chosenNextSlot?.id || remaining[0],
    missingSlots: remaining,
    confidenceBySlot: mergedConfidenceBySlot,
    optionalProfileNotes,
    lastRunSource: processed.source,
    history,
  };

  await saveAnswers(userId, merged);
  await saveProfilerState(userId, nextState);
  await appendConversation(userId, "assistant", assistantReply);

  let completionSyncState = done ? "complete_local_pending_sync" : "incomplete";
  let pendingBackendSync = done;
  if (done) {
    const completedAt = nowIso();
    await saveLocalOnboardingCompletion(userId, {
      completedLocally: true,
      completedAt,
      pendingBackendSync: true,
    });
    try {
      await syncAnswersToBackend(userId, merged);
      completionSyncState = "complete_synced";
      pendingBackendSync = false;
      await saveLocalOnboardingCompletion(userId, {
        completedLocally: true,
        completedAt,
        pendingBackendSync: false,
      });
    } catch (error) {
      completionSyncState = "sync_failed";
      pendingBackendSync = true;
      await saveLocalOnboardingCompletion(userId, {
        completedLocally: true,
        completedAt,
        pendingBackendSync: true,
        syncFailed: true,
      });
    }
  } else {
    await syncAnswersToBackend(userId, merged).catch(() => undefined);
  }

  await saveProfilerState(userId, {
    ...nextState,
    completionSyncState:
      completionSyncState as LocalProfilerState["completionSyncState"],
    pendingBackendSync,
    completedLocallyAt: done
      ? nextState.lastUpdatedAt
      : currentState.completedLocallyAt,
  });
  await safeRecordTrainingSample("profiler", {
    input: trimmed,
    expectedOutput: assistantReply,
    label: done ? "complete" : "turn",
    metadata: {
      userId,
      source: processed.source,
      rawText: processed.rawText || null,
      updates: llmOut.updates || {},
      mergedAnswers: merged,
      confidenceBySlot: mergedConfidenceBySlot,
      optionalProfileNotes,
      remainingSlots: remaining,
      replyLanguage: replyLanguageName,
    },
  });

  const summary = done
    ? await buildProfileSummaryLocally(userId, {
        ...opts?.userProfile,
        replyLanguage: fallbackReplyLanguageCode(
          replyLanguageName,
        ) as ReplyLanguage,
      })
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

function weatherLocationFromMessage(
  message: string,
  userProfile?: { place?: string },
) {
  const raw = String(message || "")
    .trim()
    .replace(/[?!.,]+$/g, "");
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

async function fetchWeatherSummary(
  message: string,
  userProfile?: { place?: string },
) {
  const location = weatherLocationFromMessage(message, userProfile);
  if (!location) return "I need a location to check the weather.";
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
  );
  const geoJson = await geo.json();
  const first = Array.isArray(geoJson?.results) ? geoJson.results[0] : null;
  if (!first) return `I couldn’t find a weather match for ${location}.`;
  const wx = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`,
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
    filtered = filtered.filter(
      (task) =>
        task.isoDatetime && new Date(task.isoDatetime).toDateString() === today,
    );
  } else if (normalized.includes("tomorrow")) {
    filtered = filtered.filter(
      (task) =>
        task.isoDatetime &&
        new Date(task.isoDatetime).toDateString() === tomorrow,
    );
  } else {
    filtered = filtered.filter(
      (task) =>
        !task.isoDatetime ||
        new Date(task.isoDatetime).getTime() >= now.getTime(),
    );
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
    ...filtered.map(
      (task) =>
        `- ${task.datetimeText || "Any time"}: ${task.title}${task.details ? ` — ${task.details}` : ""}`,
    ),
  ].join("\n");
}

async function parseReminderLocally(
  message: string,
  replyLanguage: ReplyLanguage,
) {
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  try {
    const out = await localChatJson(
      prompts.reminderExtractorSystem,
      JSON.stringify({ message, reply_language: replyLanguage }),
      cfg.models.orchestratorMedium,
      0.1,
    );
    const title = String(out.title || "Reminder").trim() || "Reminder";
    const details = String(out.details || message).trim() || message;
    const datetimeText = out.datetime_text
      ? String(out.datetime_text).trim()
      : null;
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

function selectedReasonerModel(
  cfg: LocalModelConfig,
  routesConfig: OrchestratorConfig,
  message: string,
  recentTurns: number,
  forcedModel?: string,
) {
  if (forcedModel) return forcedModel;
  const normalized = normalizeText(message);
  const largeChars = positiveInt(
    routesConfig.complexityThresholds?.largeModelQuestionChars,
    cfg.thresholds?.largeModelQuestionChars || 180,
  );
  const longConversationThreshold = positiveInt(
    routesConfig.complexityThresholds?.largeModelConversationTurns,
    8,
  );
  const multiStepKeywords = routesConfig.routes.multiStepKeywords || [];
  const hasMultiStepCue = multiStepKeywords.some((keyword) => {
    const clean = normalizeText(keyword);
    return clean && normalized.includes(clean);
  });
  if (
    message.length >= largeChars ||
    hasMultiStepCue ||
    recentTurns >= longConversationThreshold
  ) {
    return cfg.models.orchestratorLarge;
  }
  return cfg.models.orchestratorMedium;
}

function hasKeywordMatch(message: string, keywords: string[]) {
  const normalized = normalizeText(message);
  return keywords.some((keyword) => {
    const clean = normalizeText(keyword);
    if (!clean) return false;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(normalized);
  });
}

function generateClarifyingQuestion(
  message: string,
  replyLanguage: ReplyLanguage,
) {
  const normalized = normalizeText(message);
  if (/\b(this|that|it|these|those)\b/.test(normalized)) {
    return replyLanguage === "ta"
      ? "‘இது’ என்று சொல்வதில் எந்த விஷயத்தை குறிப்பிடுகிறீர்கள்?"
      : "What does that refer to exactly?";
  }
  if (/\b(he|she|they)\b/.test(normalized)) {
    return replyLanguage === "ta"
      ? "நீங்கள் சொல்வது எந்த நபர் அல்லது குழுவைப் பற்றி?"
      : "Who are you referring to?";
  }
  return replyLanguage === "ta"
    ? "கொஞ்சம் மேலும் குறிப்பாக சொல்ல முடியுமா?"
    : "Could you be a bit more specific?";
}

function ruleBasedOrchestratorDecision(
  message: string,
  replyLanguage: ReplyLanguage,
  routesConfig: OrchestratorConfig,
  selectedModel: string,
): OrchestratorDecision | null {
  const normalized = normalizeText(message);
  const tokenCount = normalized
    ? normalized.split(/\s+/).filter(Boolean).length
    : 0;
  const shortThreshold = positiveInt(
    routesConfig.clarificationRules?.shortMessageTokenThreshold,
    4,
  );
  const pronounThreshold = positiveInt(
    routesConfig.clarificationRules?.pronounOnlyTokenThreshold,
    6,
  );
  const ambiguousPronounOnly =
    tokenCount > 0 &&
    tokenCount <= pronounThreshold &&
    hasKeywordMatch(message, routesConfig.routes.ambiguityKeywords) &&
    !hasKeywordMatch(message, routesConfig.routes.profileKeywords) &&
    !hasKeywordMatch(message, routesConfig.routes.calendarKeywords) &&
    !hasKeywordMatch(message, routesConfig.routes.reminderKeywords) &&
    !hasKeywordMatch(message, routesConfig.routes.weatherKeywords);

  if (
    hasKeywordMatch(message, [
      ...(routesConfig.routes.fastGreetingKeywords || []),
      ...((routesConfig.routes.smallTalkKeywords || []) as string[]),
    ])
  ) {
    return {
      route: "fast_greeting",
      reason: "matched_greeting_or_small_talk_rule",
      confidence: 0.99,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  if (hasKeywordMatch(message, routesConfig.routes.reminderKeywords)) {
    return {
      route: "reminder_create",
      reason: "matched_local_reminder_tool_rule",
      confidence: 0.96,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel,
      fallbackAllowed: false,
    };
  }

  if (hasKeywordMatch(message, routesConfig.routes.calendarKeywords)) {
    return {
      route: "calendar_query",
      reason: "matched_local_calendar_tool_rule",
      confidence: 0.95,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  if (hasKeywordMatch(message, routesConfig.routes.weatherKeywords)) {
    return {
      route: "weather",
      reason: "matched_weather_live_tool_rule",
      confidence: 0.97,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: true,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  if (hasKeywordMatch(message, routesConfig.routes.profileKeywords)) {
    return {
      route: "profile",
      reason: "matched_local_profile_rule",
      confidence: 0.95,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel,
      fallbackAllowed: false,
    };
  }

  if (ambiguousPronounOnly || tokenCount <= shortThreshold) {
    return {
      route: "clarify",
      reason: "critical_context_missing",
      confidence: 0.92,
      needsClarification: true,
      clarificationQuestion: generateClarifyingQuestion(message, replyLanguage),
      needsLiveData: false,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  return null;
}

function sanitizeDecision(
  raw: Partial<OrchestratorDecision> & Record<string, any>,
  selectedModel: string,
  replyLanguage: ReplyLanguage,
): OrchestratorDecision {
  const route = String(raw.route || "local_answer") as OrchestratorRoute;
  const safeRoute: OrchestratorRoute = [
    "fast_greeting",
    "clarify",
    "profile",
    "calendar_query",
    "reminder_create",
    "weather",
    "local_answer",
    "fallback_openai",
  ].includes(route)
    ? route
    : "local_answer";
  const needsClarification = Boolean(
    raw.needsClarification ?? raw.needs_clarification,
  );
  return {
    route: safeRoute,
    reason: String(raw.reason || "model_route").trim() || "model_route",
    confidence: clampConfidence(raw.confidence, 0.65),
    needsClarification,
    clarificationQuestion:
      String(
        raw.clarificationQuestion ||
          raw.clarifyingQuestion ||
          raw.clarification_question ||
          "",
      ).trim() ||
      (needsClarification ? generateClarifyingQuestion("", replyLanguage) : ""),
    needsLiveData: Boolean(raw.needsLiveData ?? raw.needs_live_data),
    selectedModel:
      String(raw.selectedModel || raw.selected_model || selectedModel).trim() ||
      selectedModel,
    fallbackAllowed: Boolean(raw.fallbackAllowed ?? raw.fallback_allowed),
  };
}

async function classifyRouteWithModel(
  message: string,
  replyLanguage: ReplyLanguage,
  answers: Record<string, any>,
  profileSummary: string,
  selectedModel: string,
) {
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
      selectedModel,
      0.05,
    );
    return sanitizeDecision(out, selectedModel, replyLanguage);
  } catch {
    return sanitizeDecision(
      { route: "local_answer", reason: "model_classifier_failed" },
      selectedModel,
      replyLanguage,
    );
  }
}

function extractProtectedFactTokens(text: string) {
  const tokens = new Set<string>();
  const source = String(text || "");
  const addMatches = (regex: RegExp) => {
    const matches = source.match(regex) || [];
    matches.forEach((match) => {
      const clean = match.trim();
      if (clean) tokens.add(clean);
    });
  };
  addMatches(/\b\d+(?::\d+)?(?:\s?(?:am|pm|AM|PM))?\b/g);
  addMatches(
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  );
  addMatches(
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
  );
  addMatches(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
  return Array.from(tokens);
}

function preservesFacts(draft: string, english: string) {
  const protectedTokens = extractProtectedFactTokens(draft);
  return protectedTokens.every((token) => english.includes(token));
}

async function alignAnswer(
  draft: string,
  replyLanguage: ReplyLanguage,
  route: string,
  answers: Record<string, any>,
  profileSummary: string,
  userProfile?: LocalUserProfile,
) {
  const cfg = await getModelConfig();
  const rules = await getAlignmentRules();
  const prompts = await getPromptCatalog();
  const tonePreference = displayValue(answers.communication_tone);
  const toneInstruction =
    (tonePreference && rules.toneByPreference?.[tonePreference]) ||
    (tonePreference &&
      rules.toneByPreference?.[normalizeText(tonePreference)]) ||
    "";
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
        tone_instruction: toneInstruction,
      }),
      cfg.models.aligner,
      0.2,
    );
    const english = String(out.english_answer || draft).trim() || draft;
    const final =
      String(out.final_answer || out.english_answer || draft).trim() || draft;
    if (
      rules.fallbackToDraftOnFactDrift !== false &&
      !preservesFacts(draft, english)
    ) {
      return { english: draft, final: replyLanguage === "ta" ? draft : draft };
    }
    return { english, final };
  } catch {
    return { english: draft, final: draft };
  }
}

const PROFILE_MEMORY_PATTERNS = [
  /what do i like/i,
  /what are my hobbies/i,
  /which hobbies do i have/i,
  /what are my interests/i,
  /what do i enjoy/i,
];

const PROFILE_MEMORY_ALIASES = [
  "what do i like",
  "what are my hobbies",
  "which hobbies do i have",
  "what are my interests",
  "what do i enjoy",
];

function isProfileMemoryQuestion(message: string) {
  return PROFILE_MEMORY_PATTERNS.some((pattern) => pattern.test(message));
}

async function lookupSemanticCache(userId: number, message: string) {
  const rules = await getMemoryRules();
  const store = await loadSemanticCacheStore(userId);
  const now = Date.now();

  const rows = store.entries.filter((row) => {
    if (row.userId !== userId) return false;
    if (!row.expiresAt) return true;
    return new Date(row.expiresAt).getTime() >= now;
  });

  if (!rows.length) return null;

  const profileMemory = isProfileMemoryQuestion(message);

  // Important: compare the actual user message against cached questions.
  // Do not inject aliases here, because aliases can bypass the similarity threshold.
  const queryVectors = await embedTexts([message]);

  let best: SemanticCacheEntry | null = null;
  let bestScore = 0;

  for (const queryVec of queryVectors) {
    for (const row of rows) {
      if (
        profileMemory &&
        row.route !== "profile" &&
        !isProfileMemoryQuestion(row.sourceQuestion)
      ) {
        continue;
      }

      const score = cosine(
        queryVec,
        normalizeStoredEmbedding(row.embedding, row.sourceQuestion),
      );

      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
  }

  const threshold = positiveFloat(rules.cache?.similarityThreshold, 0.92);

  if (best && bestScore >= threshold) {
    return { ...best, score: bestScore };
  }

  return null;
}

async function recordSemanticCacheHit(
  userId: number,
  hit: SemanticCacheHitRecord,
) {
  const rules = await getMemoryRules();
  await updateSemanticCacheStore(userId, rules, async (store) => {
    store.hits.push(hit);
  });
}

async function writeSemanticCache(
  userId: number,
  question: string,
  answer: string,
  englishAnswer: string,
  route: string,
  intent: LocalAssistantTurnResult["intent"],
  alignmentProfile?: SemanticCacheEntry["alignmentProfile"],
) {
  const rules = await getMemoryRules();
  const skipRoutes = rules.cache?.skipRoutes || [];
  if (skipRoutes.includes(route)) return;
  const [embedding] = await embedTexts([question]);
  const ttlHours = positiveInt(rules.cache?.ttlHours, 168);
  const createdAt = nowIso();
  const expiresAt =
    ttlHours > 0
      ? new Date(Date.now() + ttlHours * 3600000).toISOString()
      : null;
  const newEntry: SemanticCacheEntry = {
    id: `${userId}_${simpleHash(`${question}:${englishAnswer}:${route}`)}`,
    userId,
    sourceQuestion: question,
    normalizedQuestion: normalizeText(question),
    canonicalAnswer: englishAnswer || answer,
    englishAnswer: englishAnswer || answer,
    lastPresentedAnswer: answer,
    route,
    intent,
    embedding,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    alignmentProfile,
  };
  await updateSemanticCacheStore(userId, rules, async (store) => {
    const filtered = store.entries.filter((row) => row.id !== newEntry.id);
    filtered.push(newEntry);
    store.entries = filtered;
  });
}

async function buildMemoryConsolidation(
  userId: number,
  turns: LocalChatMessage[],
  routeLogs: any[],
  answers: Record<string, any>,
  state: LocalProfilerState,
  userProfile?: LocalUserProfile,
) {
  const rules = await getMemoryRules();
  const cfg = await getModelConfig();
  const prompts = await getPromptCatalog();
  const registry = await getAgentRegistry();
  const slots = await getProfilerSlots();
  const replyLanguageName = languageLabel(
    String(
      answers.preferred_language || userProfile?.replyLanguage || "english",
    ),
  );
  const recentUserText = turns
    .filter((row) => row.role === "user")
    .map((row) => row.content.trim())
    .filter(Boolean)
    .join("\n");
  const deterministic = deterministicProfilerExtraction(
    recentUserText,
    slots,
    answers,
    state,
    replyLanguageName,
  );
  const perTurnExtractions = turns
    .filter((row) => row.role === "user")
    .map((row) =>
      deterministicProfilerExtraction(
        row.content,
        slots,
        answers,
        state,
        replyLanguageName,
      ),
    );
  const perTurnUpdates = normalizeMemoryProfileUpdates(
    slots,
    Object.assign({}, ...perTurnExtractions.map((row) => row.updates || {})),
  );
  const perTurnConfidenceBySlot = Object.assign(
    {},
    ...perTurnExtractions.map((row) => row.confidence_by_slot || {}),
  ) as Record<string, number>;
  const fallbackProfileUpdates = normalizeMemoryProfileUpdates(
    slots,
    deterministic.updates || {},
  );
  const fallbackProfileConfidenceBySlot = Object.fromEntries(
    Object.entries(deterministic.confidence_by_slot || {}).map(
      ([slotId, value]) => [slotId, clampConfidence(value, 0)],
    ),
  );
  const deriveUpdatesFromFacts = (facts: DurableFactRecord[]) => {
    const joinedFacts = facts.map((row) => row.fact).join(". ");
    const factExtraction = deterministicProfilerExtraction(
      joinedFacts,
      slots,
      answers,
      state,
      replyLanguageName,
    );
    const heuristicUpdates: Record<string, any> = {};
    const heuristicConfidenceBySlot: Record<string, number> = {};
    const normalizedFacts = normalizeText(joinedFacts);
    if (normalizedFacts.includes("english")) {
      heuristicUpdates.preferred_language = "english";
      heuristicConfidenceBySlot.preferred_language = 0.86;
    }
    if (
      normalizedFacts.includes("software engineer") ||
      normalizedFacts.includes("developer") ||
      normalizedFacts.includes("engineer")
    ) {
      heuristicUpdates.occupation = "working_professional";
      heuristicConfidenceBySlot.occupation = 0.9;
      heuristicUpdates.industry_or_field = "technology";
      heuristicConfidenceBySlot.industry_or_field = 0.9;
    }
    return {
      updates: {
        ...normalizeMemoryProfileUpdates(slots, factExtraction.updates || {}),
        ...normalizeMemoryProfileUpdates(slots, heuristicUpdates),
      },
      confidenceBySlot: {
        ...Object.fromEntries(
          Object.entries(factExtraction.confidence_by_slot || {}).map(
            ([slotId, value]) => [slotId, clampConfidence(value, 0)],
          ),
        ),
        ...heuristicConfidenceBySlot,
      },
    };
  };

  try {
    const out = await localChatJson(
      prompts.memorySyncSystem,
      JSON.stringify({
        user: userProfile || {},
        structured_profile: answers,
        profiler_summary: await loadSummary(userId),
        profiler_answers: answers,
        profiler_state: state,
        recent_turns: turns,
        route_logs: routeLogs,
        alignment_captures: (await listLocalTrainingSamples("alignment")).slice(
          -12,
        ),
        conversation_logs_path: convoPath(userId),
        semantic_memory_model: cfg.models.embedding,
      }),
      cfg.models[registry.agents.memory.summarizerModelKey],
      0.1,
    );
    const parsed = parseJsonLoose<MemoryConsolidationModelOutput>(out, {});
    const normalizedModelUpdates = normalizeMemoryProfileUpdates(
      slots,
      parsed.profile_updates || {},
    );
    const modelConfidenceBySlot = Object.fromEntries(
      Object.keys(normalizedModelUpdates).map((slotId) => [slotId, 0.95]),
    );
    const durableFacts = (
      Array.isArray(parsed.durable_facts) ? parsed.durable_facts : []
    )
      .map((row): DurableFactRecord | null => {
        const fact = String(row?.fact || "").trim();
        const confidence = clampConfidence(row?.confidence, 0);
        if (
          !fact ||
          confidence <
            positiveFloat(rules.durableFacts?.confidenceThreshold, 0.78)
        )
          return null;
        if (isTransientFact(fact, rules) && !row?.important) return null;
        return {
          fact,
          confidence,
          category: String(row?.category || "general").trim() || "general",
          source: "model",
          firstSeenAt: nowIso(),
          lastSeenAt: nowIso(),
          evidence: trimList(row?.evidence).slice(0, 4),
          important: Boolean(row?.important),
          profileUpdates: normalizeMemoryProfileUpdates(
            slots,
            row?.profile_updates || {},
          ),
        };
      })
      .filter(Boolean) as DurableFactRecord[];
    const factDerived = deriveUpdatesFromFacts(durableFacts);
    return {
      source: "model" as const,
      summary:
        String(parsed.summary || "").trim() ||
        buildFallbackMemorySummary(durableFacts, turns),
      durableFacts: durableFacts.slice(
        0,
        positiveInt(rules.durableFacts?.maxFactsPerSync, 6),
      ),
      profileUpdates: {
        ...fallbackProfileUpdates,
        ...perTurnUpdates,
        ...factDerived.updates,
        ...normalizedModelUpdates,
      },
      profileUpdateConfidenceBySlot: {
        ...fallbackProfileConfidenceBySlot,
        ...perTurnConfidenceBySlot,
        ...factDerived.confidenceBySlot,
        ...modelConfidenceBySlot,
      },
    };
  } catch {
    const durableFacts = buildDurableFactsFromHeuristics(
      turns,
      fallbackProfileUpdates,
      rules,
    );
    const factDerived = deriveUpdatesFromFacts(durableFacts);
    return {
      source: "fallback" as const,
      summary: buildFallbackMemorySummary(durableFacts, turns),
      durableFacts,
      profileUpdates: {
        ...fallbackProfileUpdates,
        ...perTurnUpdates,
        ...factDerived.updates,
      },
      profileUpdateConfidenceBySlot: {
        ...fallbackProfileConfidenceBySlot,
        ...perTurnConfidenceBySlot,
        ...factDerived.confidenceBySlot,
      },
    };
  }
}

async function applyConservativeProfileUpdates(
  userId: number,
  updates: Record<string, any>,
  updateConfidenceBySlot: Record<string, number>,
  currentAnswers: Record<string, any>,
  state: LocalProfilerState,
  rules: MemoryRules,
  userProfile?: LocalUserProfile,
) {
  const nextAnswers = { ...currentAnswers };
  const reasons: string[] = [];
  for (const [slotId, value] of Object.entries(updates || {})) {
    if (
      !shouldApplyProfileUpdate(
        slotId,
        value,
        currentAnswers,
        state.confidenceBySlot || {},
        updateConfidenceBySlot,
        rules,
      )
    ) {
      continue;
    }
    nextAnswers[slotId] = value;
    reasons.push(
      !nonEmptyAnswer(currentAnswers[slotId])
        ? `Filled empty slot ${slotId} from durable memory.`
        : `Conservatively updated ${slotId} from durable memory.`,
    );
  }

  const applied =
    JSON.stringify(nextAnswers) !== JSON.stringify(currentAnswers);
  if (applied) {
    await saveAnswers(userId, nextAnswers);
    await syncAnswersToBackend(userId, nextAnswers).catch(() => undefined);
    await buildProfileSummaryLocally(userId, userProfile);
  }

  const row: ProfileUpdateRecord = {
    userId,
    createdAt: nowIso(),
    applied,
    updates,
    previousAnswers: currentAnswers,
    nextAnswers,
    reasons,
  };
  await appendProfileUpdate(userId, row);
  return row;
}

async function refreshMemoryRagArtifacts(
  userId: number,
  summaryRow: DailySummaryRecord,
  durableFacts: DurableFactRecord[],
) {
  const texts = [
    summaryRow.summary ? `Summary: ${summaryRow.summary}` : "",
    ...durableFacts.map((row) => `Fact: ${row.fact}`),
  ].filter(Boolean);
  if (!texts.length) {
    await saveMemoryChunks(userId, []);
    return [] as LocalRagChunk[];
  }
  const embeddings = await embedTexts(texts);
  const chunks: LocalRagChunk[] = texts.map((text, index) => ({
    id: `memory:${userId}:${index}:${simpleHash(text)}`,
    sourceId: `memory:${userId}:${index}`,
    sourceType: "memory",
    text,
    embedding: Array.isArray(embeddings[index])
      ? embeddings[index]
      : hashEmbedding(text),
    metadata: {
      userId,
      createdAt: summaryRow.createdAt,
      kind: index === 0 ? "summary" : "durable_fact",
      factCount: durableFacts.length,
    },
    updatedAt: summaryRow.createdAt,
  }));
  await saveMemoryChunks(userId, chunks);
  return chunks;
}

export async function consolidateLocalMemoryOnIdle(
  userId: number,
  opts?: { force?: boolean; userProfile?: LocalUserProfile },
): Promise<MemoryConsolidationResult> {
  const rules = await getMemoryRules();
  const registry = await getAgentRegistry();
  if (!registry.agents.memory.enabled) {
    return { ok: false, skipped: true, reason: "memory_agent_disabled" };
  }

  const turns = await recentConversation(
    userId,
    positiveInt(rules.summarization?.maxTurnsForSync, 18),
  );
  if (
    !opts?.force &&
    turns.length < positiveInt(rules.summarization?.minTurnsBeforeSync, 6)
  ) {
    return { ok: false, skipped: true, reason: "not_enough_turns" };
  }
  const previous = await loadDailySummaries(userId);
  const latestSync = previous[previous.length - 1]?.createdAt;
  if (latestSync) {
    const minutes = (Date.now() - new Date(latestSync).getTime()) / 60000;
    if (
      !opts?.force &&
      minutes < positiveInt(rules.summarization?.minMinutesBetweenSync, 15)
    ) {
      return { ok: false, skipped: true, reason: "within_cooldown_window" };
    }
  }

  const answers = await loadAnswers(userId);
  const state = await loadProfilerState(userId);
  const routeLogs = await loadRouteLogs(userId, 18);
  const built = await buildMemoryConsolidation(
    userId,
    turns,
    routeLogs,
    answers,
    state,
    opts?.userProfile,
  );
  const existingFacts = await loadDurableFacts(userId);
  const mergedFacts = mergeDurableFacts(existingFacts, built.durableFacts);
  const summaryRow: DailySummaryRecord = {
    userId,
    createdAt: nowIso(),
    windowStartAt: turns[0]?.createdAt,
    windowEndAt: turns[turns.length - 1]?.createdAt,
    summary: built.summary,
    durableFacts: mergedFacts.slice(
      -positiveInt(rules.durableFacts?.maxFactsPerSync, 6),
    ),
    profileUpdates: built.profileUpdates,
    source: built.source,
    conversationTurnCount: turns.length,
    routeLogCount: routeLogs.length,
  };
  await saveDurableFacts(userId, mergedFacts);
  await appendDailySummary(userId, summaryRow);

  const profileUpdate = await applyConservativeProfileUpdates(
    userId,
    built.profileUpdates,
    built.profileUpdateConfidenceBySlot || {},
    answers,
    state,
    rules,
    opts?.userProfile,
  );
  const memoryChunks = await refreshMemoryRagArtifacts(
    userId,
    summaryRow,
    mergedFacts,
  );
  await safeRecordTrainingSample("memory", {
    input: JSON.stringify({
      recent_turns: turns,
      route_logs: routeLogs,
      current_answers: answers,
    }),
    expectedOutput: JSON.stringify(summaryRow),
    label: profileUpdate.applied ? "profile_update" : "memory_sync",
    metadata: {
      userId,
      source: built.source,
      durableFactCount: mergedFacts.length,
      profileUpdateApplied: profileUpdate.applied,
    },
  });
  return {
    ok: true,
    summary: summaryRow,
    durableFacts: mergedFacts,
    profileUpdate,
    memoryChunks,
  };
}

async function buildLocalReasoningDraft(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, any>;
  profileSummary: string;
  userProfile?: LocalUserProfile;
  selectedModel: string;
}) {
  const prompts = await getPromptCatalog();
  const memories = await loadDailySummaries(opts.userId);
  const durableFacts = await loadDurableFacts(opts.userId);
  const turns = await recentConversation(opts.userId, 10);
  const ragHits = await searchLocalRag(opts.userId, opts.message, 6);
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
      durable_facts: durableFacts.slice(-8),
      recent_conversation: turns,
      rag_hits: ragHits.map((row) => ({
        source_id: row.sourceId,
        source_type: row.sourceType,
        text: row.text,
        score: row.score,
        metadata: row.metadata || {},
      })),
    }),
    opts.selectedModel,
    0.25,
  );
  return draft.trim();
}

async function buildProfileGroundedDraft(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, any>;
  profileSummary: string;
  userProfile?: LocalUserProfile;
  selectedModel: string;
}) {
  const direct = heuristicProfileAnswer(
    opts.message,
    opts.answers,
    opts.userProfile,
  );
  if (direct) return direct;
  return buildLocalReasoningDraft(opts);
}

function canUseOpenAiFallback(opts: {
  decision: OrchestratorDecision;
  localReasonerRequestedFallback: boolean;
  needsLiveData: boolean;
  noSafeLocalPath: boolean;
  userAllowedCloudFallback: boolean;
}) {
  if (!opts.userAllowedCloudFallback) return false;

  return (
    opts.decision.fallbackAllowed === true ||
    opts.localReasonerRequestedFallback ||
    opts.needsLiveData ||
    opts.noSafeLocalPath
  );
}

async function appendRouteDecisionLog(
  userId: number,
  message: string,
  decision: OrchestratorDecision,
  extra?: Record<string, any>,
) {
  await appendJsonl(routeLogPath(userId), {
    createdAt: nowIso(),
    message,
    decision,
    ...extra,
  });
}

export async function saveScheduledTask(
  userId: number,
  task: Omit<LocalTaskRecord, "id" | "createdAt">,
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
  const replyLanguage: ReplyLanguage =
    opts.replyLanguage === "en" ? "en" : "ta";
  if (!message) throw new Error("Message is required.");

  await appendConversation(userId, "user", message);

  const answers = await loadAnswers(userId);
  const profileSummary =
    (await loadSummary(userId)) ||
    (await buildProfileSummaryLocally(userId, {
      ...opts.userProfile,
      replyLanguage,
    }));

  const semantic = await lookupSemanticCache(userId, message);
  if (semantic) {
    const needsAlignmentReapply =
      semantic.alignmentProfile?.replyLanguage !== replyLanguage ||
      normalizeText(semantic.alignmentProfile?.tone || "") !==
        normalizeText(displayValue(answers.communication_tone));
    const aligned = needsAlignmentReapply
      ? await alignAnswer(
          semantic.englishAnswer || semantic.canonicalAnswer,
          replyLanguage,
          "semantic_cache",
          answers,
          profileSummary,
          opts.userProfile,
        )
      : {
          english: semantic.englishAnswer || semantic.canonicalAnswer,
          final:
            semantic.lastPresentedAnswer ||
            semantic.englishAnswer ||
            semantic.canonicalAnswer,
        };
    const assistantText =
      aligned.final || aligned.english || semantic.canonicalAnswer;
    await appendConversation(userId, "assistant", assistantText);
    await recordSemanticCacheHit(userId, {
      userId,
      sourceQuestion: message,
      matchedQuestion: semantic.sourceQuestion,
      similarity: semantic.score,
      timestamp: nowIso(),
      alignmentReapplied: needsAlignmentReapply,
      route: semantic.route,
    });
    await safeRecordTrainingSample("memory", {
      input: message,
      expectedOutput: assistantText,
      label: "semantic_cache_hit",
      metadata: {
        userId,
        route: semantic.route,
        score: semantic.score,
        matchedQuestion: semantic.sourceQuestion,
        alignmentReapplied: needsAlignmentReapply,
      },
    });
    return {
      route: "semantic_cache",
      source: "semantic_cache",
      cacheHit: true,
      assistantText,
      englishText:
        aligned.english || semantic.englishAnswer || semantic.canonicalAnswer,
      intent: semantic.intent || "assistant",
      profileSummary,
      meta: {
        sourceQuestion: message,
        matchedQuestion: semantic.sourceQuestion,
        similarity: semantic.score,
        timestamp: nowIso(),
        alignmentReapplied: needsAlignmentReapply,
        dataFolder: DATA_DIR,
        trainingFolder: TRAINING_DIR,
        ragFolder: RAG_DIR,
      },
    } satisfies LocalAssistantTurnResult;
  }

  const routesConfig = await getOrchestratorConfig();
  const cfg = await getModelConfig();
  const registry = await getAgentRegistry();
  const turns = await recentConversation(userId, 10);
  const preferredSelectedModel = selectedReasonerModel(
    cfg,
    routesConfig,
    message,
    turns.length,
  );
  const fastDecision = ruleBasedOrchestratorDecision(
    message,
    replyLanguage,
    routesConfig,
    preferredSelectedModel,
  );
  let decision = fastDecision
    ? fastDecision
    : await classifyRouteWithModel(
        message,
        replyLanguage,
        answers,
        profileSummary,
        preferredSelectedModel,
      );

  await safeRecordTrainingSample("orchestrator", {
    input: message,
    expectedOutput: JSON.stringify(decision),
    label: fastDecision ? "fast_rule_route" : "model_route",
    metadata: {
      userId,
      replyLanguage,
      profileSummary,
      availableToolAgents: registry.agents.toolAgents,
      selectedModel: preferredSelectedModel,
    },
  });

  let route = decision.route;
  let source: LocalAssistantTurnResult["source"] = fastDecision
    ? "local_rules"
    : "local_model";
  let intent: LocalAssistantTurnResult["intent"] = "assistant";
  let title: string | null | undefined;
  let details: string | null | undefined;
  let datetimeText: string | null | undefined;
  let draft = "";
  let english = "";
  let final = "";
  let localReasonerRequestedFallback = false;
  let noSafeLocalPath = false;

  if (decision.needsLiveData && route !== "weather") {
    route = "fallback_openai";
  }

  if (route === "fast_greeting") {
    draft =
      replyLanguage === "ta"
        ? `வணக்கம் ${opts.userProfile?.name || ""}. நான் எப்படி உதவலாம்?`.trim()
        : `Hi ${opts.userProfile?.name || "there"}, how can I help?`;
    english = draft;
    final = draft;
  } else if (route === "clarify" || decision.needsClarification) {
    route = "clarify";
    intent = "clarify";
    source = "local_rules";
    draft =
      decision.clarificationQuestion ||
      (replyLanguage === "ta"
        ? "கொஞ்சம் இன்னும் தெளிவாக சொல்லுங்களேன், சரியான பதில் தர முடியும்."
        : "Could you give me a bit more detail so I can answer accurately?");
    english = draft;
    final = draft;
  } else if (route === "profile") {
    draft = await buildProfileGroundedDraft({
      userId,
      message,
      replyLanguage,
      answers,
      profileSummary,
      userProfile: opts.userProfile,
      selectedModel: decision.selectedModel,
    }).catch(() =>
      replyLanguage === "ta"
        ? "உங்களைப் பற்றிய சில தகவல்கள் என்கிட்ட இருக்கு. இதை கொஞ்சம் நேராக கேளுங்கள்."
        : "I do have some profile information about you. Ask that a little more directly.",
    );
    const aligned = await alignAnswer(
      draft,
      replyLanguage,
      route,
      answers,
      profileSummary,
      opts.userProfile,
    );
    english = aligned.english;
    final = aligned.final;
  } else if (route === "calendar_query") {
    if (!registry.agents.toolAgents.calendar) {
      noSafeLocalPath = true;
      route = "fallback_openai";
    } else {
      source = "local_rules";
      draft = await buildScheduleAnswer(userId, message);
      const aligned = await alignAnswer(
        draft,
        replyLanguage,
        route,
        answers,
        profileSummary,
        opts.userProfile,
      );
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
    const aligned = await alignAnswer(
      draft,
      replyLanguage,
      route,
      answers,
      profileSummary,
      opts.userProfile,
    );
    english = aligned.english;
    final = aligned.final;
  } else if (route === "weather") {
    if (!registry.agents.toolAgents.weather) {
      noSafeLocalPath = true;
      route = "fallback_openai";
    } else {
      try {
        draft = await fetchWeatherSummary(message, opts.userProfile);
        const aligned = await alignAnswer(
          draft,
          replyLanguage,
          route,
          answers,
          profileSummary,
          opts.userProfile,
        );
        english = aligned.english;
        final = aligned.final;
      } catch {
        noSafeLocalPath = true;
        route = "fallback_openai";
      }
    }
  } else if (route === "fallback_openai") {
    // defer backend gating until the fallback policy check below
  } else {
    route = "local_answer";
  }

  if (route === "local_answer") {
    try {
      draft = await buildLocalReasoningDraft({
        userId,
        message,
        replyLanguage,
        answers,
        profileSummary,
        userProfile: opts.userProfile,
        selectedModel: decision.selectedModel,
      });
      if (draft === OPENAI_FALLBACK_SIGNAL) {
        localReasonerRequestedFallback = true;
        route = "fallback_openai";
      } else {
        const aligned = await alignAnswer(
          draft,
          replyLanguage,
          route,
          answers,
          profileSummary,
          opts.userProfile,
        );
        english = aligned.english;
        final = aligned.final;
      }
    } catch {
      noSafeLocalPath = true;
      route = "fallback_openai";
    }
  }

  if (route === "fallback_openai") {
    decision = {
      ...decision,
      route: "fallback_openai",
      fallbackAllowed: canUseOpenAiFallback({
        decision,
        localReasonerRequestedFallback,
        needsLiveData: decision.needsLiveData,
        noSafeLocalPath,
        userAllowedCloudFallback: true,
      }),
    };
    if (decision.fallbackAllowed) {
      source = "openai_fallback";
      const backend = await apiPostBackendOnly<any>("/api/chat", {
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
            "",
        ).trim() || "I couldn’t generate a response.";
      const aligned = await alignAnswer(
        backendText,
        replyLanguage,
        route,
        answers,
        profileSummary,
        opts.userProfile,
      );
      english = aligned.english;
      final = aligned.final;
    } else {
      route = "clarify";
      decision = {
        ...decision,
        route: "clarify",
        reason: "openai_fallback_blocked_by_policy",
        needsClarification: false,
        clarificationQuestion: "",
      };
      source = "local_rules";
      intent = "clarify";
      draft =
        replyLanguage === "ta"
          ? "இதற்கு cloud/backend உதவி தேவை, ஆனால் cloud fallback முடக்கப்பட்டுள்ளது."
          : "I need cloud/backend help for this, but cloud fallback is disabled.";
      english = draft;
      final = draft;
    }
  }

  const assistantText =
    final || english || draft || "I couldn’t generate a response.";
  await appendConversation(userId, "assistant", assistantText);
  await appendRouteDecisionLog(userId, message, decision, {
    routeUsed: route,
    source,
    localReasonerRequestedFallback,
    noSafeLocalPath,
  });

  if (
    assistantText.trim() &&
    route !== "reminder_create" &&
    route !== "clarify"
  ) {
    await writeSemanticCache(
      userId,
      message,
      assistantText,
      english || draft || assistantText,
      route,
      intent,
      {
        replyLanguage,
        tone: displayValue(answers.communication_tone),
      },
    );
  }

  await safeRecordTrainingSample("alignment", {
    input: JSON.stringify({
      route,
      draft,
      english,
      replyLanguage,
      profileSummary,
      answers,
      decision,
    }),
    expectedOutput: assistantText,
    label: route,
    metadata: { userId, source, decision },
  });

  if (shouldAttemptLocalMemoryConsolidation(userId)) {
    await consolidateLocalMemoryOnIdle(userId, {
      userProfile: { ...opts.userProfile, replyLanguage },
    }).catch(() => ({ ok: false }));
  }

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
      classified: decision,
      orchestratorDecision: decision,
      dataFolder: DATA_DIR,
      trainingFolder: TRAINING_DIR,
      ragFolder: RAG_DIR,
      promptConfig: PROMPTS_PATH,
      modelConfig: MODELS_PATH,
    },
  } satisfies LocalAssistantTurnResult;
}
