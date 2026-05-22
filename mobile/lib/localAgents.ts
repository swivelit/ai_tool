import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";

import {
  BACKEND_CHAT_FALLBACK_TIMEOUT_MS,
  CLOUD_FALLBACK_CONSENT_MESSAGE,
  annotateBackendOpenAiFallbackResponse,
  apiPost,
  apiPostBackendOnly,
  sendClientTurnLog,
  type BackendFallbackReason,
} from "./api";
import {
  DeviceCapabilitySnapshot,
  ModelDeliveryConfig,
  ModelInstallStatus,
  ModelTierName,
  getModelDeliveryMode,
  getModelInstallStatus,
  getRequiredModelIdsForTier,
  isModelInstallError,
  selectModelTier,
} from "./modelDownloadManager";
import {
  ensureLocalAgentSeedData,
  LOCAL_AGENT_DATA_DIR,
} from "./localAgentBootstrap";
import {
  OPENAI_FALLBACK_SIGNAL,
  NativeOnDeviceRuntimeUnavailableError,
  createLocalModelRuntime,
  isNativeOnDeviceRuntimeUnavailableError,
  isLoopbackLocalRuntimeBaseUrl,
  normalizeLocalRuntimeBaseUrl,
} from "./localModelRuntime";
import {
  LocalBudgetExceededError,
  isLocalTurnTimeoutError,
} from "./localTurnTimeouts";
import {
  PRODUCT_DEFAULT_REPLY_LANGUAGE,
  ReplyLanguage,
  resolveReplyLanguage,
} from "./replyLanguage";
import {
  QuickLocalReplyResult,
  tryBuildQuickLocalReply,
} from "./localQuickReplies";
import {
  isLiveOrCurrentGlobalKnowledgeQuestion,
  lookupSyncedGlobalKnowledge,
  syncGlobalKnowledge,
} from "./globalKnowledgeSync";
import {
  canUseNativeEmbeddingsSafely,
  canUseNativeGeneralChatSafely,
  getNativeInferenceSafetyStatus,
} from "./nativeInferenceGuard";
import { requiresImmediateBackendCurrentData } from "./currentDataGuards";
import { __idleQueueTestUtils, enqueueLocalIdleJob } from "./localIdleQueue";
import {
  clearPendingLocalTurn,
  markPendingLocalTurn,
  updateActiveWorkflowStep,
} from "./chatTelemetry";
import {
  loadTasks,
  scheduledTasksPath,
  type LocalTaskRecord,
} from "./localTaskStore";

export { saveScheduledTask } from "./localTaskStore";

type ChatRole = "system" | "user" | "assistant";

type OrchestratorRoute =
  | "fast_greeting"
  | "identity"
  | "small_talk"
  | "wellbeing_support"
  | "capabilities"
  | "knowledge_ack"
  | "thanks"
  | "goodbye"
  | "clarify"
  | "profile"
  | "calendar_query"
  | "reminder_create"
  | "weather"
  | "local_answer"
  | "global_knowledge_cache"
  | "setup_required"
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

export type LocalRagChunk = {
  id: string;
  sourceId: string;
  sourceType: "profile" | "doc" | "memory" | "manual";
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
  updatedAt: string;
};

export type LocalRagSourceMetadata = {
  source_name: string;
  chunk_id: string;
  file?: string;
  path?: string;
  category?: string;
  freshness_date?: string;
  confidence: number;
  relevance_score: number;
};

export type LocalRagSearchResult = LocalRagChunk & {
  score: number;
  confidence: number;
  source_name: string;
  chunk_id: string;
  file?: string;
  path?: string;
  category?: string;
  freshness_date?: string;
  sourceMetadata: LocalRagSourceMetadata;
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
  kind?: "assistant_turn" | "cloud_consent_required";
  route: OrchestratorRoute | "semantic_cache";
  source: "local_model" | "local_rules" | "semantic_cache" | "global_rag" | "openai_fallback";
  cacheHit: boolean;
  assistantText: string;
  englishText: string;
  intent: "assistant" | "reminder" | "note" | "clarify";
  title?: string | null;
  details?: string | null;
  datetimeText?: string | null;
  profileSummary?: string;
  cloudFallback?: CloudConsentRequiredState;
  meta?: Record<string, any> & { orchestratorDecision?: OrchestratorDecision };
};

export type ToolResult<T> = {
  ok: boolean;
  tool: string;
  data?: T;
  error?: string;
  source?: string;
  timestamp?: string;
  confidence?: number;
};

type CloudConsentRequiredState = {
  kind: "cloud_consent_required";
  reason: string;
  localAnswerAvailable?: boolean;
  suggestedAction?: "ask_user_consent";
};

type LocalToolName =
  | "getWeather"
  | "createReminder"
  | "listReminders"
  | "getProfile"
  | "updateMemory"
  | "searchLocalRag";

type ToolPlanStep = {
  tool: LocalToolName;
  args: Record<string, any>;
  reason: string;
};

type ToolPlan = {
  id: string;
  complex: boolean;
  reason: string;
  steps: ToolPlanStep[];
};

type WeatherToolData = {
  summary: string;
  location?: string;
  date?: string;
};

type ReminderDraftToolData = {
  title: string;
  details?: string;
  datetimeText?: string | null;
  recurrence?: string | null;
  requiresConfirmation: boolean;
  assistantReply: string;
};

type ReminderListToolData = {
  summary: string;
  dateRange: string;
};

type ProfileToolData = {
  fields: Record<string, any>;
  summary: string;
};

type MemoryUpdateToolData = {
  fact: string;
  category: MemoryFactCategory;
  confidence: number;
};

type RagSearchToolData = {
  hits: LocalRagSearchResult[];
};

type LocalToolResult =
  | ToolResult<WeatherToolData>
  | ToolResult<ReminderDraftToolData>
  | ToolResult<ReminderListToolData>
  | ToolResult<ProfileToolData>
  | ToolResult<MemoryUpdateToolData>
  | ToolResult<RagSearchToolData>;

type ToolExecutionContext = {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, any>;
  profileSummary: string;
  userProfile?: LocalUserProfile;
  runtimeOptions?: ModelRuntimeTierOptions;
};

type ToolVerificationResult = {
  ok: boolean;
  issues: string[];
  sourceLabels: string[];
  missingData: string[];
  cloudFallbackUsed: boolean;
  language: ReplyLanguage;
};

