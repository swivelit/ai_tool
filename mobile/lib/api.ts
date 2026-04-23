import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

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

  const normalized = String(value ?? "").trim().toLowerCase();
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
  defaultValue: boolean
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

export const API_BASE: string =
  extra.API_BASE ||
  extra.apiBase ||
  extra.apiUrl ||
  process.env.EXPO_PUBLIC_API_BASE ||
  process.env.EXPO_PUBLIC_API_URL ||
  "https://ai-tool-rrau.onrender.com";

const LOCAL_MODEL_BASE_URL: string =
  String(
    extra.LOCAL_MODEL_BASE_URL ||
      process.env.EXPO_PUBLIC_LOCAL_MODEL_BASE_URL ||
      ""
  )
    .trim()
    .replace(/\/$/, "");

const LOCAL_MODEL_API_KEY: string =
  extra.LOCAL_MODEL_API_KEY ||
  process.env.EXPO_PUBLIC_LOCAL_MODEL_API_KEY ||
  "local-phone";

const LOCAL_STT_MODEL: string =
  extra.LOCAL_STT_MODEL ||
  process.env.EXPO_PUBLIC_LOCAL_STT_MODEL ||
  "whisper";

const LOCAL_CHAT_PIPELINE_FLAG = resolveBooleanFlag(
  extra.USE_LOCAL_CHAT_PIPELINE,
  process.env.EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE,
  true
);

const LOCAL_VOICE_PIPELINE_FLAG = resolveBooleanFlag(
  extra.USE_LOCAL_VOICE_PIPELINE,
  process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE,
  false
);

const USE_LOCAL_CHAT_PIPELINE_DEFAULT: boolean = LOCAL_CHAT_PIPELINE_FLAG.value;
const USE_LOCAL_VOICE_PIPELINE_DEFAULT: boolean = LOCAL_VOICE_PIPELINE_FLAG.value;
const CANONICAL_VOICE_ANALYZE_PATH = "/transcribe-and-analyze";

let localChatInterceptionDepth = 0;
let routingBannerLogged = false;

export function getClientRoutingDefaults() {
  return {
    chat: (USE_LOCAL_CHAT_PIPELINE_DEFAULT ? "local" : "backend") as ClientRoutingMode,
    voice: (USE_LOCAL_VOICE_PIPELINE_DEFAULT ? "local" : "backend") as ClientRoutingMode,
    chatSource: LOCAL_CHAT_PIPELINE_FLAG.source,
    voiceSource: LOCAL_VOICE_PIPELINE_FLAG.source,
    apiBase: API_BASE,
    localModelBaseUrl: LOCAL_MODEL_BASE_URL,
  };
}

export function logClientRoutingBanner(logger: Pick<Console, "info"> = console) {
  if (routingBannerLogged) {
    return;
  }

  routingBannerLogged = true;
  const routing = getClientRoutingDefaults();
  logger.info(
    `[routing] chat=${routing.chat} (source=${routing.chatSource}) | voice=${routing.voice} (source=${routing.voiceSource}) | api=${routing.apiBase} | localModel=${routing.localModelBaseUrl}`
  );
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

type LocalAnalyzeResponse = {
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
  };
  assistant: {
    text: string;
    english: string;
    tamil?: string;
    theni_tamil?: string;
  };
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
          : ""
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

async function getFeatureFlags(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && featureFlagsCache && now - featureFlagsFetchedAt < 60_000) {
    return featureFlagsCache;
  }

  try {
    const res = await fetch(buildUrl("/api/flags"));
    if (!res.ok) throw new Error(`flags ${res.status}`);
    const payload = normalizeBackendDates((await res.json()) as FeatureFlagPayload);
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

  const flags = await getFeatureFlags();
  const voiceRoutingMode = String(flags?.voiceRoutingMode || "")
    .trim()
    .toLowerCase();

  if (voiceRoutingMode === "local") {
    return true;
  }

  if (voiceRoutingMode === "backend") {
    return false;
  }

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
      CANONICAL_VOICE_ANALYZE_PATH
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
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) return null;
  if (["auto", "detect", "auto-detect", "autodetect"].includes(normalized)) {
    return null;
  }
  if (normalized.startsWith("ta")) return "ta";
  if (normalized.startsWith("en")) return "en";

  return null;
}

