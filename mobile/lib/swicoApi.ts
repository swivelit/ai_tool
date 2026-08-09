import type { User } from "firebase/auth";
import Constants from "expo-constants";

import { auth } from "./firebase";
import { SwicoSSEParser } from "./swicoStream";
import type {
  AssistantSettings, Bootstrap, ChatRequestPayload, InputMode, KnowledgeDocument,
  KnowledgeJobSummary, MemorySettings, Message, ProfileSettings, RealtimeVoiceSession, RepositorySnapshot,
  SearchResult, SynthesisResponse, Thread, TranscriptionResponse, UsageSummary, Wallet,
} from "./swicoTypes";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
export const SWICO_API_BASE = String(
  process.env.EXPO_PUBLIC_API_BASE || extra.API_BASE || "https://ai-tool-rrau.onrender.com",
).replace(/\/$/, "");

export class SwicoApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "SwicoApiError";
  }
}

function detail(body: unknown) {
  if (!body || typeof body !== "object") return "Request failed.";
  const value = body as Record<string, unknown>;
  const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : null;
  const source = error || value;
  return String(source.message || source.detail || "Request failed.");
}

function codeOf(body: unknown) {
  if (!body || typeof body !== "object") return "request_failed";
  const value = body as Record<string, unknown>;
  const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : null;
  return String(error?.code || value.code || "request_failed");
}

function requestId() {
  const random = Math.random().toString(36).slice(2);
  return `mobile-${Date.now().toString(36)}-${random}`;
}

async function token(user: User, force = false) {
  return user.getIdToken(force);
}

export async function authorizedFetch(user: User, path: string, init: RequestInit = {}) {
  let idToken = await token(user, false);
  const make = (value: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${value}`);
    const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
    if (init.body && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${SWICO_API_BASE}${path}`, { ...init, headers });
  };
  let response = await make(idToken);
  if (response.status === 401) {
    idToken = await token(user, true);
    response = await make(idToken);
  }
  return response;
}

