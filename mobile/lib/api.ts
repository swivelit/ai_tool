import Constants from "expo-constants";

import { auth } from "./firebase";
import {
  getLocalRuntimeConfigError,
  isLoopbackLocalRuntimeBaseUrl,
  normalizeLocalRuntimeBaseUrl,
} from "./localModelRuntime";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const DEFAULT_API_TIMEOUT_MS = 30_000;

function isAbortError(error: unknown) {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error as any)?.name === "AbortError"
  );
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
  const currentUser = auth.currentUser;

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

  const res = await fetchWithTimeout(
    buildUrl(path),
    {
      ...options,
      headers: await buildHeaders(baseHeaders, { auth: shouldAttachAuth }),
    },
    config?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  );

  if (res.status !== 401 || !shouldAttachAuth || !auth.currentUser) {
    return res;
  }

  // Firebase ID tokens normally refresh automatically, but an expired cached
  // token can still produce a backend 401. Force refresh once, then retry the
  // same request before surfacing the error to the caller.
  return fetchWithTimeout(
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
      backendRole: "fallback_only",
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
    "fallback_only",
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
  true,
);

const LOCAL_VOICE_PIPELINE_FLAG = resolveBooleanFlag(
  extra.USE_LOCAL_VOICE_PIPELINE,
  process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE,
  true,
);

// Normal chat is local-first by product policy. The legacy flag is kept
// for diagnostics, but it must not make backend/OpenAI the primary runtime.
const USE_LOCAL_CHAT_PIPELINE_DEFAULT: boolean = true;
const USE_LOCAL_VOICE_PIPELINE_DEFAULT: boolean =
  LOCAL_VOICE_PIPELINE_FLAG.value;
const CANONICAL_VOICE_ANALYZE_PATH = "/transcribe-and-analyze";

let localChatInterceptionDepth = 0;
let routingBannerLogged = false;

export function getClientRoutingDefaults() {
  return {
    chat: (USE_LOCAL_CHAT_PIPELINE_DEFAULT
      ? "local"
      : "backend") as ClientRoutingMode,
    voice: (USE_LOCAL_VOICE_PIPELINE_DEFAULT
      ? "local"
      : "backend") as ClientRoutingMode,
    chatSource: LOCAL_CHAT_PIPELINE_FLAG.value
      ? LOCAL_CHAT_PIPELINE_FLAG.source
      : "forced",
    voiceSource: LOCAL_VOICE_PIPELINE_FLAG.source,
    apiBase: API_BASE,
    localModelBaseUrl: LOCAL_MODEL_BASE_URL,
    localRuntimeMode: LOCAL_MODEL_RUNTIME_MODE,
    backendRole: "fallback_only",
    openAiPolicy: LOCAL_MODEL_OPENAI_POLICY,
    nativeBackend: LOCAL_ON_DEVICE_BACKEND,
    nativeModuleName: LOCAL_ON_DEVICE_NATIVE_MODULE,
    modelRoot: LOCAL_ON_DEVICE_MODEL_ROOT,
    modelDeliveryMode: LOCAL_MODEL_DELIVERY_MODE,
    localAdapterLocation: LOCAL_MODEL_ADAPTER_LOCATION,
    allowDeviceLoopback: LOCAL_MODEL_ALLOW_DEVICE_LOOPBACK_FLAG.value,
  };
}

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

type ReplyLanguage = "en" | "ta";
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
  // apiPost("/api/transcribe-and-analyze", formData) on the same local-first
  // path as apiPostForm(...) without making backend the default route.
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

  if (LOCAL_VOICE_PIPELINE_FLAG.source !== "default") {
    return LOCAL_VOICE_PIPELINE_FLAG.value;
  }

  // Recorded voice is local-first by default, matching text chat. Remote feature
  // flags must not silently make backend/OpenAI the primary recorded-voice path;
  // backend use is reserved for explicit fallback policy after local processing
  // cannot safely complete.
  return USE_LOCAL_VOICE_PIPELINE_DEFAULT;
}

