import Constants from "expo-constants";

import {
  enqueueClientTurnLog,
  flushClientTurnLogs as flushQueuedClientTurnLogs,
  updateActiveWorkflowStep,
  type ClientTurnLogPayload,
} from "./chatTelemetry";
import { getCachedDeviceCapabilities } from "./deviceCapabilities";
import {
  getE2eVoiceQuery,
  getE2eVoiceSurface,
  isE2eMockAuthEnabled,
  isE2eMockHandsFreeEnabled,
  isE2eMockVoiceTurnEnabled,
} from "./e2eMode";
import { auth } from "./firebase";
import {
  getLocalRuntimeConfigError,
  isLoopbackLocalRuntimeBaseUrl,
  normalizeLocalRuntimeBaseUrl,
} from "./localModelRuntime";
import {
  LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
  getNativeOnDeviceSpeechToTextCapability,
  getNativeOnDeviceModelBridge,
  nativeOnDeviceSttMissingMessage,
} from "./nativeOnDeviceModelBridge";
import {
  loadCachedLocalAssistantProfile,
  withResolvedReplyLanguage,
} from "./localAssistantProfile";
import { tryBuildQuickLocalReply } from "./localQuickReplies";
import { loadCloudFallbackConsent } from "./localAssistantSettings";
import { requiresImmediateBackendCurrentData } from "./currentDataGuards";
import type { GlobalKnowledgeLookupHit } from "./globalKnowledgeSync";
import {
  LocalBudgetExceededError,
  getLocalToBackendFallbackMs,
  isLocalTurnTimeoutError,
} from "./localTurnTimeouts";
import {
  PRODUCT_DEFAULT_REPLY_LANGUAGE,
  ReplyLanguage,
  detectExplicitReplyLanguage,
  normalizeReplyLanguage,
  resolveReplyLanguage,
} from "./replyLanguage";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

export type { ClientTurnLogPayload } from "./chatTelemetry";

export class ApiError extends Error {
  status: number;
  method?: string;
  path?: string;
  endpoint?: string;
  apiBase?: string;

  constructor(
    message: string,
    status: number,
    details: {
      method?: string;
      path?: string;
      endpoint?: string;
      apiBase?: string;
      cause?: unknown;
    } = {},
  ) {
    super(redactSensitiveText(message));
    this.name = "ApiError";
    this.status = status;
    this.method = details.method;
    this.path = details.path;
    this.endpoint = details.endpoint;
    this.apiBase = details.apiBase;

    if (typeof details.cause !== "undefined") {
      (this as any).cause = details.cause;
    }
  }
}

const DEFAULT_API_TIMEOUT_MS = 30_000;
function positiveTimeoutMs(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

export const BACKEND_CHAT_FALLBACK_TIMEOUT_MS = positiveTimeoutMs(
  extra.BACKEND_CHAT_FALLBACK_TIMEOUT_MS ||
    process.env.EXPO_PUBLIC_BACKEND_CHAT_FALLBACK_TIMEOUT_MS,
  90_000,
);
export const CLOUD_FALLBACK_CONSENT_MESSAGE =
  "This needs backend/OpenAI help. Enable cloud fallback to answer this.";

export type BackendFallbackReason =
  | "local_timeout"
  | "local_model_unavailable"
  | "no_safe_local_answer"
  | "live_data_needed";

function isAbortError(error: unknown) {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error as any)?.name === "AbortError"
  );
}

function redactSensitiveText(value: unknown) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("idToken"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
}

function applyApiErrorContext(
  error: ApiError,
  method: string,
  path: string,
) {
  error.method ||= method;
  error.path ||= path;
  error.apiBase ||= API_BASE;
  error.endpoint ||= buildUrl(path);
  return error;
}

function normalizeFetchFailure(
  error: unknown,
  method: string,
  path: string,
) {
  if (error instanceof ApiError) {
    return applyApiErrorContext(error, method, path);
  }

  const message =
    typeof (error as any)?.message === "string" && (error as any).message.trim()
      ? (error as any).message
      : "Network request failed";

  return new ApiError(`${method} ${path} failed: ${message}`, 0, {
    method,
    path,
    endpoint: buildUrl(path),
    apiBase: API_BASE,
    cause: error,
  });
}

export function getApiErrorDetails(
  error: unknown,
  fallback: { method?: string; path?: string } = {},
) {
  const maybeError = error as any;
  const method = maybeError?.method || fallback.method;
  const path = maybeError?.path || fallback.path;
  const endpoint = maybeError?.endpoint || (path ? buildUrl(path) : undefined);
  const status =
    typeof maybeError?.status === "number" && Number.isFinite(maybeError.status)
      ? maybeError.status
      : undefined;
  const rawMessage =
    typeof maybeError?.message === "string" && maybeError.message.trim()
      ? maybeError.message
      : String(error ?? "Unknown error");

  return {
    name: maybeError?.name || "Error",
    status,
    message: redactSensitiveText(rawMessage),
    method,
    path,
    endpoint,
    apiBase: maybeError?.apiBase || API_BASE,
  };
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const validSignals = signals.filter(Boolean);

  const nativeAny = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof nativeAny === "function") {
    return nativeAny(validSignals);
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  };

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      (controller.abort as (reason?: unknown) => void)((signal as any).reason);
    }
    cleanup();
  };

  for (const signal of validSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }

    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return controller.signal;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<Response> {
  const timeoutController = new AbortController();
  const externalSignal = options.signal ?? null;
  let abortSource: "timeout" | "external" | null = null;

  const markExternalAbort = () => {
    abortSource ??= "external";
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      markExternalAbort();
    } else {
      externalSignal.addEventListener("abort", markExternalAbort, {
        once: true,
      });
    }
  }

  const timeout = setTimeout(() => {
    abortSource ??= "timeout";
    timeoutController.abort();
  }, timeoutMs);

  const signal = externalSignal
    ? combineAbortSignals([externalSignal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(url, {
      ...options,
      signal,
    });
  } catch (error) {
    if (isAbortError(error) && abortSource === "timeout") {
      throw new ApiError("Request timed out", 408);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", markExternalAbort);
  }
}

function headersToRecord(headers?: HeadersInit | null): Record<string, string> {
  const out: Record<string, string> = {};

  if (!headers) {
    return out;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => {
      out[String(key)] = String(value);
    });
    return out;
  }

  Object.entries(headers as Record<string, string>).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      out[key] = String(value);
    }
  });

  return out;
}

