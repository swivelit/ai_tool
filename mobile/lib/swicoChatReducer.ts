import type { Message, ResponseQuality, SourceSummary, StreamEvent, SwicoTier, Wallet } from "./swicoTypes";

export type SwicoStreamState = {
  assistant: Message | null;
  phase: string;
  queuePosition: number | null;
  estimatedWaitSeconds: number | null;
  wallet: Wallet | null;
  error: { code: string; message: string; retryable: boolean; retry_at: string | null; credit_bucket?: "chat" | "voice"; reset_at?: string | null; retry_after_seconds?: number | null } | null;
  done: boolean;
};

export const emptySwicoStreamState: SwicoStreamState = {
  assistant: null, phase: "", queuePosition: null, estimatedWaitSeconds: null,
  wallet: null, error: null, done: false,
};

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

function has(data: Record<string, unknown>, key: string) { return Object.prototype.hasOwnProperty.call(data, key); }

function sources(value: unknown): SourceSummary[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const source = object(item);
    const id = String(source.id ?? "").slice(0, 16);
    const label = String(source.label ?? "").slice(0, 128);
    const locator = String(source.locator ?? "").slice(0, 256);
    if (!id || !label || !locator) return [];
    const confidenceValue = Number(source.confidence ?? 0);
    return [{ id, label, locator, confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0, source_kind: String(source.source_kind ?? "").slice(0, 32) }];
  });
}

function quality(value: unknown): ResponseQuality | null {
  const input = object(value);
  const status = String(input.status ?? "");
  if (!["verified", "grounded", "best_effort", "unverified", "insufficient_evidence"].includes(status)) return null;
  const checks = (Array.isArray(input.checks) ? input.checks : []).flatMap(item => {
    const check = object(item);
    const type = String(check.type ?? "").slice(0, 64);
    const checkStatus = String(check.status ?? "");
    if (!type || !["passed", "failed", "warning", "skipped", "error"].includes(checkStatus)) return [];
    return [{ type, status: checkStatus }];
  });
  const mode = String(input.repository_validation_mode ?? "");
  return {
    status,
    retrieval_status: typeof input.retrieval_status === "string" ? input.retrieval_status.slice(0, 32) : null,
    repository_validation_mode: ["static_only", "executable", "unavailable"].includes(mode) ? mode : null,
    checks: checks.slice(0, 24),
  };
}

