import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import { auth } from "./firebase";
import { getMobileBuildInfo } from "./mobileBuildInfo";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

export const CLIENT_TURN_LOG_QUEUE_KEY = "client_turn_logs_queue_v1";
export const PENDING_LOCAL_TURN_MARKER_KEY = "pending_local_turn_marker_v1";
export const ACTIVE_WORKFLOW_MARKER_KEY = "active_workflow_marker_v1";
const MAX_QUEUE_SIZE = 100;
const TELEMETRY_TIMEOUT_MS = 10_000;

export type ClientTurnLogPayload = {
  event: string;
  user_id?: number | string | null;
  request_id?: string | null;
  turn_id?: string | null;
  channel?: "text" | "voice" | "handsfree" | "app" | string;
  question_hash?: string | null;
  question?: string | null;
  answer?: string | null;
  question_length?: number;
  answer_length?: number;
  agent_source?: string | null;
  route_taken?: string | null;
  fallback_reason?: string | null;
  duration_ms?: number;
  min_duration_ms?: number | null;
  local_duration_ms?: number;
  backend_duration_ms?: number;
  total_duration_ms?: number;
  stage_timings?: Record<string, any> | null;
  workflow_step?: string | null;
  workflow_phase?: string | null;
  step_index?: number | null;
  decision?: string | null;
  cache_hit?: boolean | null;
  cache_source?: string | null;
  global_sync_status?: string | null;
  http_status?: number | null;
  error_name?: string | null;
  error_message?: string | null;
  model_used?: string | null;
  model_tier?: string | null;
  native_backend?: string | null;
  local_runtime_mode?: string | null;
  db_schema_ready?: boolean | null;
  screen?: string | null;
  app_state?: string | null;
  sync_id?: string | null;
  page?: number | null;
  limit?: number | null;
  since?: string | null;
  after_id?: string | null;
  missing_tables?: string[] | null;
  last_step?: string | null;
  started_at?: string | null;
  error_type?: string | null;
  app_version?: string | null;
  api_base?: string | null;
  build_number?: string | null;
  mobile_build_id?: string | null;
  mobile_git_sha?: string | null;
  local_to_backend_fallback_ms?: number | null;
  cloud_fallback_enabled?: boolean | null;
  created_at?: string | null;
  provider?: string | null;
  voice_phase?: string | null;
  telemetry_delivery?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  reply_audio_bytes?: number | null;
  reply_playback_phase?: string | null;
  voice_surface?: string | null;
  requested_reply_language?: "en" | "ta" | string | null;
  requested_speech_language?: "auto" | "en-IN" | "ta-IN" | string | null;
  tts_language_code?: "en-IN" | "ta-IN" | string | null;
  settings_language_mode?: "en" | "ta" | string | null;
  playback_uri_scheme?: string | null;
  chat_routing?: string | null;
  voice_routing?: string | null;
  native_safety_status?: Record<string, any> | null;
  device_memory_status?: Record<string, any> | null;
  question_preview?: string | null;
  answer_preview?: string | null;
};

export type PendingLocalTurnMarker = {
  request_id: string;
  user_id?: number | string | null;
  question_hash: string;
  question?: string | null;
  createdAt: string;
};

export type ActiveWorkflowMarker = {
  request_id: string;
  user_id?: number | string | null;
  question_hash: string;
  question?: string | null;
  question_preview?: string | null;
  question_length?: number;
  startedAt: string;
  lastStep: string;
};

const API_BASE =
  extra.API_BASE ||
  extra.apiBase ||
  extra.apiUrl ||
  process.env.EXPO_PUBLIC_API_BASE ||
  process.env.EXPO_PUBLIC_API_URL ||
  "https://ai-tool-rrau.onrender.com";

const APP_VERSION =
  Constants.expoConfig?.version ||
  (Constants as any).manifest?.version ||
  "";

const BUILD_NUMBER =
  (Constants.expoConfig?.ios as any)?.buildNumber ||
  (Constants.expoConfig?.android as any)?.versionCode?.toString?.() ||
  "";

let flushPromise: Promise<void> | null = null;

function buildUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

function redactSensitiveText(value: unknown) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("idToken"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
}

function warnTelemetryFailure(error: unknown) {
  if (typeof __DEV__ !== "undefined" && !__DEV__) return;
  const message =
    error instanceof Error ? error.message : String(error || "Unknown error");
  if (message === "telemetry_auth_unavailable") return;
  console.warn("[chat-telemetry]", {
    name: (error as any)?.name || "Error",
    status: (error as any)?.status || undefined,
    message: redactSensitiveText(message),
  });
}