async function buildHeaders(
  baseHeaders: HeadersInit = {},
  options?: { auth?: boolean; forceRefreshToken?: boolean },
) {
  const headers: Record<string, string> = headersToRecord(baseHeaders);
  const shouldAttachAuth = options?.auth !== false;
  const currentUser = auth?.currentUser ?? null;

  if (shouldAttachAuth && currentUser) {
    const token = await currentUser.getIdToken(
      Boolean(options?.forceRefreshToken),
    );
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

async function fetchBackend(
  path: string,
  options: RequestInit = {},
  config?: { auth?: boolean; timeoutMs?: number },
): Promise<Response> {
  const shouldAttachAuth = config?.auth !== false;
  const baseHeaders = headersToRecord(options.headers);
  const method = String(options.method || "GET").toUpperCase();

  let res: Response;
  try {
    res = await fetchWithTimeout(
      buildUrl(path),
      {
        ...options,
        headers: await buildHeaders(baseHeaders, { auth: shouldAttachAuth }),
      },
      config?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    );
  } catch (error) {
    throw normalizeFetchFailure(error, method, path);
  }

  const currentUser = auth?.currentUser ?? null;
  if (res.status !== 401 || !shouldAttachAuth || !currentUser) {
    if (res.ok) {
      void flushQueuedClientTurnLogs();
    }
    return res;
  }

  // Firebase ID tokens normally refresh automatically, but an expired cached
  // token can still produce a backend 401. Force refresh once, then retry the
  // same request before surfacing the error to the caller.
  try {
    const retryResponse = await fetchWithTimeout(
      buildUrl(path),
      {
        ...options,
        headers: await buildHeaders(baseHeaders, {
          auth: true,
          forceRefreshToken: true,
        }),
      },
      config?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    );
    if (retryResponse.ok) {
      void flushQueuedClientTurnLogs();
    }
    return retryResponse;
  } catch (error) {
    throw normalizeFetchFailure(error, method, path);
  }
}

type ClientRoutingMode = "local" | "backend";
type ClientRoutingSource = "default" | "extra" | "env" | "flags" | "forced";

type BooleanFlagResolution = {
  value: boolean;
  source: ClientRoutingSource;
};

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function resolveBooleanFlag(
  extraValue: unknown,
  envValue: unknown,
  defaultValue: boolean,
): BooleanFlagResolution {
  const parsedExtra = parseBooleanFlag(extraValue);
  if (parsedExtra !== null) {
    return { value: parsedExtra, source: "extra" };
  }

  const parsedEnv = parseBooleanFlag(envValue);
  if (parsedEnv !== null) {
    return { value: parsedEnv, source: "env" };
  }

  return { value: defaultValue, source: "default" };
}

function normalizeLocalModelBaseUrl(value: unknown) {
  return normalizeLocalRuntimeBaseUrl(value);
}

function isLoopbackLocalModelBaseUrl(value: unknown) {
  return isLoopbackLocalRuntimeBaseUrl(value);
}

function getLocalModelConfigError(featureName: string) {
  return getLocalRuntimeConfigError(
    {
      primary: "phone_local",
      mode: LOCAL_MODEL_RUNTIME_MODE,
      backendRole: "primary",
      openAiPolicy: LOCAL_MODEL_OPENAI_POLICY,
      baseUrl: LOCAL_MODEL_BASE_URL,
      allowDeviceLoopback: LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK_FLAG.value,
      adapterLocation: LOCAL_MODEL_ADAPTER_LOCATION,
      nativeBackend: LOCAL_ON_DEVICE_BACKEND,
      nativeModuleName: LOCAL_ON_DEVICE_NATIVE_MODULE,
      modelRoot: LOCAL_ON_DEVICE_MODEL_ROOT,
    },
    featureName,
  );
}

function assertUsableLocalModelBaseUrl(featureName: string) {
  const message = getLocalModelConfigError(featureName);

  if (message) {
    throw new Error(message);
  }

  return LOCAL_MODEL_BASE_URL;
}

export const API_BASE: string =
  extra.API_BASE ||
  extra.apiBase ||
  extra.apiUrl ||
  process.env.EXPO_PUBLIC_API_BASE ||
  process.env.EXPO_PUBLIC_API_URL ||
  "https://ai-tool-rrau.onrender.com";

const LOCAL_MODEL_BASE_URL: string = normalizeLocalModelBaseUrl(
  extra.LOCAL_MODEL_BASE_URL ||
    process.env.EXPO_PUBLIC_LOCAL_MODEL_BASE_URL ||
    "",
);

const LOCAL_MODEL_RUNTIME_MODE: string = String(
  extra.LOCAL_MODEL_RUNTIME_MODE ||
    process.env.EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE ||
    "native_on_device",
);

const LOCAL_MODEL_OPENAI_POLICY: string = String(
  extra.LOCAL_MODEL_OPENAI_POLICY ||
    process.env.EXPO_PUBLIC_LOCAL_MODEL_OPENAI_POLICY ||
    "backend_controlled",
);

const LOCAL_MODEL_ADAPTER_LOCATION: string = String(
  extra.LOCAL_MODEL_ADAPTER_LOCATION ||
    process.env.EXPO_PUBLIC_LOCAL_MODEL_ADAPTER_LOCATION ||
    "external_lan",
);

const LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK_FLAG = resolveBooleanFlag(
  extra.LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK,
  process.env.EXPO_PUBLIC_LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK,
  false,
);

const LOCAL_ON_DEVICE_BACKEND: string = String(
  extra.LOCAL_ON_DEVICE_BACKEND ||
    process.env.EXPO_PUBLIC_LOCAL_ON_DEVICE_BACKEND ||
    "llama_cpp",
);

const LOCAL_ON_DEVICE_NATIVE_MODULE: string = String(
  extra.LOCAL_ON_DEVICE_NATIVE_MODULE ||
    process.env.EXPO_PUBLIC_LOCAL_ON_DEVICE_NATIVE_MODULE ||
    "JaiOnDeviceModel",
);

const LOCAL_ON_DEVICE_MODEL_ROOT: string = String(
  extra.LOCAL_ON_DEVICE_MODEL_ROOT ||
    process.env.EXPO_PUBLIC_LOCAL_ON_DEVICE_MODEL_ROOT ||
    "document://models",
);

const LOCAL_MODEL_DELIVERY_MODE: string = String(
  extra.LOCAL_MODEL_DELIVERY_MODE ||
    process.env.EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE ||
    "download_on_first_launch",
);

// Do not read EXPO_PUBLIC_LOCAL_MODEL_API_KEY here. EXPO_PUBLIC values are bundled
// into the app and are not secrets; local model auth should use a pairing flow,
// backend proxy, or another short-lived runtime token mechanism.
const LOCAL_MODEL_API_KEY = "";

const LOCAL_STT_MODEL: string =
  extra.LOCAL_STT_MODEL || process.env.EXPO_PUBLIC_LOCAL_STT_MODEL || "whisper";

const LOCAL_CHAT_PIPELINE_FLAG = resolveBooleanFlag(
  extra.USE_LOCAL_CHAT_PIPELINE,
  process.env.EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE,
  false,
);

const LOCAL_VOICE_PIPELINE_FLAG = resolveBooleanFlag(
  extra.USE_LOCAL_VOICE_PIPELINE,
  process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE,
  false,
);

const LOCAL_MODEL_FALLBACK_FLAG = resolveBooleanFlag(
  extra.ENABLE_LOCAL_MODEL_FALLBACK,
  process.env.EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK,
  false,
);

// Backend AI router is the primary runtime. Local chat remains an explicit
// fallback/dev path only when EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=true.
const USE_LOCAL_CHAT_PIPELINE_DEFAULT: boolean = false;
const CANONICAL_VOICE_ANALYZE_PATH = "/api/transcribe-and-analyze";
const E2E_TINY_WAV_BASE64 =
  "UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

let localChatInterceptionDepth = 0;
let routingBannerLogged = false;

export function getClientRoutingDefaults() {
  return {
    chat: (LOCAL_CHAT_PIPELINE_FLAG.value
      ? "local"
      : "backend") as ClientRoutingMode,
    voice: (LOCAL_VOICE_PIPELINE_FLAG.value
      ? "local"
      : "backend") as ClientRoutingMode,
    chatSource: LOCAL_CHAT_PIPELINE_FLAG.source,
    voiceSource: LOCAL_VOICE_PIPELINE_FLAG.source,
    apiBase: API_BASE,
    localModelBaseUrl: LOCAL_MODEL_BASE_URL,
    localRuntimeMode: LOCAL_MODEL_RUNTIME_MODE,
    enableLocalModelFallback: LOCAL_MODEL_FALLBACK_FLAG.value,
    backendRole: "primary",
    openAiPolicy: LOCAL_MODEL_OPENAI_POLICY,
    nativeBackend: LOCAL_ON_DEVICE_BACKEND,
    nativeModuleName: LOCAL_ON_DEVICE_NATIVE_MODULE,
    modelRoot: LOCAL_ON_DEVICE_MODEL_ROOT,
    modelDeliveryMode: LOCAL_MODEL_DELIVERY_MODE,
    localAdapterLocation: LOCAL_MODEL_ADAPTER_LOCATION,
    allowDeviceLoopback: LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK_FLAG.value,
  };
}

function emitClientStartupTelemetry() {
  const routing = getClientRoutingDefaults();
  sendClientTurnLog({
    event: "client_app_started",
    channel: "app",
    agent_source: "mobile",
    route_taken: "startup",
    api_base: API_BASE,
    chat_routing: routing.chat,
    voice_routing: routing.voice,
  });
}

void Promise.resolve().then(emitClientStartupTelemetry);

export function logClientRoutingBanner(
  logger: Pick<Console, "info"> = console,
) {
  if (routingBannerLogged) {
    return;
  }

  routingBannerLogged = true;
  const routing = getClientRoutingDefaults();
  logger.info(
    `[routing] chat=${routing.chat} (source=${routing.chatSource}) | voice=${routing.voice} (source=${routing.voiceSource}) | api=${routing.apiBase} | localModel=${routing.localModelBaseUrl || "not-configured"} | runtimeMode=${routing.localRuntimeMode} | nativeBackend=${routing.nativeBackend} | nativeModule=${routing.nativeModuleName} | modelDelivery=${routing.modelDeliveryMode} | backendRole=${routing.backendRole} | openAiPolicy=${routing.openAiPolicy}`,
  );

  const localModelError = getLocalModelConfigError("Local model routing");
  if (
    localModelError &&
    (routing.chat === "local" || routing.voice === "local")
  ) {
    logger.info(`[routing] ${localModelError}`);
  }
}

logClientRoutingBanner();

type FeatureFlagPayload = {
  ok?: boolean;
  flags?: {
    voiceRoutingMode?: "local" | "backend" | string;
    streamingChatEnabled?: boolean;
    asyncExportJobsEnabled?: boolean;
    asyncChatJobsEnabled?: boolean;
    vectorStoreBackend?: string;
  };
};

let featureFlagsCache: FeatureFlagPayload["flags"] | null = null;
let featureFlagsFetchedAt = 0;

type SpeechLanguage = "en" | "ta" | null;

type LocalVoiceTranscription = {
  text: string;
  model: string;
  endpoint: string;
  durationMs: number;
};

type LocalAnalyzeItem = {
  id: number;
  intent: string;
  category: string;
  raw_text: string;
  transcript?: string | null;
  datetime?: string | null;
  title?: string | null;
  details?: string | null;
};

type LocalChatProxyResponse = {
  ok: boolean;
  kind?: "assistant_turn" | "voice_unavailable" | "cloud_consent_required";
  item: {
    id: number;
    intent: string;
    category: string;
    raw_text: string;
    transcript?: string | null;
    datetime?: string | null;
    title?: string | null;
    details?: string | null;
    created_at?: string | null;
    source?: string | null;
    __origin?: "backend" | "local";
  };
  assistant: {
    text: string;
    english: string;
    tamil?: string;
    theni_tamil?: string;
  };
  pipeline?: Record<string, any>;
  meta?: Record<string, any>;
};

type VoiceUnavailableAction =
  | "ask_user_consent"
  | "install_local_stt"
  | "configure_local_stt";

type VoiceUnavailableState = {
  kind: "voice_unavailable" | "cloud_consent_required";
  reason: string;
  localAnswerAvailable: false;
  suggestedAction: VoiceUnavailableAction;
};

class LocalVoiceUnavailableError extends Error {
  state: VoiceUnavailableState;

  constructor(
    reason = LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
    details: Partial<VoiceUnavailableState> = {},
  ) {
    super(reason);
    this.name = "LocalVoiceUnavailableError";
    this.state = {
      kind: details.kind || "voice_unavailable",
      reason,
      localAnswerAvailable: false,
      suggestedAction: details.suggestedAction || "configure_local_stt",
    };
  }
}

function buildUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

function localApiCandidates(baseUrl: string) {
  const normalized = String(baseUrl || "").replace(/\/$/, "");
  if (!normalized) {
    return [];
  }

  const variants = [normalized];

  if (normalized.endsWith("/v1")) {
    variants.push(normalized.slice(0, -3));
  } else {
    variants.push(`${normalized}/v1`);
  }

  return variants
    .map((value) => value.replace(/\/$/, ""))
    .filter(Boolean)
    .filter((value, index, items) => items.indexOf(value) === index);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const UTC_TIMESTAMP_KEYS = new Set([
  "created_at",
  "updated_at",
  "timestamp",
  "createdAt",
  "updatedAt",
  "started_at",
  "finished_at",
  "startedAt",
  "finishedAt",
  "saved_at",
  "last_sync_at",
  "lastSyncAt",
  "run_at",
  "runAt",
]);

function normalizeUtcTimestampString(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return raw;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    return `${raw}Z`;
  }

  return raw;
}

function normalizeBackendDates<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBackendDates(entry)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, any> = {};

  Object.entries(value as Record<string, any>).forEach(([key, entryValue]) => {
    if (typeof entryValue === "string" && UTC_TIMESTAMP_KEYS.has(key)) {
      normalized[key] = normalizeUtcTimestampString(entryValue);
      return;
    }

    normalized[key] = normalizeBackendDates(entryValue);
  });

  return normalized as T;
}

function normalizeTranscriptText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPunctuationOnlyTranscript(value: string) {
  const normalized = normalizeTranscriptText(value);
  if (!normalized) return true;

  const alphanumeric = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  return alphanumeric.length === 0;
}

function extractTranscriptText(payload: any) {
  if (!payload) return "";
  if (typeof payload === "string") return normalizeTranscriptText(payload);

  const direct =
    payload.text ||
    payload.transcript ||
    payload.output_text ||
    payload.response ||
    payload.result ||
    payload.message;

  if (typeof direct === "string") return normalizeTranscriptText(direct);

  if (Array.isArray(direct)) {
    const joined = direct
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item?.text === "string"
            ? item.text
            : "",
      )
      .join(" ");

    return normalizeTranscriptText(joined);
  }

  if (Array.isArray(payload.segments)) {
    const joined = payload.segments
      .map((segment: any) => String(segment?.text || "").trim())
      .filter(Boolean)
      .join(" ");

    return normalizeTranscriptText(joined);
  }

  return "";
}

