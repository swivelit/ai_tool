import type { User } from "firebase/auth";

import type {
  AssistantSettings, Bootstrap, ChatRequestPayload, CreditBucket, KnowledgeDocument,
  MemorySettings, Message, PaymentHistory, PaymentStatus, ProfileSettings, SearchResult,
  Thread, TopupEstimateResponse, UsagePreferences, UsageSummary, Wallet,
} from "./swicoTypes";
import { getE2eReplyLanguage } from "./e2eMode";

type FixtureRequest = { method?: string; body?: BodyInit | null };

const now = () => new Date().toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();

const tokenEstimate = {
  tier: "standard" as const,
  tier_label: "Swico Standard",
  pricing_as_of: "e2e-fixture",
  estimated_blended_tokens: 12_000,
  range_min_tokens: 9_000,
  range_max_tokens: 15_000,
  explanation: "Deterministic debug fixture estimate.",
};

const wallet = (bucket: CreditBucket): Wallet => ({
  credit_bucket: bucket,
  balance_micros: 100_000_000,
  reserved_micros: 0,
  available_micros: 100_000_000,
  version: 1,
  token_estimate: tokenEstimate,
});

const assistantSettings = (): AssistantSettings => ({
  tier: "standard",
  tier_label: "Swico Standard",
  tier_description: "Balanced quality and speed for everyday work.",
  tier_selection_enabled: true,
  tiers: [
    { id: "free", label: "Swico Free", description: "Try Swico with limited usage.", available: true, selected: false },
    { id: "lite", label: "Swico Lite", description: "Fast answers for lighter tasks.", available: true, selected: false },
    { id: "standard", label: "Swico Standard", description: "Balanced quality and speed.", available: true, selected: true },
    { id: "pro", label: "Swico Pro", description: "The strongest available Swico mode.", available: true, selected: false },
  ],
});

const thread: Thread = {
  id: "e2e-thread-1",
  title: "E2E starter conversation",
  archived_at: null,
  created_at: now(),
  updated_at: now(),
};

const state = {
  assistant: assistantSettings(),
  threads: [thread] as Thread[],
  messages: new Map<string, Message[]>(),
  profile: {
    name: "E2E Tester",
    place: "Local Device",
    timezone: "Asia/Kolkata",
    assistant_name: "Elli",
    reply_language: getE2eReplyLanguage(),
    email: "e2e@local.test",
    email_editable: false as const,
  } satisfies ProfileSettings,
  memory: { available: true, enabled: true, items: [] } as MemorySettings,
  usagePreferences: {
    period: "monthly" as const,
    hard_limit_micros: null,
    hard_limit_ai_credits: null,
    warning_threshold_percent: 80,
    notify_at_threshold: true,
    current_usage_micros: 0,
    current_usage_ai_credits: "0",
    remaining_micros: null,
    warning_reached: false,
    hard_limit_token_estimate: null,
    remaining_token_estimate: tokenEstimate,
    next_reset_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    timezone: "Asia/Kolkata",
    updated_at: now(),
    tier: "standard" as const,
    tier_label: "Swico Standard",
  } as UsagePreferences,
  payments: [] as PaymentHistory[],
};