type LocalModelConfig = {
  version?: number;
  modelDelivery?: ModelDeliveryConfig;
  runtime?: {
    primary: "phone_local" | string;
    mode?: "native_on_device" | "local_adapter" | string;
    backendRole?: "fallback_only" | string;
    backendPolicy?: string;
    openAiPolicy?: "fallback_only" | "disabled" | string;
    localRuntimeInterface?: string;
    nativeRuntime?: string;
    nativeBackend?: string;
    nativeModuleName?: string;
    nativeImplementationStatus?: string;
    adapterRuntime?: string;
    adapterDevelopmentOnly?: boolean;
    adapterContract?: string;
    adapterLocation?:
      | "device_loopback"
      | "external_lan"
      | "emulator_host"
      | string;
    allowDeviceLoopback?: boolean;
  };
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  native?: {
    backend?: string;
    bridgeModuleName?: string;
    modelRoot?: string;
    requiresDevClient?: boolean;
    assetPolicy?: string;
    models?: Record<
      string,
      {
        id: string;
        roles?: string[];
        backend?: string;
        format?: string;
        quantization?: string;
        fileName?: string;
        modelPath: string;
        tokenizerPath?: string;
        configPath?: string;
        contextSize?: number;
        batchSize?: number;
        threads?: number;
        gpuLayers?: number;
        useMmap?: boolean;
        useMetal?: boolean;
        useGpu?: boolean;
        acceleration?: string;
        chatTemplate?: string;
        promptFormat?: string;
        embedding?: boolean;
        description?: string;
      }
    >;
  };
  models: {
    profiler: string;
    orchestratorMedium: string;
    orchestratorLarge: string;
    orchestratorPro?: string;
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
    capabilitiesKeywords?: string[];
    wellbeingKeywords?: string[];
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

type ModelRuntimeTierOptions = {
  modelTier?: ModelTierName;
  deviceInfo?: DeviceCapabilitySnapshot;
  proOptIn?: boolean;
  selectedTier?: ModelTierName;
  installedModelIds?: string[];
  modelsReady?: boolean;
  requestId?: string;
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
  confidence?: number;
  sourceLabels?: string[];
};

type SemanticCacheHitRecord = {
  userId: number;
  sourceQuestion: string;
  matchedQuestion: string;
  similarity: number;
  confidence?: number;
  timestamp: string;
  alignmentReapplied: boolean;
  route: string;
};

type SemanticCacheStore = {
  version: number;
  entries: SemanticCacheEntry[];
  hits: SemanticCacheHitRecord[];
};

type MemoryFactCategory =
  | "identity"
  | "location"
  | "communication_preference"
  | "goal"
  | "schedule_preference"
  | "health_context"
  | "work_or_education"
  | "other";

type MemoryFactStatus = "active" | "stale" | "deleted";

type DurableFactRecord = {
  id: string;
  fact: string;
  confidence: number;
  category: MemoryFactCategory;
  source_turn_id?: string;
  created_at: string;
  last_confirmed_at?: string;
  expires_at?: string | null;
  status: MemoryFactStatus;
  source?: "model" | "heuristic" | "local_tool" | "user" | string;
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
  runtime?: {
    primary: "phone_local" | string;
    mode?: "native_on_device" | "local_adapter" | string;
    backendRole?: "fallback_only" | string;
    openAiPolicy?: "fallback_only" | "disabled" | string;
    backendPolicy?: string;
    localRuntimeInterface?: string;
    nativeRuntime?: string;
    nativeBackend?: string;
    nativeModuleName?: string;
    nativeImplementationStatus?: string;
  };
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

const LOCAL_TASK_MAX_TOKENS = {
  classifier: 128,
  reminderExtraction: 128,
  profiler: 128,
  memorySummary: 192,
  alignment: 192,
  localAnswerLite: 256,
  localAnswerStandard: 256,
  localAnswerPro: 384,
} as const;

function maxTokensForLocalAnswer(
  runtimeOptions: ModelRuntimeTierOptions = {},
) {
  const tier = String(runtimeOptions.selectedTier || runtimeOptions.modelTier || "lite");
  if (tier === "pro") return LOCAL_TASK_MAX_TOKENS.localAnswerPro;
  if (tier === "standard") return LOCAL_TASK_MAX_TOKENS.localAnswerStandard;
  return LOCAL_TASK_MAX_TOKENS.localAnswerLite;
}

const DEFAULT_MODEL_CONFIG: LocalModelConfig = {
  version: 8,
  runtime: {
    primary: "phone_local",
    mode: "native_on_device",
    backendRole: "fallback_only",
    backendPolicy:
      "OpenAI/backend is never primary; call it only after the local orchestrator or local runtime explicitly requests fallback.",
    openAiPolicy: "fallback_only",
    localRuntimeInterface: "LocalModelRuntime",
    nativeRuntime: "NativeOnDeviceModelRuntime",
    nativeBackend: "llama_cpp",
    nativeModuleName: "JaiOnDeviceModel",
    nativeImplementationStatus: "native_build_verified_by_native_verify_llama_llama_cpp_linkable_production_gguf_runtime_target_device_gguf_generation_required",
    adapterRuntime: "OpenAiCompatibleLocalAdapterRuntime",
    adapterDevelopmentOnly: true,
    adapterContract:
      "Development-only /chat/completions and /embeddings adapter contract. Production runtime.mode is native_on_device with downloaded GGUF model files in app-private storage.",
    adapterLocation: "external_lan",
    allowDeviceLoopback: false,
  },
  baseUrl: "",
  apiKey: "",
  timeoutMs: 120000,
  modelDelivery: {
    mode: "download_on_first_launch",
    storageRoot: "document://models",
    wifiRecommended: true,
    maxRetries: 2,
    defaultTier: "lite",
    modelTiers: {
      lite: {
        id: "lite",
        label: "Lite",
        requiredModelIds: [
          "google/gemma-3-4b-it",
          "Qwen/Qwen3-Embedding-0.6B",
        ],
        optionalModelIds: ["Qwen/Qwen3-8B"],
      },
      standard: {
        id: "standard",
        label: "Standard",
        requiredModelIds: ["Qwen/Qwen3-8B", "Qwen/Qwen3-Embedding-0.6B"],
        optionalModelIds: ["google/gemma-3-4b-it"],
        minRamBytes: 8 * 1024 * 1024 * 1024,
        minFreeStorageBytes: 8 * 1024 * 1024 * 1024,
      },
      pro: {
        id: "pro",
        label: "Pro",
        requiredModelIds: ["Qwen/Qwen3-14B", "Qwen/Qwen3-Embedding-0.6B"],
        optionalModelIds: ["Qwen/Qwen3-8B", "google/gemma-3-4b-it"],
        minRamBytes: 16 * 1024 * 1024 * 1024,
        minFreeStorageBytes: 16 * 1024 * 1024 * 1024,
      },
    },
    cdnBaseUrlEnv: "LOCAL_MODEL_CDN_BASE_URL",
    requireIntegrityMetadataInProduction: true,
    models: [
      {
        id: "google/gemma-3-4b-it",
        fileName: "gemma-3-4b-it-q4_k_m.gguf",
        downloadUrl: "cdn://models/gemma-3-4b-it-q4_k_m.gguf",
        downloadUrlEnv: "LOCAL_MODEL_URL_GEMMA_4B",
        downloadPath: "models/gemma-3-4b-it-q4_k_m.gguf",
        expectedBytes: null,
        expectedBytesEnv: "LOCAL_MODEL_BYTES_GEMMA_4B",
        sha256: null,
        sha256Env: "LOCAL_MODEL_SHA256_GEMMA_4B",
        localPath: "models/gemma-3-4b-it-q4_k_m.gguf",
        required: true,
        requiredForTiers: ["lite"],
      },
      {
        id: "Qwen/Qwen3-8B",
        fileName: "qwen3-8b-q4_k_m.gguf",
        downloadUrl: "cdn://models/qwen3-8b-q4_k_m.gguf",
        downloadUrlEnv: "LOCAL_MODEL_URL_QWEN_8B",
        downloadPath: "models/qwen3-8b-q4_k_m.gguf",
        expectedBytes: null,
        expectedBytesEnv: "LOCAL_MODEL_BYTES_QWEN_8B",
        sha256: null,
        sha256Env: "LOCAL_MODEL_SHA256_QWEN_8B",
        localPath: "models/qwen3-8b-q4_k_m.gguf",
        required: false,
        requiredForTiers: ["standard"],
      },
      {
        id: "Qwen/Qwen3-14B",
        fileName: "qwen3-14b-q4_k_m.gguf",
        downloadUrl: "cdn://models/qwen3-14b-q4_k_m.gguf",
        downloadUrlEnv: "LOCAL_MODEL_URL_QWEN_14B",
        downloadPath: "models/qwen3-14b-q4_k_m.gguf",
        expectedBytes: null,
        expectedBytesEnv: "LOCAL_MODEL_BYTES_QWEN_14B",
        sha256: null,
        sha256Env: "LOCAL_MODEL_SHA256_QWEN_14B",
        localPath: "models/qwen3-14b-q4_k_m.gguf",
        required: false,
        requiredForTiers: ["pro"],
      },
      {
        id: "Qwen/Qwen3-Embedding-0.6B",
        fileName: "qwen3-embedding-0.6b-q8_0.gguf",
        downloadUrl: "cdn://models/qwen3-embedding-0.6b-q8_0.gguf",
        downloadUrlEnv: "LOCAL_MODEL_URL_QWEN_EMBED",
        downloadPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
        expectedBytes: null,
        expectedBytesEnv: "LOCAL_MODEL_BYTES_QWEN_EMBED",
        sha256: null,
        sha256Env: "LOCAL_MODEL_SHA256_QWEN_EMBED",
        localPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
        required: true,
        requiredForTiers: ["lite", "standard", "pro"],
      },
    ],
  },
  native: {
    backend: "llama_cpp",
    bridgeModuleName: "JaiOnDeviceModel",
    modelRoot: "document://models",
    requiresDevClient: true,
    assetPolicy:
      "Production downloads quantized GGUF files into app-private storage on first launch/chat. bundled_assets remains an optional development/build-time mode via plugins/withJaiOnDeviceModelAssets.js.",
    models: {
      "google/gemma-3-4b-it": {
        id: "google/gemma-3-4b-it",
        roles: ["profiler", "orchestrator_lite", "memory_summarizer", "alignment"],
        backend: "llama_cpp",
        format: "gguf",
        quantization: "Q4_K_M",
        chatTemplate: "gemma3",
        fileName: "gemma-3-4b-it-q4_k_m.gguf",
        modelPath: "models/gemma-3-4b-it-q4_k_m.gguf",
        contextSize: 4096,
        batchSize: 512,
        threads: 4,
        gpuLayers: 0,
        useMmap: true,
        useMetal: false,
        useGpu: false,
        acceleration: "cpu_only",
        description: "Lite chat, profiler, summarizer, and alignment model; replace modelPath with the actual bundled GGUF asset path.",
      },
      "Qwen/Qwen3-8B": {
        id: "Qwen/Qwen3-8B",
        roles: ["orchestrator_medium", "memory_summarizer"],
        backend: "llama_cpp",
        format: "gguf",
        quantization: "Q4_K_M",
        chatTemplate: "qwen3",
        fileName: "qwen3-8b-q4_k_m.gguf",
        modelPath: "models/qwen3-8b-q4_k_m.gguf",
        contextSize: 8192,
        batchSize: 512,
        threads: 4,
        gpuLayers: 0,
        useMmap: true,
        useMetal: false,
        useGpu: false,
        acceleration: "cpu_only",
        description: "Standard tier orchestrator; replace with the actual quantized Qwen3 8B GGUF file.",
      },
      "Qwen/Qwen3-14B": {
        id: "Qwen/Qwen3-14B",
        roles: ["orchestrator_pro"],
        backend: "llama_cpp",
        format: "gguf",
        quantization: "Q4_K_M",
        chatTemplate: "qwen3",
        fileName: "qwen3-14b-q4_k_m.gguf",
        modelPath: "models/qwen3-14b-q4_k_m.gguf",
        contextSize: 8192,
        batchSize: 512,
        threads: 4,
        gpuLayers: 0,
        useMmap: true,
        useMetal: false,
        useGpu: false,
        acceleration: "cpu_only",
        description: "Pro tier 14B orchestrator for high-RAM devices or explicit opt-in; replace with the actual quantized Qwen3 14B GGUF file.",
      },
      "Qwen/Qwen3-Embedding-0.6B": {
        id: "Qwen/Qwen3-Embedding-0.6B",
        roles: ["memory_embedding"],
        backend: "llama_cpp",
        format: "gguf",
        quantization: "Q8_0",
        promptFormat: "embedding",
        fileName: "qwen3-embedding-0.6b-q8_0.gguf",
        modelPath: "models/qwen3-embedding-0.6b-q8_0.gguf",
        contextSize: 4096,
        batchSize: 512,
        threads: 4,
        gpuLayers: 0,
        useMmap: true,
        useMetal: false,
        useGpu: false,
        acceleration: "cpu_only",
        embedding: true,
        description: "Semantic cache and memory embedding model; native bridge must call llama.cpp embedding mode.",
      },
    },
  },
  models: {
    profiler: "google/gemma-3-4b-it",
    orchestratorMedium: "google/gemma-3-4b-it",
    orchestratorLarge: "Qwen/Qwen3-8B",
    orchestratorPro: "Qwen/Qwen3-14B",
    aligner: "google/gemma-3-4b-it",
    embedding: "Qwen/Qwen3-Embedding-0.6B",
    summarizer: "google/gemma-3-4b-it",
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
    fastGreetingKeywords: [
      "hi",
      "hello",
      "hey",
      "vanakkam",
      "thanks",
      "thank you",
      "good morning",
      "good evening",
      "good night",
      "okay thanks",
      "cool thanks",
    ],
    smallTalkKeywords: [
      "what are you up to",
      "what are you doing",
      "what's up",
      "whats up",
      "how are you",
      "how is it going",
      "are you there",
      "can you hear me",
      "are you awake",
      "nice to meet you",
    ],
    capabilitiesKeywords: [
      "what can you do",
      "how can you help",
      "help me",
      "your features",
      "what are your features",
    ],
    wellbeingKeywords: [
      "tired",
      "so tired",
      "exhausted",
      "sleepy",
      "drained",
      "stressed",
      "not feeling good",
    ],
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
    "You are the Orchestrator Agent. Route the request local-first and return JSON only with: route, reason, confidence, needs_clarification, clarification_question, needs_live_data, selected_model, fallback_allowed. Set selected_model to the selected_model value provided in the input.",
  reminderExtractorSystem:
    "Extract reminder title, details, datetime_text, and assistant_reply as JSON.",
  alignmentSystem:
    "Rewrite the factual draft to match the user's tone and language without changing facts or adding claims. Return JSON with english_answer and final_answer.",
  memorySyncSystem:
    "You are the local Memory & Cache Agent. Use only the provided recent conversation, route logs, profiler state, and alignment captures. Extract durable user facts conservatively. Ignore transient facts unless the user explicitly marks them important. Use categories only from identity, location, communication_preference, goal, schedule_preference, health_context, work_or_education, other. Store health_context only when the user explicitly gives health context. Return JSON only with: summary, durable_facts[{fact, confidence, category, important, evidence, profile_updates}], profile_updates.",
  localReasonerSystem: `Use only local context. Reply ${OPENAI_FALLBACK_SIGNAL} if live public data is required.`,
};

const DEFAULT_AGENT_REGISTRY: AgentRegistryConfig = {
  version: 4,
  runtime: {
    primary: "phone_local",
    mode: "native_on_device",
    nativeRuntime: "NativeOnDeviceModelRuntime",
    nativeBackend: "llama_cpp",
    nativeModuleName: "JaiOnDeviceModel",
    nativeImplementationStatus: "native_build_verified_by_native_verify_llama_llama_cpp_linkable_production_gguf_runtime_target_device_gguf_generation_required",
    backendRole: "fallback_only",
    openAiPolicy: "fallback_only",
    backendPolicy: "OpenAI/backend is fallback-only and cannot be the default runtime.",
    localRuntimeInterface: "LocalModelRuntime",
  },
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
  version: 6,
  runtime: {
    primary: "phone_local",
    mode: "native_on_device",
    backendRole: "fallback_only",
    backendPolicy: "fallback_only",
    openAiPolicy: "fallback_only",
    localRuntimeInterface: "LocalModelRuntime",
    nativeRuntime: "NativeOnDeviceModelRuntime",
    nativeImplementationStatus: "native_build_verified_by_native_verify_llama_llama_cpp_linkable_production_gguf_runtime_target_device_gguf_generation_required",
    nativeBackend: "llama_cpp",
    nativeModuleName: "JaiOnDeviceModel",
    adapterRuntime: "OpenAiCompatibleLocalAdapterRuntime",
    adapterDevelopmentOnly: true,
    allowDeviceLoopback: false,
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

function parseBooleanConfig(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
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

function escapeRegExp(text: string) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export async function flushLocalLearningJobsForTests() {
  if (
    String((globalThis as any)?.process?.env?.NODE_ENV || "").toLowerCase() !==
    "test"
  ) {
    throw new Error("flushLocalLearningJobsForTests is available only in tests.");
  }

  await __idleQueueTestUtils.flush();
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

function normalizeEmbeddingVector(
  embedding: unknown,
  fallbackText: string,
  opts?: { allowHashFallback?: boolean; source?: string },
) {
  const values = Array.isArray(embedding)
    ? embedding.map(Number).filter(Number.isFinite)
    : [];
  if (values.length === EMBEDDING_DIMS) return values;
  if (opts?.allowHashFallback === false) {
    throw new Error(
      `${opts.source || "Embedding runtime"} returned ${values.length || 0} dimensions; expected ${EMBEDDING_DIMS}. Refusing hash embedding fallback in runtime.mode=native_on_device.`,
    );
  }
  return hashEmbedding(fallbackText);
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
  return scheduledTasksPath(userId);
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
const LOCAL_MEMORY_CONSOLIDATION_ATTEMPT_COOLDOWN_MINUTES = Math.max(
  60,
  positiveInt(DEFAULT_MEMORY_RULES.summarization?.minMinutesBetweenSync, 15),
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
    modelDelivery: {
      ...(DEFAULT_MODEL_CONFIG.modelDelivery || {}),
      ...(fileConfig.modelDelivery || {}),
      mode: String(
        extra.LOCAL_MODEL_DELIVERY_MODE ||
          fileConfig.modelDelivery?.mode ||
          DEFAULT_MODEL_CONFIG.modelDelivery?.mode ||
          "download_on_first_launch",
      ),
    },
    timeoutMs: Number(
      extra.LOCAL_MODEL_TIMEOUT_MS ||
        fileConfig.timeoutMs ||
        DEFAULT_MODEL_CONFIG.timeoutMs,
    ),
    runtime: {
      ...DEFAULT_MODEL_CONFIG.runtime,
      ...(fileConfig.runtime || {}),
      primary: "phone_local",
      mode: String(
        extra.LOCAL_MODEL_RUNTIME_MODE ||
          fileConfig.runtime?.mode ||
          DEFAULT_MODEL_CONFIG.runtime?.mode ||
          "native_on_device",
      ),
      backendRole: "fallback_only",
      openAiPolicy: String(
        extra.LOCAL_MODEL_OPENAI_POLICY ||
          fileConfig.runtime?.openAiPolicy ||
          DEFAULT_MODEL_CONFIG.runtime?.openAiPolicy ||
          "fallback_only",
      ),
      nativeBackend: String(
        extra.LOCAL_ON_DEVICE_BACKEND ||
          fileConfig.runtime?.nativeBackend ||
          DEFAULT_MODEL_CONFIG.runtime?.nativeBackend ||
          "llama_cpp",
      ),
      nativeModuleName: String(
        extra.LOCAL_ON_DEVICE_NATIVE_MODULE ||
          fileConfig.runtime?.nativeModuleName ||
          DEFAULT_MODEL_CONFIG.runtime?.nativeModuleName ||
          "JaiOnDeviceModel",
      ),
      adapterLocation: String(
        extra.LOCAL_MODEL_ADAPTER_LOCATION ||
          fileConfig.runtime?.adapterLocation ||
          DEFAULT_MODEL_CONFIG.runtime?.adapterLocation ||
          "external_lan",
      ),
      allowDeviceLoopback: parseBooleanConfig(
        extra.LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK,
        Boolean(
          fileConfig.runtime?.allowDeviceLoopback ??
            DEFAULT_MODEL_CONFIG.runtime?.allowDeviceLoopback,
        ),
      ),
    },
    native: {
      ...DEFAULT_MODEL_CONFIG.native,
      ...(fileConfig.native || {}),
      backend: String(
        extra.LOCAL_ON_DEVICE_BACKEND ||
          fileConfig.native?.backend ||
          DEFAULT_MODEL_CONFIG.native?.backend ||
          "llama_cpp",
      ),
      bridgeModuleName: String(
        extra.LOCAL_ON_DEVICE_NATIVE_MODULE ||
          fileConfig.native?.bridgeModuleName ||
          DEFAULT_MODEL_CONFIG.native?.bridgeModuleName ||
          "JaiOnDeviceModel",
      ),
      modelRoot: String(
        extra.LOCAL_ON_DEVICE_MODEL_ROOT ||
          fileConfig.native?.modelRoot ||
          DEFAULT_MODEL_CONFIG.native?.modelRoot ||
          "asset://models",
      ),
      models: {
        ...(DEFAULT_MODEL_CONFIG.native?.models || {}),
        ...(fileConfig.native?.models || {}),
      },
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
        extra.LOCAL_MODEL_GEMMA_4B ||
          fileConfig.models?.orchestratorMedium ||
          DEFAULT_MODEL_CONFIG.models.orchestratorMedium,
      ),
      orchestratorLarge: String(
        extra.LOCAL_MODEL_QWEN_8B ||
          fileConfig.models?.orchestratorLarge ||
          DEFAULT_MODEL_CONFIG.models.orchestratorLarge,
      ),
      orchestratorPro: String(
        extra.LOCAL_MODEL_QWEN_14B ||
          fileConfig.models?.orchestratorPro ||
          DEFAULT_MODEL_CONFIG.models.orchestratorPro,
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
        extra.LOCAL_MODEL_GEMMA_4B ||
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
  const rows = await readJson<any[]>(durableFactsPath(userId), []);
  return rows
    .map(normalizeDurableFact)
    .filter(Boolean) as DurableFactRecord[];
}

async function saveDurableFacts(userId: number, rows: DurableFactRecord[]) {
  await writeJson(
    durableFactsPath(userId),
    rows
      .map(normalizeDurableFact)
      .filter(Boolean) as DurableFactRecord[],
  );
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
  runtimeOptions: ModelRuntimeTierOptions = {},
  maxTokens: number = LOCAL_TASK_MAX_TOKENS.localAnswerLite,
) {
  const cfg = await getModelConfig();
  if (
    isNativeOnDeviceModelConfig(cfg) &&
    getModelDeliveryMode(cfg) === "download_on_first_launch" &&
    runtimeOptions.modelsReady === false
  ) {
    throw new NativeOnDeviceRuntimeUnavailableError(
      "Required local model files are not ready. Normal chat must not start model downloads.",
    );
  }
  if (isNativeOnDeviceModelConfig(cfg)) {
    const safety = canUseNativeGeneralChatSafely({
      mode: cfg.runtime?.mode,
      nativeModuleName:
        cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName,
      modelsReady: runtimeOptions.modelsReady,
    });
    if (!safety.safe) {
      throw new NativeOnDeviceRuntimeUnavailableError(
        `Native on-device chat is not verified safe for general inference: ${safety.reason}.`,
      );
    }
  }
  const runtime = createLocalModelRuntime({
    primary: cfg.runtime?.primary,
    mode: cfg.runtime?.mode,
    backendRole: cfg.runtime?.backendRole,
    openAiPolicy: cfg.runtime?.openAiPolicy,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    allowDeviceLoopback: cfg.runtime?.allowDeviceLoopback,
    adapterLocation: cfg.runtime?.adapterLocation,
    nativeBackend: cfg.native?.backend || cfg.runtime?.nativeBackend,
    nativeModuleName: cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName,
    modelRoot: cfg.native?.modelRoot,
    modelAssets: cfg.native?.models,
    modelDeliveryMode: getModelDeliveryMode(cfg),
    modelDelivery: cfg.modelDelivery,
    modelTier: runtimeOptions.selectedTier || runtimeOptions.modelTier,
    deviceInfo: runtimeOptions.deviceInfo,
    proOptIn: runtimeOptions.proOptIn,
  });
  return runtime.completeChat({
    model,
    temperature,
    maxTokens,
    requestId: runtimeOptions.requestId,
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
  runtimeOptions: ModelRuntimeTierOptions = {},
  maxTokens: number = LOCAL_TASK_MAX_TOKENS.classifier,
) {
  const json = await localChatRaw(systemPrompt, userPrompt, model, temperature, runtimeOptions, maxTokens);
  return parseJsonLoose<any>(extractCompletionText(json), {});
}

async function localChatText(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature = 0.2,
  runtimeOptions: ModelRuntimeTierOptions = {},
  maxTokens: number = LOCAL_TASK_MAX_TOKENS.localAnswerLite,
) {
  const json = await localChatRaw(systemPrompt, userPrompt, model, temperature, runtimeOptions, maxTokens);
  return extractCompletionText(json);
}

function isNativeOnDeviceModelConfig(cfg: LocalModelConfig) {
  return String(cfg.runtime?.mode || "native_on_device") === "native_on_device";
}

async function embedTexts(
  texts: string[],
  runtimeOptions: ModelRuntimeTierOptions = {},
) {
  const cfg = await getModelConfig();
  const baseUrl = normalizeLocalModelBaseUrl(cfg.baseUrl);
  const nativeMode = isNativeOnDeviceModelConfig(cfg);
  if (
    nativeMode &&
    getModelDeliveryMode(cfg) === "download_on_first_launch" &&
    runtimeOptions.modelsReady === false
  ) {
    throw new NativeOnDeviceRuntimeUnavailableError(
      "Required local embedding model files are not ready. Normal chat must not start model downloads.",
    );
  }
  if (nativeMode) {
    const safety = canUseNativeEmbeddingsSafely({
      mode: cfg.runtime?.mode,
      nativeModuleName:
        cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName,
      modelsReady: runtimeOptions.modelsReady,
    });
    if (!safety.safe) {
      throw new NativeOnDeviceRuntimeUnavailableError(
        `Native on-device embeddings are not verified safe: ${safety.reason}.`,
      );
    }
  }

  try {
    const runtime = createLocalModelRuntime({
      primary: cfg.runtime?.primary,
      mode: cfg.runtime?.mode,
      backendRole: cfg.runtime?.backendRole,
      openAiPolicy: cfg.runtime?.openAiPolicy,
      baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      allowDeviceLoopback: cfg.runtime?.allowDeviceLoopback,
      adapterLocation: cfg.runtime?.adapterLocation,
      nativeBackend: cfg.native?.backend || cfg.runtime?.nativeBackend,
      nativeModuleName: cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName,
      modelRoot: cfg.native?.modelRoot,
      modelAssets: cfg.native?.models,
      modelDeliveryMode: getModelDeliveryMode(cfg),
      modelDelivery: cfg.modelDelivery,
      modelTier: runtimeOptions.selectedTier || runtimeOptions.modelTier,
      deviceInfo: runtimeOptions.deviceInfo,
      proOptIn: runtimeOptions.proOptIn,
    });
    if (!runtime.isConfigured()) {
      if (nativeMode) {
        throw new Error(
          "Native Qwen embedding runtime is not configured. runtime.mode=native_on_device requires the JaiOnDeviceModel bridge and downloaded Qwen/Qwen3-Embedding-0.6B GGUF file; hash embeddings are disabled in production native mode.",
        );
      }
      return texts.map((text) => hashEmbedding(text));
    }
    const vectors = await runtime.embedTexts({
      model: cfg.models.embedding,
      texts,
      requestId: runtimeOptions.requestId,
    });
    return vectors.map((embedding, index) =>
      normalizeEmbeddingVector(embedding, texts[index] || "", {
        allowHashFallback: !nativeMode,
        source: cfg.models.embedding,
      }),
    );
  } catch (error) {
    if (nativeMode) {
      throw error;
    }
    return texts.map((text) => hashEmbedding(text));
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

const ACTIVE_MEMORY_STATUSES: MemoryFactStatus[] = ["active"];

function normalizeMemoryCategory(
  category: unknown,
  fact?: string,
): MemoryFactCategory {
  const normalizedCategory = normalizeText(String(category || ""));
  const normalizedFact = normalizeText(fact || "");
  if (
    normalizedCategory === "identity" ||
    /\b(name:|my name|identity|who i am)\b/.test(normalizedFact)
  ) {
    return "identity";
  }
  if (
    normalizedCategory === "location" ||
    /\b(location|place|live in|moved to|from|city|hometown)\b/.test(
      normalizedFact,
    )
  ) {
    return "location";
  }
  if (
    [
      "communication_preference",
      "preference",
      "language",
      "style",
    ].includes(normalizedCategory) ||
    /\b(language|reply|respond|tone|english|tamil|hindi|telugu|malayalam)\b/.test(
      normalizedFact,
    )
  ) {
    return "communication_preference";
  }
  if (normalizedCategory === "goal" || /\b(goal|focus|priority)\b/.test(normalizedFact)) {
    return "goal";
  }
  if (
    normalizedCategory === "schedule_preference" ||
    /\b(schedule|wake|sleep|morning|evening|routine|meeting)\b/.test(
      normalizedFact,
    )
  ) {
    return "schedule_preference";
  }
  if (
    normalizedCategory === "health_context" ||
    /\b(health|diabetes|blood pressure|allergy|allergic|pregnant|medicine|medication|asthma|thyroid|kidney|symptom|diagnosed)\b/.test(
      normalizedFact,
    )
  ) {
    return "health_context";
  }
  if (
    ["work_or_education", "occupation", "work", "education"].includes(
      normalizedCategory,
    ) ||
    /\b(work|job|occupation|student|school|college|engineer|developer|teacher)\b/.test(
      normalizedFact,
    )
  ) {
    return "work_or_education";
  }
  return "other";
}

function normalizeMemoryStatus(status: unknown): MemoryFactStatus {
  const normalized = normalizeText(String(status || ""));
  return ["active", "stale", "deleted"].includes(normalized)
    ? (normalized as MemoryFactStatus)
    : "active";
}

function createMemoryFactId(category: MemoryFactCategory, fact: string) {
  return `mem_${category}_${simpleHash(normalizeText(fact))}`;
}

function normalizeDurableFact(row: any): DurableFactRecord | null {
  const fact = String(row?.fact || "").trim();
  if (!fact) return null;
  const category = normalizeMemoryCategory(row?.category, fact);
  const createdAt = String(
    row?.created_at || row?.firstSeenAt || row?.createdAt || nowIso(),
  );
  const lastConfirmedAt = String(
    row?.last_confirmed_at || row?.lastSeenAt || row?.updatedAt || createdAt,
  );
  return {
    id: String(row?.id || createMemoryFactId(category, fact)),
    fact,
    category,
    source_turn_id: row?.source_turn_id
      ? String(row.source_turn_id)
      : Array.isArray(row?.evidence) && row.evidence[0]
        ? String(row.evidence[0])
        : undefined,
    confidence: clampConfidence(row?.confidence, 0.78),
    created_at: createdAt,
    last_confirmed_at: lastConfirmedAt,
    expires_at:
      row?.expires_at === undefined ? null : (row.expires_at as string | null),
    status: normalizeMemoryStatus(row?.status),
    source: row?.source ? String(row.source) : "heuristic",
    firstSeenAt: createdAt,
    lastSeenAt: lastConfirmedAt,
    evidence: trimList(row?.evidence).slice(-8),
    important: Boolean(row?.important),
    profileUpdates:
      row?.profileUpdates && typeof row.profileUpdates === "object"
        ? row.profileUpdates
        : row?.profile_updates && typeof row.profile_updates === "object"
          ? row.profile_updates
          : {},
  };
}

function createDurableFactRecord(opts: {
  fact: string;
  confidence: number;
  category?: string;
  source?: DurableFactRecord["source"];
  sourceTurnId?: string;
  evidence?: string[];
  important?: boolean;
  profileUpdates?: Record<string, any>;
  createdAt?: string;
}): DurableFactRecord | null {
  const fact = String(opts.fact || "").trim();
  if (!fact) return null;
  const category = normalizeMemoryCategory(opts.category, fact);
  const createdAt = opts.createdAt || nowIso();
  return normalizeDurableFact({
    id: createMemoryFactId(category, fact),
    fact,
    category,
    confidence: opts.confidence,
    source: opts.source || "heuristic",
    source_turn_id: opts.sourceTurnId,
    created_at: createdAt,
    last_confirmed_at: createdAt,
    expires_at: null,
    status: "active",
    evidence: opts.evidence || (opts.sourceTurnId ? [opts.sourceTurnId] : []),
    important: opts.important,
    profileUpdates: opts.profileUpdates || {},
  });
}

function isActiveMemoryFact(row: DurableFactRecord, at = Date.now()) {
  if (!ACTIVE_MEMORY_STATUSES.includes(row.status)) return false;
  if (!row.expires_at) return true;
  const expiresAt = new Date(row.expires_at).getTime();
  return Number.isFinite(expiresAt) ? expiresAt > at : true;
}

function activeDurableFacts(rows: DurableFactRecord[]) {
  return rows.filter((row) => isActiveMemoryFact(row));
}

function isHealthRelatedMemoryQuery(message: string) {
  const normalized = normalizeText(message);
  return /\b(health|medical|doctor|medicine|medication|symptom|diagnosis|treatment|allergy|allergic|pregnan|diabetes|blood pressure|asthma|thyroid|kidney|diet|food|exercise|workout)\b/.test(
    normalized,
  );
}

function relevantDurableFactsForMessage(
  facts: DurableFactRecord[],
  message: string,
) {
  const healthRelevant = isHealthRelatedMemoryQuery(message);
  return activeDurableFacts(facts).filter(
    (row) => row.category !== "health_context" || healthRelevant,
  );
}

function contradictionKey(row: DurableFactRecord) {
  const normalized = normalizeText(row.fact);
  if (row.category === "location") return "location:current";
  if (
    row.category === "communication_preference" &&
    /\b(language|reply|respond|english|tamil|hindi|telugu|malayalam)\b/.test(
      normalized,
    )
  ) {
    return "communication_preference:language";
  }
  if (row.category === "identity" && /\b(name)\b/.test(normalized)) {
    return "identity:name";
  }
  return "";
}

function mergeDurableFacts(
  existing: DurableFactRecord[],
  additions: DurableFactRecord[],
) {
  const byFact = new Map<string, DurableFactRecord>();
  const normalizedExisting = existing
    .map(normalizeDurableFact)
    .filter(Boolean) as DurableFactRecord[];
  for (const row of normalizedExisting) {
    byFact.set(normalizeText(row.fact), row);
  }
  for (const row of additions) {
    const normalizedRow = normalizeDurableFact(row);
    if (!normalizedRow) continue;
    const key = normalizeText(normalizedRow.fact);
    if (!key) continue;
    const current = byFact.get(key);
    if (!current) {
      const nextContradictionKey = contradictionKey(normalizedRow);
      if (nextContradictionKey) {
        for (const [existingKey, existingRow] of Array.from(byFact.entries())) {
          if (
            existingRow.status === "active" &&
            contradictionKey(existingRow) === nextContradictionKey &&
            normalizeText(existingRow.fact) !== key
          ) {
            byFact.set(existingKey, {
              ...existingRow,
              status: "stale",
              lastSeenAt: normalizedRow.lastSeenAt,
              last_confirmed_at:
                existingRow.last_confirmed_at || existingRow.lastSeenAt,
            });
          }
        }
      }
      byFact.set(key, normalizedRow);
      continue;
    }
    byFact.set(key, {
      ...current,
      id: current.id || normalizedRow.id,
      status: current.status === "deleted" ? "deleted" : "active",
      confidence: Math.max(current.confidence, normalizedRow.confidence),
      lastSeenAt: normalizedRow.lastSeenAt,
      last_confirmed_at: normalizedRow.last_confirmed_at,
      important: current.important || normalizedRow.important,
      evidence: uniq([
        ...(current.evidence || []),
        ...(normalizedRow.evidence || []),
      ]).slice(-6),
      source_turn_id: normalizedRow.source_turn_id || current.source_turn_id,
      profileUpdates: {
        ...(current.profileUpdates || {}),
        ...(normalizedRow.profileUpdates || {}),
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
  const activeFacts = activeDurableFacts(facts);
  if (activeFacts.length) {
    return `Durable user facts: ${activeFacts.map((row) => row.fact).join("; ")}.`;
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
    category: MemoryFactCategory;
    important: boolean;
    evidence: string[];
    sourceTurnId?: string;
  }> = [];

  const extract = (
    fact: string,
    confidence: number,
    category: string,
    evidence: string,
    important = false,
    sourceTurnId?: string,
  ) => {
    const clean = String(fact || "").trim();
    if (!clean || isTransientFact(clean, rules)) return;
    candidates.push({
      fact: clean,
      confidence,
      category: normalizeMemoryCategory(category, clean),
      important,
      evidence: [evidence],
      sourceTurnId,
    });
  };

  for (const row of userTurns) {
    const content = row.content.trim();
    const sourceTurnId = row.createdAt || simpleHash(content);
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
        /\b(?:i live in|i am living in|my location is|my city is|my place is) ([^.!,\n]+)/i,
        (match) => [`Location: ${match[1].trim()}`, "location", 0.94],
      ],
      [
        /\b(?:i moved to|i have moved to|we moved to) ([^.!,\n]+)/i,
        (match) => [`Location: ${match[1].trim()}`, "location", 0.96],
      ],
      [
        /\bi am(?: a| an)? ([^.!,\n]+)/i,
        (match) => [`Identity: ${match[1].trim()}`, "identity", 0.82],
      ],
      [
        /\bi work as(?: a| an)? ([^.!,\n]+)/i,
        (match) => [`Occupation: ${match[1].trim()}`, "work_or_education", 0.92],
      ],
      [
        /\bi (?:study|am studying) ([^.!,\n]+)/i,
        (match) => [`Education: ${match[1].trim()}`, "work_or_education", 0.88],
      ],
      [
        /\bi (?:prefer|want) (?:you to )?(?:reply|respond|speak) (?:in )?([^.!,\n]+)/i,
        (match) => [
          `Preferred language: ${match[1].trim()}`,
          "communication_preference",
          0.9,
        ],
      ],
      [
        /\bi prefer (english|tamil|hindi|telugu|malayalam)(?:\s+(?:replies|responses|answers))?\b/i,
        (match) => [
          `Preferred language: ${match[1].trim()}`,
          "communication_preference",
          0.9,
        ],
      ],
      [
        /\bi (?:prefer|want) ([^.!,\n]+)/i,
        (match) => [`Preference: ${match[1].trim()}`, "communication_preference", 0.85],
      ],
      [
        /\bi (?:like|love|enjoy) ([^.!,\n]+)/i,
        (match) => [`Likes: ${match[1].trim()}`, "other", 0.83],
      ],
      [
        /\bi (?:speak|use) ([^.!,\n]+)/i,
        (match) => [`Languages: ${match[1].trim()}`, "communication_preference", 0.84],
      ],
      [
        /\bmy goal is ([^.!,\n]+)/i,
        (match) => [`Goal: ${match[1].trim()}`, "goal", 0.88],
      ],
      [
        /\bi usually (?:wake up|sleep|work|study) ([^.!,\n]+)/i,
        (match) => [`Schedule preference: ${match[1].trim()}`, "schedule_preference", 0.82],
      ],
      [
        /\bi (?:have|am diagnosed with|am allergic to|take medicine for) ([^.!,\n]*(?:diabetes|blood pressure|allergy|allergic|asthma|thyroid|kidney|pregnan|medicine|medication|symptom)[^.!,\n]*)/i,
        (match) => [`Health context: ${match[1].trim()}`, "health_context", 0.9],
      ],
    ];

    for (const [regex, build] of namedPatterns) {
      const match = regex.exec(content);
      if (!match) continue;
      const [fact, category, confidence] = build(match);
      const normalizedFact = normalizeText(fact);
      if (
        normalizedFact.startsWith("preference") &&
        /\b(english|tamil|hindi|telugu|malayalam|replies|responses|answers)\b/.test(
          normalizedFact,
        ) &&
        candidates.some(
          (candidate) =>
            candidate.category === "communication_preference" &&
            normalizeText(candidate.fact).startsWith("preferred language"),
        )
      ) {
        continue;
      }
      extract(fact, confidence, category, content, important, sourceTurnId);
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
    .map((row) =>
      createDurableFactRecord({
        fact: row.fact,
        confidence: row.confidence,
        category: row.category,
        source: "heuristic",
        sourceTurnId: row.sourceTurnId,
        evidence: row.evidence,
        important: row.important,
        profileUpdates,
      }),
    )
    .filter(Boolean) as DurableFactRecord[];
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

function ragMetadataValue(metadata: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function ragFreshnessDate(row: LocalRagChunk) {
  const metadata = row.metadata || {};
  return (
    ragMetadataValue(metadata, [
      "freshness_date",
      "freshnessDate",
      "date",
      "updated_at",
      "updatedAt",
      "created_at",
      "createdAt",
    ]) || row.updatedAt
  );
}

function ragSourceMetadata(
  row: LocalRagChunk,
  score: number,
): LocalRagSourceMetadata {
  const metadata = row.metadata || {};
  const path = ragMetadataValue(metadata, [
    "path",
    "file_path",
    "filePath",
    "filepath",
    "uri",
  ]);
  const file = ragMetadataValue(metadata, ["file", "fileName", "filename"]);
  const sourceName =
    ragMetadataValue(metadata, [
      "source_name",
      "sourceName",
      "title",
      "name",
      "label",
    ]) ||
    file ||
    path ||
    row.sourceId ||
    row.sourceType;
  return {
    source_name: sourceName,
    chunk_id: row.id,
    ...(file ? { file } : {}),
    ...(path ? { path } : {}),
    category:
      ragMetadataValue(metadata, ["category", "kind", "topic"]) ||
      row.sourceType,
    freshness_date: ragFreshnessDate(row),
    confidence: clampConfidence(score, 0),
    relevance_score: score,
  };
}

function isTimeSensitiveRagQuery(query: string) {
  const normalized = normalizeText(query);
  return /\b(today|tomorrow|tonight|current|currently|latest|now|news|weather|forecast|rain|temperature|score|price|stock|exchange rate|live)\b/.test(
    normalized,
  );
}

function isStaleRagChunk(row: LocalRagChunk, nowMs = Date.now()) {
  const metadata = row.metadata || {};
  const status = normalizeText(String(metadata.status || ""));
  if (status === "stale" || status === "deleted") return true;
  if (metadata.stale === true) return true;
  const expiresAt = ragMetadataValue(metadata, [
    "expires_at",
    "expiresAt",
    "valid_until",
    "validUntil",
  ]);
  if (expiresAt) {
    const parsed = new Date(expiresAt).getTime();
    if (Number.isFinite(parsed) && parsed <= nowMs) return true;
  }
  return false;
}

function freshnessRank(row: LocalRagChunk, nowMs = Date.now()) {
  const parsed = new Date(ragFreshnessDate(row)).getTime();
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, (nowMs - parsed) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function decorateRagResult(
  row: LocalRagChunk,
  score: number,
): LocalRagSearchResult {
  const sourceMetadata = ragSourceMetadata(row, score);
  return {
    ...row,
    score,
    confidence: sourceMetadata.confidence,
    source_name: sourceMetadata.source_name,
    chunk_id: sourceMetadata.chunk_id,
    ...(sourceMetadata.file ? { file: sourceMetadata.file } : {}),
    ...(sourceMetadata.path ? { path: sourceMetadata.path } : {}),
    ...(sourceMetadata.category ? { category: sourceMetadata.category } : {}),
    ...(sourceMetadata.freshness_date
      ? { freshness_date: sourceMetadata.freshness_date }
      : {}),
    sourceMetadata,
  };
}

export async function searchLocalRag(
  userId: number,
  query: string,
  limit = 6,
  runtimeOptions: ModelRuntimeTierOptions = {},
) {
  await ensureLocalAgentData();
  const clean = String(query || "").trim();
  if (!clean) return [] as LocalRagSearchResult[];
  const rows = await loadRagChunks(userId);
  if (!rows.length) return [] as LocalRagSearchResult[];
  const [queryVec] = await embedTexts([clean], runtimeOptions);
  const timeSensitive = isTimeSensitiveRagQuery(clean);
  const nowMs = Date.now();
  return rows
    .filter((row) => !timeSensitive || !isStaleRagChunk(row, nowMs))
    .map((row) => ({
      row,
      score: cosine(
        queryVec,
        normalizeStoredEmbedding(row.embedding, row.text),
      ),
    }))
    .filter(({ score }) => score >= 0.2)
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (Math.abs(scoreDelta) > 0.03) return scoreDelta;
      return freshnessRank(b.row, nowMs) - freshnessRank(a.row, nowMs);
    })
    .slice(0, Math.max(1, limit))
    .map(({ row, score }) => decorateRagResult(row, score));
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
      .some((phrase) => {
        if (!phrase) return false;
        if (/^[a-z0-9]+$/.test(phrase) && phrase.length <= 2) {
          return new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(
            normalizedMessage,
          );
        }
        return normalizedMessage.includes(phrase);
      }),
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
    if (nonEmptyAnswer(answers[slot.id])) continue;
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

  if (!Object.keys(updates).length && state.status === "active") {
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
      {},
      LOCAL_TASK_MAX_TOKENS.profiler,
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
  selectedReasonerModel,
};

export const __memoryTestUtils = {
  isTransientFact,
  heuristicMemoryCandidates,
  buildDurableFactsFromHeuristics,
  mergeDurableFacts,
  shouldApplyProfileUpdate,
  shouldSkipVectorSemanticCache,
  lookupSemanticCache,
  writeSemanticCache,
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
      {},
      LOCAL_TASK_MAX_TOKENS.alignment,
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
      {},
      LOCAL_TASK_MAX_TOKENS.profiler,
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
      {},
      LOCAL_TASK_MAX_TOKENS.reminderExtraction,
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

function toolOk<T>(
  tool: LocalToolName,
  data: T,
  opts?: { source?: string; confidence?: number },
): ToolResult<T> {
  return {
    ok: true,
    tool,
    data,
    source: opts?.source,
    timestamp: nowIso(),
    confidence: opts?.confidence,
  };
}

function toolFail<T>(
  tool: LocalToolName,
  error: string,
  opts?: { source?: string; confidence?: number; data?: T },
): ToolResult<T> {
  return {
    ok: false,
    tool,
    ...(opts?.data ? { data: opts.data } : {}),
    error,
    source: opts?.source,
    timestamp: nowIso(),
    confidence: opts?.confidence ?? 0,
  };
}

function inferDateRange(message: string) {
  const normalized = normalizeText(message);
  if (normalized.includes("tomorrow")) return "tomorrow";
  if (normalized.includes("today")) return "today";
  if (/\b(this week|week|next week)\b/.test(normalized)) return "this_week";
  return "upcoming";
}

function isWeatherToolIntent(normalized: string) {
  return /\b(weather|temperature|rain|forecast|climate|humid|wind)\b/.test(
    normalized,
  );
}

function isReminderCreateToolIntent(normalized: string) {
  return /\b(remind me|set a reminder|add reminder|do not let me forget|don t let me forget|create a task)\b/.test(
    normalized,
  );
}

function isReminderListToolIntent(normalized: string) {
  if (isReminderCreateToolIntent(normalized)) return false;
  return /\b(reminders?|tasks?|schedule|agenda|calendar|today plan|tomorrow plan|plan my day|what do i have|this week|upcoming)\b/.test(
    normalized,
  );
}

function isProfileToolIntent(normalized: string) {
  return /\b(my name|who am i|my hobbies|what do i like|my goal|my language|my job|my work|my profile|saved profile|what do you know about me|job applications?|resume|career)\b/.test(
    normalized,
  );
}

function isMemoryUpdateToolIntent(normalized: string) {
  return /\b(remember that|remember this|save this|note that|keep in mind)\b/.test(
    normalized,
  );
}

function isRagToolIntent(normalized: string) {
  return /\b(local knowledge|knowledge base|rag|saved notes?|documents?|docs|what do we know)\b/.test(
    normalized,
  );
}

function isComplexToolPrompt(normalized: string) {
  return /\b(plan my day|prepare for job applications?|job applications?|summarize what i need to do|what i need to do this week|based on weather and reminders|based on reminders and weather|this week)\b/.test(
    normalized,
  );
}

function inferProfileFields(message: string) {
  const normalized = normalizeText(message);
  if (/\b(name|who am i)\b/.test(normalized)) return ["name"];
  if (/\b(hobbies|like|interests|enjoy)\b/.test(normalized)) return ["hobbies"];
  if (/\b(language|speak)\b/.test(normalized)) {
    return ["preferred_language", "secondary_language", "replyLanguage"];
  }
  if (/\b(job|work|career|application|resume)\b/.test(normalized)) {
    return ["occupation", "industry_or_field", "main_goal", "skills"];
  }
  if (/\b(goal|focus|priority)\b/.test(normalized)) return ["main_goal"];
  return [];
}

function extractMemoryFact(message: string) {
  const raw = String(message || "").trim();
  const match = raw.match(
    /\b(?:remember that|remember this|save this|note that|keep in mind)\b[:,\s-]*(.+)$/i,
  );
  return String(match?.[1] || raw).trim();
}

function planLocalTools(opts: {
  message: string;
  decision: OrchestratorDecision;
}): ToolPlan {
  const normalized = normalizeText(opts.message);
  const complex = isComplexToolPrompt(normalized);
  const steps: ToolPlanStep[] = [];
  const addStep = (
    tool: LocalToolName,
    args: Record<string, any>,
    reason: string,
  ) => {
    if (!steps.some((step) => step.tool === tool)) {
      steps.push({ tool, args, reason });
    }
  };

  if (isMemoryUpdateToolIntent(normalized)) {
    addStep(
      "updateMemory",
      {
        fact: extractMemoryFact(opts.message),
        category: "user_note",
        confidence: 0.82,
      },
      "user_asked_to_store_memory",
    );
  }

  if (
    opts.decision.route === "weather" ||
    isWeatherToolIntent(normalized) ||
    (complex && /\bweather|forecast|rain\b/.test(normalized))
  ) {
    addStep(
      "getWeather",
      {
        location: weatherLocationFromMessage(opts.message),
        date: inferDateRange(opts.message),
      },
      "weather_intent",
    );
  }

  if (isReminderCreateToolIntent(normalized)) {
    addStep(
      "createReminder",
      { recurrence: null },
      "reminder_creation_intent",
    );
  } else if (
    opts.decision.route === "calendar_query" ||
    isReminderListToolIntent(normalized) ||
    (complex && /\b(day|week|reminders?|tasks?|schedule|plan)\b/.test(normalized))
  ) {
    addStep(
      "listReminders",
      { dateRange: inferDateRange(opts.message) },
      "reminder_lookup_intent",
    );
  }

  if (
    opts.decision.route === "profile" ||
    isProfileToolIntent(normalized) ||
    (complex && /\b(profile|job|career|resume|application)\b/.test(normalized))
  ) {
    addStep(
      "getProfile",
      { fields: inferProfileFields(opts.message) },
      "profile_context_intent",
    );
  }

  if (isRagToolIntent(normalized)) {
    addStep("searchLocalRag", { query: opts.message }, "local_rag_intent");
  }

  return {
    id: `tool_plan_${simpleHash(opts.message)}`,
    complex,
    reason: complex ? "complex_local_task" : "single_tool_intent",
    steps,
  };
}

async function runGetWeatherTool(
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult<WeatherToolData>> {
  const location = String(args.location || "").trim();
  const message = location ? `weather in ${location}` : context.message;
  const resolvedLocation = weatherLocationFromMessage(
    message,
    context.userProfile,
  );
  if (!resolvedLocation) {
    return toolFail("getWeather", "I need a location to check the weather.", {
      source: "open-meteo",
      confidence: 0.2,
      data: {
        summary: "",
        date: String(args.date || inferDateRange(context.message)),
      },
    });
  }
  try {
    const summary = await fetchWeatherSummary(message, context.userProfile);
    if (summary.startsWith("I need") || summary.startsWith("I couldn")) {
      return toolFail("getWeather", summary, {
        source: "open-meteo",
        confidence: 0.3,
        data: {
          summary,
          location: resolvedLocation,
          date: String(args.date || inferDateRange(context.message)),
        },
      });
    }
    return toolOk(
      "getWeather",
      {
        summary,
        location: resolvedLocation,
        date: String(args.date || inferDateRange(context.message)),
      },
      { source: "open-meteo", confidence: 0.88 },
    );
  } catch (error) {
    return toolFail(
      "getWeather",
      error instanceof Error
        ? error.message
        : "Weather data is unavailable right now.",
      { source: "open-meteo", confidence: 0.2 },
    );
  }
}

async function runCreateReminderTool(
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult<ReminderDraftToolData>> {
  const parsed = await parseReminderLocally(
    context.message,
    context.replyLanguage,
  );
  return toolOk(
    "createReminder",
    {
      title: parsed.title,
      details: parsed.details,
      datetimeText: parsed.datetimeText,
      recurrence: args.recurrence ? String(args.recurrence) : null,
      // TODO: commit reminders only through the existing user-confirmed save path.
      requiresConfirmation: true,
      assistantReply: parsed.assistantReply,
    },
    { source: "local_reminder_parser", confidence: 0.78 },
  );
}

async function runListRemindersTool(
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult<ReminderListToolData>> {
  const summary = await buildScheduleAnswer(context.userId, context.message);
  const data = {
    summary,
    dateRange: String(args.dateRange || inferDateRange(context.message)),
  };
  if (summary.startsWith("You do not have")) {
    return toolFail("listReminders", summary, {
      source: "local_reminders",
      confidence: 0.65,
      data,
    });
  }
  return toolOk("listReminders", data, {
    source: "local_reminders",
    confidence: 0.9,
  });
}

function selectedProfileFields(
  answers: Record<string, any>,
  userProfile: LocalUserProfile | undefined,
  requestedFields: unknown,
) {
  const combined: Record<string, any> = {
    ...(userProfile?.name ? { name: userProfile.name } : {}),
    ...(userProfile?.place ? { place: userProfile.place } : {}),
    ...(userProfile?.assistantName
      ? { assistantName: userProfile.assistantName }
      : {}),
    ...(userProfile?.replyLanguage
      ? { replyLanguage: userProfile.replyLanguage }
      : {}),
    ...answers,
  };
  const requested = Array.isArray(requestedFields)
    ? requestedFields.map((field) => String(field || "").trim()).filter(Boolean)
    : [];
  const keys = requested.length ? requested : Object.keys(combined);
  return Object.fromEntries(
    keys
      .filter((key) => combined[key] != null && displayValue(combined[key]))
      .map((key) => [key, combined[key]]),
  );
}

async function runGetProfileTool(
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult<ProfileToolData>> {
  const fields = selectedProfileFields(
    context.answers,
    context.userProfile,
    args.fields,
  );
  const summary =
    context.profileSummary ||
    profileFactsText(context.answers) ||
    formatProfileFields(fields);
  if (!Object.keys(fields).length && !summary) {
    return toolFail("getProfile", "No saved profile facts are available yet.", {
      source: "local_profile",
      confidence: 0.4,
      data: { fields, summary: "" },
    });
  }
  return toolOk("getProfile", { fields, summary }, {
    source: "local_profile",
    confidence: 0.86,
  });
}

async function runUpdateMemoryTool(
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult<MemoryUpdateToolData>> {
  const fact = String(args.fact || extractMemoryFact(context.message)).trim();
  if (!fact) {
    return toolFail("updateMemory", "No memory fact was provided.", {
      source: "local_memory",
      confidence: 0.2,
    });
  }
  const category = String(args.category || "user_note").trim() || "user_note";
  const confidence = Number.isFinite(Number(args.confidence))
    ? Math.max(0, Math.min(1, Number(args.confidence)))
    : 0.8;
  const current = await loadDurableFacts(context.userId);
  const nextFact = createDurableFactRecord({
    fact,
    category,
    confidence,
    source: "local_tool",
    sourceTurnId: String(args.sourceTurnId || "local_tool_updateMemory"),
    evidence: [String(args.sourceTurnId || context.message)],
  });
  if (!nextFact) {
    return toolFail("updateMemory", "No memory fact was provided.", {
      source: "local_memory",
      confidence: 0.2,
    });
  }
  const merged = mergeDurableFacts(current, [nextFact]);
  await saveDurableFacts(context.userId, merged.slice(-500));
  return toolOk(
    "updateMemory",
    {
      fact: nextFact.fact,
      category: nextFact.category,
      confidence: nextFact.confidence,
    },
    { source: "local_memory", confidence },
  );
}

async function runSearchLocalRagTool(
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult<RagSearchToolData>> {
  const query = String(args.query || context.message).trim();
  if (!query) {
    return toolFail("searchLocalRag", "No local RAG query was provided.", {
      source: "local_rag",
      confidence: 0.2,
    });
  }
  try {
    const hits = await searchLocalRag(context.userId, query, 6, context.runtimeOptions);
    if (!hits.length) {
      return toolFail("searchLocalRag", "No matching local knowledge was found.", {
        source: "local_rag",
        confidence: 0.45,
        data: { hits },
      });
    }
    return toolOk("searchLocalRag", { hits }, {
      source: "local_rag",
      confidence: Math.max(...hits.map((hit) => hit.score), 0.5),
    });
  } catch (error) {
    return toolFail(
      "searchLocalRag",
      error instanceof Error
        ? error.message
        : "Local RAG search is unavailable.",
      { source: "local_rag", confidence: 0.25 },
    );
  }
}

async function executeToolStep(
  step: ToolPlanStep,
  context: ToolExecutionContext,
): Promise<LocalToolResult> {
  if (step.tool === "getWeather") return runGetWeatherTool(step.args, context);
  if (step.tool === "createReminder") {
    return runCreateReminderTool(step.args, context);
  }
  if (step.tool === "listReminders") {
    return runListRemindersTool(step.args, context);
  }
  if (step.tool === "getProfile") return runGetProfileTool(step.args, context);
  if (step.tool === "updateMemory") {
    return runUpdateMemoryTool(step.args, context);
  }
  if (step.tool === "searchLocalRag") {
    return runSearchLocalRagTool(step.args, context);
  }
  return toolFail(step.tool, "Tool is not implemented yet.", {
    source: "local_tool_stub",
  }) as LocalToolResult;
}

async function executeToolPlan(plan: ToolPlan, context: ToolExecutionContext) {
  const results: LocalToolResult[] = [];
  for (const step of plan.steps) {
    results.push(await executeToolStep(step, context));
  }
  return results;
}

function toolSourceLabel(result: LocalToolResult) {
  if (result.tool === "getWeather") return "weather";
  if (result.tool === "createReminder" || result.tool === "listReminders") {
    return "reminders";
  }
  if (result.tool === "getProfile") return "profile";
  if (result.tool === "updateMemory") return "memory";
  if (result.tool === "searchLocalRag") return "local_rag";
  return result.tool;
}

function formatProfileFields(fields: Record<string, any>) {
  const rows = Object.entries(fields)
    .filter(([, value]) => displayValue(value))
    .map(([key, value]) => `${key}: ${displayValue(value)}`);
  return rows.join("; ");
}

function resultByTool<T>(results: LocalToolResult[], tool: LocalToolName) {
  return results.find((result) => result.tool === tool) as
    | ToolResult<T>
    | undefined;
}

function composeToolDraft(
  plan: ToolPlan,
  results: LocalToolResult[],
  context: ToolExecutionContext,
) {
  const lines: string[] = [];
  const weather = resultByTool<WeatherToolData>(results, "getWeather");
  const reminderDraft = resultByTool<ReminderDraftToolData>(
    results,
    "createReminder",
  );
  const reminders = resultByTool<ReminderListToolData>(
    results,
    "listReminders",
  );
  const profile = resultByTool<ProfileToolData>(results, "getProfile");
  const memory = resultByTool<MemoryUpdateToolData>(results, "updateMemory");
  const rag = resultByTool<RagSearchToolData>(results, "searchLocalRag");

  if (!plan.complex && reminderDraft?.ok && reminderDraft.data) {
    return reminderDraft.data.assistantReply;
  }

  if (!plan.complex && weather) {
    return weather.ok && weather.data?.summary
      ? weather.data.summary
      : `I could not get weather data: ${weather.error || "weather is unavailable"}`;
  }

  if (!plan.complex && reminders) {
    return reminders.ok && reminders.data?.summary
      ? reminders.data.summary
      : reminders.error || "I do not have reminder data for that range.";
  }

  if (!plan.complex && profile) {
    return profile.ok && profile.data
      ? `Based on your saved profile: ${formatProfileFields(profile.data.fields) || profile.data.summary}`
      : profile.error || "I do not have saved profile data for that yet.";
  }

  if (!plan.complex && memory) {
    return memory.ok
      ? "Noted. I saved that to local memory."
      : memory.error || "I could not save that memory locally.";
  }

  if (!plan.complex && rag) {
    if (!rag.ok || !rag.data?.hits.length) {
      return rag.error || "I could not find matching local knowledge.";
    }
    const sourceLabels = uniq(
      rag.data.hits.map((hit) => hit.source_name).filter(Boolean),
    ).slice(0, 3);
    return [
      `Based on local knowledge${sourceLabels.length ? ` (${sourceLabels.join(", ")})` : ""}:`,
      ...rag.data.hits
        .slice(0, 3)
        .map((hit) => `- ${hit.text}`),
    ].join("\n");
  }

  if (profile) {
    if (profile.ok && profile.data) {
      lines.push(
        `Based on your saved profile: ${formatProfileFields(profile.data.fields) || profile.data.summary}`,
      );
    } else {
      lines.push(
        `Profile data missing: ${profile.error || "no saved profile facts are available"}`,
      );
    }
  }

  if (weather) {
    if (weather.ok && weather.data?.summary) {
      lines.push(`Based on weather data: ${weather.data.summary}`);
    } else {
      lines.push(
        `Weather data missing: ${weather.error || "weather is unavailable"}`,
      );
    }
  }

  if (reminders) {
    if (reminders.ok && reminders.data?.summary) {
      lines.push(`Based on your reminders:\n${reminders.data.summary}`);
    } else {
      lines.push(
        `Reminder data missing: ${reminders.error || "no reminders were found"}`,
      );
    }
  }

  if (rag) {
    if (rag.ok && rag.data?.hits.length) {
      const sourceLabels = uniq(
        rag.data.hits.map((hit) => hit.source_name).filter(Boolean),
      ).slice(0, 3);
      lines.push(
        [
          `Based on local knowledge${sourceLabels.length ? ` (${sourceLabels.join(", ")})` : ""}:`,
          ...rag.data.hits
            .slice(0, 3)
            .map((hit) => `- ${hit.text}`),
        ].join("\n"),
      );
    } else {
      lines.push(
        `Local knowledge missing: ${rag.error || "no matching local knowledge was found"}`,
      );
    }
  }

  if (memory) {
    lines.push(
      memory.ok
        ? "I saved the new fact to local memory."
        : `Memory update missing: ${memory.error || "local memory update failed"}`,
    );
  }

  const normalized = normalizeText(context.message);
  if (/\b(plan my day|tomorrow plan|today plan)\b/.test(normalized)) {
    lines.push(
      "Suggested plan: handle fixed reminders first, then use the weather note to decide travel or outdoor timing. If either source is missing, treat this as a partial local plan.",
    );
  } else if (/\b(job applications?|resume|career)\b/.test(normalized)) {
    lines.push(
      "Suggested next step: use the saved profile facts above to tailor your resume, shortlist roles, and prepare examples. I will not invent profile details that are not saved locally.",
    );
  } else if (/\b(this week|week)\b/.test(normalized)) {
    lines.push(
      "Suggested weekly focus: start with the listed reminders. If reminder data is missing, I need saved reminders before I can summarize the week reliably.",
    );
  }

  if (!lines.length) {
    return "I could not find enough local tool data to answer that reliably.";
  }
  return lines.join("\n\n");
}

function verifyToolDraft(
  draft: string,
  results: LocalToolResult[],
  replyLanguage: ReplyLanguage,
): ToolVerificationResult {
  const sourceLabels = uniq(results.map(toolSourceLabel));
  const missingData = results
    .filter((result) => !result.ok)
    .map((result) => result.error || `${result.tool} data is unavailable.`);
  const issues: string[] = [];
  if (results.length && !sourceLabels.length) {
    issues.push("tool_sources_missing");
  }
  if (
    missingData.length &&
    !/missing|could not|unavailable|do not have|need/i.test(draft)
  ) {
    issues.push("missing_data_not_disclosed");
  }
  return {
    ok: issues.length === 0,
    issues,
    sourceLabels,
    missingData,
    cloudFallbackUsed: false,
    language: replyLanguage,
  };
}

function routeForToolPlan(plan: ToolPlan, currentRoute: OrchestratorRoute) {
  if (plan.complex) return "local_answer" as OrchestratorRoute;
  const first = plan.steps[0]?.tool;
  if (first === "getWeather") return "weather" as OrchestratorRoute;
  if (first === "createReminder") {
    return "reminder_create" as OrchestratorRoute;
  }
  if (first === "listReminders") return "calendar_query" as OrchestratorRoute;
  if (first === "getProfile" || first === "updateMemory") {
    return "profile" as OrchestratorRoute;
  }
  if (first === "searchLocalRag") return "local_answer" as OrchestratorRoute;
  return currentRoute === "fallback_openai" ? "local_answer" : currentRoute;
}

function shouldExecuteToolPlan(plan: ToolPlan, route: OrchestratorRoute) {
  if (!plan.steps.length) return false;
  if (plan.complex) return true;
  if (
    plan.steps.some((step) =>
      ["updateMemory", "searchLocalRag"].includes(step.tool),
    )
  ) {
    return true;
  }
  return [
    "weather",
    "calendar_query",
    "reminder_create",
    "profile",
  ].includes(route);
}

function toolPlanAvailable(plan: ToolPlan, registry: AgentRegistryConfig) {
  return plan.steps.every((step) => {
    if (step.tool === "getWeather") return registry.agents.toolAgents.weather;
    if (step.tool === "listReminders") return registry.agents.toolAgents.calendar;
    if (step.tool === "getProfile") return registry.agents.toolAgents.profile;
    return true;
  });
}

function selectedTierForRuntime(
  cfg: LocalModelConfig,
  options: ModelRuntimeTierOptions = {},
): ModelTierName {
  if (options.selectedTier) return options.selectedTier;
  return selectModelTier(
    cfg,
    {
      ...(options.deviceInfo || {}),
      proOptIn: options.proOptIn ?? options.deviceInfo?.proOptIn ?? false,
    },
    options.modelTier,
  );
}

function installedModelIdsFromStatus(status: ModelInstallStatus) {
  return status.required
    .concat(status.optional)
    .filter((entry) => entry.valid)
    .map((entry) => entry.id);
}

function modelTierOptionsFromInstallStatus(
  options: ModelRuntimeTierOptions,
  status: ModelInstallStatus,
): ModelRuntimeTierOptions {
  return {
    ...options,
    selectedTier: status.selectedTier,
    installedModelIds: installedModelIdsFromStatus(status),
    modelsReady: status.ready,
  };
}

function isNativeDownloadRuntime(cfg: LocalModelConfig) {
  return (
    String(cfg.runtime?.mode || "native_on_device") === "native_on_device" &&
    getModelDeliveryMode(cfg) === "download_on_first_launch"
  );
}

function modelInstallRecordSummary(record: ModelInstallStatus["required"][number]) {
  return {
    id: record.id,
    name: record.fileName || record.id,
    fileName: record.fileName,
    reason: record.reason || (record.exists ? "invalid" : "missing"),
    bytesOnDisk: record.bytesOnDisk,
    expectedBytes: record.expectedBytes ?? null,
  };
}

async function getNormalChatModelReadiness(
  cfg: LocalModelConfig,
  opts: {
    modelTier?: ModelTierName;
    deviceInfo?: DeviceCapabilitySnapshot;
    proOptIn?: boolean;
  },
) {
  if (!isNativeDownloadRuntime(cfg)) {
    const selectedTier = selectedTierForRuntime(cfg, opts);
    return {
      required: false,
      ready: true,
      selectedTier,
      installedModelIds: [] as string[],
      missingModels: [] as ReturnType<typeof modelInstallRecordSummary>[],
      invalidModels: [] as ReturnType<typeof modelInstallRecordSummary>[],
      status: null as ModelInstallStatus | null,
    };
  }

  let status: ModelInstallStatus;
  try {
    status = await getModelInstallStatus({
      config: cfg,
      modelTier: opts.modelTier,
      deviceInfo: opts.deviceInfo,
      proOptIn: opts.proOptIn,
      skipHashVerification: true,
    });
  } catch (error) {
    const selectedTier = selectedTierForRuntime(cfg, opts);
    return {
      required: true,
      ready: false,
      selectedTier,
      installedModelIds: [] as string[],
      missingModels: [] as ReturnType<typeof modelInstallRecordSummary>[],
      invalidModels: [
        {
          id: "local_model_setup",
          name: "Local model setup",
          fileName: "Local model setup",
          reason: error instanceof Error ? error.message : String(error || "setup check failed"),
          bytesOnDisk: 0,
          expectedBytes: null,
        },
      ],
      status: null as ModelInstallStatus | null,
    };
  }

  return {
    required: true,
    ready: status.ready,
    selectedTier: status.selectedTier,
    installedModelIds: installedModelIdsFromStatus(status),
    missingModels: status.missing.map(modelInstallRecordSummary),
    invalidModels: status.invalid.map(modelInstallRecordSummary),
    status,
  };
}

function canServeWithRulesOrToolsBeforeModelSetup(
  message: string,
  earlyDecision: OrchestratorDecision | null,
) {
  if (isMemoryUpdateToolIntent(normalizeText(message))) {
    return true;
  }

  return Boolean(
    earlyDecision &&
      ["calendar_query", "reminder_create", "weather", "profile"].includes(
        earlyDecision.route,
      ),
  );
}

function setupRequiredAssistantText(replyLanguage: ReplyLanguage) {
  const english =
    "Local AI files are still setting up on this phone. Please open the model setup screen and let the download finish. I can still answer simple messages instantly while setup continues.";
  if (replyLanguage === "ta") {
    return "இந்த phone-ல local AI files இன்னும் setup ஆகிக்கொண்டிருக்கிறது. Model setup screen-ஐ திறந்து download முடிக்கவும். Setup நடக்கும்போதும் simple messages-க்கு நான் உடனே பதில் சொல்ல முடியும்.";
  }
  return english;
}

async function buildSetupRequiredTurn(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  cfg: LocalModelConfig;
  readiness: Awaited<ReturnType<typeof getNormalChatModelReadiness>>;
  stageTimings: Record<string, number>;
}): Promise<LocalAssistantTurnResult> {
  const assistantText = setupRequiredAssistantText(opts.replyLanguage);
  const englishText = setupRequiredAssistantText("en");
  const affectedModels = opts.readiness.missingModels.concat(
    opts.readiness.invalidModels,
  );
  const decision: OrchestratorDecision = {
    route: "setup_required",
    reason: "local_model_setup_required",
    confidence: 1,
    needsClarification: false,
    clarificationQuestion: "",
    needsLiveData: false,
    selectedModel: "rules",
    fallbackAllowed: false,
  };

  await appendConversation(opts.userId, "user", opts.message);
  await appendConversation(opts.userId, "assistant", assistantText);
  await appendRouteDecisionLog(opts.userId, opts.message, decision, {
    routeUsed: "setup_required",
    source: "local_rules",
    setupRequired: true,
    selectedTier: opts.readiness.selectedTier,
    missingModels: opts.readiness.missingModels,
    invalidModels: opts.readiness.invalidModels,
    fallbackPolicy: {
      backendRole: opts.cfg.runtime?.backendRole || "fallback_only",
      openAiPolicy: opts.cfg.runtime?.openAiPolicy || "fallback_only",
    },
  });

  return {
    route: "setup_required",
    source: "local_rules",
    cacheHit: false,
    assistantText,
    englishText,
    intent: "clarify",
    title: "Model Setup",
    details: assistantText,
    profileSummary: "",
    meta: {
      source: "local_rules",
      route: "setup_required",
      setupRequired: true,
      fastPath: false,
      responsePath: "setup_required",
      selectedTier: opts.readiness.selectedTier,
      missingModelIds: opts.readiness.missingModels.map((model) => model.id),
      invalidModelIds: opts.readiness.invalidModels.map((model) => model.id),
      missingModels: opts.readiness.missingModels,
      invalidModels: opts.readiness.invalidModels,
      affectedModels,
      modelDeliveryMode: getModelDeliveryMode(opts.cfg),
      storageRoot: opts.readiness.status?.storageRoot,
      classified: decision,
      orchestratorDecision: decision,
      stageTimings: opts.stageTimings,
      runtime: {
        primary: opts.cfg.runtime?.primary || "phone_local",
        mode: opts.cfg.runtime?.mode || "native_on_device",
        backendRole: opts.cfg.runtime?.backendRole || "fallback_only",
        openAiPolicy: opts.cfg.runtime?.openAiPolicy || "fallback_only",
        nativeBackend:
          opts.cfg.native?.backend || opts.cfg.runtime?.nativeBackend || "llama_cpp",
        nativeModuleName:
          opts.cfg.native?.bridgeModuleName ||
          opts.cfg.runtime?.nativeModuleName ||
          "JaiOnDeviceModel",
        modelRoot: opts.cfg.native?.modelRoot || "document://models",
        modelDeliveryMode: getModelDeliveryMode(opts.cfg),
        selectedModelTier: opts.readiness.selectedTier,
      },
    },
  };
}

function isExplicitProfileOrMemoryUpdate(message: string) {
  const normalized = normalizeText(message);
  return (
    isMemoryUpdateToolIntent(normalized) ||
    /\b(my name is|call me|i prefer|i work as|i live in|i am living in|my location is|my city is|my place is|i moved to|my goal is|i speak|i use|i study|i am studying|i am allergic to|i take medicine for)\b/.test(
      normalized,
    )
  );
}

function hasDurableProfileFactCue(message: string) {
  const normalized = normalizeText(message);
  return /\b(my name is|call me|i prefer|i work as|i live in|i am living in|my location is|my city is|my place is|i moved to|my goal is|i speak|i use|i study|i am studying|i like|i love|i enjoy|i usually (?:wake|sleep|work|study)|i have (?:diabetes|blood pressure|allergy|asthma|thyroid|kidney)|i am allergic to|i take medicine for)\b/.test(
    normalized,
  );
}

type NormalChatProfilerResult = Awaited<
  ReturnType<typeof runProfilerExtractionInsideNormalChat>
>;

function skippedNormalChatProfiler(
  answers: Record<string, string | string[]>,
): NormalChatProfilerResult {
  return {
    ran: false,
    answers,
    state: { status: "idle", history: [] },
    source: "skipped",
    missingSlots: [],
    updates: {},
  } as NormalChatProfilerResult;
}

function isReasonerModelAvailableForTier(
  cfg: LocalModelConfig,
  modelId: string | undefined,
  options: ModelRuntimeTierOptions = {},
) {
  const id = String(modelId || "").trim();
  if (!id) return false;
  const selectedTier = selectedTierForRuntime(cfg, options);
  const requiredIds = new Set(getRequiredModelIdsForTier(cfg, selectedTier));
  const installedIds = new Set(options.installedModelIds || []);
  return requiredIds.has(id) || installedIds.has(id);
}

function selectedReasonerModel(
  cfg: LocalModelConfig,
  routesConfig: OrchestratorConfig,
  message: string,
  recentTurns: number,
  forcedModel?: string,
  runtimeOptions: ModelRuntimeTierOptions = {},
) {
  if (forcedModel && isReasonerModelAvailableForTier(cfg, forcedModel, runtimeOptions)) {
    return forcedModel;
  }
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
    const selectedTier = selectedTierForRuntime(cfg, runtimeOptions);
    if (
      selectedTier === "pro" &&
      cfg.models.orchestratorPro &&
      isReasonerModelAvailableForTier(cfg, cfg.models.orchestratorPro, runtimeOptions)
    ) {
      return cfg.models.orchestratorPro;
    }
    if (
      (selectedTier === "standard" || selectedTier === "pro") &&
      isReasonerModelAvailableForTier(cfg, cfg.models.orchestratorLarge, runtimeOptions)
    ) {
      return cfg.models.orchestratorLarge;
    }
    return cfg.models.orchestratorMedium;
  }
  if (
    !isReasonerModelAvailableForTier(cfg, cfg.models.orchestratorMedium, runtimeOptions) &&
    isReasonerModelAvailableForTier(cfg, cfg.models.orchestratorLarge, runtimeOptions)
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

function isSimpleWellbeingSupportMessage(
  message: string,
  routesConfig: OrchestratorConfig,
  tokenCount: number,
) {
  if (!hasKeywordMatch(message, routesConfig.routes.wellbeingKeywords || [])) {
    return false;
  }

  if (tokenCount > 14) {
    return false;
  }

  return !hasKeywordMatch(message, [
    ...(routesConfig.routes.calendarKeywords || []),
    ...(routesConfig.routes.reminderKeywords || []),
    ...(routesConfig.routes.weatherKeywords || []),
    ...(routesConfig.routes.profileKeywords || []),
    ...(routesConfig.routes.liveDataKeywords || []),
    ...((routesConfig.routes.multiStepKeywords || []) as string[]),
  ]);
}

function wellbeingSupportAnswer(replyLanguage: ReplyLanguage) {
  if (replyLanguage === "ta") {
    return "அது ரொம்ப சோர்வாக இருக்கலாம். கொஞ்சம் ஓய்வு எடுத்துக்கோங்க, தண்ணீர் குடிங்க, உங்களை அதிகம் அழுத்த வேண்டாம். இது வழக்கத்துக்கு மாறாக, கடுமையாக, அல்லது தொடர்ந்து இருந்தால் மருத்துவரிடம் பேசுங்கள்.";
  }

  return "That sounds exhausting. Take a short rest, drink some water, and don't push yourself too hard. If this feels unusual, severe, or keeps happening, please consider checking with a medical professional.";
}

function quickLocalDecision(
  quick: QuickLocalReplyResult,
): OrchestratorDecision {
  return {
    route: quick.route,
    reason: `matched_${quick.route}_quick_reply_rule`,
    confidence: quick.confidence,
    needsClarification: false,
    clarificationQuestion: "",
    needsLiveData: false,
    selectedModel: "rules",
    fallbackAllowed: false,
  };
}

const QUICK_ROUTE_CANONICAL_MESSAGE: Partial<Record<OrchestratorRoute, string>> = {
  fast_greeting: "hello",
  identity: "who are you",
  small_talk: "what are you up to",
  wellbeing_support: "tired",
  capabilities: "what can you do",
  knowledge_ack: "do you know about IPL",
  thanks: "thanks",
  goodbye: "bye",
};

function deterministicQuickReplyForRoute(
  route: OrchestratorRoute,
  opts: {
    message: string;
    replyLanguage: ReplyLanguage;
    userProfile?: LocalUserProfile;
  },
) {
  return (
    tryBuildQuickLocalReply({
      message: opts.message,
      replyLanguage: opts.replyLanguage,
      assistantName: opts.userProfile?.assistantName,
      userName: opts.userProfile?.name,
    }) ||
    tryBuildQuickLocalReply({
      message: QUICK_ROUTE_CANONICAL_MESSAGE[route] || "",
      replyLanguage: opts.replyLanguage,
      assistantName: opts.userProfile?.assistantName,
      userName: opts.userProfile?.name,
    })
  );
}

async function appendQuickLocalReplyIfReady(
  userId: number,
  message: string,
  quick: QuickLocalReplyResult,
  decision: OrchestratorDecision,
) {
  const timeoutMs = 25;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    (async () => {
      if (!(await exists(DATA_DIR))) {
        return;
      }

      await appendConversation(userId, "user", message);
      await appendConversation(userId, "assistant", quick.assistantText);
      await appendRouteDecisionLog(userId, message, decision, {
        routeUsed: quick.route,
        source: quick.source,
        fastPath: true,
      });
    })(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]).catch(() => undefined);

  if (timeout) {
    clearTimeout(timeout);
  }
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

function isLikelyLiveCurrentDataRequest(message: string) {
  const normalized = normalizeText(message);
  if (!normalized || isSimpleTimeOrDateQuery(message)) return false;
  if (/\b(without live data|no live data|offline)\b/.test(normalized)) {
    return false;
  }
  return requiresImmediateBackendCurrentData(message);
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
    hasKeywordMatch(message, routesConfig.routes.fastGreetingKeywords || [])
  ) {
    return {
      route: "fast_greeting",
      reason: "matched_greeting_rule",
      confidence: 0.99,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  if (hasKeywordMatch(message, routesConfig.routes.smallTalkKeywords || [])) {
    return {
      route: "small_talk",
      reason: "matched_small_talk_rule",
      confidence: 0.98,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  if (hasKeywordMatch(message, routesConfig.routes.capabilitiesKeywords || [])) {
    return {
      route: "capabilities",
      reason: "matched_capabilities_rule",
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

  if (isLikelyLiveCurrentDataRequest(message)) {
    return {
      route: "fallback_openai",
      reason: "matched_live_current_data_rule",
      confidence: 0.94,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: true,
      selectedModel: "rules",
      fallbackAllowed: false,
    };
  }

  if (isSimpleWellbeingSupportMessage(message, routesConfig, tokenCount)) {
    return {
      route: "wellbeing_support",
      reason: "matched_simple_wellbeing_support_rule",
      confidence: 0.97,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "rules",
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

function canReturnImmediateFastGreeting(message: string) {
  const normalized = normalizeText(message);
  return !/\b(i prefer|prefer english|prefer tamil|work as|software engineer|developer|engineer|my name|i am|i'm|i live|from)\b/.test(
    normalized,
  );
}

function sanitizeDecision(
  raw: Partial<OrchestratorDecision> & Record<string, any>,
  selectedModel: string,
  replyLanguage: ReplyLanguage,
): OrchestratorDecision {
  const route = String(raw.route || "local_answer") as OrchestratorRoute;
  const safeRoute: OrchestratorRoute = [
    "fast_greeting",
    "identity",
    "small_talk",
    "wellbeing_support",
    "capabilities",
    "knowledge_ack",
    "thanks",
    "goodbye",
    "clarify",
    "profile",
    "calendar_query",
    "reminder_create",
    "weather",
    "local_answer",
    "setup_required",
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
  runtimeOptions: ModelRuntimeTierOptions = {},
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
        selected_model: selectedModel,
        selected_model_tier: runtimeOptions.selectedTier,
      }),
      selectedModel,
      0.05,
      runtimeOptions,
      LOCAL_TASK_MAX_TOKENS.classifier,
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
  runtimeOptions: ModelRuntimeTierOptions = {},
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
      runtimeOptions,
      LOCAL_TASK_MAX_TOKENS.alignment,
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

const VECTOR_SEMANTIC_CACHE_SKIP_ROUTES = new Set<OrchestratorRoute>([
  "fast_greeting",
  "identity",
  "small_talk",
  "wellbeing_support",
  "capabilities",
  "thanks",
  "goodbye",
  "clarify",
  "calendar_query",
  "reminder_create",
  "weather",
  "setup_required",
]);

const SAFE_DETERMINISTIC_LOCAL_ROUTES = new Set<OrchestratorRoute>([
  "fast_greeting",
  "identity",
  "small_talk",
  "capabilities",
  "knowledge_ack",
  "thanks",
  "goodbye",
  "clarify",
  "calendar_query",
  "reminder_create",
]);

function canAnswerRouteWithoutNativeInference(
  decision?: OrchestratorDecision | null,
) {
  return Boolean(decision && SAFE_DETERMINISTIC_LOCAL_ROUTES.has(decision.route));
}

function isLikelyDeterministicLocalRequest(message: string) {
  const normalized = normalizeText(message);
  if (!normalized) return true;
  return (
    isReminderCreateToolIntent(normalized) ||
    isReminderListToolIntent(normalized) ||
    isSimpleTimeOrDateQuery(message) ||
    /\b(capabilities|what can you do|who are you|your name)\b/.test(normalized)
  );
}

function shouldRouteGeneralQuestionToBackendEarly(
  message: string,
  nativeSafety: { safe: boolean },
  userAllowedCloudFallback?: boolean | null,
) {
  if (nativeSafety.safe) return false;
  if (isLikelyDeterministicLocalRequest(message)) return false;
  return userAllowedCloudFallback === true || userAllowedCloudFallback === false;
}

function tokenCountForMessage(message: string) {
  const normalized = normalizeText(message);
  return normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
}

function isSimpleTimeOrDateQuery(message: string) {
  const normalized = normalizeText(message);
  return /^(what(?:s| is)? (?:the )?(?:time|date)|what day is it|current time|time now|date today|today date|what is today)(?: in [\p{L}\s]+)?$/u.test(
    normalized,
  );
}

function isVeryShortSimpleMessage(message: string) {
  const normalized = normalizeText(message);
  if (!normalized) return true;
  if (isProfileMemoryQuestion(message)) return false;
  return tokenCountForMessage(message) <= 3 && normalized.length <= 28;
}

function shouldSkipVectorSemanticCache(
  message: string,
  route?: OrchestratorRoute | null,
) {
  if (route && VECTOR_SEMANTIC_CACHE_SKIP_ROUTES.has(route)) return true;
  if (isSimpleTimeOrDateQuery(message)) return true;
  return isVeryShortSimpleMessage(message);
}

function isOptionalEmbeddingUnavailable(error: unknown) {
  const message = String((error as any)?.message || error || "");
  return (
    isNativeOnDeviceRuntimeUnavailableError(error) ||
    /NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE/.test(message) ||
    /JAI_LLAMA_CPP_BACKEND_MISSING/.test(message) ||
    /JAI_MODEL_FILE_MISSING/.test(message) ||
    /JAI_NATIVE_MODELS_MISSING/.test(message) ||
    /JAI_MODEL_NOT_CONFIGURED/.test(message) ||
    /JAI_MODEL_PATH_MISSING/.test(message) ||
    /native on-device .*not (?:installed|available|ready)/i.test(message) ||
    /llama\.cpp backend is not available/i.test(message) ||
    /compiled without llama\.cpp/i.test(message)
  );
}

async function optionalEmbedTexts(
  texts: string[],
  runtimeOptions: ModelRuntimeTierOptions = {},
) {
  if (!texts.length) return [] as number[][];
  if (runtimeOptions.modelsReady === false) return null;
  try {
    return await embedTexts(texts, runtimeOptions);
  } catch (error) {
    if (isOptionalEmbeddingUnavailable(error)) return null;
    throw error;
  }
}

async function lookupSemanticCache(
  userId: number,
  message: string,
  runtimeOptions: ModelRuntimeTierOptions = {},
  opts: {
    route?: OrchestratorRoute | null;
    allowVectorEmbeddings?: boolean;
    onTelemetry?: (event: string, payload?: Record<string, any>) => void;
  } = {},
) {
  const rules = await getMemoryRules();
  if (isTimeSensitiveRagQuery(message)) {
    return null;
  }
  const store = await loadSemanticCacheStore(userId);
  const now = Date.now();

  const rows = store.entries.filter((row) => {
    if (row.userId !== userId) return false;
    if (!row.expiresAt) return true;
    return new Date(row.expiresAt).getTime() >= now;
  });

  if (!rows.length) return null;

  const normalizedMessage = normalizeText(message);
  const exactMatch = rows.find(
    (row) =>
      normalizeText(row.normalizedQuestion || row.sourceQuestion) ===
      normalizedMessage,
  );
  if (exactMatch) {
    const confidence = clampConfidence(exactMatch.confidence, 1);
    const threshold = positiveFloat(rules.cache?.similarityThreshold, 0.92);
    if (confidence >= threshold) {
      opts.onTelemetry?.("client_semantic_cache_exact_hit", {
        cache_hit: true,
        cache_source: "semantic_cache_exact",
        route_taken: "semantic_cache",
        decision: "exact_hit",
      });
    }
    return confidence >= threshold
      ? { ...exactMatch, score: 1, confidence }
      : null;
  }

  const profileMemory = isProfileMemoryQuestion(message);
  if (
    runtimeOptions.modelsReady === false ||
    shouldSkipVectorSemanticCache(message, opts.route)
  ) {
    opts.onTelemetry?.("client_semantic_cache_vector_skipped", {
      cache_hit: false,
      cache_source: "semantic_cache_vector",
      route_taken: "semantic_cache",
      decision:
        runtimeOptions.modelsReady === false
          ? "models_not_ready"
          : "route_or_message_skipped",
    });
    return null;
  }
  if (opts.allowVectorEmbeddings !== true) {
    opts.onTelemetry?.("client_semantic_cache_vector_skipped", {
      cache_hit: false,
      cache_source: "semantic_cache_vector",
      route_taken: "semantic_cache",
      decision: "native_embeddings_not_verified",
    });
    return null;
  }
  // Important: compare the actual user message against cached questions.
  // Do not inject aliases here, because aliases can bypass the similarity
  // threshold. The exact check above is a narrow deterministic local cache hit.
  opts.onTelemetry?.("client_semantic_cache_vector_started", {
    cache_hit: false,
    cache_source: "semantic_cache_vector",
    route_taken: "semantic_cache",
    workflow_phase: "started",
  });
  let queryVectors: number[][] | null = null;
  try {
    queryVectors = await optionalEmbedTexts([message], runtimeOptions);
  } catch (error) {
    opts.onTelemetry?.("client_semantic_cache_vector_failed", {
      cache_hit: false,
      cache_source: "semantic_cache_vector",
      route_taken: "semantic_cache",
      workflow_phase: "failed",
      error_type: "semantic_cache_embedding_failed",
      error_name: (error as any)?.name || "Error",
      error_message: String((error as any)?.message || error || "Unknown error").slice(0, 240),
    });
    return null;
  }
  if (!queryVectors?.length) {
    opts.onTelemetry?.("client_semantic_cache_vector_failed", {
      cache_hit: false,
      cache_source: "semantic_cache_vector",
      route_taken: "semantic_cache",
      workflow_phase: "failed",
      error_type: "semantic_cache_embedding_unavailable",
    });
    return null;
  }

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
    return { ...best, score: bestScore, confidence: bestScore };
  }

  return null;
}

async function lookupSemanticCacheExact(userId: number, message: string) {
  if (isTimeSensitiveRagQuery(message)) return null;
  const store = await loadSemanticCacheStore(userId);
  const now = Date.now();
  const normalizedMessage = normalizeText(message);
  const exactMatch = store.entries.find((row) => {
    if (row.userId !== userId) return false;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < now) return false;
    return (
      normalizeText(row.normalizedQuestion || row.sourceQuestion) ===
      normalizedMessage
    );
  });
  if (!exactMatch) return null;
  const confidence = clampConfidence(exactMatch.confidence, 1);
  return confidence >= 0.92
    ? { ...exactMatch, score: 1, confidence }
    : null;
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

const LOCAL_EXACT_CACHE_PRIVATE_RE = /\b(my|our)\s+(email|phone|mobile|address|password|otp|account|bank|card|upi|aadhaar|ssn|salary|income|ctc|pay|profile|memory|routine|goal)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}/i;
const LOCAL_EXACT_CACHE_HIGH_RISK_RE = /\b(emergency|suicide|self harm|kill myself|hurt myself|chest pain|cannot breathe|medical|medicine|symptom|diagnosis|treatment|prescription|dosage|legal|lawyer|lawsuit|contract|tax|financial advice|investment|loan|insurance|bank account|credit card)\b/i;
const LOCAL_EXACT_CACHE_BAD_ANSWER_RE = /\b(couldn'?t|could not|failed|error|try again|unavailable|timeout|not configured)\b/i;

function isStableSafeSemanticCacheWrite(
  question: string,
  answer: string,
  route: string,
) {
  const normalizedRoute = normalizeText(route);
  if (
    normalizedRoute.includes("reminder") ||
    normalizedRoute.includes("calendar") ||
    normalizedRoute.includes("schedule") ||
    normalizedRoute.includes("weather") ||
    normalizedRoute.includes("tool") ||
    normalizedRoute.includes("clarify") ||
    normalizedRoute.includes("setup")
  ) {
    return false;
  }
  if (isTimeSensitiveRagQuery(question)) return false;
  const combined = `${question}\n${answer}`;
  if (LOCAL_EXACT_CACHE_PRIVATE_RE.test(combined)) return false;
  if (LOCAL_EXACT_CACHE_HIGH_RISK_RE.test(combined)) return false;
  if (LOCAL_EXACT_CACHE_BAD_ANSWER_RE.test(answer)) return false;
  return Boolean(normalizeText(question) && String(answer || "").trim());
}

async function writeSemanticCache(
  userId: number,
  question: string,
  answer: string,
  englishAnswer: string,
  route: string,
  intent: LocalAssistantTurnResult["intent"],
  alignmentProfile?: SemanticCacheEntry["alignmentProfile"],
  runtimeOptions: ModelRuntimeTierOptions = {},
  opts: { allowVectorEmbeddings?: boolean } = {},
) {
  const rules = await getMemoryRules();
  const skipRoutes = rules.cache?.skipRoutes || [];
  if (skipRoutes.includes(route)) return;
  if (!isStableSafeSemanticCacheWrite(question, englishAnswer || answer, route)) return;
  const profileRoute = normalizeText(route).includes("profile");
  if (profileRoute && opts.allowVectorEmbeddings !== true) return;
  let embedding: number[] = [];
  if (opts.allowVectorEmbeddings === true) {
    const vectors = await optionalEmbedTexts([question], runtimeOptions);
    embedding = vectors?.[0] || [];
  }
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
    confidence: 1,
    sourceLabels: embedding.length ? [route] : [route, "exact_match_only"],
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
  runtimeOptions: ModelRuntimeTierOptions = {},
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
      runtimeOptions,
      LOCAL_TASK_MAX_TOKENS.memorySummary,
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
        return createDurableFactRecord({
          fact,
          confidence,
          category: String(row?.category || "other").trim() || "other",
          source: "model",
          evidence: trimList(row?.evidence).slice(0, 4),
          important: Boolean(row?.important),
          profileUpdates: normalizeMemoryProfileUpdates(
            slots,
            row?.profile_updates || {},
          ),
        });
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
  runtimeOptions: ModelRuntimeTierOptions = {},
) {
  const activeFacts = activeDurableFacts(durableFacts);
  const texts = [
    summaryRow.summary ? `Summary: ${summaryRow.summary}` : "",
    ...activeFacts.map((row) => `Fact: ${row.fact}`),
  ].filter(Boolean);
  if (!texts.length) {
    await saveMemoryChunks(userId, []);
    return [] as LocalRagChunk[];
  }
  const embeddings = await optionalEmbedTexts(texts, runtimeOptions);
  if (!embeddings) {
    return [] as LocalRagChunk[];
  }
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
      factCount: activeFacts.length,
    },
    updatedAt: summaryRow.createdAt,
  }));
  await saveMemoryChunks(userId, chunks);
  return chunks;
}

async function backgroundMemoryRuntimeOptions() {
  const cfg = await getModelConfig();
  let runtimeOptions: ModelRuntimeTierOptions = {
    selectedTier: selectedTierForRuntime(cfg),
  };

  if (isNativeDownloadRuntime(cfg)) {
    const readiness = await getNormalChatModelReadiness(cfg, {});
    runtimeOptions = readiness.status
      ? modelTierOptionsFromInstallStatus(runtimeOptions, readiness.status)
      : {
          ...runtimeOptions,
          selectedTier: readiness.selectedTier,
          installedModelIds: readiness.installedModelIds,
          modelsReady: readiness.ready,
        };
    if (!readiness.ready) return runtimeOptions;
  }

  if (isNativeOnDeviceModelConfig(cfg)) {
    const runtime = createLocalModelRuntime({
      primary: cfg.runtime?.primary,
      mode: cfg.runtime?.mode,
      backendRole: cfg.runtime?.backendRole,
      openAiPolicy: cfg.runtime?.openAiPolicy,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      allowDeviceLoopback: cfg.runtime?.allowDeviceLoopback,
      adapterLocation: cfg.runtime?.adapterLocation,
      nativeBackend: cfg.native?.backend || cfg.runtime?.nativeBackend,
      nativeModuleName: cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName,
      modelRoot: cfg.native?.modelRoot,
      modelAssets: cfg.native?.models,
      modelDeliveryMode: getModelDeliveryMode(cfg),
      modelDelivery: cfg.modelDelivery,
      modelTier: runtimeOptions.selectedTier || runtimeOptions.modelTier,
      deviceInfo: runtimeOptions.deviceInfo,
      proOptIn: runtimeOptions.proOptIn,
    });
    if (!runtime.isConfigured()) {
      return {
        ...runtimeOptions,
        modelsReady: false,
      };
    }
  }

  return {
    ...runtimeOptions,
    modelsReady: runtimeOptions.modelsReady ?? true,
  };
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
  const runtimeOptions = await backgroundMemoryRuntimeOptions();
  const built = await buildMemoryConsolidation(
    userId,
    turns,
    routeLogs,
    answers,
    state,
    opts?.userProfile,
    runtimeOptions,
  );
  const existingFacts = await loadDurableFacts(userId);
  const mergedFacts = mergeDurableFacts(existingFacts, built.durableFacts);
  const activeMergedFacts = activeDurableFacts(mergedFacts);
  const summaryRow: DailySummaryRecord = {
    userId,
    createdAt: nowIso(),
    windowStartAt: turns[0]?.createdAt,
    windowEndAt: turns[turns.length - 1]?.createdAt,
    summary: built.summary,
    durableFacts: activeMergedFacts.slice(
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
    runtimeOptions,
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

export async function listActiveMemories(userId: number) {
  await ensureLocalAgentData();
  return activeDurableFacts(await loadDurableFacts(userId)).map((row) => ({
    id: row.id,
    fact: row.fact,
    category: row.category,
    confidence: row.confidence,
    created_at: row.created_at,
    last_confirmed_at: row.last_confirmed_at,
    source: row.source,
  }));
}

async function updateMemoryFactStatus(
  userId: number,
  memoryId: string,
  status: MemoryFactStatus,
) {
  await ensureLocalAgentData();
  const facts = await loadDurableFacts(userId);
  let changed = false;
  const updated = facts.map((row) => {
    if (row.id !== memoryId) return row;
    changed = true;
    return {
      ...row,
      status,
      lastSeenAt: nowIso(),
    };
  });
  if (changed) {
    await saveDurableFacts(userId, updated);
    const runtimeOptions = await backgroundMemoryRuntimeOptions().catch(() => ({
      modelsReady: false,
    }));
    await refreshMemoryRagArtifacts(
      userId,
      {
        userId,
        createdAt: nowIso(),
        summary: "Memory user-control update.",
        durableFacts: activeDurableFacts(updated),
        profileUpdates: {},
        source: "fallback",
        conversationTurnCount: 0,
        routeLogCount: 0,
      },
      updated,
      runtimeOptions,
    ).catch(() => []);
  }
  return {
    ok: changed,
    id: memoryId,
    status,
  };
}

export async function markLocalMemoryStale(userId: number, memoryId: string) {
  return updateMemoryFactStatus(userId, memoryId, "stale");
}

export async function deleteLocalMemoryFact(userId: number, memoryId: string) {
  return updateMemoryFactStatus(userId, memoryId, "deleted");
}

function isFollowUpQuery(message: string) {
  const normalized = normalizeText(message);
  return (
    /^(what about|and for|how about|and what about|what if|and tomorrow|tomorrow|today)\b/.test(
      normalized,
    ) || /^(and\s+)?(for|in)\s+[a-z\s]+$/.test(normalized)
  );
}

function previousUserTurnForFollowUp(
  turns: LocalChatMessage[],
  currentMessage: string,
) {
  let skippedCurrent = false;
  for (const turn of [...turns].reverse()) {
    if (turn.role !== "user") continue;
    if (!skippedCurrent && turn.content.trim() === currentMessage.trim()) {
      skippedCurrent = true;
      continue;
    }
    if (!isFollowUpQuery(turn.content) && normalizeText(turn.content).length > 8) {
      return turn.content.trim();
    }
  }
  return "";
}

function rewriteFollowUpRagQuery(opts: {
  message: string;
  turns: LocalChatMessage[];
  userProfile?: LocalUserProfile;
}) {
  const message = opts.message.trim();
  if (!isFollowUpQuery(message)) return message;
  const previous = previousUserTurnForFollowUp(opts.turns, message);
  const profilePlace = opts.userProfile?.place
    ? ` in ${opts.userProfile.place}`
    : "";
  if (previous) return `${previous} ${message}`.trim();
  if (profilePlace && /\b(today|tomorrow|weather|forecast|rain)\b/.test(normalizeText(message))) {
    return `${message}${profilePlace}`;
  }
  return message;
}

type LocalReasoningBuildResult = {
  draft: string;
  rewrittenQuery: string;
  ragHits: LocalRagSearchResult[];
  usedSources: LocalRagSourceMetadata[];
};

async function buildLocalReasoningWithContext(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, any>;
  profileSummary: string;
  userProfile?: LocalUserProfile;
  selectedModel: string;
  runtimeOptions?: ModelRuntimeTierOptions;
}) {
  const prompts = await getPromptCatalog();
  const memories = await loadDailySummaries(opts.userId);
  const durableFacts = relevantDurableFactsForMessage(
    await loadDurableFacts(opts.userId),
    opts.message,
  );
  const turns = await recentConversation(opts.userId, 10);
  const rewrittenQuery = rewriteFollowUpRagQuery({
    message: opts.message,
    turns,
    userProfile: opts.userProfile,
  });
  const ragHits = await searchLocalRag(
    opts.userId,
    rewrittenQuery,
    6,
    opts.runtimeOptions,
  );
  const usedSources = ragHits.map((row) => row.sourceMetadata);
  const draft = await localChatText(
    prompts.localReasonerSystem,
    JSON.stringify({
      user_message: opts.message,
      rewritten_retrieval_query: rewrittenQuery,
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
        source_name: row.source_name,
        chunk_id: row.chunk_id,
        path: row.path,
        file: row.file,
        category: row.category,
        freshness_date: row.freshness_date,
        text: row.text,
        score: row.score,
        confidence: row.confidence,
        metadata: row.metadata || {},
      })),
    }),
    opts.selectedModel,
    0.25,
    opts.runtimeOptions,
    maxTokensForLocalAnswer(opts.runtimeOptions),
  );
  return {
    draft: draft.trim(),
    rewrittenQuery,
    ragHits,
    usedSources,
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
  runtimeOptions?: ModelRuntimeTierOptions;
}) {
  return (await buildLocalReasoningWithContext(opts)).draft;
}

async function buildProfileGroundedDraft(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, any>;
  profileSummary: string;
  userProfile?: LocalUserProfile;
  selectedModel: string;
  runtimeOptions?: ModelRuntimeTierOptions;
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
  policyAllowedWhen: string[];
  openAiPolicy?: string;
}) {
  if (String(opts.openAiPolicy || "fallback_only") === "disabled") return false;

  const allowed = new Set(opts.policyAllowedWhen || []);
  const explicitPolicyAllowsFallback =
    allowed.has("explicit_user_or_config_cloud_fallback_allowed") ||
    allowed.has("orchestrator_fallback_allowed");
  const orchestratorExplicitlyRoutedFallback =
    opts.decision.route === "fallback_openai";

  return (
    (opts.localReasonerRequestedFallback &&
      allowed.has("local_reasoner_returns___OPENAI_FALLBACK__")) ||
    (opts.needsLiveData && allowed.has("orchestrator_needs_live_data")) ||
    (opts.noSafeLocalPath &&
      orchestratorExplicitlyRoutedFallback &&
      allowed.has("no_safe_local_tool_or_model_path")) ||
    (opts.decision.fallbackAllowed === true && explicitPolicyAllowsFallback)
  );
}

function answerTextFromBackendPayload(payload: any) {
  return String(
    payload?.assistant?.text ||
      payload?.assistant?.english ||
      payload?.item?.details ||
      payload?.details ||
      payload?.raw_text ||
      "",
  ).trim();
}

function textLength(value: unknown) {
  return String(value || "").length;
}

function logClientWorkflowStep(payload: Parameters<typeof sendClientTurnLog>[0]) {
  sendClientTurnLog(payload);
  if (payload.request_id && payload.event) {
    void updateActiveWorkflowStep(String(payload.request_id), payload.event).catch(() => undefined);
  }
}

function logClientBackendFallbackEvent(input: {
  event: "client_backend_fallback_started" | "client_backend_fallback_completed";
  userId: number;
  message: string;
  answer?: string;
  requestId?: string | null;
  fallbackReason: BackendFallbackReason;
  originalRoute?: string | null;
  stageTimings?: Record<string, any>;
  durationMs?: number;
}) {
  logClientWorkflowStep({
    event: input.event,
    user_id: input.userId,
    request_id: input.requestId || undefined,
    channel: "text",
    question: input.message,
    answer: input.answer,
    question_length: textLength(input.message),
    answer_length: input.answer ? textLength(input.answer) : undefined,
    agent_source: "backend_openai",
    route_taken: "fallback_openai",
    fallback_reason: input.fallbackReason,
    workflow_step: "backend_fallback",
    workflow_phase: input.event.endsWith("_started") ? "started" : "completed",
    duration_ms: input.durationMs,
    stage_timings: input.stageTimings || null,
  });
}

async function callBackendOpenAiFallback(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  requestId?: string | null;
  fallbackReason: BackendFallbackReason;
  originalRoute?: string | null;
  stageTimings?: Record<string, any>;
}) {
  const startedAt = Date.now();
  logClientBackendFallbackEvent({
    event: "client_backend_fallback_started",
    userId: opts.userId,
    message: opts.message,
    requestId: opts.requestId,
    fallbackReason: opts.fallbackReason,
    originalRoute: opts.originalRoute,
    stageTimings: opts.stageTimings,
  });
  let backend: any;
  try {
    backend = await apiPostBackendOnly<any>(
      "/api/chat",
      {
        user_id: opts.userId,
        message: opts.message,
        reply_language: opts.replyLanguage,
        request_id: opts.requestId || undefined,
        client_fallback_reason: opts.fallbackReason,
        client_original_route: opts.originalRoute || undefined,
      },
      { timeoutMs: BACKEND_CHAT_FALLBACK_TIMEOUT_MS },
    );
  } catch (error) {
    logClientWorkflowStep({
      event: "client_backend_fallback_completed",
      user_id: opts.userId,
      request_id: opts.requestId || undefined,
      channel: "text",
      question: opts.message,
      question_length: textLength(opts.message),
      agent_source: "backend_openai",
      route_taken: "fallback_openai",
      fallback_reason: opts.fallbackReason,
      workflow_step: "backend_fallback",
      workflow_phase: "failed",
      error_type: (error as any)?.name || "backend_fallback_failed",
      error_name: (error as any)?.name || "Error",
      error_message: String((error as any)?.message || error || "Unknown error").slice(0, 240),
      http_status: Number((error as any)?.status || 0) || undefined,
      duration_ms: Date.now() - startedAt,
      stage_timings: opts.stageTimings || null,
    });
    throw error;
  }
  const annotated = annotateBackendOpenAiFallbackResponse(backend, {
    fallbackReason: opts.fallbackReason,
    originalRoute: opts.originalRoute,
    stageTimings: opts.stageTimings,
  });
  const durationMs = Date.now() - startedAt;
  logClientBackendFallbackEvent({
    event: "client_backend_fallback_completed",
    userId: opts.userId,
    message: opts.message,
    answer: answerTextFromBackendPayload(annotated),
    requestId: opts.requestId,
    fallbackReason: opts.fallbackReason,
    originalRoute: opts.originalRoute,
    durationMs,
    stageTimings: {
      ...(opts.stageTimings || {}),
      backend_fallback: durationMs,
    },
  });
  void syncGlobalKnowledge({ lightweight: true, limit: 25 }).catch(() => undefined);
  return annotated;
}

async function buildBackendFallbackTurn(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  fallbackReason: BackendFallbackReason;
  originalRoute?: string | null;
  decision: OrchestratorDecision;
  stageTimings: Record<string, number>;
  requestId?: string | null;
  appendUserTurn?: boolean;
}): Promise<LocalAssistantTurnResult> {
  if (opts.appendUserTurn) {
    await appendConversation(opts.userId, "user", opts.message);
  }
  const backendResponse = await callBackendOpenAiFallback({
    userId: opts.userId,
    message: opts.message,
    replyLanguage: opts.replyLanguage,
    requestId: opts.requestId,
    fallbackReason: opts.fallbackReason,
    originalRoute: opts.originalRoute,
    stageTimings: opts.stageTimings,
  });
  const assistantText =
    answerTextFromBackendPayload(backendResponse) ||
    "I couldn’t generate a response.";
  await appendConversation(opts.userId, "assistant", assistantText);
  await appendRouteDecisionLog(opts.userId, opts.message, opts.decision, {
    routeUsed: "fallback_openai",
    source: "openai_fallback",
    fallbackReason: opts.fallbackReason,
    originalRoute: opts.originalRoute,
    stageTimings: opts.stageTimings,
  });
  return {
    route: "fallback_openai",
    source: "openai_fallback",
    cacheHit: false,
    assistantText,
    englishText:
      String(backendResponse?.assistant?.english || "").trim() || assistantText,
    intent: "assistant",
    title: "Assistant",
    details: assistantText,
    profileSummary: "",
    meta: {
      source: "backend_openai_fallback",
      fallback_reason: opts.fallbackReason,
      original_route: opts.originalRoute || undefined,
      backendResponse,
      classified: opts.decision,
      orchestratorDecision: opts.decision,
      route: "fallback_openai",
      responsePath: "backend_openai_fallback",
      stageTimings: opts.stageTimings,
    },
  };
}

async function buildCloudFallbackConsentTurn(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  fallbackReason: BackendFallbackReason;
  originalRoute?: string | null;
  decision: OrchestratorDecision;
  stageTimings: Record<string, number>;
  appendUserTurn?: boolean;
}): Promise<LocalAssistantTurnResult> {
  if (opts.appendUserTurn) {
    await appendConversation(opts.userId, "user", opts.message);
  }
  await appendConversation(opts.userId, "assistant", CLOUD_FALLBACK_CONSENT_MESSAGE);
  const cloudFallback: CloudConsentRequiredState = {
    kind: "cloud_consent_required",
    reason: opts.fallbackReason,
    localAnswerAvailable: false,
    suggestedAction: "ask_user_consent",
  };
  const decision: OrchestratorDecision = {
    ...opts.decision,
    route: "fallback_openai",
    reason: opts.fallbackReason,
    needsClarification: false,
    clarificationQuestion: "",
    fallbackAllowed: false,
  };
  await appendRouteDecisionLog(opts.userId, opts.message, decision, {
    routeUsed: "cloud_consent_required",
    source: "local_rules",
    cloudFallback,
    fallbackReason: opts.fallbackReason,
    originalRoute: opts.originalRoute,
    stageTimings: opts.stageTimings,
  });
  return {
    kind: "cloud_consent_required",
    route: "fallback_openai",
    source: "local_rules",
    cacheHit: false,
    assistantText: CLOUD_FALLBACK_CONSENT_MESSAGE,
    englishText: CLOUD_FALLBACK_CONSENT_MESSAGE,
    intent: "clarify",
    title: "Cloud fallback",
    details: CLOUD_FALLBACK_CONSENT_MESSAGE,
    profileSummary: "",
    cloudFallback,
    meta: {
      source: "cloud_consent_required",
      fallback_reason: opts.fallbackReason,
      original_route: opts.originalRoute || undefined,
      cloudFallback,
      classified: decision,
      orchestratorDecision: decision,
      route: "cloud_consent_required",
      responsePath: "cloud_consent_required",
      stageTimings: opts.stageTimings,
    },
  };
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

async function runProfilerExtractionInsideNormalChat(opts: {
  userId: number;
  message: string;
  replyLanguage: ReplyLanguage;
  answers: Record<string, string | string[]>;
  userProfile?: LocalUserProfile;
}) {
  const slots = await getProfilerSlots();
  const currentState = await loadProfilerState(opts.userId);
  const rules = await getMemoryRules();
  const replyLanguageName = languageLabel(
    String(opts.answers.preferred_language || opts.replyLanguage || "english"),
  );
  const deterministicPreview = deterministicProfilerExtraction(
    opts.message,
    slots,
    opts.answers,
    currentState,
    replyLanguageName,
  );
  const profileFacts = heuristicMemoryCandidates(
    [{ role: "user", content: opts.message, createdAt: nowIso() }],
    rules,
  );
  const hasProfileUpdates = Object.values(
    deterministicPreview.updates || {},
  ).some(nonEmptyAnswer);
  const hasDurableProfileFact = profileFacts.length > 0;
  const hasIncompleteProfile = missingSlots(slots, opts.answers).length > 0;
  const shouldRun =
    hasProfileUpdates ||
    hasDurableProfileFact ||
    (currentState.status === "active" && hasIncompleteProfile);

  if (!shouldRun) {
    return {
      ran: false,
      answers: opts.answers,
      state: currentState,
      source: "skipped" as const,
      missingSlots: missingSlots(slots, opts.answers),
      updates: {},
    };
  }

  const processed = await runProfilerTurnModel(
    opts.message,
    replyLanguageName,
    opts.answers,
    currentState,
    slots,
    {
      ...opts.userProfile,
      replyLanguage: fallbackReplyLanguageCode(replyLanguageName) as ReplyLanguage,
    },
  );
  const updates = normalizeMemoryProfileUpdates(
    slots,
    processed.output.updates || {},
  );
  const merged = mergeProfilerUpdates(slots, opts.answers, updates);
  const changed =
    JSON.stringify(merged) !== JSON.stringify(opts.answers) ||
    (processed.output.optional_profile_notes || []).length > 0;
  const mergedConfidenceBySlot = slotConfidenceMap(
    slots,
    currentState.confidenceBySlot || {},
    processed.output.confidence_by_slot || {},
    merged,
  );
  const remaining = missingSlots(slots, merged);
  const done = remaining.length === 0;
  const optionalProfileNotes = uniq(
    [
      ...(currentState.optionalProfileNotes || []),
      ...(processed.output.optional_profile_notes || []).map(String),
    ]
      .map((note) => note.trim())
      .filter(Boolean),
  ).slice(-20);
  const nextSlotCandidate = chooseNextProfilerSlot(
    slots,
    merged,
    mergedConfidenceBySlot,
    Object.keys(updates),
  );
  const nextState: LocalProfilerState = {
    ...currentState,
    status: done ? "complete" : currentState.status === "idle" ? "active" : currentState.status,
    startedAt: currentState.startedAt || nowIso(),
    lastUpdatedAt: nowIso(),
    currentTargetSlot: done ? undefined : nextSlotCandidate?.id || remaining[0],
    missingSlots: remaining,
    confidenceBySlot: mergedConfidenceBySlot,
    optionalProfileNotes,
    lastRunSource: processed.source,
    history: [
      ...(currentState.history || []),
      { role: "user" as const, content: opts.message, createdAt: nowIso() },
    ].slice(-40),
  };

  if (changed) {
    await saveAnswers(opts.userId, merged);
    await saveProfilerState(opts.userId, nextState);
    await buildProfileSummaryLocally(opts.userId, {
      ...opts.userProfile,
      replyLanguage: opts.replyLanguage,
    }).catch(() => "");
    await safeRecordTrainingSample("profiler", {
      input: opts.message,
      expectedOutput: JSON.stringify(updates),
      label: "normal_chat_profile_extraction",
      metadata: {
        userId: opts.userId,
        source: processed.source,
        missingSlots: remaining,
        profileFacts: profileFacts.map((row) => row.fact),
      },
    });
  }

  return {
    ran: changed,
    answers: merged,
    state: nextState,
    source: processed.source,
    missingSlots: remaining,
    updates,
  };
}

export async function runLocalAssistantTurn(opts: {
  userId: number;
  message: string;
  replyLanguage?: ReplyLanguage;
  userProfile?: LocalUserProfile;
  userAllowedCloudFallback?: boolean;
  modelTier?: ModelTierName;
  deviceInfo?: DeviceCapabilitySnapshot;
  proOptIn?: boolean;
  requestId?: string | null;
  abortSignal?: AbortSignal;
  localDeadlineMs?: number;
}): Promise<LocalAssistantTurnResult> {
  const stageTimings: Record<string, number> = {};
  const localBudgetStartedAt = Date.now();
  const localBudgetMs =
    Number.isFinite(Number(opts.localDeadlineMs)) && Number(opts.localDeadlineMs) > 0
      ? Math.max(1, Math.floor(Number(opts.localDeadlineMs) - localBudgetStartedAt))
      : 0;
  const throwIfLocalBudgetExceeded = (stage: string) => {
    const reason = (opts.abortSignal as any)?.reason;
    if (opts.abortSignal?.aborted) {
      if (reason instanceof LocalBudgetExceededError) {
        throw reason;
      }
      throw new LocalBudgetExceededError(
        `Local assistant budget was aborted during ${stage}.`,
        {
          timeoutMs: localBudgetMs || 1,
          source: "local_agents",
          stage,
        },
      );
    }
    if (
      Number.isFinite(Number(opts.localDeadlineMs)) &&
      Number(opts.localDeadlineMs) > 0 &&
      Date.now() >= Number(opts.localDeadlineMs)
    ) {
      throw new LocalBudgetExceededError(
        `Local assistant exceeded backend fallback budget during ${stage}.`,
        {
          timeoutMs: localBudgetMs || 1,
          source: "local_agents",
          stage,
        },
      );
    }
  };
  const timeStage = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    throwIfLocalBudgetExceeded(label);
    let value!: T;
    try {
      value = await fn();
    } finally {
      stageTimings[label] = (stageTimings[label] || 0) + (Date.now() - startedAt);
    }
    throwIfLocalBudgetExceeded(label);
    return value;
  };
  const userId = opts.userId;
  const message = String(opts.message || "").trim();
  const replyLanguage = resolveReplyLanguage({
    explicit: opts.replyLanguage,
    profile: opts.userProfile?.replyLanguage,
    message,
    productDefault: PRODUCT_DEFAULT_REPLY_LANGUAGE,
  });
  if (!message) throw new Error("Message is required.");

  const quick = tryBuildQuickLocalReply({
    message,
    replyLanguage,
    assistantName: opts.userProfile?.assistantName,
    userName: opts.userProfile?.name,
  });

  if (quick) {
    const decision = quickLocalDecision(quick);

    await appendQuickLocalReplyIfReady(userId, message, quick, decision);

    return {
      route: quick.route,
      source: quick.source,
      cacheHit: false,
      assistantText: quick.assistantText,
      englishText: quick.englishText,
      intent: quick.intent,
      title: quick.title,
      details: quick.assistantText,
      profileSummary: "",
      meta: {
        source: quick.source,
        route: quick.route,
        fastPath: true,
        responsePath: "quick_reply",
        confidence: quick.confidence,
        classified: decision,
        orchestratorDecision: decision,
        stageTimings,
      },
    } satisfies LocalAssistantTurnResult;
  }

  const earlyNativeSafetyStatus = getNativeInferenceSafetyStatus({
    mode: "native_on_device",
    modelsReady: false,
  });
  const earlyNativeGeneralChatSafety = earlyNativeSafetyStatus.generalChat;
  if (!isLikelyDeterministicLocalRequest(message)) {
    const exactSemantic = await timeStage("semantic_cache_exact", () =>
      lookupSemanticCacheExact(userId, message),
    );
    if (exactSemantic) {
      const assistantText =
        exactSemantic.lastPresentedAnswer ||
        exactSemantic.englishAnswer ||
        exactSemantic.canonicalAnswer;
      logClientWorkflowStep({
        event: "client_semantic_cache_exact_hit",
        user_id: userId,
        request_id: opts.requestId || undefined,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "semantic_cache",
        route_taken: "semantic_cache",
        workflow_step: "semantic_cache",
        workflow_phase: "completed",
        cache_hit: true,
        cache_source: "semantic_cache_exact",
        stage_timings: stageTimings,
      });
      await appendConversation(userId, "user", message);
      await appendConversation(userId, "assistant", assistantText);
      return {
        route: "semantic_cache",
        source: "semantic_cache",
        cacheHit: true,
        assistantText,
        englishText:
          exactSemantic.englishAnswer ||
          exactSemantic.canonicalAnswer ||
          assistantText,
        intent: exactSemantic.intent || "assistant",
        profileSummary: "",
        meta: {
          sourceQuestion: message,
          matchedQuestion: exactSemantic.sourceQuestion,
          similarity: exactSemantic.score,
          confidence: exactSemantic.confidence ?? exactSemantic.score,
          semanticCache: {
            confidence: exactSemantic.confidence ?? exactSemantic.score,
            sourceQuestion: exactSemantic.sourceQuestion,
            sourceLabels: exactSemantic.sourceLabels || [exactSemantic.route],
          },
          source: "semantic_cache",
          route: "semantic_cache",
          fastPath: true,
          responsePath: "semantic_cache",
          stageTimings,
        },
      } satisfies LocalAssistantTurnResult;
    }
  }
  if (
    shouldRouteGeneralQuestionToBackendEarly(
      message,
      earlyNativeGeneralChatSafety,
      opts.userAllowedCloudFallback,
    )
  ) {
    const decision: OrchestratorDecision = {
      route: "fallback_openai",
      reason: "local_model_unavailable",
      confidence: 1,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "native_inference_guard",
      fallbackAllowed: opts.userAllowedCloudFallback === true,
    };
    stageTimings.native_inference_guard =
      stageTimings.native_inference_guard || 0;
    logClientWorkflowStep({
      event: "client_local_path_skipped_for_safety",
      user_id: userId,
      request_id: opts.requestId || undefined,
      channel: "text",
      question: message,
      question_length: textLength(message),
      agent_source: "local_safety_guard",
      route_taken: "local_native_guard",
      workflow_step: "native_inference_guard",
      workflow_phase: "skipped",
      fallback_reason: "local_model_unavailable",
      native_safety_status: earlyNativeSafetyStatus,
      device_memory_status: {
        lowMemory: opts.deviceInfo?.lowMemory ?? null,
        lowRamDevice: opts.deviceInfo?.lowRamDevice ?? null,
        availableMemoryBytes: opts.deviceInfo?.availableMemoryBytes ?? null,
      },
      stage_timings: stageTimings,
    });
    if (opts.userAllowedCloudFallback === true) {
      throwIfLocalBudgetExceeded("backend_fallback");
      return buildBackendFallbackTurn({
        userId,
        message,
        replyLanguage,
        requestId: opts.requestId,
        fallbackReason: "local_model_unavailable",
        originalRoute: "native_inference_guard",
        decision,
        stageTimings,
        appendUserTurn: true,
      });
    }
    return buildCloudFallbackConsentTurn({
      userId,
      message,
      replyLanguage,
      fallbackReason: "local_model_unavailable",
      originalRoute: "native_inference_guard",
      decision,
      stageTimings,
      appendUserTurn: true,
    });
  }

  await timeStage("ensure_agent_data", () => ensureLocalAgentData());
  const routesConfig = await getOrchestratorConfig();
  const cfg = await getModelConfig();
  let modelRuntimeOptions: ModelRuntimeTierOptions = {
    modelTier: opts.modelTier,
    deviceInfo: opts.deviceInfo,
    proOptIn: opts.proOptIn,
    requestId: opts.requestId || undefined,
    selectedTier: selectedTierForRuntime(cfg, {
      modelTier: opts.modelTier,
      deviceInfo: opts.deviceInfo,
      proOptIn: opts.proOptIn,
    }),
  };
  const earlyRuleDecision = ruleBasedOrchestratorDecision(
    message,
    replyLanguage,
    routesConfig,
    "rules",
  );
  if (
    (earlyRuleDecision?.route === "fast_greeting" &&
      canReturnImmediateFastGreeting(message)) ||
    earlyRuleDecision?.route === "wellbeing_support"
  ) {
    const assistantText =
      earlyRuleDecision.route === "wellbeing_support"
        ? wellbeingSupportAnswer(replyLanguage)
        : replyLanguage === "ta"
          ? `வணக்கம் ${opts.userProfile?.name || ""}. நான் எப்படி உதவலாம்?`.trim()
          : `Hi ${opts.userProfile?.name || "there"}, how can I help?`;
    const englishText =
      earlyRuleDecision.route === "wellbeing_support"
        ? wellbeingSupportAnswer("en")
        : assistantText;
    await appendConversation(userId, "user", message);
    await appendConversation(userId, "assistant", assistantText);
    await appendRouteDecisionLog(userId, message, earlyRuleDecision, {
      routeUsed: earlyRuleDecision.route,
      source: "local_rules",
      fastPath: true,
      fallbackPolicy: {
        backendRole: cfg.runtime?.backendRole || "fallback_only",
        openAiPolicy: cfg.runtime?.openAiPolicy || "fallback_only",
        allowedWhen: routesConfig.fallbackPolicy?.openAiAllowedWhen || [],
      },
    });
    return {
      route: earlyRuleDecision.route,
      source: "local_rules",
      cacheHit: false,
      assistantText,
      englishText,
      intent: "assistant",
      profileSummary: "",
      meta: {
        classified: earlyRuleDecision,
        orchestratorDecision: earlyRuleDecision,
        stageTimings: {
          ...stageTimings,
          route_classification: 0,
        },
        source: "local_rules",
        route: earlyRuleDecision.route,
        fastPath: true,
        responsePath: "quick_reply",
        runtime: {
          primary: cfg.runtime?.primary || "phone_local",
          mode: cfg.runtime?.mode || "native_on_device",
          backendRole: cfg.runtime?.backendRole || "fallback_only",
          openAiPolicy: cfg.runtime?.openAiPolicy || "fallback_only",
          nativeBackend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
          nativeModuleName:
            cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName || "JaiOnDeviceModel",
          modelRoot: cfg.native?.modelRoot || "document://models",
          modelDeliveryMode: getModelDeliveryMode(cfg),
          selectedModelTier: modelRuntimeOptions.selectedTier,
          adapterLocation: cfg.runtime?.adapterLocation || "external_lan",
          allowDeviceLoopback: Boolean(cfg.runtime?.allowDeviceLoopback),
        },
        fallbackPolicy: {
          allowedWhen: routesConfig.fallbackPolicy?.openAiAllowedWhen || [],
        },
      },
    } satisfies LocalAssistantTurnResult;
  }

  const readiness = await timeStage("model_readiness", () =>
    getNormalChatModelReadiness(cfg, {
      modelTier: opts.modelTier,
      deviceInfo: opts.deviceInfo,
      proOptIn: opts.proOptIn,
    }),
  );
  if (readiness.status) {
    modelRuntimeOptions = modelTierOptionsFromInstallStatus(
      modelRuntimeOptions,
      readiness.status,
    );
  } else {
    modelRuntimeOptions = {
      ...modelRuntimeOptions,
      selectedTier: readiness.selectedTier,
      installedModelIds: readiness.installedModelIds,
      modelsReady: readiness.ready,
    };
  }
  const nativeSafetyStatus = getNativeInferenceSafetyStatus({
    mode: cfg.runtime?.mode,
    nativeModuleName:
      cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName,
    modelsReady: modelRuntimeOptions.modelsReady,
  });
  const nativeGeneralChatSafety = nativeSafetyStatus.generalChat;
  const nativeEmbeddingSafety = nativeSafetyStatus.embeddings;

  const globalKnowledgeHit = await timeStage("global_knowledge_cache", () =>
    (async () => {
      logClientWorkflowStep({
        event: "client_global_knowledge_lookup_started",
        user_id: userId,
        request_id: opts.requestId || undefined,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "global_rag",
        route_taken: "global_knowledge_cache",
        workflow_step: "global_knowledge_lookup",
        workflow_phase: "started",
        cache_source: "global_knowledge_sync",
        stage_timings: stageTimings,
      });
      return lookupSyncedGlobalKnowledge(message, {
        embedTexts:
          modelRuntimeOptions.modelsReady === false ||
          isLiveOrCurrentGlobalKnowledgeQuestion(message) ||
          !nativeEmbeddingSafety.safe
            ? undefined
            : (texts) => embedTexts(texts, modelRuntimeOptions),
      });
    })(),
  );
  if (globalKnowledgeHit) {
    logClientWorkflowStep({
      event: "client_global_knowledge_lookup_hit",
      user_id: userId,
      request_id: opts.requestId || undefined,
      channel: "text",
      question: message,
      question_length: textLength(message),
      agent_source: "global_rag",
      route_taken: "global_knowledge_cache",
      workflow_step: "global_knowledge_lookup",
      workflow_phase: "completed",
      cache_hit: true,
      cache_source: globalKnowledgeHit.source,
      duration_ms: stageTimings.global_knowledge_cache,
      stage_timings: stageTimings,
    });
    const assistantText = globalKnowledgeHit.entry.answer;
    await appendConversation(userId, "user", message);
    await appendConversation(userId, "assistant", assistantText);
    const decision: OrchestratorDecision = {
      route: "global_knowledge_cache",
      reason: "synced_global_knowledge_hit",
      confidence: globalKnowledgeHit.score,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "global_knowledge_cache",
      fallbackAllowed: false,
    };
    await appendRouteDecisionLog(userId, message, decision, {
      routeUsed: "global_knowledge_cache",
      source: "global_rag",
      fastPath: true,
      responsePath: "global_knowledge_cache",
      globalKnowledge: {
        id: globalKnowledgeHit.entry.id,
        score: globalKnowledgeHit.score,
        matchSource: globalKnowledgeHit.source,
        topic: globalKnowledgeHit.entry.topic,
      },
      stageTimings,
      fallbackPolicy: {
        backendRole: cfg.runtime?.backendRole || "fallback_only",
        openAiPolicy: cfg.runtime?.openAiPolicy || "fallback_only",
        allowedWhen: routesConfig.fallbackPolicy?.openAiAllowedWhen || [],
      },
    });
    return {
      route: "global_knowledge_cache",
      source: "global_rag",
      cacheHit: true,
      assistantText,
      englishText: assistantText,
      intent: "assistant",
      details: assistantText,
      profileSummary: "",
      meta: {
        source: "global_rag",
        route: "global_knowledge_cache",
        fastPath: true,
        responsePath: "global_knowledge_cache",
        cacheHit: true,
        globalKnowledge: {
          id: globalKnowledgeHit.entry.id,
          score: globalKnowledgeHit.score,
          matchSource: globalKnowledgeHit.source,
          confidence: globalKnowledgeHit.entry.confidence,
          topic: globalKnowledgeHit.entry.topic,
        },
        classified: decision,
        orchestratorDecision: decision,
        stageTimings,
      },
    } satisfies LocalAssistantTurnResult;
  }

  logClientWorkflowStep({
    event: "client_global_knowledge_lookup_miss",
    user_id: userId,
    request_id: opts.requestId || undefined,
    channel: "text",
    question: message,
    question_length: textLength(message),
    agent_source: "global_rag",
    route_taken: "global_knowledge_cache",
    workflow_step: "global_knowledge_lookup",
    workflow_phase: "completed",
    cache_hit: false,
    cache_source: "global_knowledge_sync",
    duration_ms: stageTimings.global_knowledge_cache,
    stage_timings: stageTimings,
  });

  if (
    readiness.required &&
    !readiness.ready &&
    !canServeWithRulesOrToolsBeforeModelSetup(message, earlyRuleDecision)
  ) {
    const decision: OrchestratorDecision = {
      route: "fallback_openai",
      reason: "local_model_unavailable",
      confidence: 1,
      needsClarification: false,
      clarificationQuestion: "",
      needsLiveData: false,
      selectedModel: "rules",
      fallbackAllowed: opts.userAllowedCloudFallback === true,
    };
    if (opts.userAllowedCloudFallback === true) {
      throwIfLocalBudgetExceeded("backend_fallback");
      return buildBackendFallbackTurn({
        userId,
        message,
        replyLanguage,
        requestId: opts.requestId,
        fallbackReason: "local_model_unavailable",
        originalRoute: "setup_required",
        decision,
        stageTimings,
        appendUserTurn: true,
      });
    }
    return buildCloudFallbackConsentTurn({
      userId,
      message,
      replyLanguage,
      fallbackReason: "local_model_unavailable",
      originalRoute: "setup_required",
      decision,
      stageTimings,
      appendUserTurn: true,
    });
  }

  let answers = await loadAnswers(userId);
  let normalChatProfiler = skippedNormalChatProfiler(answers);
  if (isExplicitProfileOrMemoryUpdate(message) && nativeGeneralChatSafety.safe) {
    normalChatProfiler = await timeStage("profiler", () =>
      runProfilerExtractionInsideNormalChat({
        userId,
        message,
        replyLanguage,
        answers,
        userProfile: opts.userProfile,
      }),
    );
    answers = normalChatProfiler.answers;
  }
  const profileSummary = await loadSummary(userId);

  const semantic = await timeStage("semantic_cache", () =>
    (async () => {
      logClientWorkflowStep({
        event: "client_semantic_cache_lookup_started",
        user_id: userId,
        request_id: opts.requestId || undefined,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "semantic_cache",
        route_taken: "semantic_cache",
        workflow_step: "semantic_cache",
        workflow_phase: "started",
        cache_source: "semantic_cache",
        stage_timings: stageTimings,
      });
      return lookupSemanticCache(userId, message, modelRuntimeOptions, {
        route: earlyRuleDecision?.route,
        allowVectorEmbeddings: nativeEmbeddingSafety.safe,
        onTelemetry: (event, payload = {}) =>
          logClientWorkflowStep({
            event,
            user_id: userId,
            request_id: opts.requestId || undefined,
            channel: "text",
            question: message,
            question_length: textLength(message),
            agent_source: "semantic_cache",
            route_taken: "semantic_cache",
            workflow_step: "semantic_cache",
            workflow_phase: String(payload.workflow_phase || "completed"),
            stage_timings: stageTimings,
            ...payload,
          }),
      });
    })(),
  );
  if (semantic) {
    const needsAlignmentReapply =
      semantic.alignmentProfile?.replyLanguage !== replyLanguage ||
      normalizeText(semantic.alignmentProfile?.tone || "") !==
        normalizeText(displayValue(answers.communication_tone));
    const aligned = needsAlignmentReapply && nativeGeneralChatSafety.safe
      ? await timeStage("alignment", () =>
          alignAnswer(
            semantic.englishAnswer || semantic.canonicalAnswer,
            replyLanguage,
            "semantic_cache",
            answers,
            profileSummary,
            opts.userProfile,
            modelRuntimeOptions,
          ),
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
    await appendConversation(userId, "user", message);
    await appendConversation(userId, "assistant", assistantText);
    enqueueLocalIdleJob("semantic_cache_hit", async () => {
      await recordSemanticCacheHit(userId, {
        userId,
        sourceQuestion: message,
        matchedQuestion: semantic.sourceQuestion,
        similarity: semantic.score,
        confidence: semantic.confidence ?? semantic.score,
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
          confidence: semantic.confidence ?? semantic.score,
          matchedQuestion: semantic.sourceQuestion,
          alignmentReapplied: needsAlignmentReapply,
        },
      });
    }, { delayMs: 120, staggerMs: 300 });
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
        confidence: semantic.confidence ?? semantic.score,
        semanticCache: {
          confidence: semantic.confidence ?? semantic.score,
          sourceQuestion: semantic.sourceQuestion,
          sourceLabels: semantic.sourceLabels || [semantic.route],
        },
        sources: (semantic.sourceLabels || [semantic.route]).map((label) => ({
          source_name: label,
          category: "semantic_cache",
          confidence: semantic.confidence ?? semantic.score,
        })),
        timestamp: nowIso(),
        alignmentReapplied: needsAlignmentReapply,
        source: "semantic_cache",
        route: "semantic_cache",
        fastPath: false,
        responsePath: "semantic_cache",
        stageTimings,
        profiler: {
          ran: normalChatProfiler.ran,
          source: normalChatProfiler.source,
          missingSlots: normalChatProfiler.missingSlots,
          updates: normalChatProfiler.updates,
        },
        dataFolder: DATA_DIR,
        trainingFolder: TRAINING_DIR,
        ragFolder: RAG_DIR,
      },
    } satisfies LocalAssistantTurnResult;
  }

  if (!canAnswerRouteWithoutNativeInference(earlyRuleDecision)) {
    if (!nativeGeneralChatSafety.safe) {
      const decision: OrchestratorDecision = {
        route: "fallback_openai",
        reason: "local_model_unavailable",
        confidence: 1,
        needsClarification: false,
        clarificationQuestion: "",
        needsLiveData: false,
        selectedModel: "native_inference_guard",
        fallbackAllowed: opts.userAllowedCloudFallback === true,
      };
      stageTimings.native_inference_guard =
        stageTimings.native_inference_guard || 0;
      logClientWorkflowStep({
        event: "client_local_path_skipped_for_safety",
        user_id: userId,
        request_id: opts.requestId || undefined,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "local_safety_guard",
        route_taken: "local_native_guard",
        workflow_step: "native_inference_guard",
        workflow_phase: "skipped",
        fallback_reason: "local_model_unavailable",
        native_safety_status: nativeSafetyStatus,
        stage_timings: stageTimings,
      });
      if (opts.userAllowedCloudFallback === true) {
        throwIfLocalBudgetExceeded("backend_fallback");
        return buildBackendFallbackTurn({
          userId,
          message,
          replyLanguage,
          requestId: opts.requestId,
          fallbackReason: "local_model_unavailable",
          originalRoute: "native_inference_guard",
          decision,
          stageTimings,
          appendUserTurn: true,
        });
      }
      return buildCloudFallbackConsentTurn({
        userId,
        message,
        replyLanguage,
        fallbackReason: "local_model_unavailable",
        originalRoute: "native_inference_guard",
        decision,
        stageTimings,
        appendUserTurn: true,
      });
    }
  }

  await appendConversation(userId, "user", message);

  const registry = await getAgentRegistry();

  const turns = await recentConversation(userId, 10);
  const preferredSelectedModel = selectedReasonerModel(
    cfg,
    routesConfig,
    message,
    turns.length,
    undefined,
    modelRuntimeOptions,
  );
  const fastDecision = ruleBasedOrchestratorDecision(
    message,
    replyLanguage,
    routesConfig,
    preferredSelectedModel,
  );
  const fullLocalRequestId =
    opts.requestId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let pendingFullLocalMarkerSet = false;
  const markFullLocalTurn = async () => {
    if (pendingFullLocalMarkerSet) return;
    pendingFullLocalMarkerSet = true;
    await markPendingLocalTurn({
      requestId: fullLocalRequestId,
      userId,
      question: message,
    }).catch(() => undefined);
  };
  const clearFullLocalTurn = async () => {
    if (!pendingFullLocalMarkerSet) return;
    await clearPendingLocalTurn(fullLocalRequestId).catch(() => undefined);
    pendingFullLocalMarkerSet = false;
  };
  let decision = await timeStage("route_classification", async () => {
    if (fastDecision) return fastDecision;
    await markFullLocalTurn();
    logClientWorkflowStep({
      event: "client_local_model_started",
      user_id: userId,
      request_id: fullLocalRequestId,
      channel: "text",
      question: message,
      question_length: textLength(message),
      agent_source: "local_model",
      route_taken: "route_classification",
      workflow_step: "local_model_route_classification",
      workflow_phase: "started",
      model_tier: modelRuntimeOptions.selectedTier,
      native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
      local_runtime_mode: cfg.runtime?.mode || "native_on_device",
      stage_timings: stageTimings,
    });
    try {
      throwIfLocalBudgetExceeded("local_model_route_classification");
      const classified = await classifyRouteWithModel(
        message,
        replyLanguage,
        answers,
        profileSummary,
        preferredSelectedModel,
        modelRuntimeOptions,
      );
      throwIfLocalBudgetExceeded("local_model_route_classification");
      logClientWorkflowStep({
        event: "client_local_model_completed",
        user_id: userId,
        request_id: fullLocalRequestId,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "local_model",
        route_taken: classified.route,
        workflow_step: "local_model_route_classification",
        workflow_phase: "completed",
        decision: classified.route,
        model_used: preferredSelectedModel,
        model_tier: modelRuntimeOptions.selectedTier,
        native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
        local_runtime_mode: cfg.runtime?.mode || "native_on_device",
        stage_timings: stageTimings,
      });
      return classified;
    } catch {
      logClientWorkflowStep({
        event: "client_local_model_failed",
        user_id: userId,
        request_id: fullLocalRequestId,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "local_model",
        route_taken: "route_classification",
        workflow_step: "local_model_route_classification",
        workflow_phase: "failed",
        error_type: "route_classification_failed",
        model_used: preferredSelectedModel,
        model_tier: modelRuntimeOptions.selectedTier,
        native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
        local_runtime_mode: cfg.runtime?.mode || "native_on_device",
        stage_timings: stageTimings,
      });
      return {
        route: "local_answer",
        reason: "route_classification_failed",
        confidence: 0.1,
        needsClarification: false,
        clarificationQuestion: "",
        needsLiveData: false,
        selectedModel: preferredSelectedModel,
        fallbackAllowed: false,
      } satisfies OrchestratorDecision;
    }
  });

  enqueueLocalIdleJob("orchestrator_training", () => {
    return safeRecordTrainingSample("orchestrator", {
      input: message,
      expectedOutput: JSON.stringify(decision),
      label: fastDecision ? "fast_rule_route" : "model_route",
      metadata: {
        userId,
        replyLanguage,
        profileSummary,
        availableToolAgents: registry.agents.toolAgents,
        selectedModel: preferredSelectedModel,
        selectedModelTier: modelRuntimeOptions.selectedTier,
      },
    });
  }, { delayMs: 180, staggerMs: 300 });

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
  let cloudFallback: CloudConsentRequiredState | undefined;
  let toolPlan: ToolPlan | undefined;
  let toolResults: LocalToolResult[] = [];
  let toolVerification: ToolVerificationResult | undefined;
  let handledByToolPlan = false;
  let ragResponseMetadata:
    | {
        rewrittenQuery: string;
        usedSources: LocalRagSourceMetadata[];
      }
    | undefined;
  let fallbackReason: BackendFallbackReason | undefined;
  let backendFallbackResponse: any | undefined;

  if (decision.needsLiveData && route !== "weather") {
    route = "fallback_openai";
    fallbackReason = "live_data_needed";
  }

  toolPlan = await timeStage("tool_plan", async () =>
    planLocalTools({ message, decision }),
  );
  if (
    shouldExecuteToolPlan(toolPlan, route) &&
    toolPlanAvailable(toolPlan, registry)
  ) {
    handledByToolPlan = true;
    route = routeForToolPlan(toolPlan, route);
    source = "local_rules";
    toolResults = await timeStage("tool_plan", () =>
      executeToolPlan(toolPlan as ToolPlan, {
        userId,
        message,
        replyLanguage,
        answers,
        profileSummary,
        userProfile: opts.userProfile,
        runtimeOptions: modelRuntimeOptions,
      }),
    );
    draft = composeToolDraft(toolPlan, toolResults, {
      userId,
      message,
      replyLanguage,
      answers,
      profileSummary,
      userProfile: opts.userProfile,
    });
    toolVerification = verifyToolDraft(draft, toolResults, replyLanguage);
    const reminderDraft = resultByTool<ReminderDraftToolData>(
      toolResults,
      "createReminder",
    );
    if (reminderDraft?.ok && reminderDraft.data) {
      intent = "reminder";
      title = reminderDraft.data.title;
      details = reminderDraft.data.details;
      datetimeText = reminderDraft.data.datetimeText;
    }
    const aligned = await timeStage("alignment", () =>
      alignAnswer(
        draft,
        replyLanguage,
        route,
        answers,
        profileSummary,
        opts.userProfile,
        modelRuntimeOptions,
      ),
    );
    english = aligned.english;
    final = aligned.final;
  }

  if (handledByToolPlan) {
    // The deterministic planner/executor already produced the local answer.
  } else if (route === "fast_greeting") {
    const quickDraft = deterministicQuickReplyForRoute(route, {
      message,
      replyLanguage,
      userProfile: opts.userProfile,
    });
    source = "local_rules";
    draft =
      quickDraft?.assistantText ||
      (replyLanguage === "ta"
        ? `வணக்கம் ${opts.userProfile?.name || ""}. நான் எப்படி உதவலாம்?`.trim()
        : `Hi ${opts.userProfile?.name || "there"}, how can I help?`);
    english = quickDraft?.englishText || draft;
    final = draft;
  } else if (
    route === "identity" ||
    route === "small_talk" ||
    route === "capabilities" ||
    route === "knowledge_ack" ||
    route === "thanks" ||
    route === "goodbye"
  ) {
    const quickDraft = deterministicQuickReplyForRoute(route, {
      message,
      replyLanguage,
      userProfile: opts.userProfile,
    });
    source = "local_rules";
    draft = quickDraft?.assistantText || "I'm here with you. What would you like to do?";
    english = quickDraft?.englishText || draft;
    final = draft;
  } else if (route === "wellbeing_support") {
    source = "local_rules";
    const quickDraft = deterministicQuickReplyForRoute(route, {
      message,
      replyLanguage,
      userProfile: opts.userProfile,
    });
    draft = quickDraft?.assistantText || wellbeingSupportAnswer(replyLanguage);
    english = quickDraft?.englishText || wellbeingSupportAnswer("en");
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
      runtimeOptions: modelRuntimeOptions,
    }).catch(() =>
      replyLanguage === "ta"
        ? "உங்களைப் பற்றிய சில தகவல்கள் என்கிட்ட இருக்கு. இதை கொஞ்சம் நேராக கேளுங்கள்."
        : "I do have some profile information about you. Ask that a little more directly.",
    );
    const aligned = await timeStage("alignment", () =>
      alignAnswer(
        draft,
        replyLanguage,
        route,
        answers,
        profileSummary,
        opts.userProfile,
        modelRuntimeOptions,
      ),
    );
    english = aligned.english;
    final = aligned.final;
  } else if (route === "calendar_query") {
    if (!registry.agents.toolAgents.calendar) {
      noSafeLocalPath = true;
      route = "fallback_openai";
      fallbackReason = "no_safe_local_answer";
    } else {
      source = "local_rules";
      draft = await buildScheduleAnswer(userId, message);
      const aligned = await timeStage("alignment", () =>
        alignAnswer(
          draft,
          replyLanguage,
          route,
          answers,
          profileSummary,
          opts.userProfile,
          modelRuntimeOptions,
        ),
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
    const aligned = await timeStage("alignment", () =>
      alignAnswer(
        draft,
        replyLanguage,
        route,
        answers,
        profileSummary,
        opts.userProfile,
        modelRuntimeOptions,
      ),
    );
    english = aligned.english;
    final = aligned.final;
  } else if (route === "weather") {
    if (!registry.agents.toolAgents.weather) {
      noSafeLocalPath = true;
      route = "fallback_openai";
      fallbackReason = "live_data_needed";
    } else {
      try {
        draft = await fetchWeatherSummary(message, opts.userProfile);
        const aligned = await timeStage("alignment", () =>
          alignAnswer(
            draft,
            replyLanguage,
            route,
            answers,
            profileSummary,
            opts.userProfile,
            modelRuntimeOptions,
          ),
        );
        english = aligned.english;
        final = aligned.final;
      } catch {
        noSafeLocalPath = true;
        route = "fallback_openai";
        fallbackReason = "live_data_needed";
      }
    }
  } else if (route === "fallback_openai") {
    // defer backend gating until the fallback policy check below
  } else {
    route = "local_answer";
  }

  if (!handledByToolPlan && route === "local_answer") {
    try {
      await markFullLocalTurn();
      logClientWorkflowStep({
        event: "client_local_model_started",
        user_id: userId,
        request_id: fullLocalRequestId,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "local_model",
        route_taken: "local_answer",
        workflow_step: "local_model_answer",
        workflow_phase: "started",
        model_used: decision.selectedModel,
        model_tier: modelRuntimeOptions.selectedTier,
        native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
        local_runtime_mode: cfg.runtime?.mode || "native_on_device",
        stage_timings: stageTimings,
      });
      throwIfLocalBudgetExceeded("local_reasoner");
      const reasoned = await timeStage("local_reasoner", () =>
        buildLocalReasoningWithContext({
          userId,
          message,
          replyLanguage,
          answers,
          profileSummary,
          userProfile: opts.userProfile,
          selectedModel: decision.selectedModel,
          runtimeOptions: modelRuntimeOptions,
        }),
      );
      throwIfLocalBudgetExceeded("local_reasoner");
      draft = reasoned.draft;
      ragResponseMetadata = {
        rewrittenQuery: reasoned.rewrittenQuery,
        usedSources: reasoned.usedSources,
      };
      if (draft === OPENAI_FALLBACK_SIGNAL) {
        localReasonerRequestedFallback = true;
        route = "fallback_openai";
        fallbackReason = "live_data_needed";
        logClientWorkflowStep({
          event: "client_local_model_completed",
          user_id: userId,
          request_id: fullLocalRequestId,
          channel: "text",
          question: message,
          question_length: textLength(message),
          agent_source: "local_model",
          route_taken: "fallback_openai",
          workflow_step: "local_model_answer",
          workflow_phase: "completed",
          decision: "fallback_openai",
          model_used: decision.selectedModel,
          model_tier: modelRuntimeOptions.selectedTier,
          native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
          local_runtime_mode: cfg.runtime?.mode || "native_on_device",
          duration_ms: stageTimings.local_reasoner,
          stage_timings: stageTimings,
        });
      } else {
        const aligned = await timeStage("alignment", () =>
          alignAnswer(
            draft,
            replyLanguage,
            route,
            answers,
            profileSummary,
            opts.userProfile,
            modelRuntimeOptions,
          ),
        );
        english = aligned.english;
        final = aligned.final;
        logClientWorkflowStep({
          event: "client_local_model_completed",
          user_id: userId,
          request_id: fullLocalRequestId,
          channel: "text",
          question: message,
          answer: final,
          question_length: textLength(message),
          answer_length: textLength(final),
          agent_source: "local_model",
          route_taken: "local_answer",
          workflow_step: "local_model_answer",
          workflow_phase: "completed",
          model_used: decision.selectedModel,
          model_tier: modelRuntimeOptions.selectedTier,
          native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
          local_runtime_mode: cfg.runtime?.mode || "native_on_device",
          duration_ms: stageTimings.local_reasoner,
          stage_timings: stageTimings,
        });
      }
    } catch (error) {
      logClientWorkflowStep({
        event: "client_local_model_failed",
        user_id: userId,
        request_id: fullLocalRequestId,
        channel: "text",
        question: message,
        question_length: textLength(message),
        agent_source: "local_model",
        route_taken: "local_answer",
        workflow_step: "local_model_answer",
        workflow_phase: "failed",
        error_type: isLocalTurnTimeoutError(error)
          ? "local_timeout"
          : isNativeOnDeviceRuntimeUnavailableError(error) || isModelInstallError(error)
            ? "local_model_unavailable"
            : "local_processing_error",
        error_name: (error as any)?.name || "Error",
        error_message: String((error as any)?.message || error || "Unknown error").slice(0, 240),
        model_used: decision.selectedModel,
        model_tier: modelRuntimeOptions.selectedTier,
        native_backend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
        local_runtime_mode: cfg.runtime?.mode || "native_on_device",
        duration_ms: stageTimings.local_reasoner,
        stage_timings: stageTimings,
      });
      if (isLocalTurnTimeoutError(error)) {
        route = "fallback_openai";
        decision = {
          ...decision,
          route: "fallback_openai",
          reason: "local_timeout",
          needsClarification: false,
          clarificationQuestion: "",
          fallbackAllowed: opts.userAllowedCloudFallback === true,
        };
        noSafeLocalPath = true;
        fallbackReason = "local_timeout";
      } else if (isNativeOnDeviceRuntimeUnavailableError(error) || isModelInstallError(error)) {
        route = "fallback_openai";
        decision = {
          ...decision,
          route: "fallback_openai",
          reason: "local_model_unavailable",
          needsClarification: false,
          clarificationQuestion: "",
          fallbackAllowed: opts.userAllowedCloudFallback === true,
        };
        noSafeLocalPath = true;
        fallbackReason = "local_model_unavailable";
      } else {
        route = "local_answer";
        source = "local_rules";
        noSafeLocalPath = false;
        fallbackReason = undefined;
        draft = "I hit a local processing error. Please try again.";
        english = draft;
        final = draft;
        decision = {
          ...decision,
          route: "local_answer",
          reason: "local_processing_error",
          needsClarification: false,
          clarificationQuestion: "",
          fallbackAllowed: false,
        };
      }
    }
  }

  if (route === "fallback_openai") {
    const userAllowedCloudFallback = opts.userAllowedCloudFallback === true;
    fallbackReason =
      fallbackReason ||
      (decision.needsLiveData
        ? "live_data_needed"
        : noSafeLocalPath
          ? "no_safe_local_answer"
          : "no_safe_local_answer");
    const fallbackAllowedWithConsent = canUseOpenAiFallback({
      decision,
      localReasonerRequestedFallback,
      needsLiveData: decision.needsLiveData,
      noSafeLocalPath,
      policyAllowedWhen: routesConfig.fallbackPolicy?.openAiAllowedWhen || [],
      openAiPolicy: cfg.runtime?.openAiPolicy,
    });
    decision = {
      ...decision,
      route: "fallback_openai",
      fallbackAllowed: userAllowedCloudFallback && fallbackAllowedWithConsent,
    };
    if (decision.fallbackAllowed) {
      source = "openai_fallback";
      throwIfLocalBudgetExceeded("backend_fallback");
      const backend = await callBackendOpenAiFallback({
        userId,
        message,
        replyLanguage,
        requestId: opts.requestId,
        fallbackReason,
        originalRoute: decision.reason === fallbackReason ? "local_answer" : decision.route,
        stageTimings,
      });
      throwIfLocalBudgetExceeded("backend_fallback");
      backendFallbackResponse = backend;
      const backendText =
        String(
          backend?.assistant?.text ||
            backend?.assistant?.english ||
            backend?.details ||
            backend?.raw_text ||
            "",
        ).trim() || "I couldn’t generate a response.";
      english = String(backend?.assistant?.english || "").trim() || backendText;
      final = backendText;
    } else if (!userAllowedCloudFallback && fallbackAllowedWithConsent) {
      route = "clarify";
      cloudFallback = {
        kind: "cloud_consent_required",
        reason: fallbackReason,
        localAnswerAvailable: Boolean(draft || english || final),
        suggestedAction: "ask_user_consent",
      };
      decision = {
        ...decision,
        route: "clarify",
        reason: cloudFallback.reason,
        needsClarification: false,
        clarificationQuestion: "",
      };
      source = "local_rules";
      intent = "clarify";
      draft = CLOUD_FALLBACK_CONSENT_MESSAGE;
      english = CLOUD_FALLBACK_CONSENT_MESSAGE;
      final = draft;
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
      draft = CLOUD_FALLBACK_CONSENT_MESSAGE;
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
    stageTimings,
    localReasonerRequestedFallback,
    noSafeLocalPath,
    cloudFallback,
    fallbackReason,
    ...(toolPlan?.steps.length
      ? {
          toolPlan,
          toolResults,
          toolVerification,
        }
      : {}),
    ...(ragResponseMetadata ? { rag: ragResponseMetadata } : {}),
    fallbackPolicy: {
      backendRole: cfg.runtime?.backendRole || "fallback_only",
      openAiPolicy: cfg.runtime?.openAiPolicy || "fallback_only",
      allowedWhen: routesConfig.fallbackPolicy?.openAiAllowedWhen || [],
    },
  });

  if (
    assistantText.trim() &&
    route !== "reminder_create" &&
    route !== "clarify" &&
    route !== "setup_required"
  ) {
    enqueueLocalIdleJob("semantic_cache_write", () =>
      writeSemanticCache(
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
        modelRuntimeOptions,
        { allowVectorEmbeddings: nativeEmbeddingSafety.safe },
      ),
      { delayMs: 450, staggerMs: 450 },
    );
  }

  enqueueLocalIdleJob("alignment_training", () => {
    return safeRecordTrainingSample("alignment", {
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
      metadata: {
        userId,
        source,
        decision,
        ...(toolPlan?.steps.length
          ? {
              toolPlan,
              toolResults,
              toolVerification,
            }
          : {}),
        ...(ragResponseMetadata ? { rag: ragResponseMetadata } : {}),
      },
    });
  }, { delayMs: 260, staggerMs: 300 });

  if (
    nativeGeneralChatSafety.safe &&
    !isExplicitProfileOrMemoryUpdate(message) &&
    hasDurableProfileFactCue(message)
  ) {
    enqueueLocalIdleJob("deferred_profile_extraction", () =>
      runProfilerExtractionInsideNormalChat({
        userId,
        message,
        replyLanguage,
        answers,
        userProfile: opts.userProfile,
      }).then(() => undefined),
      { delayMs: 900, staggerMs: 500 },
    );
  }

  if (nativeGeneralChatSafety.safe && shouldAttemptLocalMemoryConsolidation(userId)) {
    enqueueLocalIdleJob("memory_consolidation", () =>
      consolidateLocalMemoryOnIdle(userId, {
        userProfile: { ...opts.userProfile, replyLanguage },
      }).then(() => undefined),
      { delayMs: 3_000, staggerMs: 1_000 },
    );
  }

  await clearFullLocalTurn();

  const responsePath =
    cloudFallback?.kind === "cloud_consent_required"
      ? "cloud_consent_required"
      : toolPlan?.steps.length
        ? "tool_plan"
        : source === "local_model"
          ? "local_model"
          : route === "setup_required"
            ? "setup_required"
            : source === "openai_fallback"
              ? "backend_openai_fallback"
              : "local_rules";

  return {
    kind: cloudFallback?.kind || "assistant_turn",
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
    cloudFallback,
    meta: {
      classified: decision,
      orchestratorDecision: decision,
      ...(cloudFallback ? { cloudFallback } : {}),
      ...(backendFallbackResponse ? { backendResponse: backendFallbackResponse } : {}),
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      ...(source === "openai_fallback"
        ? {
            original_route:
              backendFallbackResponse?.meta?.original_route ||
              (decision.reason === fallbackReason ? "local_answer" : decision.route),
          }
        : {}),
      ...(route === "setup_required" ? { setupRequired: true } : {}),
      ...(toolPlan?.steps.length
        ? {
            tools: {
              plan: toolPlan,
              results: toolResults,
              verification: toolVerification,
              sourceLabels: toolVerification?.sourceLabels || [],
            },
          }
        : {}),
      ...(ragResponseMetadata
        ? {
            rag: ragResponseMetadata,
            sources: ragResponseMetadata.usedSources,
          }
        : {}),
      dataFolder: DATA_DIR,
      trainingFolder: TRAINING_DIR,
      ragFolder: RAG_DIR,
      promptConfig: PROMPTS_PATH,
      modelConfig: MODELS_PATH,
      source:
        source === "openai_fallback" ? "backend_openai_fallback" : source,
      route,
      fastPath: false,
      responsePath,
      stageTimings,
      runtime: {
        primary: cfg.runtime?.primary || "phone_local",
        mode: cfg.runtime?.mode || "native_on_device",
        backendRole: cfg.runtime?.backendRole || "fallback_only",
        openAiPolicy: cfg.runtime?.openAiPolicy || "fallback_only",
        nativeBackend: cfg.native?.backend || cfg.runtime?.nativeBackend || "llama_cpp",
        nativeModuleName:
          cfg.native?.bridgeModuleName || cfg.runtime?.nativeModuleName || "JaiOnDeviceModel",
        modelRoot: cfg.native?.modelRoot || "document://models",
        modelDeliveryMode: getModelDeliveryMode(cfg),
        selectedModelTier: modelRuntimeOptions.selectedTier,
        adapterLocation: cfg.runtime?.adapterLocation || "external_lan",
        allowDeviceLoopback: Boolean(cfg.runtime?.allowDeviceLoopback),
      },
      fallbackPolicy: {
        allowedWhen: routesConfig.fallbackPolicy?.openAiAllowedWhen || [],
      },
      profiler: {
        ran: normalChatProfiler.ran,
        source: normalChatProfiler.source,
        missingSlots: normalChatProfiler.missingSlots,
        updates: normalChatProfiler.updates,
      },
    },
  } satisfies LocalAssistantTurnResult;
}