function parseQueryParam(path: string, key: string) {
  try {
    const normalized = path.startsWith("http")
      ? path
      : `https://dummy${path.startsWith("/") ? path : `/${path}`}`;
    const url = new URL(normalized);
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

function extractErrorCode(error: unknown) {
  const value = error as Record<string, unknown> | null;
  const direct = value?.code || value?.nativeCode || value?.errorCode;
  return typeof direct === "string" ? direct : "";
}

function isLocalModelUnavailableError(error: unknown) {
  const code = extractErrorCode(error);
  const setupCode = String((error as any)?.setupCode || "");
  const message = String((error as any)?.message || error || "");
  return (
    code === "NATIVE_ON_DEVICE_RUNTIME_UNAVAILABLE" ||
    setupCode === "LOCAL_MODEL_SETUP_ERROR" ||
    /native on-device|local model|model file|gguf|llama\.cpp|runtime .*not (?:linked|available|ready)|model download|model setup/i.test(
      message,
    )
  );
}

function safeAnswerText(payload: any) {
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

export function sendClientTurnLog(payload: ClientTurnLogPayload) {
  void enqueueClientTurnLog(payload);
}

export const flushClientTurnLogs = flushQueuedClientTurnLogs;

function logClientWorkflowStep(payload: ClientTurnLogPayload) {
  sendClientTurnLog(payload);
  if (payload.request_id && payload.event) {
    void updateActiveWorkflowStep(String(payload.request_id), payload.event).catch(() => undefined);
  }
}

function logClientLocalTurnCompleted(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  answer: string;
  source: string;
  route: string;
  stageTimings?: Record<string, any> | null;
  cloudFallbackEnabled?: boolean | null;
}) {
  logClientWorkflowStep({
    event: "client_local_turn_completed",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    answer: input.answer,
    question_length: textLength(input.message),
    answer_length: textLength(input.answer),
    agent_source: input.source === "local_model" ? "local_model" : "local_rules",
    route_taken: input.route,
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? undefined,
  });
}

function logClientLocalTurnFailed(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  errorType: string;
  route?: string | null;
  stageTimings?: Record<string, any> | null;
  cloudFallbackEnabled?: boolean | null;
}) {
  logClientWorkflowStep({
    event: "client_local_turn_failed",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    question_length: textLength(input.message),
    agent_source: "local_model",
    route_taken: input.route || "local_answer",
    stage_timings: input.stageTimings || null,
    error_type: input.errorType,
    fallback_reason: input.errorType,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? undefined,
  });
}

export function annotateBackendOpenAiFallbackResponse<T extends Record<string, any>>(
  payload: T,
  options: {
    fallbackReason: BackendFallbackReason;
    originalRoute?: string | null;
    stageTimings?: Record<string, any> | null;
  },
): T {
  const source = "backend_openai_fallback";
  const pipeline = {
    ...(payload?.pipeline || {}),
    direct_answer_source:
      payload?.pipeline?.direct_answer_source || "backend_openai",
    meta: {
      ...(payload?.pipeline?.meta || {}),
      source,
      fallback_reason: options.fallbackReason,
      original_route: options.originalRoute || undefined,
      ...(options.stageTimings ? { stageTimings: options.stageTimings } : {}),
    },
  };
  return {
    ...payload,
    item: payload?.item
      ? {
          ...payload.item,
          __origin: "backend",
        }
      : payload?.item,
    pipeline,
    meta: {
      ...(payload?.meta || {}),
      source,
      fallback_reason: options.fallbackReason,
      original_route: options.originalRoute || undefined,
      agent_source: "backend_openai",
      ...(options.stageTimings ? { stageTimings: options.stageTimings } : {}),
    },
  };
}

function buildCloudFallbackConsentResponse(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  replyLanguage: ReplyLanguage;
  fallbackReason: BackendFallbackReason;
  originalRoute?: string | null;
  stageTimings?: Record<string, any> | null;
}): LocalChatProxyResponse {
  const createdAt = new Date().toISOString();
  return {
    ok: false,
    kind: "cloud_consent_required",
    item: {
      id: Date.now(),
      intent: "assistant",
      category: "Other",
      raw_text: input.message,
      transcript: null,
      datetime: null,
      title: "Cloud fallback",
      details: CLOUD_FALLBACK_CONSENT_MESSAGE,
      created_at: createdAt,
      source: "text",
      __origin: "local",
    },
    assistant: {
      text: CLOUD_FALLBACK_CONSENT_MESSAGE,
      english: CLOUD_FALLBACK_CONSENT_MESSAGE,
      tamil:
        input.replyLanguage === "ta"
          ? CLOUD_FALLBACK_CONSENT_MESSAGE
          : undefined,
      theni_tamil:
        input.replyLanguage === "ta"
          ? CLOUD_FALLBACK_CONSENT_MESSAGE
          : undefined,
    },
    pipeline: {
      route_taken: "cloud_consent_required",
      predicted_label: "assistant",
      raw_english: input.message,
      remodeled_english: CLOUD_FALLBACK_CONSENT_MESSAGE,
      tamil_text:
        input.replyLanguage === "ta" ? CLOUD_FALLBACK_CONSENT_MESSAGE : "",
      theni_tamil_text:
        input.replyLanguage === "ta" ? CLOUD_FALLBACK_CONSENT_MESSAGE : "",
      direct_answer_source: "local_rules",
      meta: {
        source: "cloud_consent_required",
        fallback_reason: input.fallbackReason,
        original_route: input.originalRoute || undefined,
        request_id: input.requestId || null,
        stageTimings: input.stageTimings || {},
      },
    },
    meta: {
      source: "cloud_consent_required",
      route: "cloud_consent_required",
      fallback_reason: input.fallbackReason,
      original_route: input.originalRoute || undefined,
      cloudFallback: {
        kind: "cloud_consent_required",
        reason: input.fallbackReason,
        localAnswerAvailable: false,
        suggestedAction: "ask_user_consent",
      },
      userId: input.userId,
      request_id: input.requestId || null,
      stageTimings: input.stageTimings || {},
      created_at: createdAt,
    },
  };
}

async function postChatFallbackToBackend(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  replyLanguage: ReplyLanguage;
  fallbackReason: BackendFallbackReason;
  originalRoute?: string | null;
  localBudgetMs?: number | null;
  stageTimings?: Record<string, any> | null;
  cloudFallbackEnabled?: boolean | null;
}) {
  const startedAt = Date.now();
  logClientWorkflowStep({
    event: "client_backend_fallback_started",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    question_length: textLength(input.message),
    agent_source: "backend_openai",
    route_taken: "fallback_openai",
    fallback_reason: input.fallbackReason,
    workflow_step: "backend_fallback",
    workflow_phase: "started",
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? true,
  });

  let backend: LocalChatProxyResponse;
  try {
    backend = await apiPostBackendOnly<LocalChatProxyResponse>(
      "/api/chat",
      {
        user_id: input.userId,
        message: input.message,
        reply_language: input.replyLanguage,
        request_id: input.requestId || undefined,
        client_fallback_reason: input.fallbackReason,
        client_local_budget_ms: input.localBudgetMs || undefined,
        client_original_route: input.originalRoute || undefined,
      },
      { timeoutMs: BACKEND_CHAT_FALLBACK_TIMEOUT_MS },
    );
  } catch (error) {
    logClientWorkflowStep({
      event: "client_backend_fallback_completed",
      user_id: input.userId,
      request_id: input.requestId || null,
      channel: "text",
      question: input.message,
      question_length: textLength(input.message),
      agent_source: "backend_openai",
      route_taken: "fallback_openai",
      fallback_reason: input.fallbackReason,
      workflow_step: "backend_fallback",
      workflow_phase: "failed",
      http_status: getApiErrorDetails(error, { method: "POST", path: "/api/chat" }).status,
      error_type: getApiErrorDetails(error, { method: "POST", path: "/api/chat" }).name,
      error_name: getApiErrorDetails(error, { method: "POST", path: "/api/chat" }).name,
      error_message: getApiErrorDetails(error, { method: "POST", path: "/api/chat" }).message,
      duration_ms: Date.now() - startedAt,
      stage_timings: input.stageTimings || null,
      cloud_fallback_enabled: input.cloudFallbackEnabled ?? true,
    });
    throw error;
  }
  const annotated = annotateBackendOpenAiFallbackResponse(backend, {
    fallbackReason: input.fallbackReason,
    originalRoute: input.originalRoute,
    stageTimings: input.stageTimings,
  });
  const answer = safeAnswerText(annotated);
  logClientWorkflowStep({
    event: "client_backend_fallback_completed",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    answer,
    question_length: textLength(input.message),
    answer_length: textLength(answer),
    agent_source: "backend_openai",
    route_taken: "fallback_openai",
    fallback_reason: input.fallbackReason,
    workflow_step: "backend_fallback",
    workflow_phase: "completed",
    http_status: 200,
    duration_ms: Date.now() - startedAt,
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? true,
  });
  void import("./globalKnowledgeSync")
    .then(({ syncGlobalKnowledge }) => syncGlobalKnowledge())
    .catch(() => undefined);
  return annotated;
}

function localBudgetTimer(timeoutMs: number, source = "local_to_backend_budget") {
  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  return new Promise<{
    type: "local_budget_exceeded";
    error: LocalBudgetExceededError;
  }>((resolve) => {
    setTimeout(() => {
      resolve({
        type: "local_budget_exceeded",
        error: new LocalBudgetExceededError(
          `Local assistant exceeded ${safeTimeoutMs}ms backend fallback budget.`,
          {
            timeoutMs: safeTimeoutMs,
            source,
            stage: "api_local_to_backend_budget",
          },
        ),
      });
    }, safeTimeoutMs);
  });
}