function getRequiredLocalModelBaseUrl() {
  if (LOCAL_MODEL_BASE_URL) {
    return LOCAL_MODEL_BASE_URL;
  }

  throw new Error(
    "EXPO_PUBLIC_LOCAL_MODEL_BASE_URL is required for local voice routing. Use your laptop's LAN IP for a real phone or 10.0.2.2 for the Android emulator."
  );
}

async function transcribeAudioLocally(
  fileUri: string,
  speechLanguage?: unknown
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
        headers: {
          Authorization: `Bearer ${LOCAL_MODEL_API_KEY}`,
        },
        body: form,
      });

      const rawText = await res.text().catch(() => "");
      if (!res.ok) {
        lastError = `${res.status}${rawText ? ` - ${rawText}` : ""}`;
        continue;
      }

      const payload = safeJsonParse<any>(rawText, rawText);
      const transcript = normalizeTranscriptText(extractTranscriptText(payload));

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
      `Local speech transcription failed for model "${LOCAL_STT_MODEL}". Check that your phone-local runtime has this exact model loaded and exposed.`
  );
}

async function handleLocalTranscribeAndAnalyze(
  path: string,
  form: FormData
): Promise<LocalAnalyzeResponse> {
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
  const resolvedSpeechLanguage: SpeechLanguage = requestedSpeechLanguage || replyLanguage;

  let transcript = await transcribeAudioLocally(fileUri, resolvedSpeechLanguage);

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
      "Speech was recorded, but the transcript only contained punctuation. Please speak a little closer to the mic and try again."
    );
  }

  const { runLocalAssistantTurn } = await import("./localAgents");
  const turn = await runLocalAssistantTurn({
    userId,
    message: normalizedTranscriptText,
    replyLanguage,
  });

  return {
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
}

function isChatPath(path: string) {
  const normalized = String(path || "");
  return normalized === "/api/chat" || normalized.startsWith("/api/chat?");
}

async function shouldUseLocalChatPipeline() {
  logClientRoutingBanner();
  return USE_LOCAL_CHAT_PIPELINE_DEFAULT;
}

async function handleLocalChat(path: string, body?: any): Promise<LocalChatProxyResponse> {
  const userId = Number(body?.user_id ?? body?.userId ?? 0);
  const message = String(body?.message ?? body?.text ?? "").trim();
  const replyLanguage: ReplyLanguage =
    body?.reply_language === "en" || body?.replyLanguage === "en" ? "en" : "ta";

  if (!Number.isFinite(userId) || userId <= 0 || !message) {
    throw new Error("Valid user_id and message are required for local chat routing.");
  }

  const { runLocalAssistantTurn } = await import("./localAgents");
  const turn = await runLocalAssistantTurn({
    userId,
    message,
    replyLanguage,
  });

  return {
    ok: true,
    item: {
      id: Date.now(),
      intent: turn.intent === "reminder" ? "reminder" : "assistant",
      category: "Other",
      raw_text: message,
      transcript: null,
      datetime: turn.datetimeText || null,
      title:
        turn.intent === "reminder"
          ? turn.title || "Reminder"
          : formatIntentLabel(turn.route),
      details: turn.assistantText,
    },
    assistant: {
      text: turn.assistantText,
      english: turn.englishText || turn.assistantText,
      tamil: replyLanguage === "ta" ? turn.assistantText : undefined,
      theni_tamil: replyLanguage === "ta" ? turn.assistantText : undefined,
    },
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  if (
    localChatInterceptionDepth === 0 &&
    (await shouldUseLocalChatPipeline()) &&
    isChatPath(path)
  ) {
    localChatInterceptionDepth += 1;
    try {
      return (await handleLocalChat(path, body)) as T;
    } finally {
      localChatInterceptionDepth = Math.max(0, localChatInterceptionDepth - 1);
    }
  }

  const res = await fetch(buildUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }
  return normalizeBackendDates((await res.json()) as T);
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const resolvedPath = isTranscribeAndAnalyzePath(path)
    ? normalizeVoiceAnalyzePath(path)
    : path;

  if (
    (await shouldUseLocalVoicePipeline()) &&
    isTranscribeAndAnalyzePath(resolvedPath)
  ) {
    return (await handleLocalTranscribeAndAnalyze(resolvedPath, form)) as T;
  }

  const res = await fetch(buildUrl(resolvedPath), {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }

  return normalizeBackendDates((await res.json()) as T);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DELETE ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`
    );
  }
  return normalizeBackendDates((await res.json()) as T);
}

export { getFeatureFlags };