export async function swicoJson<T>(user: User, path: string, init: RequestInit = {}) {
  const response = await authorizedFetch(user, path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SwicoApiError(response.status, codeOf(body), detail(body));
  return body as T;
}

export function newSwicoRequestId() { return requestId(); }
export const getBootstrap = (user: User) => swicoJson<Bootstrap>(user, "/api/web/bootstrap");
export const getThreads = (user: User, archived = false, q = "") => {
  const query = new URLSearchParams({ archived: String(archived), limit: "50", offset: "0" });
  if (q.trim()) query.set("q", q.trim());
  return swicoJson<{ items: Thread[]; has_more: boolean }>(user, `/api/web/threads?${query}`);
};
export const createThread = (user: User, title: string) => swicoJson<Thread>(user, "/api/web/threads", { method: "POST", body: JSON.stringify({ title }) });
export const getMessages = (user: User, threadId: string) => swicoJson<{ items: Message[] }>(user, `/api/web/threads/${encodeURIComponent(threadId)}/messages`);
export const patchThread = (user: User, id: string, body: { title?: string; archived?: boolean }) => swicoJson<Thread>(user, `/api/web/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteThread = (user: User, id: string) => swicoJson<void>(user, `/api/web/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
export const searchChats = (user: User, query: string) => swicoJson<{ items: SearchResult[] }>(user, `/api/web/search?q=${encodeURIComponent(query)}&limit=20`);
export const updateAssistant = (user: User, tier: string) => swicoJson<AssistantSettings>(user, "/api/web/settings/assistant", { method: "PATCH", body: JSON.stringify({ tier }) });
export const getProfileSettings = (user: User) => swicoJson<ProfileSettings>(user, "/api/web/settings/profile");
export const updateProfileSettings = (user: User, body: Partial<ProfileSettings>) => swicoJson<ProfileSettings>(user, "/api/web/settings/profile", { method: "PATCH", body: JSON.stringify(body) });
export const getMemorySettings = (user: User) => swicoJson<MemorySettings>(user, "/api/web/settings/memory");
export const updateMemorySettings = (user: User, enabled: boolean) => swicoJson<MemorySettings>(user, "/api/web/settings/memory", { method: "PATCH", body: JSON.stringify({ enabled }) });
export const deleteMemory = (user: User, id?: string) => swicoJson<void>(user, id ? `/api/web/settings/memory/${encodeURIComponent(id)}` : "/api/web/settings/memory", { method: "DELETE" });
export const getUsage = (user: User) => swicoJson<UsageSummary>(user, "/api/web/usage/summary?period=current_month");
export const getUsageSettings = (user: User) => swicoJson<Record<string, unknown>>(user, "/api/web/settings/usage");
export const getWallet = (user: User) => swicoJson<Wallet & { wallets?: Record<string, Wallet> }>(user, "/api/web/billing/wallet");
export const getLedger = (user: User) => swicoJson<{ items: unknown[] }>(user, "/api/web/billing/ledger");
export const getPayments = (user: User) => swicoJson<{ items: unknown[] }>(user, "/api/web/billing/payments");
export const sendFeedback = (user: User, messageId: string, rating: "up" | "down") => swicoJson<void>(user, `/api/web/messages/${encodeURIComponent(messageId)}/feedback`, { method: "POST", body: JSON.stringify({ rating }) });
export const cancelChatRequest = (user: User, id: string) => swicoJson<{ status: string }>(user, `/api/web/chat/requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
export const chatRequestStatus = (user: User, id: string) => swicoJson<Record<string, unknown>>(user, `/api/web/chat/requests/${encodeURIComponent(id)}/status`);

async function uploadForm<T>(user: User, path: string, fields: Record<string, string>, file?: { uri: string; name: string; type: string }) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  if (file) form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  return swicoJson<T>(user, path, { method: "POST", body: form });
}
export const uploadDocument = (user: User, file: { uri: string; name: string; type: string }) => uploadForm<unknown>(user, "/api/web/uploads", {}, file);
export const deleteUpload = (user: User, id: string) => swicoJson<void>(user, `/api/web/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
export const uploadText = (user: User, text: string, operation: string) => swicoJson<unknown>(user, "/api/web/uploads/text", { method: "POST", body: JSON.stringify({ upload_id: requestId(), text, operation }) });
export const uploadRepository = (user: User, file: { uri: string; name: string; type: string }, repositoryId: string) => uploadForm<RepositorySnapshot>(user, "/api/web/repositories", { repository_id: repositoryId }, file);
export const deleteRepository = (user: User, id: string) => swicoJson<void>(user, `/api/web/repositories/${encodeURIComponent(id)}`, { method: "DELETE" });
export const listKnowledge = (user: User) => swicoJson<{ items: KnowledgeDocument[] }>(user, "/api/web/knowledge");
export const approveKnowledge = (user: User, uploadId: string) => swicoJson<unknown>(user, "/api/web/knowledge", { method: "POST", body: JSON.stringify({ upload_id: uploadId, confirm_persistence: true }) });
export const deleteKnowledge = (user: User, id: string) => swicoJson<void>(user, `/api/web/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" });
export const reindexKnowledge = (user: User, id: string, operationId = requestId()) => swicoJson<unknown>(user, `/api/web/knowledge/${encodeURIComponent(id)}/reindex`, { method: "POST", body: JSON.stringify({ operation_id: operationId }) });
export const getKnowledgeJobStatus = (user: User, id: string) => swicoJson<{ job: KnowledgeJobSummary }>(user, `/api/web/knowledge/${encodeURIComponent(id)}/job`);
export const cancelKnowledgeJob = (user: User, id: string) => swicoJson<{ job: KnowledgeJobSummary }>(user, `/api/web/knowledge/${encodeURIComponent(id)}/job`, { method: "DELETE" });
export const transcribeAudioUri = (user: User, file: { uri: string; name: string; type: string }, operationId: string, voiceTurnId: string, language?: string) => uploadForm<TranscriptionResponse>(user, "/api/web/audio/transcribe", { operation_id: operationId, voice_turn_id: voiceTurnId, ...(language ? { language } : {}) }, file);
export const synthesizeAudio = (user: User, body: { operation_id: string; message_id: string; voice_turn_id: string }) => swicoJson<SynthesisResponse>(user, "/api/web/audio/synthesize", { method: "POST", body: JSON.stringify(body) });
export const createVoiceSession = (user: User, body: Record<string, unknown> = {}) => swicoJson<RealtimeVoiceSession>(user, "/api/web/voice/sessions", { method: "POST", body: JSON.stringify(body) });
export const endVoiceSession = (user: User) => swicoJson<void>(user, "/api/web/voice/sessions", { method: "DELETE" });

type StreamHandlers = { onEvent: (event: { event: string; data: unknown }) => void; onAccepted?: () => void };
async function streamAttempt(user: User, payload: ChatRequestPayload, handlers: StreamHandlers, signal: AbortSignal, forceToken = false) {
  const idToken = await token(user, forceToken);
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const parser = new SwicoSSEParser();
    let offset = 0;
    let accepted = false;
    let settled = false;
    const finish = (error?: unknown) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    const consume = () => {
      const text = xhr.responseText || "";
      if (text.length <= offset) return;
      const chunk = text.slice(offset); offset = text.length;
      parser.push(chunk).forEach(handlers.onEvent);
    };
    xhr.open("POST", `${SWICO_API_BASE}/api/web/chat/stream`);
    xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2 && !accepted && xhr.status >= 200 && xhr.status < 300) { accepted = true; handlers.onAccepted?.(); }
      if (xhr.readyState === 3) consume();
      if (xhr.readyState !== 4) return;
      consume();
      if (xhr.status >= 200 && xhr.status < 300) {
        parser.finish().forEach(handlers.onEvent);
        finish();
      } else {
        let body: unknown = {};
        try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* safe generic error */ }
        finish(new SwicoApiError(xhr.status, codeOf(body), detail(body)));
      }
    };
    xhr.onerror = () => finish(new SwicoApiError(0, "network_error", "We could not reach Swico."));
    xhr.onabort = () => finish(new DOMException("Aborted", "AbortError"));
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    try { xhr.send(JSON.stringify(payload)); } catch (error) { finish(error); }
  });
}
export async function streamChat(user: User, payload: ChatRequestPayload, handlers: StreamHandlers, signal: AbortSignal) {
  try {
    await streamAttempt(user, payload, handlers, signal);
  } catch (error) {
    if (error instanceof SwicoApiError && error.status === 401) {
      await streamAttempt(user, payload, handlers, signal, true);
      return;
    }
    throw error;
  }
}

export function swicoPayload(message: string, threadId?: string, inputMode: InputMode = "text"): ChatRequestPayload {
  return { request_id: requestId(), message, ...(threadId ? { thread_id: threadId } : {}), input_mode: inputMode };
}