function logClientLocalBudgetExceeded(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  localBudgetMs: number;
  stageTimings?: Record<string, any> | null;
  cloudFallbackEnabled?: boolean | null;
}) {
  logClientWorkflowStep({
    event: "client_local_budget_exceeded",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    question_length: textLength(input.message),
    agent_source: "local_model",
    route_taken: "local_answer",
    fallback_reason: "local_timeout",
    workflow_step: "local_to_backend_budget",
    workflow_phase: "exceeded",
    duration_ms: input.localBudgetMs,
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? undefined,
  });
}

function logIgnoredLateLocalResult(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  route?: string | null;
  source?: string | null;
  stageTimings?: Record<string, any> | null;
  cloudFallbackEnabled?: boolean | null;
}) {
  logClientWorkflowStep({
    event: "client_local_result_ignored_after_backend_fallback",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    question_length: textLength(input.message),
    agent_source: input.source || "local_model",
    route_taken: input.route || "local_answer",
    fallback_reason: "local_timeout",
    workflow_step: "local_to_backend_budget",
    workflow_phase: "ignored_late_result",
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? true,
  });
}

function logCurrentDataBackendRequired(input: {
  userId: number;
  requestId?: string | null;
  message: string;
  userAllowedCloudFallback: boolean;
  stageTimings?: Record<string, any> | null;
}) {
  logClientWorkflowStep({
    event: "client_current_data_backend_required",
    user_id: input.userId,
    request_id: input.requestId || null,
    channel: "text",
    question: input.message,
    question_length: textLength(input.message),
    agent_source: "mobile",
    route_taken: input.userAllowedCloudFallback
      ? "fallback_openai"
      : "cloud_consent_required",
    fallback_reason: "live_data_needed",
    workflow_step: "current_data_guard",
    workflow_phase: "completed",
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.userAllowedCloudFallback,
  });
}

function requestNativeLocalCancel(input: {
  requestId?: string | null;
  userId: number;
  message: string;
  stageTimings?: Record<string, any> | null;
  cloudFallbackEnabled?: boolean | null;
}) {
  const requestId = String(input.requestId || "").trim();
  if (!requestId) return;
  const bridge = getNativeOnDeviceModelBridge();
  if (typeof bridge?.cancelRequest !== "function") return;

  logClientWorkflowStep({
    event: "client_native_cancel_requested",
    user_id: input.userId,
    request_id: requestId,
    channel: "text",
    question: input.message,
    question_length: textLength(input.message),
    agent_source: "local_model",
    route_taken: "local_answer",
    fallback_reason: "local_timeout",
    workflow_step: "native_cancel",
    workflow_phase: "requested",
    stage_timings: input.stageTimings || null,
    cloud_fallback_enabled: input.cloudFallbackEnabled ?? undefined,
  });
  void Promise.resolve(bridge.cancelRequest(requestId)).catch(() => undefined);
}

function isNativeSttNotImplementedError(error: unknown) {
  const code = extractErrorCode(error);
  const message = String((error as any)?.message || error || "");
  return (
    code === "JAI_NATIVE_STT_NOT_IMPLEMENTED" ||
    message.includes("JAI_NATIVE_STT_NOT_IMPLEMENTED") ||
    message.toLowerCase().includes("no native phone-local stt backend")
  );
}

function sanitizeVoiceUnavailableReason(error: unknown) {
  if (error instanceof LocalVoiceUnavailableError) {
    return error.state.reason;
  }
  if (isNativeSttNotImplementedError(error)) {
    return LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE;
  }
  return LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE;
}

function toVoiceUnavailableError(error: unknown) {
  if (error instanceof LocalVoiceUnavailableError) return error;
  return new LocalVoiceUnavailableError(sanitizeVoiceUnavailableReason(error));
}

function buildVoiceUnavailableResponse(
  state: VoiceUnavailableState,
  options: {
    userId: number;
    replyLanguage: ReplyLanguage;
  },
): LocalChatProxyResponse {
  const createdAt = new Date().toISOString();
  const userMessage =
    state.kind === "cloud_consent_required"
      ? `${LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE} Enable cloud fallback to use cloud speech recognition.`
      : LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE;

  return {
    ok: false,
    kind: state.kind,
    item: {
      id: Date.now(),
      intent: "assistant",
      category: "Voice",
      raw_text: "",
      transcript: null,
      datetime: null,
      title: "Voice unavailable",
      details: userMessage,
      created_at: createdAt,
      source: "voice",
      __origin: "local",
    },
    assistant: {
      text: userMessage,
      english: userMessage,
      tamil: options.replyLanguage === "ta" ? userMessage : undefined,
      theni_tamil: options.replyLanguage === "ta" ? userMessage : undefined,
    },
    pipeline: {
      route_taken: state.kind,
      predicted_label: "assistant",
      raw_english: "",
      remodeled_english: userMessage,
      tamil_text: options.replyLanguage === "ta" ? userMessage : "",
      theni_tamil_text: options.replyLanguage === "ta" ? userMessage : "",
      direct_answer_source: "local_rules",
      meta: {
        voice: state,
      },
    },
    meta: {
      source: "local_voice_proxy",
      route: state.kind,
      cacheHit: false,
      voice: state,
      stt: {
        available: false,
        reason: state.reason,
      },
      userId: options.userId,
      created_at: createdAt,
    },
  };
}

function e2eVoiceAnswerFor(query: string, replyLanguage: ReplyLanguage) {
  if (/spitzola/i.test(query)) {
    return replyLanguage === "en"
      ? "I’m not finding a common disease called ‘Spitzola’. It may be a misheard or misspelled term. Did you mean Spitz nevus, spirochete infection, or leptospirosis?"
      : "‘Spitzola’ nu common disease name-a clear-aa kandupidikka mudiyala. Spelling/mic transcript wrong irukkalam.";
  }
  return replyLanguage === "en"
    ? "E2E voice reply ready."
    : "Seri, unga voice reply ready.";
}

function e2eTtsLanguageCode(replyLanguage: ReplyLanguage) {
  return replyLanguage === "ta" ? "ta-IN" : "en-IN";
}

function e2eTtsLocaleStyle(replyLanguage: ReplyLanguage) {
  return replyLanguage === "ta" ? "local_tamil" : "indian_english";
}

function buildE2eMockVoiceTurnResponse(replyLanguage: ReplyLanguage = PRODUCT_DEFAULT_REPLY_LANGUAGE): LocalChatProxyResponse {
  const createdAt = new Date().toISOString();
  const voiceQuery = getE2eVoiceQuery();
  const assistantText = e2eVoiceAnswerFor(voiceQuery, replyLanguage);
  const routeTaken = replyLanguage === "ta" ? "sarvam_general" : "openai_general";
  const ttsLanguageCode = e2eTtsLanguageCode(replyLanguage);
  return {
    ok: true,
    kind: "assistant_turn",
    item: {
      id: Date.now(),
      intent: "assistant",
      category: "Voice",
      raw_text: voiceQuery,
      transcript: voiceQuery,
      datetime: null,
      title: "E2E voice",
      details: assistantText,
      created_at: createdAt,
      source: "voice",
      __origin: "local",
    },
    assistant: {
      text: assistantText,
      english: replyLanguage === "en" ? assistantText : "",
      tamil: replyLanguage === "ta" ? assistantText : undefined,
      theni_tamil: replyLanguage === "ta" ? assistantText : undefined,
    },
    pipeline: {
      route_taken: routeTaken,
      predicted_label: "general",
      raw_english: voiceQuery,
      remodeled_english: replyLanguage === "en" ? assistantText : "",
      tamil_text: replyLanguage === "ta" ? assistantText : "",
      theni_tamil_text: replyLanguage === "ta" ? assistantText : "",
      direct_answer_source: "e2e_voice_mock",
      meta: {
        source: "e2e_voice_mock",
        requested_reply_language: replyLanguage,
        tts_language_code: ttsLanguageCode,
        target_language_code: ttsLanguageCode,
        tts_locale_style: e2eTtsLocaleStyle(replyLanguage),
        voice_surface: getE2eVoiceSurface(),
      },
    },
    meta: {
      source: "e2e_voice_mock",
      route: routeTaken,
      language: replyLanguage,
      requested_reply_language: replyLanguage,
      tts_language_code: ttsLanguageCode,
      target_language_code: ttsLanguageCode,
      tts_locale_style: e2eTtsLocaleStyle(replyLanguage),
      voice_surface: getE2eVoiceSurface(),
      cacheHit: false,
      created_at: createdAt,
    },
  };
}

function buildE2eMockHandsFreeChatResponse(input: {
  message: string;
  replyLanguage: ReplyLanguage;
  requestId?: string | null;
  source?: "handsfree" | "text";
}): LocalChatProxyResponse {
  const createdAt = new Date().toISOString();
  const assistantText = e2eVoiceAnswerFor(input.message, input.replyLanguage);
  const routeTaken = input.replyLanguage === "ta" ? "sarvam_general" : "openai_general";
  const ttsLanguageCode = e2eTtsLanguageCode(input.replyLanguage);
  const source = input.source || "handsfree";
  const isHandsFree = source === "handsfree";
  return {
    ok: true,
    kind: "assistant_turn",
    item: {
      id: Date.now(),
      intent: "assistant",
      category: isHandsFree ? "Hands free" : "Chat",
      raw_text: input.message,
      transcript: null,
      datetime: null,
      title: isHandsFree ? "Hands-free" : "E2E chat",
      details: assistantText,
      created_at: createdAt,
      source: "text",
      __origin: "local",
    },
    assistant: {
      text: assistantText,
      english: input.replyLanguage === "en" ? assistantText : "",
      tamil: input.replyLanguage === "ta" ? assistantText : undefined,
      theni_tamil: input.replyLanguage === "ta" ? assistantText : undefined,
    },
    pipeline: {
      route_taken: routeTaken,
      predicted_label: "general",
      raw_english: input.message,
      remodeled_english: input.replyLanguage === "en" ? assistantText : "",
      tamil_text: input.replyLanguage === "ta" ? assistantText : "",
      theni_tamil_text: input.replyLanguage === "ta" ? assistantText : "",
      direct_answer_source: "e2e_hands_free_mock",
      meta: {
        source: isHandsFree ? "e2e_hands_free_mock" : "e2e_chat_mock",
        request_id: input.requestId || null,
        requested_reply_language: input.replyLanguage,
        tts_language_code: ttsLanguageCode,
        target_language_code: ttsLanguageCode,
        tts_locale_style: e2eTtsLocaleStyle(input.replyLanguage),
      },
    },
    meta: {
      source: isHandsFree ? "e2e_hands_free_mock" : "e2e_chat_mock",
      route: routeTaken,
      request_id: input.requestId || null,
      language: input.replyLanguage,
      requested_reply_language: input.replyLanguage,
      tts_language_code: ttsLanguageCode,
      target_language_code: ttsLanguageCode,
      tts_locale_style: e2eTtsLocaleStyle(input.replyLanguage),
      cacheHit: false,
      created_at: createdAt,
    },
  };
}