function isTranscribeAndAnalyzePath(path: string) {
  const normalized = String(path || "");
  return (
    normalized.startsWith("/transcribe-and-analyze") ||
    normalized.startsWith("/api/transcribe-and-analyze")
  );
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
    return normalized;
  }

  return normalized;
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

  const replyLanguage: ReplyLanguage = replyLanguageRaw === "en" ? "en" : "ta";
  const requestedSpeechLanguage = normalizeSpeechLanguage(speechLanguageRaw);
  const resolvedSpeechLanguage: SpeechLanguage =
    requestedSpeechLanguage || replyLanguage;

  let transcript = await transcribeAudioLocally(
    fileUri,
    resolvedSpeechLanguage,
  );

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

  const { runLocalAssistantTurn } = await import("./localAgents");
  const turn = await runLocalAssistantTurn({
    userId,
    message: normalizedTranscriptText,
    replyLanguage,
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

async function shouldUseLocalChatPipeline() {
  logClientRoutingBanner();

  // Normal chat must enter the phone-local agent pipeline first. A missing
  // model adapter is handled inside LocalModelRuntime, not by silently making
  // backend/OpenAI the primary runtime.
  return USE_LOCAL_CHAT_PIPELINE_DEFAULT;
}

async function handleLocalChat(
  path: string,
  body?: any,
): Promise<LocalChatProxyResponse> {
  const userId = Number(body?.user_id ?? body?.userId ?? 0);
  const message = String(body?.message ?? body?.text ?? "").trim();
  const replyLanguage: ReplyLanguage =
    body?.reply_language === "en" || body?.replyLanguage === "en" ? "en" : "ta";

  if (!Number.isFinite(userId) || userId <= 0 || !message) {
    throw new Error(
      "Valid user_id and message are required for local chat routing.",
    );
  }

  const { runLocalAssistantTurn } = await import("./localAgents");
  const turn = await runLocalAssistantTurn({
    userId,
    message,
    replyLanguage,
  });

  const createdAt = new Date().toISOString();
  const normalizedIntent =
    turn.intent === "reminder" ? "reminder" : "assistant";
  const resolvedTitle =
    turn.intent === "reminder"
      ? turn.title || "Reminder"
      : formatIntentLabel(turn.route);

  return {
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
      meta: turn.meta || {},
    },
    meta: {
      source: "local_chat_proxy",
      cacheHit: Boolean(turn.cacheHit),
      route: turn.route,
      created_at: createdAt,
    },
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchBackend(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `GET ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  if (isTranscribeAndAnalyzePath(path)) {
    if (isFormDataPayload(body)) {
      return apiPostForm<T>(path, body);
    }

    if (await shouldUseLocalVoicePipeline()) {
      throw new Error(
        "Local-first recorded voice routing requires FormData with a file part. " +
          "Use apiPostForm('/api/transcribe-and-analyze', formData) or pass FormData to apiPost; " +
          "backend/OpenAI fallback is not automatic when audio input is missing.",
      );
    }
  }

  if (
    localChatInterceptionDepth === 0 &&
    isChatPath(path) &&
    (await shouldUseLocalChatPipeline())
  ) {
    localChatInterceptionDepth += 1;
    try {
      return (await handleLocalChat(path, body)) as T;
    } finally {
      localChatInterceptionDepth = Math.max(0, localChatInterceptionDepth - 1);
    }
  }

  return apiPostBackendOnly<T>(path, body);
}

export async function apiPostBackendOnly<T>(
  path: string,
  body?: any,
): Promise<T> {
  const res = await fetchBackend(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`,
      res.status,
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const resolvedPath = isTranscribeAndAnalyzePath(path)
    ? normalizeVoiceAnalyzePath(path)
    : path;

  if (
    isTranscribeAndAnalyzePath(resolvedPath) &&
    (await shouldUseLocalVoicePipeline())
  ) {
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
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export { getFeatureFlags };