function bootstrap(): Bootstrap {
  return {
    user: { id: 900001, name: state.profile.name, email: state.profile.email, reply_language: state.profile.reply_language },
    wallet: wallet("chat"),
    wallets: { chat: wallet("chat"), voice: wallet("voice") },
    billing: {
      currency: "INR", credit_percent: "50", min_topup_paise: 1_000, max_topup_paise: 50_000,
      razorpay_key_id: "e2e_public_key_only", razorpay_mode: "test", checkout_enabled: false,
      custom_topup_enabled: true,
      packages: [
        { gross_amount_paise: 1_000, credited_amount_micros: 50_000, platform_share_paise: 100, token_estimate: tokenEstimate },
        { gross_amount_paise: 2_500, credited_amount_micros: 125_000, platform_share_paise: 250, token_estimate: tokenEstimate },
      ],
    },
    assistant: state.assistant,
    features: {
      web_chat: true, prepaid_billing: true, web_attachments: true, web_image_uploads: true,
      web_voice_recording: true, web_voice_reply: true, web_voice_billing: true,
      web_realtime_voice: true, separate_voice_credits: true, web_message_edit: true,
      web_cross_thread_memory: true, web_long_input: true, web_answer_feedback: true,
      web_content_search: true, web_response_provenance: true, web_repository_upload: true,
      web_repository_chat: true, web_repository_validation: true, web_knowledge_library: true,
    },
    backend_release: "e2e-fixture",
    voice_protocol_version: 1,
    uploads: {
      available: true, ttl_seconds: 3_600, max_file_bytes: 20_000_000, max_files_per_message: 5,
      max_total_bytes: 50_000_000, supported_extensions: [".txt", ".pdf", ".zip"],
      long_input_enabled: true, long_input_inline_threshold_chars: 16_000, long_input_max_chars: 64_000,
    },
    repositories: { ttl_seconds: 3_600, max_archive_bytes: 50_000_000, validation_capability: "static_only" },
  } as Bootstrap;
}