function getFormFilePart(form: FormData) {
  const internal = (form as any)?._parts;
  if (!Array.isArray(internal)) return null;

  for (const part of internal) {
    if (!Array.isArray(part) || part.length < 2) continue;
    if (part[0] !== "file") continue;
    return part[1] || null;
  }

  return null;
}

function isFormDataPayload(value: unknown): value is FormData {
  if (!value || typeof value !== "object") return false;
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return true;
  }

  // React Native FormData stores parts in a private _parts array. This keeps
  // apiPost("/api/transcribe-and-analyze", formData) on the same voice route
  // as apiPostForm(...). The route still defaults to the authenticated backend.
  return Array.isArray((value as any)?._parts);
}

async function getFeatureFlags(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    featureFlagsCache &&
    now - featureFlagsFetchedAt < 60_000
  ) {
    return featureFlagsCache;
  }

  try {
    const res = await fetchBackend("/api/flags", {}, { auth: false });
    if (!res.ok) throw new Error(`flags ${res.status}`);
    const payload = normalizeBackendDates(
      (await res.json()) as FeatureFlagPayload,
    );
    featureFlagsCache = payload?.flags || null;
    featureFlagsFetchedAt = now;
    return featureFlagsCache;
  } catch {
    return featureFlagsCache;
  }
}

async function shouldUseLocalVoicePipeline() {
  logClientRoutingBanner();

  // Recorded voice uses the authenticated backend by default so provider
  // credentials stay server-side. Phone-local STT remains explicit dev mode.
  return LOCAL_VOICE_PIPELINE_FLAG.value;
}

function isTranscribeAndAnalyzePath(path: string) {
  const normalized = String(path || "");
  return (
    normalized.startsWith("/transcribe-and-analyze") ||
    normalized.startsWith("/api/transcribe-and-analyze")
  );
}

function isTtsPath(path: string) {
  const normalized = String(path || "");
  return normalized === "/api/tts" || normalized.startsWith("/api/tts?");
}

function normalizeVoiceAnalyzePath(path: string) {
  const normalized = String(path || "").trim();
  if (!normalized) return CANONICAL_VOICE_ANALYZE_PATH;

  if (normalized.startsWith("/api/transcribe-and-analyze")) {
    return normalized.replace(
      "/api/transcribe-and-analyze",
      CANONICAL_VOICE_ANALYZE_PATH,
    );
  }

  if (normalized.startsWith("/transcribe-and-analyze")) {
    return normalized.replace(
      "/transcribe-and-analyze",
      CANONICAL_VOICE_ANALYZE_PATH,
    );
  }

  return normalized;
}

async function withVoiceLanguageDefaults(path: string, defaults: { replyLanguage?: ReplyLanguage; speechLanguage?: "auto" | "en-IN" | "ta-IN" } = {}) {
  const [rawBase, rawQuery = ""] = String(path || CANONICAL_VOICE_ANALYZE_PATH).split("?");
  const params = new URLSearchParams(rawQuery);
  if (!params.has("reply_language")) {
    const userId = Number(params.get("user_id") || 0);
    const cachedProfile = Number.isFinite(userId) && userId > 0
      ? await loadCachedLocalAssistantProfile(userId)
      : await loadCachedLocalAssistantProfile();
    params.set(
      "reply_language",
      defaults.replyLanguage || cachedProfile?.replyLanguage || PRODUCT_DEFAULT_REPLY_LANGUAGE,
    );
  }
  if (!params.has("speech_language")) {
    params.set("speech_language", defaults.speechLanguage || "auto");
  }
  const query = params.toString();
  return `${rawBase}${query ? `?${query}` : ""}`;
}

function formatIntentLabel(value?: string | null) {
  const source = (value || "assistant").replace(/[_-]+/g, " ").trim();
  if (!source) return "Assistant";

  return source
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSpeechLanguage(value: unknown): SpeechLanguage {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) return null;
  if (["auto", "detect", "auto-detect", "autodetect"].includes(normalized)) {
    return null;
  }
  if (normalized.startsWith("ta")) return "ta";
  if (normalized.startsWith("en")) return "en";

  return null;
}

function getRequiredLocalModelBaseUrl() {
  return assertUsableLocalModelBaseUrl("Local voice routing");
}

async function transcribeAudioLocally(
  fileUri: string,
  speechLanguage?: unknown,
): Promise<LocalVoiceTranscription> {
  if (
    String(LOCAL_MODEL_RUNTIME_MODE || "")
      .trim()
      .toLowerCase() === "native_on_device"
  ) {
    return transcribeAudioWithNativeBridge(fileUri, speechLanguage);
  }

  return transcribeAudioWithLocalAdapter(fileUri, speechLanguage);
}

async function transcribeAudioWithNativeBridge(
  fileUri: string,
  speechLanguage?: unknown,
): Promise<LocalVoiceTranscription> {
  const startedAt = Date.now();
  const normalizedSpeechLanguage = normalizeSpeechLanguage(speechLanguage);
  const capability = await getNativeOnDeviceSpeechToTextCapability(
    LOCAL_ON_DEVICE_NATIVE_MODULE,
  );
  if (!capability.available) {
    throw new LocalVoiceUnavailableError(
      capability.reason || LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
      { suggestedAction: "configure_local_stt" },
    );
  }

  const bridge = getNativeOnDeviceModelBridge(LOCAL_ON_DEVICE_NATIVE_MODULE);

  if (!bridge || typeof bridge.transcribeAudio !== "function") {
    throw new LocalVoiceUnavailableError(
      LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
      { suggestedAction: "configure_local_stt" },
    );
  }

  let payload: unknown;
  try {
    payload = await bridge.transcribeAudio({
      fileUri,
      model: LOCAL_STT_MODEL,
      language: normalizedSpeechLanguage,
    });
  } catch (error) {
    if (isNativeSttNotImplementedError(error)) {
      throw new LocalVoiceUnavailableError(
        LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
        { suggestedAction: "configure_local_stt" },
      );
    }

    throw new Error(
      `${nativeOnDeviceSttMissingMessage(
        "Recorded voice",
        LOCAL_ON_DEVICE_NATIVE_MODULE,
      )} ${error instanceof Error ? error.message : String(error || "")}`.trim(),
    );
  }

  const transcript = normalizeTranscriptText(extractTranscriptText(payload));

  if (!transcript) {
    throw new LocalVoiceUnavailableError(
      LOCAL_VOICE_RECOGNITION_UNAVAILABLE_MESSAGE,
      { suggestedAction: "configure_local_stt" },
    );
  }

  return {
    text: transcript,
    model: String((payload as any)?.model || LOCAL_STT_MODEL),
    endpoint: `${LOCAL_ON_DEVICE_NATIVE_MODULE}.transcribeAudio`,
    durationMs: Date.now() - startedAt,
  };
}

async function transcribeAudioWithLocalAdapter(
  fileUri: string,
  speechLanguage?: unknown,
): Promise<LocalVoiceTranscription> {
  const startedAt = Date.now();
  const baseCandidates = localApiCandidates(getRequiredLocalModelBaseUrl());
  const normalizedSpeechLanguage = normalizeSpeechLanguage(speechLanguage);

  let lastError = "";

  for (const base of baseCandidates) {
    const endpoint = `${base}/audio/transcriptions`;

    const form = new FormData();
    form.append("file", {
      uri: fileUri,
      name: "audio.m4a",
      type: "audio/m4a",
    } as any);
    form.append("model", LOCAL_STT_MODEL);
    if (normalizedSpeechLanguage) {
      form.append("language", normalizedSpeechLanguage);
    }
    form.append("temperature", "0");
    form.append("response_format", "json");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: LOCAL_MODEL_API_KEY
          ? { Authorization: `Bearer ${LOCAL_MODEL_API_KEY}` }
          : undefined,
        body: form,
      });

      const rawText = await res.text().catch(() => "");
      if (!res.ok) {
        lastError = `${res.status}${rawText ? ` - ${rawText}` : ""}`;
        continue;
      }

      const payload = safeJsonParse<any>(rawText, rawText);
      const transcript = normalizeTranscriptText(
        extractTranscriptText(payload),
      );

      if (!transcript) {
        lastError = `Local STT model "${LOCAL_STT_MODEL}" returned an empty transcript.`;
        continue;
      }

      return {
        text: transcript,
        model: LOCAL_STT_MODEL,
        endpoint,
        durationMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      lastError = error?.message || "Local STT request failed.";
    }
  }

  throw new Error(
    lastError ||
      `Local speech transcription failed for model "${LOCAL_STT_MODEL}". Check that your phone-local runtime has this exact model loaded and exposed.`,
  );
}

async function postVoiceFormToBackend(
  path: string,
  form: FormData,
): Promise<LocalChatProxyResponse> {
  const res = await fetchBackend(path, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
      {
        method: "POST",
        path,
        endpoint: buildUrl(path),
        apiBase: API_BASE,
      },
    );
  }

  const payload = normalizeBackendDates(
    (await res.json()) as LocalChatProxyResponse,
  );
  return {
    ...payload,
    meta: {
      ...(payload?.meta || {}),
      cloudFallback: {
        kind: "cloud_voice_fallback",
        reason:
          "Local voice recognition is unavailable and explicit cloud fallback consent is enabled.",
      },
    },
  };
}

