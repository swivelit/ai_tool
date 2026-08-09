import type { User } from "firebase/auth";
import Constants from "expo-constants";

import { auth } from "./firebase";
import { isE2eApiFixtureEnabled } from "./e2eMode";
import { fixtureJson, fixtureStreamChat } from "./swicoE2eFixture";
import { SwicoSSEParser } from "./swicoStream";
import type {
  AssistantSettings, Bootstrap, ChatRequestPayload, CreditBucket, InputMode, KnowledgeDocument,
  KnowledgeJobSummary, MemorySettings, Message, ProfileSettings, RealtimeVoiceSession, RepositorySnapshot,
  PaymentHistory, PaymentStatus, SearchResult, SynthesisResponse, Thread, TopupEstimateResponse, TranscriptionResponse, UsagePreferences, UsageSummary, Wallet,
} from "./swicoTypes";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
export const SWICO_API_BASE = String(
  process.env.EXPO_PUBLIC_API_BASE || extra.API_BASE || "https://ai-tool-rrau.onrender.com",
).replace(/\/$/, "");

export class SwicoApiError extends Error {
  public readonly retry_at: string | null;
  public readonly credit_bucket: CreditBucket | null;
  public readonly reset_at: string | null;
  public readonly body: unknown;

  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
    public retryAt: string | null = null,
    metadata: { credit_bucket?: CreditBucket; reset_at?: string | null; retry_at?: string | null } = {},
    body: unknown = null,
  ) {
    super(message);
    this.name = "SwicoApiError";
    this.retry_at = retryAt ?? metadata.retry_at ?? null;
    this.credit_bucket = metadata.credit_bucket ?? null;
    this.reset_at = metadata.reset_at ?? null;
    this.body = body;
  }
}

