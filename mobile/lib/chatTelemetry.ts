import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import { auth } from "./firebase";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

export const CLIENT_TURN_LOG_QUEUE_KEY = "client_turn_logs_queue_v1";
const MAX_QUEUE_SIZE = 100;
const TELEMETRY_TIMEOUT_MS = 10_000;

export type ClientTurnLogPayload = {
  event: string;
  user_id?: number | string | null;
  request_id?: string | null;
  turn_id?: string | null;
  channel?: "text" | "voice" | "handsfree" | "app" | string;
  question?: string | null;
  answer?: string | null;
  question_length?: number;
  answer_length?: number;
  agent_source?: string | null;
  route_taken?: string | null;
  fallback_reason?: string | null;
  duration_ms?: number;
  local_duration_ms?: number;
  backend_duration_ms?: number;
  total_duration_ms?: number;
  stage_timings?: Record<string, any> | null;
  error_type?: string | null;
  app_version?: string | null;
  api_base?: string | null;
  build_number?: string | null;
  created_at?: string | null;
  provider?: string | null;
  voice_phase?: string | null;
  telemetry_delivery?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  chat_routing?: string | null;
  voice_routing?: string | null;
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

function enrichPayload(payload: ClientTurnLogPayload): ClientTurnLogPayload {
  const turnId = payload.turn_id || payload.request_id || newTurnId();
  return {
    ...payload,
    request_id: payload.request_id || turnId,
    turn_id: turnId,
    created_at: payload.created_at || new Date().toISOString(),
    app_version: payload.app_version ?? APP_VERSION,
    api_base: payload.api_base ?? API_BASE,
    build_number: payload.build_number ?? BUILD_NUMBER,
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