async function handleLocalTranscribeAndAnalyze(
  path: string,
  form: FormData,
): Promise<LocalChatProxyResponse> {
  const file = getFormFilePart(form);
  const fileUri = String(file?.uri || "").trim();
  const userIdRaw = parseQueryParam(path, "user_id");
  const replyLanguageRaw = parseQueryParam(path, "reply_language");
  const speechLanguageRaw = parseQueryParam(path, "speech_language");

  if (!fileUri) {
    throw new Error("Audio file was missing from the voice request.");
  }

  const userId = Number(userIdRaw || 0);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error("Valid user_id is required for local voice routing.");
  }

  const cachedProfile = await loadCachedLocalAssistantProfile(userId);
  const userAllowedCloudFallback = await loadCloudFallbackConsent();
  const explicitReplyLanguage = normalizeReplyLanguage(replyLanguageRaw);
  const initialReplyLanguage: ReplyLanguage =
    explicitReplyLanguage || cachedProfile?.replyLanguage || PRODUCT_DEFAULT_REPLY_LANGUAGE;
  const requestedSpeechLanguage = normalizeSpeechLanguage(speechLanguageRaw);
  const resolvedSpeechLanguage: SpeechLanguage = requestedSpeechLanguage;

  let transcript: LocalVoiceTranscription;
  try {
    transcript = await transcribeAudioLocally(
      fileUri,
      resolvedSpeechLanguage,
    );
  } catch (error) {
    const unavailable = toVoiceUnavailableError(error);
    if (userAllowedCloudFallback) {
      return postVoiceFormToBackend(path, form);
    }

    return buildVoiceUnavailableResponse(
      {
        ...unavailable.state,
        kind: "cloud_consent_required",
        suggestedAction: "ask_user_consent",
      },
      {
        userId,
        replyLanguage: initialReplyLanguage,
      },
    );
  }

  if (isPunctuationOnlyTranscript(transcript.text) && resolvedSpeechLanguage) {
    try {
      const autodetectTranscript = await transcribeAudioLocally(fileUri, null);
      if (!isPunctuationOnlyTranscript(autodetectTranscript.text)) {
        transcript = autodetectTranscript;
      }
    } catch {
      // Keep the primary result so the user still gets the original STT failure if both attempts fail.
    }
  }

  const normalizedTranscriptText = normalizeTranscriptText(transcript.text);
  if (!normalizedTranscriptText) {
    throw new Error("Local STT returned an empty transcript.");
  }

  if (isPunctuationOnlyTranscript(normalizedTranscriptText)) {
    throw new Error(
      "Speech was recorded, but the transcript only contained punctuation. Please speak a little closer to the mic and try again.",
    );
  }

  const replyLanguage =
    explicitReplyLanguage ||
    detectExplicitReplyLanguage(normalizedTranscriptText) ||
    cachedProfile?.replyLanguage ||
    PRODUCT_DEFAULT_REPLY_LANGUAGE;
  const userProfile = withResolvedReplyLanguage(cachedProfile, replyLanguage);
  const deviceInfo = await getCachedDeviceCapabilities();

  const { runLocalAssistantTurn } = await import("./localAgents");
  const turn = await runLocalAssistantTurn({
    userId,
    message: normalizedTranscriptText,
    replyLanguage,
    userAllowedCloudFallback,
    deviceInfo,
    requestId: `voice_${Date.now()}`,
    ...(userProfile ? { userProfile } : {}),
  });
  const createdAt = new Date().toISOString();
  const item: LocalAnalyzeItem = {
    id: Date.now(),
    intent: turn.intent === "reminder" ? "reminder" : "assistant",
    category: "Other",
    raw_text: normalizedTranscriptText,
    transcript: normalizedTranscriptText,
    datetime: turn.datetimeText || null,
    title:
      turn.intent === "reminder"
        ? turn.title || "Reminder"
        : formatIntentLabel(turn.route),
    details: turn.assistantText,
  };

  return {
    ok: true,
    item: {
      ...item,
      created_at: createdAt,
      source: "voice",
      __origin: "local",
    },
    assistant: {
      text: turn.assistantText,
      english: turn.englishText || turn.assistantText,
      tamil: replyLanguage === "ta" ? turn.assistantText : undefined,
      theni_tamil: replyLanguage === "ta" ? turn.assistantText : undefined,
    },
    pipeline: {
      route_taken: turn.route,
      predicted_label: item.intent,
      raw_english: turn.englishText || normalizedTranscriptText,
      remodeled_english: turn.englishText || turn.assistantText,
      tamil_text: replyLanguage === "ta" ? turn.assistantText : "",
      theni_tamil_text: replyLanguage === "ta" ? turn.assistantText : "",
      direct_answer_source: turn.source,
      meta: turn.meta || {},
    },
    meta: {
      source: "local_voice_proxy",
      cacheHit: Boolean(turn.cacheHit),
      route: turn.route,
      ...(turn.cloudFallback ? { cloudFallback: turn.cloudFallback } : {}),
      stt: {
        model: transcript.model,
        endpoint: transcript.endpoint,
        durationMs: transcript.durationMs,
      },
      created_at: createdAt,
    },
  };
}

function isChatPath(path: string) {
  const normalized = String(path || "");
  return normalized === "/api/chat" || normalized.startsWith("/api/chat?");
}

function chatMessageFromBody(body?: any) {
  return String(body?.message ?? body?.text ?? "").trim();
}

function chatReplyLanguageFromBody(body?: any): ReplyLanguage | undefined {
  return (
    normalizeReplyLanguage(body?.reply_language ?? body?.replyLanguage) ||
    undefined
  );
}

function requestLightweightGlobalKnowledgeSync() {
  void import("./globalKnowledgeSync")
    .then(({ syncGlobalKnowledge }) =>
      syncGlobalKnowledge({
        lightweight: true,
        limit: 25,
        minIntervalMs: 30_000,
      }),
    )
    .catch(() => undefined);
}

function buildSyncedGlobalKnowledgeChatResponse(input: {
  body?: any;
  message: string;
  replyLanguage?: ReplyLanguage;
  requestId?: string | null;
  hit: GlobalKnowledgeLookupHit | null;
}): LocalChatProxyResponse | null {
  const hit = input.hit;
  if (!hit) return null;
  const entry = hit.entry;
  const createdAt = new Date().toISOString();
  const answer = entry.answer;
  const isTamilAnswer = String(entry.answerLanguage || "").toLowerCase().startsWith("ta");
  const source =
    entry.scope === "user"
      ? "synced_user_qa_cache"
      : "synced_global_knowledge";
  const replyLanguage = input.replyLanguage || chatReplyLanguageFromBody(input.body);
  return {
    ok: true,
    item: {
      id: Date.now(),
      intent: "assistant",
      category: "Other",
      raw_text: input.message,
      transcript: null,
      datetime: null,
      title: entry.canonicalQuestion || input.message,
      details: answer,
      created_at: createdAt,
      source: "text",
      __origin: "local",
    },
    assistant: {
      text: answer,
      english: isTamilAnswer ? "" : answer,
      tamil: isTamilAnswer ? answer : undefined,
      theni_tamil: isTamilAnswer ? answer : undefined,
    },
    pipeline: {
      route_taken: "global_knowledge_cache",
      predicted_label: "global_knowledge",
      raw_english: isTamilAnswer ? "" : answer,
      remodeled_english: isTamilAnswer ? "" : answer,
      tamil_text: isTamilAnswer ? answer : "",
      theni_tamil_text: isTamilAnswer ? answer : "",
      direct_answer_source: source,
      direct_answer_confidence: hit.score.toFixed(4),
      cache_hit: "true",
      meta: {
        source,
        cache_source: "global_knowledge_sync",
        scope: entry.scope,
        global_knowledge_entry_id: entry.id,
        request_id: input.requestId || undefined,
        score: hit.score,
        match_source: hit.source,
        reply_language: replyLanguage,
      },
    },
    meta: {
      source,
      route: "global_knowledge_cache",
      request_id: input.requestId || null,
      cacheHit: true,
      cache_source: "global_knowledge_sync",
      scope: entry.scope,
      globalKnowledgeEntryId: entry.id,
      score: hit.score,
      matchSource: hit.source,
      responsePath: "local_synced_global_knowledge",
      created_at: createdAt,
    },
  };
}

async function maybeServeSyncedGlobalKnowledgeChat(
  path: string,
  body?: any,
): Promise<LocalChatProxyResponse | null> {
  if (!isChatPath(path)) return null;
  const message = chatMessageFromBody(body);
  if (!message || requiresImmediateBackendCurrentData(message)) {
    return null;
  }
  const requestId = String(body?.request_id ?? body?.requestId ?? "").trim() || null;
  const replyLanguage = chatReplyLanguageFromBody(body);
  const startedAt = Date.now();
  const { lookupSyncedGlobalKnowledge } = await import("./globalKnowledgeSync");
  const hit = await lookupSyncedGlobalKnowledge(message, {
    replyLanguage,
    minSimilarity: 0.9,
  });
  if (!hit) {
    return null;
  }
  logClientWorkflowStep({
    event: "client_synced_global_knowledge_cache_hit",
    user_id: Number(body?.user_id ?? body?.userId ?? 0) || undefined,
    request_id: requestId,
    channel: "text",
    question: message,
    question_length: textLength(message),
    answer_length: textLength(hit.entry.answer),
    agent_source: "global_rag",
    route_taken: "global_knowledge_cache",
    workflow_step: "global_knowledge_lookup",
    workflow_phase: "completed",
    cache_hit: true,
    cache_source: "global_knowledge_sync",
    cache_hit_source: hit.entry.scope === "user" ? "L1_mobile_synced_user" : "L1_mobile_synced_global",
    duration_ms: Date.now() - startedAt,
  });
  return buildSyncedGlobalKnowledgeChatResponse({
    body,
    message,
    replyLanguage,
    requestId,
    hit,
  });
}

async function shouldUseLocalChatPipeline() {
  logClientRoutingBanner();

  return LOCAL_CHAT_PIPELINE_FLAG.value;
}