export class SwicoStreamError extends SwicoApiError {
  constructor(code: string, message: string, retryable = true, retryAt: string | null = null) {
    super(0, code, message, retryable, retryAt);
    this.name = "SwicoStreamError";
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

function errorSource(body: unknown) {
  if (!body || typeof body !== "object") return {};
  const value = body as Record<string, unknown>;
  return value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : value;
}

function metadataOf(body: unknown) {
  const source = errorSource(body);
  const bucket = source.credit_bucket;
  const creditBucket: CreditBucket | undefined = bucket === "chat" || bucket === "voice" ? bucket : undefined;
  return {
    credit_bucket: creditBucket,
    reset_at: typeof source.reset_at === "string" ? source.reset_at : null,
    retry_at: typeof source.retry_at === "string" ? source.retry_at : null,
  };
}

function apiError(status: number, body: unknown) {
  const metadata = metadataOf(body);
  return new SwicoApiError(
    status,
    codeOf(body),
    detail(body),
    typeof errorSource(body).retryable === "boolean" ? errorSource(body).retryable === true : false,
    metadata.retry_at,
    metadata,
    body,
  );
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
  if (isE2eApiFixtureEnabled()) return fixtureJson<T>(user, path, init);
  const response = await authorizedFetch(user, path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(response.status, body);
  return body as T;
}

export function newSwicoRequestId() { return requestId(); }
export const getBootstrap = (user: User) => swicoJson<Bootstrap>(user, "/api/web/bootstrap");
export const getThreads = (user: User, archived = false, q = "", offset = 0) => {
  const query = new URLSearchParams({ archived: String(archived), limit: "50", offset: String(Math.max(0, offset)) });
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
export const getUsageSettings = (user: User) => swicoJson<UsagePreferences>(user, "/api/web/settings/usage");
export const updateUsageSettings = (user: User, body: {
  period: "monthly";
  hard_limit_estimated_tokens: number | null;
  warning_threshold_percent: number;
  notify_at_threshold: boolean;
}) => swicoJson<UsagePreferences>(user, "/api/web/settings/usage", { method: "PATCH", body: JSON.stringify(body) });
export const getWallet = (user: User) => swicoJson<Wallet & { wallets?: Record<string, Wallet> }>(user, "/api/web/billing/wallet");
export const getLedger = (user: User) => swicoJson<{ items: unknown[] }>(user, "/api/web/billing/ledger");
export const getPayments = (user: User) => swicoJson<{ items: PaymentHistory[] }>(user, "/api/web/billing/payments");
export const getPaymentStatus = (user: User, internalOrderId: string) => swicoJson<PaymentStatus>(user, `/api/web/billing/payments/${encodeURIComponent(internalOrderId)}`);
export const getBillingEstimate = (user: User, grossAmountPaise: number, creditBucket: CreditBucket) => swicoJson<TopupEstimateResponse>(user, `/api/web/billing/estimate?gross_amount_paise=${grossAmountPaise}&credit_bucket=${creditBucket}`);
export type BillingOrder = {
  key_id: string;
  provider_order_id: string;
  amount: number;
  currency: string;
  internal_order_id: string;
  credited_amount_micros: number;
  platform_share_paise: number;
  credit_bucket: CreditBucket;
};
export const createBillingOrder = (user: User, body: { gross_amount_paise: number; credit_bucket: CreditBucket; idempotency_key: string }) => swicoJson<BillingOrder>(user, "/api/web/billing/orders", { method: "POST", body: JSON.stringify(body) });
export const verifyBillingPayment = (user: User, body: { internal_order_id: string; razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => swicoJson<{ status: string; credited: boolean }>(user, "/api/web/billing/verify", { method: "POST", body: JSON.stringify(body) });
export const sendFeedback = (user: User, messageId: string, rating: "up" | "down") => swicoJson<void>(user, `/api/web/messages/${encodeURIComponent(messageId)}/feedback`, { method: "POST", body: JSON.stringify({ rating }) });
export const cancelChatRequest = (user: User, id: string) => swicoJson<{ status: string }>(user, `/api/web/chat/requests/${encodeURIComponent(id)}/cancel`, { method: "POST" });
export const chatRequestStatus = (user: User, id: string) => swicoJson<Record<string, unknown>>(user, `/api/web/chat/requests/${encodeURIComponent(id)}/status`);

async function uploadForm<T>(user: User, path: string, fields: Record<string, string>, file?: { uri: string; name: string; type: string }, onProgress?: (progress: number) => void) {
  if (isE2eApiFixtureEnabled()) {
    onProgress?.(100);
    return fixtureJson<T>(user, path, { method: "POST", body: JSON.stringify(fields) });
  }
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  if (file) form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  if (onProgress) {
    const send = (idToken: string) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open("POST", `${SWICO_API_BASE}${path}`); xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100))); };
      xhr.onerror = () => reject(new SwicoApiError(0, "network_error", "Upload could not reach Swico.", true));
      xhr.onabort = () => reject(new SwicoApiError(0, "upload_aborted", "Upload was cancelled."));
      xhr.onload = () => { let body: unknown = {}; try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* safe generic error */ } resolve({ status: xhr.status, body }); };
      onProgress(0); xhr.send(form);
    });
    let result = await send(await token(user));
    if (result.status === 401) result = await send(await token(user, true));
    if (result.status < 200 || result.status >= 300) throw apiError(result.status, result.body);
    onProgress(100); return result.body as T;
  }
  return swicoJson<T>(user, path, { method: "POST", body: form });
}
export const uploadDocument = (user: User, file: { uri: string; name: string; type: string }, onProgress?: (progress: number) => void) => uploadForm<unknown>(user, "/api/web/uploads", {}, file, onProgress);
export const deleteUpload = (user: User, id: string) => swicoJson<void>(user, `/api/web/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
export const uploadText = (user: User, text: string, operation: string) => swicoJson<unknown>(user, "/api/web/uploads/text", { method: "POST", body: JSON.stringify({ upload_id: requestId(), text, operation }) });
export const uploadRepository = (user: User, file: { uri: string; name: string; type: string }, repositoryId: string, onProgress?: (progress: number) => void) => uploadForm<RepositorySnapshot>(user, "/api/web/repositories", { repository_id: repositoryId }, file, onProgress);
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
    let terminalEventReceived = false;
    let terminalError: SwicoStreamError | null = null;
    const emit = (event: { event: string; data: unknown }) => {
      if (event.event === "done" || event.event === "error") terminalEventReceived = true;
      if (event.event === "error") {
        const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
        terminalError = new SwicoStreamError(
          String(data.code || "generation_failed"), String(data.message || "Generation failed."),
          data.retryable === true, typeof data.retry_at === "string" ? data.retry_at : null,
        );
      }
      handlers.onEvent(event);
    };
    const finish = (error?: unknown) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    const consume = () => {
      const text = xhr.responseText || "";
      if (text.length <= offset) return;
      const chunk = text.slice(offset); offset = text.length;
      parser.push(chunk).forEach(emit);
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
        parser.finish().forEach(emit);
        finish(terminalError || (terminalEventReceived ? undefined : new SwicoStreamError(
          "stream_interrupted",
          "The connection ended before Swico finished. Retry.",
        )));
      } else {
        let body: unknown = {};
        try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* safe generic error */ }
        finish(apiError(xhr.status, body));
      }
    };
    xhr.onerror = () => finish(new SwicoApiError(0, "network_error", "We could not reach Swico.", true));
    xhr.onabort = () => finish(new DOMException("Aborted", "AbortError"));
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    try { xhr.send(JSON.stringify(payload)); } catch (error) { finish(error); }
  });
}
export async function streamChat(user: User, payload: ChatRequestPayload, handlers: StreamHandlers, signal: AbortSignal) {
  if (isE2eApiFixtureEnabled()) {
    await fixtureStreamChat(user, payload, handlers, signal);
    return;
  }
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