function usage(): UsageSummary {
  const byTier = {
    free: { label: "Swico Free", request_count: 0, debited_micros: 0, debited_ai_credits: "0", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0, utilization_percentage: 0 },
    lite: { label: "Swico Lite", request_count: 0, debited_micros: 0, debited_ai_credits: "0", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0, utilization_percentage: 0 },
    standard: { label: "Swico Standard", request_count: 2, debited_micros: 100, debited_ai_credits: "100", input_tokens: 20, cached_input_tokens: 0, output_tokens: 40, total_tokens: 60, utilization_percentage: 1 },
    pro: { label: "Swico Pro", request_count: 0, debited_micros: 0, debited_ai_credits: "0", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0, utilization_percentage: 0 },
  };
  return {
    request_count: 2, input_tokens: 20, cached_input_tokens: 0, output_tokens: 40, total_tokens: 60,
    debited_micros: 100, debited_ai_credits: "100", chat_available_credits: "100000", voice_available_credits: "100000",
    estimated_tokens_remaining: tokenEstimate, by_tier: byTier,
    voice: { label: "Voice", stt_request_count: 0, llm_request_count: 0, tts_request_count: 0, total_audio_seconds: 0, total_tts_characters: 0, utilization_percentage: 0 },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bodyObject(init?: FixtureRequest) {
  if (!init?.body || typeof init.body !== "string") return {} as Record<string, unknown>;
  try { return JSON.parse(init.body) as Record<string, unknown>; } catch { return {}; }
}

function pathParts(path: string) {
  return new URL(path, "https://e2e.swico").pathname.split("/").filter(Boolean);
}

function messagesFor(threadId: string) {
  return state.messages.get(threadId) || [];
}

function setMessages(threadId: string, messages: Message[]) {
  state.messages.set(threadId, messages);
}

function assistantMessage(payload: ChatRequestPayload, threadId: string): Message {
  const response = payload.message.toLowerCase().includes("solo")
    ? "Swico E2E fixture response: I can help explain, plan, summarize, and work with your conversations."
    : `Swico E2E fixture response for: ${payload.message}`;
  return {
    id: `e2e-assistant-${payload.request_id}`, thread_id: threadId, role: "assistant", content: response,
    request_id: payload.request_id, tier: state.assistant.tier, tier_label: state.assistant.tier_label,
    input_tokens: 12, output_tokens: 24, usage_source: "actual", charge_micros: 50, status: "complete",
    created_at: now(), input_mode: payload.input_mode, voice_turn_id: payload.voice_turn_id || null,
    reply_language: state.profile.reply_language, finish_reason: "stop", completion_status: "complete",
    sources: [{ id: "e2e-source", label: "E2E fixture", locator: "fixture://swico", confidence: 1, source_kind: "backend_tool" }],
    quality: { status: "good", retrieval_status: "not_requested", repository_validation_mode: null, checks: [{ type: "e2e", status: "pass" }] },
  };
}

export function fixtureJson<T>(_user: User, path: string, init: FixtureRequest = {}): T {
  const method = String(init.method || "GET").toUpperCase();
  const url = new URL(path, "https://e2e.swico");
  const parts = pathParts(path);
  const body = bodyObject(init);

  if (path === "/api/web/bootstrap") return clone(bootstrap()) as T;
  if (parts[2] === "threads" && parts.length === 3) {
    if (method === "POST") {
      const created: Thread = { id: `e2e-thread-${Date.now()}`, title: String(body.title || "New chat"), archived_at: null, created_at: now(), updated_at: now() };
      state.threads.unshift(created);
      return clone(created) as T;
    }
    const archived = url.searchParams.get("archived") === "true";
    return { items: clone(state.threads.filter(item => Boolean(item.archived_at) === archived)), has_more: false } as T;
  }
  if (parts[2] === "threads" && parts[4] === "messages") return { items: clone(messagesFor(parts[3])) } as T;
  if (parts[2] === "threads" && parts.length === 4) {
    const target = state.threads.find(item => item.id === parts[3]);
    if (method === "DELETE") { state.threads = state.threads.filter(item => item.id !== parts[3]); state.messages.delete(parts[3]); return undefined as T; }
    if (target && method === "PATCH") { Object.assign(target, { ...(body.title ? { title: String(body.title) } : {}), ...(typeof body.archived === "boolean" ? { archived_at: body.archived ? now() : null } : {}), updated_at: now() }); return clone(target) as T; }
  }
  if (parts[2] === "search") {
    const query = String(url.searchParams.get("q") || "fixture");
    const result: SearchResult = { thread_id: state.threads[0]?.id || null, message_id: null, snippet: `E2E search result for ${query}`, source_kind: "summary", updated_at: now(), rank: 1 };
    return { items: [result] } as T;
  }
  if (path === "/api/web/settings/assistant" && method === "PATCH") {
    const tier = String(body.tier) as Bootstrap["assistant"]["tier"];
    state.assistant = { ...state.assistant, tier, tier_label: `Swico ${tier[0].toUpperCase()}${tier.slice(1)}`, tiers: state.assistant.tiers.map(item => ({ ...item, selected: item.id === tier })) };
    return clone(state.assistant) as T;
  }
  if (path === "/api/web/settings/profile") {
    if (method === "PATCH") Object.assign(state.profile, body);
    return clone(state.profile) as T;
  }
  if (path === "/api/web/settings/memory") {
    if (method === "PATCH") state.memory.enabled = body.enabled === true;
    if (method === "DELETE") state.memory.items = [];
    return clone(state.memory) as T;
  }
  if (parts[2] === "settings" && parts[3] === "memory" && parts.length === 5 && method === "DELETE") {
    state.memory.items = state.memory.items.filter(item => item.id !== parts[4]);
    return undefined as T;
  }
  if (path.startsWith("/api/web/usage/summary")) return usage() as T;
  if (path === "/api/web/settings/usage") {
    if (method === "PATCH") {
      const limit = body.hard_limit_estimated_tokens;
      state.usagePreferences = { ...state.usagePreferences, warning_threshold_percent: Number(body.warning_threshold_percent || 80), notify_at_threshold: body.notify_at_threshold === true, hard_limit_token_estimate: typeof limit === "number" ? { ...tokenEstimate, estimated_blended_tokens: limit } : null };
    }
    return clone(state.usagePreferences) as T;
  }
  if (path === "/api/web/billing/wallet") return { ...wallet("chat"), wallets: { chat: wallet("chat"), voice: wallet("voice") } } as T;
  if (path === "/api/web/billing/ledger") return { items: [] } as T;
  if (path === "/api/web/billing/payments") return { items: clone(state.payments) } as T;
  if (parts[2] === "billing" && parts[3] === "payments" && parts.length === 5) {
    return { internal_order_id: parts[4], gross_amount_paise: 1_000, credited_amount_micros: 50_000, platform_share_paise: 100, refunded_amount_paise: 0, status: "pending", provider_payment_id: null, created_at: now(), paid_at: null, refunded_at: null, updated_at: now() } as PaymentStatus as T;
  }
  if (parts[2] === "billing" && parts[3] === "estimate") return { gross_amount_paise: Number(url.searchParams.get("gross_amount_paise") || 1_000), credit_bucket: url.searchParams.get("credit_bucket") || "chat", token_estimate: tokenEstimate, voice_estimate: { estimated_stt_minutes: "10", estimated_tts_characters: 10_000, assumption: "E2E fixture" } } as TopupEstimateResponse as T;
  if (path === "/api/web/billing/orders" && method === "POST") return { key_id: "e2e_public_key_only", provider_order_id: "e2e_provider_order", amount: Number(body.gross_amount_paise || 1_000), currency: "INR", internal_order_id: "e2e_internal_order", credited_amount_micros: 50_000, platform_share_paise: 100, credit_bucket: body.credit_bucket || "chat" } as T;
  if (path === "/api/web/billing/verify") return { status: "pending", credited: false } as T;
  if (parts[2] === "knowledge") {
    if (parts.length === 3 && method === "GET") return { items: [] as KnowledgeDocument[] } as T;
    return { job: { status: "complete" } } as T;
  }
  if (path === "/api/web/chat/requests/e2e/status") return { status: "completed", phase: "complete" } as T;
  if (parts[2] === "chat" && parts[3] === "requests" && parts[5] === "cancel") return { status: "stopped" } as T;
  if (path.startsWith("/api/web/uploads") || path.startsWith("/api/web/repositories")) return { id: "e2e-upload", status: "ready", expires_at: future() } as T;
  if (path.startsWith("/api/web/audio")) return { transcript: "E2E dictated text", voice_turn_id: "e2e-voice-turn", detected_language: "en-IN", duration_seconds: 1, duration_milliseconds: 1000, stt_charge: { charged_micros: 0, voice_credits: "100000" }, wallet: wallet("voice") } as T;
  if (path === "/api/web/voice/sessions") return { session_id: "e2e-voice-session", ticket: "e2e-ticket", websocket_url: "wss://127.0.0.1/api/web/voice/ws", tier: state.assistant.tier, tier_label: state.assistant.tier_label, language: state.profile.reply_language, wallets: { chat: wallet("chat"), voice: wallet("voice") }, playback_mode: "client", selected_codec: "mp3", provider_sample_rate: 16000, media_source_allowed: false, approved_websocket_hosts: ["127.0.0.1"] } as T;
  return {} as T;
}

export async function fixtureStreamChat(
  _user: User,
  payload: ChatRequestPayload,
  handlers: { onEvent: (event: { event: string; data: unknown }) => void; onAccepted?: () => void },
  signal: AbortSignal,
) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const threadId = payload.thread_id || `e2e-thread-${Date.now()}`;
  if (!state.threads.some(item => item.id === threadId)) state.threads.unshift({ id: threadId, title: payload.message.slice(0, 40) || "New chat", archived_at: null, created_at: now(), updated_at: now() });
  const userMessage: Message = { id: `e2e-user-${payload.request_id}`, thread_id: threadId, role: "user", content: payload.message, request_id: payload.request_id, tier: state.assistant.tier, tier_label: state.assistant.tier_label, input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "complete", created_at: now(), input_mode: payload.input_mode, voice_turn_id: payload.voice_turn_id || null, reply_language: state.profile.reply_language };
  const assistant = assistantMessage(payload, threadId);
  setMessages(threadId, [...messagesFor(threadId), userMessage, assistant]);
  handlers.onAccepted?.();
  handlers.onEvent({ event: "thread", data: { thread_id: threadId } });
  handlers.onEvent({ event: "status", data: { phase: "responding" } });
  handlers.onEvent({ event: "delta", data: { text: assistant.content } });
  handlers.onEvent({ event: "sources", data: { sources: assistant.sources } });
  handlers.onEvent({ event: "quality", data: assistant.quality });
  handlers.onEvent({ event: "usage", data: { tier: assistant.tier, tier_label: assistant.tier_label, input_tokens: assistant.input_tokens, output_tokens: assistant.output_tokens, usage_source: "actual", charged_micros: assistant.charge_micros } });
  handlers.onEvent({ event: "done", data: { message_id: assistant.id, finish_reason: "stop", completion_status: "complete" } });
}