async function loadCachedProfileForQuickReply(userId: number) {
  const timeoutMs = 25;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadCachedLocalAssistantProfile(userId),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function handleLocalChat(
  path: string,
  body?: any,
): Promise<LocalChatProxyResponse> {
  const stageTimings: Record<string, number> = {};
  const timeStage = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      stageTimings[label] = (stageTimings[label] || 0) + (Date.now() - startedAt);
    }
  };
  const userId = Number(body?.user_id ?? body?.userId ?? 0);
  const message = String(body?.message ?? body?.text ?? "").trim();
  const requestId = String(body?.request_id ?? body?.requestId ?? "").trim() || null;
  const workflowStartedAt = Date.now();

  if (!Number.isFinite(userId) || userId <= 0 || !message) {
    throw new Error(
      "Valid user_id and message are required for local chat routing.",
    );
  }

  const explicitReplyLanguage = normalizeReplyLanguage(
    body?.reply_language ?? body?.replyLanguage,
  );
  logClientWorkflowStep({
    event: "client_quick_reply_check_started",
    user_id: userId,
    request_id: requestId,
    channel: "text",
    question: message,
    question_length: textLength(message),
    agent_source: "local_rules",
    route_taken: "quick_reply_check",
    workflow_step: "quick_reply_check",
    workflow_phase: "started",
    step_index: 1,
    stage_timings: stageTimings,
  });
  let quick = tryBuildQuickLocalReply({
    message,
    replyLanguage: explicitReplyLanguage,
  });

  if (quick) {
    logClientWorkflowStep({
      event: "client_quick_reply_hit",
      user_id: userId,
      request_id: requestId,
      channel: "text",
      question: message,
      question_length: textLength(message),
      agent_source: "local_rules",
      route_taken: quick.route,
      workflow_step: "quick_reply_check",
      workflow_phase: "completed",
      step_index: 2,
      decision: "hit",
      cache_hit: false,
      duration_ms: Date.now() - workflowStartedAt,
      stage_timings: stageTimings,
    });
    const quickProfile = await timeStage("quick_profile", () =>
      loadCachedProfileForQuickReply(userId),
    );
    const quickReplyLanguage =
      explicitReplyLanguage || quickProfile?.replyLanguage;
    quick =
      tryBuildQuickLocalReply({
        message,
        replyLanguage: quickReplyLanguage,
        assistantName: quickProfile?.assistantName,
        userName: quickProfile?.name,
      }) || quick;
    const quickLanguage = quickReplyLanguage || explicitReplyLanguage;
    const createdAt = new Date().toISOString();

    const response: LocalChatProxyResponse = {
      ok: true,
      item: {
        id: Date.now(),
        intent: "assistant",
        category: "Other",
        raw_text: message,
        transcript: null,
        datetime: null,
        title: quick.title,
        details: quick.assistantText,
        created_at: createdAt,
        source: "text",
        __origin: "local",
      },
      assistant: {
        text: quick.assistantText,
        english: quick.englishText,
        tamil: quickLanguage === "ta" ? quick.assistantText : undefined,
        theni_tamil:
          quickLanguage === "ta" ? quick.assistantText : undefined,
      },
      pipeline: {
        route_taken: quick.route,
        predicted_label: "assistant",
        raw_english: quick.englishText || message,
        remodeled_english: quick.englishText || quick.assistantText,
        tamil_text: quickLanguage === "ta" ? quick.assistantText : "",
        theni_tamil_text:
          quickLanguage === "ta" ? quick.assistantText : "",
        direct_answer_source: "local_rules",
        meta: {
          source: quick.source,
          route: quick.route,
          request_id: requestId,
          confidence: quick.confidence,
          fastPath: true,
          responsePath: "quick_reply",
          stageTimings,
        },
      },
      meta: {
        source: "local_quick_reply",
        route: quick.route,
        request_id: requestId,
        fastPath: true,
        responsePath: "quick_reply",
        stageTimings,
        created_at: createdAt,
      },
    };
    logClientLocalTurnCompleted({
      userId,
      requestId,
      message,
      answer: quick.assistantText,
      source: "local_rules",
      route: quick.route,
      stageTimings,
    });
    return response;
  }

  logClientWorkflowStep({
    event: "client_quick_reply_miss",
    user_id: userId,
    request_id: requestId,
    channel: "text",
    question: message,
    question_length: textLength(message),
    agent_source: "local_rules",
    route_taken: "quick_reply_check",
    workflow_step: "quick_reply_check",
    workflow_phase: "completed",
    step_index: 2,
    decision: "miss",
    cache_hit: false,
    duration_ms: Date.now() - workflowStartedAt,
    stage_timings: stageTimings,
  });

  const cachedProfile = await timeStage("cached_profile", () =>
    loadCachedLocalAssistantProfile(userId),
  );
  const userAllowedCloudFallback = await timeStage("cloud_fallback_consent", () =>
    loadCloudFallbackConsent(),
  );
  const replyLanguage = resolveReplyLanguage({
    explicit: body?.reply_language ?? body?.replyLanguage,
    profile: cachedProfile?.replyLanguage,
    message,
  });
  const userProfile = withResolvedReplyLanguage(cachedProfile, replyLanguage);
  const deviceInfo = await timeStage("device_capabilities", () =>
    getCachedDeviceCapabilities(),
  );

  if (requiresImmediateBackendCurrentData(message)) {
    stageTimings.global_knowledge_cache = stageTimings.global_knowledge_cache || 0;
    logClientWorkflowStep({
      event: "client_global_knowledge_lookup_miss",
      user_id: userId,
      request_id: requestId,
      channel: "text",
      question: message,
      question_length: textLength(message),
      agent_source: "global_rag",
      route_taken: "global_knowledge_cache",
      workflow_step: "global_knowledge_lookup",
      workflow_phase: "completed",
      cache_hit: false,
      cache_source: "global_knowledge_sync",
      duration_ms: 0,
      stage_timings: stageTimings,
      cloud_fallback_enabled: userAllowedCloudFallback,
    });
    logCurrentDataBackendRequired({
      userId,
      requestId,
      message,
      userAllowedCloudFallback,
      stageTimings,
    });
    if (userAllowedCloudFallback) {
      return postChatFallbackToBackend({
        userId,
        requestId,
        message,
        replyLanguage,
        fallbackReason: "live_data_needed",
        originalRoute: "current_data_guard",
        stageTimings,
        cloudFallbackEnabled: userAllowedCloudFallback,
      });
    }
    return buildCloudFallbackConsentResponse({
      userId,
      requestId,
      message,
      replyLanguage,
      fallbackReason: "live_data_needed",
      originalRoute: "current_data_guard",
      stageTimings,
    });
  }

  const importStartedAt = Date.now();
  const { runLocalAssistantTurn } = await import("./localAgents");
  stageTimings.local_agents_import =
    (stageTimings.local_agents_import || 0) + (Date.now() - importStartedAt);
  let turn;
  const localBudgetMs = getLocalToBackendFallbackMs();
  const localAbortController = new AbortController();
  let backendFallbackStarted = false;
  let localResultHandled = false;
  const localTurnPromise = timeStage("local_turn", () =>
    runLocalAssistantTurn({
      userId,
      message,
      replyLanguage,
      userAllowedCloudFallback,
      deviceInfo,
      requestId,
      abortSignal: localAbortController.signal,
      localDeadlineMs: Date.now() + localBudgetMs,
      ...(userProfile ? { userProfile } : {}),
    }),
  );
  localTurnPromise.then(
    (lateTurn) => {
      if (backendFallbackStarted && !localResultHandled) {
        logIgnoredLateLocalResult({
          userId,
          requestId,
          message,
          route: lateTurn?.route,
          source: lateTurn?.source,
          stageTimings: {
            ...stageTimings,
            ...(lateTurn?.meta?.stageTimings || {}),
          },
          cloudFallbackEnabled: userAllowedCloudFallback,
        });
      }
    },
    () => undefined,
  );
  try {
    const localOutcome = await Promise.race([
      localTurnPromise.then(
        (value) => ({ type: "local_result" as const, value }),
        (error) => ({ type: "local_error" as const, error }),
      ),
      localBudgetTimer(localBudgetMs),
    ]);

    if (localOutcome.type === "local_budget_exceeded") {
      backendFallbackStarted = true;
      stageTimings.local_to_backend_budget = localBudgetMs;
      localAbortController.abort(localOutcome.error);
      requestNativeLocalCancel({
        userId,
        requestId,
        message,
        stageTimings,
        cloudFallbackEnabled: userAllowedCloudFallback,
      });
      logClientLocalBudgetExceeded({
        userId,
        requestId,
        message,
        localBudgetMs,
        stageTimings,
        cloudFallbackEnabled: userAllowedCloudFallback,
      });
      if (userAllowedCloudFallback) {
        return postChatFallbackToBackend({
          userId,
          requestId,
          message,
          replyLanguage,
          fallbackReason: "local_timeout",
          originalRoute: "local_answer",
          localBudgetMs,
          stageTimings,
          cloudFallbackEnabled: userAllowedCloudFallback,
        });
      }
      return buildCloudFallbackConsentResponse({
        userId,
        requestId,
        message,
        replyLanguage,
        fallbackReason: "local_timeout",
        originalRoute: "local_answer",
        stageTimings,
      });
    }

    if (localOutcome.type === "local_error") {
      throw localOutcome.error;
    }

    localResultHandled = true;
    turn = localOutcome.value;
  } catch (error) {
    const fallbackReason: BackendFallbackReason = isLocalTurnTimeoutError(error)
      ? "local_timeout"
      : isLocalModelUnavailableError(error)
        ? "local_model_unavailable"
        : "no_safe_local_answer";
    logClientLocalTurnFailed({
      userId,
      requestId,
      message,
      errorType: fallbackReason,
      route: "local_answer",
      stageTimings,
      cloudFallbackEnabled: userAllowedCloudFallback,
    });
    if (userAllowedCloudFallback) {
      backendFallbackStarted = true;
      return postChatFallbackToBackend({
        userId,
        requestId,
        message,
        replyLanguage,
        fallbackReason,
        originalRoute: "local_answer",
        localBudgetMs:
          fallbackReason === "local_timeout" ? localBudgetMs : undefined,
        stageTimings,
        cloudFallbackEnabled: userAllowedCloudFallback,
      });
    }
    return buildCloudFallbackConsentResponse({
      userId,
      requestId,
      message,
      replyLanguage,
      fallbackReason,
      originalRoute: "local_answer",
      stageTimings,
    });
  }

  if ((turn.meta as any)?.backendResponse) {
    return (turn.meta as any).backendResponse as LocalChatProxyResponse;
  }

  if (!String(turn.assistantText || "").trim()) {
    const fallbackReason: BackendFallbackReason = "no_safe_local_answer";
    logClientLocalTurnFailed({
      userId,
      requestId,
      message,
      errorType: fallbackReason,
      route: turn.route,
      stageTimings: {
        ...stageTimings,
        ...(turn.meta?.stageTimings || {}),
      },
      cloudFallbackEnabled: userAllowedCloudFallback,
    });
    if (userAllowedCloudFallback) {
      return postChatFallbackToBackend({
        userId,
        requestId,
        message,
        replyLanguage,
        fallbackReason,
        originalRoute: turn.route,
        stageTimings: {
          ...stageTimings,
          ...(turn.meta?.stageTimings || {}),
        },
        cloudFallbackEnabled: userAllowedCloudFallback,
      });
    }
    return buildCloudFallbackConsentResponse({
      userId,
      requestId,
      message,
      replyLanguage,
      fallbackReason,
      originalRoute: turn.route,
      stageTimings: {
        ...stageTimings,
        ...(turn.meta?.stageTimings || {}),
      },
    });
  }

  const createdAt = new Date().toISOString();
  const normalizedIntent =
    turn.intent === "reminder" ? "reminder" : "assistant";
  const resolvedTitle =
    turn.intent === "reminder"
      ? turn.title || "Reminder"
      : formatIntentLabel(turn.route);

  const response: LocalChatProxyResponse = {
    ok: true,
    item: {
      id: Date.now(),
      intent: normalizedIntent,
      category: "Other",
      raw_text: message,
      transcript: null,
      datetime: turn.datetimeText || null,
      title: resolvedTitle,
      details: turn.assistantText,
      created_at: createdAt,
      source: "text",
      __origin: "local",
    },
    assistant: {
      text: turn.assistantText,
      english: turn.englishText || turn.assistantText,
      tamil: replyLanguage === "ta" ? turn.assistantText : undefined,
      theni_tamil: replyLanguage === "ta" ? turn.assistantText : undefined,
    },
    pipeline: {
      route_taken: turn.route,
      predicted_label: normalizedIntent,
      raw_english: turn.englishText || message,
      remodeled_english: turn.englishText || turn.assistantText,
      tamil_text: replyLanguage === "ta" ? turn.assistantText : "",
      theni_tamil_text: replyLanguage === "ta" ? turn.assistantText : "",
      direct_answer_source: turn.source,
      profile_summary: turn.profileSummary || null,
      meta: {
        ...(turn.meta || {}),
        request_id: requestId,
        stageTimings: {
          ...stageTimings,
          ...(turn.meta?.stageTimings || {}),
        },
        fastPath: Boolean(turn.meta?.fastPath),
        responsePath: turn.meta?.responsePath || turn.route,
      },
    },
    meta: {
      source: "local_chat_proxy",
      request_id: requestId,
      cacheHit: Boolean(turn.cacheHit),
      route: turn.route,
      fastPath: Boolean(turn.meta?.fastPath),
      responsePath: turn.meta?.responsePath || turn.route,
      stageTimings: {
        ...stageTimings,
        ...(turn.meta?.stageTimings || {}),
      },
      ...(turn.meta?.setupRequired
        ? {
            setupRequired: true,
            selectedTier: turn.meta.selectedTier,
            missingModelIds: turn.meta.missingModelIds,
            invalidModelIds: turn.meta.invalidModelIds,
            missingModels: turn.meta.missingModels,
            invalidModels: turn.meta.invalidModels,
          }
        : {}),
      ...(turn.cloudFallback ? { cloudFallback: turn.cloudFallback } : {}),
      created_at: createdAt,
    },
  };

  if (turn.source === "openai_fallback") {
    logClientWorkflowStep({
      event: "client_backend_fallback_completed",
      user_id: userId,
      request_id: requestId,
      channel: "text",
      question: message,
      answer: turn.assistantText,
      question_length: textLength(message),
      answer_length: textLength(turn.assistantText),
      agent_source: "backend_openai",
      route_taken: "fallback_openai",
      fallback_reason: String(turn.meta?.fallback_reason || ""),
      stage_timings: response.meta?.stageTimings || null,
      cloud_fallback_enabled: userAllowedCloudFallback,
    });
  } else {
    logClientLocalTurnCompleted({
      userId,
      requestId,
      message,
      answer: turn.assistantText,
      source: turn.source,
      route: turn.route,
      stageTimings: response.meta?.stageTimings || null,
      cloudFallbackEnabled: userAllowedCloudFallback,
    });
  }

  return response;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchBackend(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `GET ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
      {
        method: "GET",
        path,
        endpoint: buildUrl(path),
        apiBase: API_BASE,
      },
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiFetchRaw(
  path: string,
  options: RequestInit = {},
  config: { timeoutMs?: number; auth?: boolean } = {},
): Promise<Response> {
  return fetchBackend(path, options, config);
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  if (
    (isE2eMockHandsFreeEnabled() || isE2eMockAuthEnabled()) &&
    isChatPath(path) &&
    (isE2eMockAuthEnabled() ||
      String(body?.client_source || "").trim().toLowerCase() === "handsfree")
  ) {
    const clientSource = String(body?.client_source || "").trim().toLowerCase();
    const isHandsFree = clientSource === "handsfree";
    const replyLanguage =
      normalizeReplyLanguage(body?.reply_language) || PRODUCT_DEFAULT_REPLY_LANGUAGE;
    const mock = buildE2eMockHandsFreeChatResponse({
      message: String(body?.message || "tell me about Spitzola"),
      replyLanguage,
      requestId: body?.request_id || null,
      source: isHandsFree ? "handsfree" : "text",
    }) as T;
    console.info(isHandsFree ? "[e2e_hands_free_mock] /api/chat" : "[e2e_chat_mock] /api/chat", {
      requested_reply_language: replyLanguage,
      predicted_label: "general",
      route_taken: replyLanguage === "ta" ? "sarvam_general" : "openai_general",
      tts_language_code: e2eTtsLanguageCode(replyLanguage),
      tts_locale_style: e2eTtsLocaleStyle(replyLanguage),
    });
    return mock;
  }

  if (isE2eMockVoiceTurnEnabled() && isTtsPath(path)) {
    const targetLanguageCode =
      String(body?.target_language_code || "").trim() ||
      e2eTtsLanguageCode(normalizeReplyLanguage(process.env.EXPO_PUBLIC_E2E_REPLY_LANGUAGE) || PRODUCT_DEFAULT_REPLY_LANGUAGE);
    const replyLanguage = targetLanguageCode.toLowerCase().startsWith("ta") ? "ta" : "en";
    console.info("[e2e_voice_mock] /api/tts", {
      target_language_code: targetLanguageCode,
      tts_language_code: targetLanguageCode,
      tts_locale_style: e2eTtsLocaleStyle(replyLanguage),
    });
    return {
      audio_base64: E2E_TINY_WAV_BASE64,
      speaker: replyLanguage === "ta" ? "karun" : "anushka",
      target_language_code: targetLanguageCode,
      locale_style: e2eTtsLocaleStyle(replyLanguage),
      model: "bulbul:v2",
    } as T;
  }

  if (isTranscribeAndAnalyzePath(path)) {
    if (isFormDataPayload(body)) {
      return apiPostForm<T>(path, body);
    }

    if (await shouldUseLocalVoicePipeline()) {
      throw new Error(
        "Local recorded voice routing requires FormData with a file part. " +
          "Use apiPostForm('/api/transcribe-and-analyze', formData) or pass FormData to apiPost; " +
          "backend Sarvam fallback cannot run when audio input is missing.",
      );
    }
  }

  const chatPath = isChatPath(path);
  const useLocalChatPipeline =
    localChatInterceptionDepth === 0 && chatPath
      ? await shouldUseLocalChatPipeline()
      : false;

  if (
    localChatInterceptionDepth === 0 &&
    chatPath &&
    useLocalChatPipeline
  ) {
    localChatInterceptionDepth += 1;
    try {
      return (await handleLocalChat(path, body)) as T;
    } finally {
      localChatInterceptionDepth = Math.max(0, localChatInterceptionDepth - 1);
    }
  }

  if (localChatInterceptionDepth === 0 && chatPath) {
    const localHit = await maybeServeSyncedGlobalKnowledgeChat(path, body);
    if (localHit) {
      return localHit as T;
    }
    const response = await apiPostBackendOnly<T>(path, body);
    requestLightweightGlobalKnowledgeSync();
    return response;
  }

  return apiPostBackendOnly<T>(path, body);
}

export async function apiPostBackendOnly<T>(
  path: string,
  body?: any,
  config: { timeoutMs?: number; auth?: boolean } = {},
): Promise<T> {
  const res = await fetchBackend(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, config);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
      {
        method: "POST",
        path,
        endpoint: buildUrl(path),
        apiBase: API_BASE,
      },
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const isVoiceAnalyze = isTranscribeAndAnalyzePath(path);
  const resolvedPath = isVoiceAnalyze ? await withVoiceLanguageDefaults(normalizeVoiceAnalyzePath(path)) : path;
  if (isVoiceAnalyze && isE2eMockVoiceTurnEnabled()) {
    const replyLanguage = normalizeReplyLanguage(parseQueryParam(resolvedPath, "reply_language")) || PRODUCT_DEFAULT_REPLY_LANGUAGE;
    const mock = buildE2eMockVoiceTurnResponse(
      replyLanguage,
    ) as T;
    console.info("[e2e_voice_mock] /api/transcribe-and-analyze", {
      requested_reply_language: replyLanguage,
      predicted_label: "general",
      route_taken: replyLanguage === "ta" ? "sarvam_general" : "openai_general",
      tts_language_code: e2eTtsLanguageCode(replyLanguage),
      tts_locale_style: e2eTtsLocaleStyle(replyLanguage),
      voice_surface: getE2eVoiceSurface(),
    });
    return mock;
  }

  const useLocalVoicePipeline = isVoiceAnalyze && (await shouldUseLocalVoicePipeline());

  if (useLocalVoicePipeline) {
    return (await handleLocalTranscribeAndAnalyze(resolvedPath, form)) as T;
  }

  const res = await fetchBackend(resolvedPath, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
      {
        method: "POST",
        path,
        endpoint: buildUrl(path),
        apiBase: API_BASE,
      },
    );
  }

  return normalizeBackendDates((await res.json()) as T);
}

export async function apiPut<T>(path: string, body?: any): Promise<T> {
  const res = await fetchBackend(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `PUT ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
      {
        method: "PUT",
        path,
        endpoint: buildUrl(path),
        apiBase: API_BASE,
      },
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetchBackend(path, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `DELETE ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
      {
        method: "DELETE",
        path,
        endpoint: buildUrl(path),
        apiBase: API_BASE,
      },
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export { getFeatureFlags };