function textLength(value: unknown) {
  return String(value || "").length;
}

function newTurnId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function simpleHash(text: unknown) {
  let h = 2166136261;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0).toString(16);
}

function sanitizeQuestionPreview(value: unknown) {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function enrichPayload(payload: ClientTurnLogPayload): ClientTurnLogPayload {
  const turnId = payload.turn_id || payload.request_id || newTurnId();
  const buildInfo = getMobileBuildInfo();
  return {
    ...payload,
    request_id: payload.request_id || turnId,
    turn_id: turnId,
    created_at: payload.created_at || new Date().toISOString(),
    app_version: payload.app_version ?? APP_VERSION,
    api_base: payload.api_base ?? API_BASE,
    build_number: payload.build_number ?? BUILD_NUMBER,
    mobile_build_id: payload.mobile_build_id ?? buildInfo.mobile_build_id,
    mobile_git_sha: payload.mobile_git_sha ?? buildInfo.mobile_git_sha,
    local_to_backend_fallback_ms:
      payload.local_to_backend_fallback_ms ??
      buildInfo.local_to_backend_fallback_ms,
    question_length:
      payload.question_length ?? (payload.question != null ? textLength(payload.question) : undefined),
    answer_length:
      payload.answer_length ?? (payload.answer != null ? textLength(payload.answer) : undefined),
  };
}

async function readQueue(): Promise<ClientTurnLogPayload[]> {
  try {
    const raw = await AsyncStorage.getItem(CLIENT_TURN_LOG_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(-MAX_QUEUE_SIZE) : [];
  } catch (error) {
    warnTelemetryFailure(error);
    return [];
  }
}

async function writeQueue(items: ClientTurnLogPayload[]) {
  const bounded = items.slice(-MAX_QUEUE_SIZE);
  await AsyncStorage.setItem(CLIENT_TURN_LOG_QUEUE_KEY, JSON.stringify(bounded));
}

async function appendQueue(payload: ClientTurnLogPayload) {
  const queue = await readQueue();
  queue.push(enrichPayload(payload));
  await writeQueue(queue);
}

async function removeSentFromQueue(sentCount: number) {
  if (sentCount <= 0) return;
  const latest = await readQueue();
  await writeQueue(latest.slice(sentCount));
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendClientTurnLogNow(payload: ClientTurnLogPayload) {
  const currentUser = auth?.currentUser ?? null;
  if (!currentUser) {
    throw new Error("telemetry_auth_unavailable");
  }

  const token = await currentUser.getIdToken();
  if (!token) {
    throw new Error("telemetry_auth_token_unavailable");
  }

  const response = await fetchWithTimeout(
    buildUrl("/api/client/turn-log"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(enrichPayload(payload)),
    },
    TELEMETRY_TIMEOUT_MS,
  );

  if (!response.ok) {
    const error = new Error(`telemetry POST failed: ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }
}

export async function flushClientTurnLogs() {
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    const queue = await readQueue();
    let sentCount = 0;

    for (const item of queue) {
      try {
        await sendClientTurnLogNow({
          ...item,
          telemetry_delivery: item.telemetry_delivery || "retry",
        });
        sentCount += 1;
      } catch (error) {
        warnTelemetryFailure(error);
        break;
      }
    }

    await removeSentFromQueue(sentCount);
  })().finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

export async function enqueueClientTurnLog(payload: ClientTurnLogPayload) {
  const enriched = enrichPayload(payload);

  try {
    await flushClientTurnLogs();
    await sendClientTurnLogNow({
      ...enriched,
      telemetry_delivery: enriched.telemetry_delivery || "realtime",
    });
  } catch (error) {
    warnTelemetryFailure(error);
    await appendQueue(enriched);
  }
}

export async function markPendingLocalTurn(input: {
  requestId: string;
  userId?: number | string | null;
  question: string;
}) {
  const marker: PendingLocalTurnMarker = {
    request_id: input.requestId,
    user_id: input.userId ?? null,
    question_hash: simpleHash(input.question),
    question: input.question,
    createdAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(PENDING_LOCAL_TURN_MARKER_KEY, JSON.stringify(marker));
  return marker;
}

export async function clearPendingLocalTurn(requestId?: string | null) {
  if (!requestId) {
    await AsyncStorage.removeItem(PENDING_LOCAL_TURN_MARKER_KEY);
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(PENDING_LOCAL_TURN_MARKER_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PendingLocalTurnMarker;
    if (parsed?.request_id === requestId) {
      await AsyncStorage.removeItem(PENDING_LOCAL_TURN_MARKER_KEY);
    }
  } catch {
    await AsyncStorage.removeItem(PENDING_LOCAL_TURN_MARKER_KEY);
  }
}

export async function sendPendingCrashMarkerIfPresent() {
  let marker: PendingLocalTurnMarker | null = null;
  try {
    const raw = await AsyncStorage.getItem(PENDING_LOCAL_TURN_MARKER_KEY);
    if (!raw) return sendActiveWorkflowCrashMarkerIfPresent();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.request_id) {
      await AsyncStorage.removeItem(PENDING_LOCAL_TURN_MARKER_KEY);
      return sendActiveWorkflowCrashMarkerIfPresent();
    }
    marker = parsed as PendingLocalTurnMarker;
  } catch {
    await AsyncStorage.removeItem(PENDING_LOCAL_TURN_MARKER_KEY);
    return sendActiveWorkflowCrashMarkerIfPresent();
  }

  await enqueueClientTurnLog({
    event: "client_turn_crash_suspected",
    user_id: marker.user_id,
    request_id: marker.request_id,
    channel: "text",
    question: marker.question || null,
    agent_source: "local_model",
    route_taken: "local_answer",
    error_type: "pending_local_turn_marker_found",
    created_at: new Date().toISOString(),
  });
  await AsyncStorage.removeItem(PENDING_LOCAL_TURN_MARKER_KEY);
  await sendActiveWorkflowCrashMarkerIfPresent();
  return marker;
}

export async function markActiveWorkflow(input: {
  requestId: string;
  userId?: number | string | null;
  question: string;
  lastStep?: string | null;
}) {
  const marker: ActiveWorkflowMarker = {
    request_id: input.requestId,
    user_id: input.userId ?? null,
    question_hash: simpleHash(input.question),
    question: sanitizeQuestionPreview(input.question),
    question_preview: sanitizeQuestionPreview(input.question),
    question_length: String(input.question || "").length,
    startedAt: new Date().toISOString(),
    lastStep: input.lastStep || "client_chat_turn_started",
  };
  await AsyncStorage.setItem(ACTIVE_WORKFLOW_MARKER_KEY, JSON.stringify(marker));
  return marker;
}

export async function updateActiveWorkflowStep(
  requestId: string | null | undefined,
  lastStep: string,
) {
  if (!requestId || !lastStep) return null;
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_WORKFLOW_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveWorkflowMarker;
    if (parsed?.request_id !== requestId) return parsed;
    const next = { ...parsed, lastStep };
    await AsyncStorage.setItem(ACTIVE_WORKFLOW_MARKER_KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export async function clearActiveWorkflow(requestId?: string | null) {
  if (!requestId) {
    await AsyncStorage.removeItem(ACTIVE_WORKFLOW_MARKER_KEY);
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_WORKFLOW_MARKER_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as ActiveWorkflowMarker;
    if (parsed?.request_id === requestId) {
      await AsyncStorage.removeItem(ACTIVE_WORKFLOW_MARKER_KEY);
    }
  } catch {
    await AsyncStorage.removeItem(ACTIVE_WORKFLOW_MARKER_KEY);
  }
}

export async function sendActiveWorkflowCrashMarkerIfPresent() {
  let marker: ActiveWorkflowMarker | null = null;
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_WORKFLOW_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.request_id) {
      await AsyncStorage.removeItem(ACTIVE_WORKFLOW_MARKER_KEY);
      return null;
    }
    marker = parsed as ActiveWorkflowMarker;
  } catch {
    await AsyncStorage.removeItem(ACTIVE_WORKFLOW_MARKER_KEY);
    return null;
  }

  const startupTime = new Date().toISOString();
  await enqueueClientTurnLog({
    event: "client_workflow_crash_suspected",
    user_id: marker.user_id,
    request_id: marker.request_id,
    channel: "text",
    question_hash: marker.question_hash,
    question: marker.question || null,
    question_preview: marker.question_preview || marker.question || null,
    question_length: marker.question_length ?? marker.question?.length,
    agent_source: "mobile",
    route_taken: "active_workflow",
    workflow_step: marker.lastStep,
    workflow_phase: "crash_suspected",
    last_step: marker.lastStep,
    started_at: marker.startedAt,
    created_at: startupTime,
    error_type: "active_workflow_marker_found",
  });
  await AsyncStorage.removeItem(ACTIVE_WORKFLOW_MARKER_KEY);
  return marker;
}