export function reduceSwicoStream(state: SwicoStreamState, event: StreamEvent): SwicoStreamState {
  const data = object(event.data);
  switch (event.event) {
    case "thread":
      return { ...state, assistant: state.assistant ? {
        ...state.assistant,
        thread_id: has(data, "thread_id") ? String(data.thread_id ?? state.assistant.thread_id) : state.assistant.thread_id,
        continuation_render_prefix: has(data, "continuation_render_prefix") ? String(data.continuation_render_prefix ?? "") : state.assistant.continuation_render_prefix,
        continuation_parent_message_id: has(data, "continuation_parent_message_id") ? (data.continuation_parent_message_id ? String(data.continuation_parent_message_id) : null) : state.assistant.continuation_parent_message_id,
        continuation_root_message_id: has(data, "continuation_root_message_id") ? (data.continuation_root_message_id ? String(data.continuation_root_message_id) : null) : state.assistant.continuation_root_message_id,
        continuation_segment_index: has(data, "continuation_segment_index") ? Number(data.continuation_segment_index ?? 0) : state.assistant.continuation_segment_index,
        continuation_rewind_characters: has(data, "continuation_rewind_characters") ? Number(data.continuation_rewind_characters ?? 0) : state.assistant.continuation_rewind_characters,
      } : state.assistant };
    case "status":
      return {
        ...state,
        phase: has(data, "phase") ? String(data.phase ?? "") : state.phase,
        queuePosition: has(data, "queue_position") && Number.isFinite(Number(data.queue_position)) ? Math.max(1, Number(data.queue_position)) : state.queuePosition,
        estimatedWaitSeconds: has(data, "estimated_wait_seconds") && Number.isFinite(Number(data.estimated_wait_seconds)) ? Math.max(0, Number(data.estimated_wait_seconds)) : state.estimatedWaitSeconds,
      };
    case "delta":
      return { ...state, phase: "responding", assistant: state.assistant ? { ...state.assistant, content: state.assistant.content + String(data.text ?? "") } : null };
    case "sources":
      return { ...state, assistant: state.assistant ? { ...state.assistant, sources: sources(data.sources) } : null };
    case "quality":
      return { ...state, assistant: state.assistant ? { ...state.assistant, quality: quality(data) } : null };
    case "usage":
      return {
        ...state,
        assistant: state.assistant ? {
          ...state.assistant,
          tier: ["free", "lite", "standard", "pro"].includes(String(data.tier)) ? String(data.tier) as SwicoTier : state.assistant.tier,
          tier_label: has(data, "tier_label") ? String(data.tier_label ?? state.assistant.tier_label) : state.assistant.tier_label,
          input_tokens: has(data, "input_tokens") ? Number(data.input_tokens ?? 0) : state.assistant.input_tokens,
          output_tokens: has(data, "output_tokens") ? Number(data.output_tokens ?? 0) : state.assistant.output_tokens,
          usage_source: has(data, "usage_source") ? (data.usage_source === "actual" ? "actual" : "estimated") : state.assistant.usage_source,
          charge_micros: has(data, "charged_micros") ? Number(data.charged_micros ?? 0) : state.assistant.charge_micros,
        } : state.assistant,
      };
    case "wallet": return { ...state, wallet: data as Wallet };
    case "done":
      return {
        ...state, done: true, phase: data.cancelled ? "stopped" : "complete",
        assistant: state.assistant ? {
          ...state.assistant, id: has(data, "message_id") && data.message_id ? String(data.message_id) : state.assistant.id, status: data.cancelled ? "cancelled" : "complete",
          ...(has(data, "input_mode") && ["text", "voice", "dictation", "realtime_voice"].includes(String(data.input_mode)) ? { input_mode: String(data.input_mode) as Message["input_mode"] } : {}),
          ...(has(data, "voice_turn_id") ? { voice_turn_id: data.voice_turn_id ? String(data.voice_turn_id) : null } : {}),
          ...(has(data, "reply_language") ? { reply_language: data.reply_language === "ta" ? "ta" as const : data.reply_language === "en" ? "en" as const : null } : {}),
          ...(has(data, "finish_reason") ? { finish_reason: String(data.finish_reason ?? "unknown") } : {}),
          ...(has(data, "truncated") ? { truncated: Boolean(data.truncated) } : {}),
          ...(has(data, "can_continue") ? { can_continue: Boolean(data.can_continue) } : {}),
          ...(has(data, "completion_status") ? { completion_status: String(data.completion_status ?? "unknown") } : {}),
          continuation_render_prefix: has(data, "continuation_render_prefix") ? String(data.continuation_render_prefix ?? "") : (state.assistant.continuation_render_prefix || ""),
          continuation_parent_message_id: data.continuation_parent_message_id ? String(data.continuation_parent_message_id) : state.assistant.continuation_parent_message_id,
          continuation_root_message_id: data.continuation_root_message_id ? String(data.continuation_root_message_id) : state.assistant.continuation_root_message_id,
          continuation_segment_index: has(data, "continuation_segment_index") ? Number(data.continuation_segment_index ?? 0) : (state.assistant.continuation_segment_index || 0),
          continuation_rewind_characters: has(data, "continuation_rewind_characters") ? Number(data.continuation_rewind_characters ?? 0) : (state.assistant.continuation_rewind_characters || 0),
          ...(has(data, "provenance") ? { provenance: Array.isArray(data.provenance) ? data.provenance.map(String).filter(value => ["memory", "document", "repository", "cached_answer", "semantic_cache", "backend_tool", "web_search"].includes(value)) as Message["provenance"] : [] } : {}),
          ...(has(data, "sources") ? { sources: Array.isArray(data.sources) ? sources(data.sources) : state.assistant.sources } : {}),
          ...(has(data, "quality") ? { quality: quality(data.quality) } : {}),
        } : state.assistant,
      };
    case "error":
      return {
        ...state, done: true, phase: "error",
        error: {
          code: String(data.code || "generation_failed"), message: String(data.message || "Generation failed."), retryable: data.retryable === true,
          retry_at: typeof data.retry_at === "string" ? data.retry_at : null,
          ...(data.credit_bucket === "chat" || data.credit_bucket === "voice" ? { credit_bucket: data.credit_bucket } : {}),
          ...(typeof data.reset_at === "string" ? { reset_at: data.reset_at } : {}),
          ...(typeof data.retry_after_seconds === "number" ? { retry_after_seconds: Math.max(0, data.retry_after_seconds) } : {}),
        },
        assistant: state.assistant ? { ...state.assistant, status: "retryable", failure_code: String(data.code || "generation_failed"), retry_at: typeof data.retry_at === "string" ? data.retry_at : null } : state.assistant,
      };
    default: return state;
  }
}
