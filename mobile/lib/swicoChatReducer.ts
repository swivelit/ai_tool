import type { Message, StreamEvent, SwicoTier, Wallet } from "./swicoTypes";

export type SwicoStreamState = {
  assistant: Message | null;
  phase: string;
  queuePosition: number | null;
  estimatedWaitSeconds: number | null;
  wallet: Wallet | null;
  error: { code: string; message: string; retryable: boolean; retry_at?: string | null } | null;
  done: boolean;
};

export const emptySwicoStreamState: SwicoStreamState = {
  assistant: null, phase: "", queuePosition: null, estimatedWaitSeconds: null,
  wallet: null, error: null, done: false,
};

function object(value: unknown) { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

export function reduceSwicoStream(state: SwicoStreamState, event: StreamEvent): SwicoStreamState {
  const data = object(event.data);
  switch (event.event) {
    case "thread":
      return { ...state, assistant: state.assistant ? {
        ...state.assistant,
        thread_id: String(data.thread_id || state.assistant.thread_id),
        continuation_render_prefix: String(data.continuation_render_prefix || ""),
        continuation_parent_message_id: data.continuation_parent_message_id ? String(data.continuation_parent_message_id) : null,
        continuation_root_message_id: data.continuation_root_message_id ? String(data.continuation_root_message_id) : null,
        continuation_segment_index: Number(data.continuation_segment_index || 0),
        continuation_rewind_characters: Number(data.continuation_rewind_characters || 0),
      } : state.assistant };
    case "status":
      return {
        ...state,
        phase: String(data.phase || ""),
        queuePosition: Number.isFinite(Number(data.queue_position)) ? Number(data.queue_position) : null,
        estimatedWaitSeconds: Number.isFinite(Number(data.estimated_wait_seconds)) ? Number(data.estimated_wait_seconds) : null,
      };
    case "delta":
      return { ...state, phase: "responding", assistant: state.assistant ? { ...state.assistant, content: state.assistant.content + String(data.text || "") } : null };
    case "sources":
      return { ...state, assistant: state.assistant ? { ...state.assistant, sources: Array.isArray(data.sources) ? data.sources as Message["sources"] : [] } : null };
    case "quality":
      return { ...state, assistant: state.assistant ? { ...state.assistant, quality: data as Message["quality"] } : null };
    case "usage":
      return {
        ...state,
        assistant: state.assistant ? {
          ...state.assistant,
          tier: ["free", "lite", "standard", "pro"].includes(String(data.tier)) ? String(data.tier) as SwicoTier : state.assistant.tier,
          tier_label: String(data.tier_label || state.assistant.tier_label),
          input_tokens: Number(data.input_tokens || 0), output_tokens: Number(data.output_tokens || 0),
          usage_source: data.usage_source === "actual" ? "actual" : "estimated",
          charge_micros: Number(data.charged_micros || 0),
        } : state.assistant,
      };
    case "wallet": return { ...state, wallet: data as Wallet };
    case "done":
      return {
        ...state, done: true, phase: data.cancelled ? "stopped" : "complete",
        assistant: state.assistant ? {
          ...state.assistant, id: String(data.message_id || state.assistant.id), status: data.cancelled ? "cancelled" : "complete",
          finish_reason: String(data.finish_reason || "unknown"), truncated: Boolean(data.truncated), can_continue: Boolean(data.can_continue),
          completion_status: String(data.completion_status || "complete"),
          continuation_render_prefix: String(data.continuation_render_prefix || state.assistant.continuation_render_prefix || ""),
          continuation_parent_message_id: data.continuation_parent_message_id ? String(data.continuation_parent_message_id) : state.assistant.continuation_parent_message_id,
          continuation_root_message_id: data.continuation_root_message_id ? String(data.continuation_root_message_id) : state.assistant.continuation_root_message_id,
          continuation_segment_index: Number(data.continuation_segment_index || state.assistant.continuation_segment_index || 0),
          continuation_rewind_characters: Number(data.continuation_rewind_characters || state.assistant.continuation_rewind_characters || 0),
        } : state.assistant,
      };
    case "error":
      return {
        ...state, done: true, phase: "error",
        error: { code: String(data.code || "generation_failed"), message: String(data.message || "Generation failed."), retryable: data.retryable === true, retry_at: typeof data.retry_at === "string" ? data.retry_at : null },
        assistant: state.assistant ? { ...state.assistant, status: "retryable", failure_code: String(data.code || "generation_failed") } : state.assistant,
      };
    default: return state;
  }
}
