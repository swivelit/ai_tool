import type { Message, SSEEvent, SwicoTier, Wallet } from './types'

export type StreamState = {
  assistant: Message | null
  phase: string
  wallet: Wallet | null
  error: { code: string; message: string } | null
  done: boolean
}

export type StreamAction =
  | { type: 'start'; requestId: string; threadId: string; tier: SwicoTier; tierLabel: string }
  | { type: 'event'; event: SSEEvent }
  | { type: 'reset' }

export const emptyStreamState: StreamState = { assistant: null, phase: '', wallet: null, error: null, done: false }

function record(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

export function chatStreamReducer(state: StreamState, action: StreamAction): StreamState {
  if (action.type === 'reset') return emptyStreamState
  if (action.type === 'start') return {
    ...emptyStreamState,
    phase: 'connecting',
    assistant: {
      id: `stream-${action.requestId}`, thread_id: action.threadId, role: 'assistant', content: '',
      request_id: action.requestId, tier: action.tier, tier_label: action.tierLabel,
      input_tokens: 0, output_tokens: 0,
      usage_source: null, charge_micros: 0, status: 'streaming', created_at: new Date().toISOString(),
      input_mode: 'text', voice_turn_id: null, reply_language: null,
    },
  }
  const data = record(action.event.data)
  switch (action.event.event) {
    case 'thread':
      return { ...state, assistant: state.assistant ? { ...state.assistant, thread_id: String(data.thread_id ?? '') } : null }
    case 'status':
      return { ...state, phase: String(data.phase ?? '') }
    case 'delta':
      return {
        ...state, phase: 'responding',
        assistant: state.assistant ? { ...state.assistant, content: state.assistant.content + String(data.text ?? '') } : null,
      }
    case 'usage':
      return {
        ...state,
        assistant: state.assistant ? {
          ...state.assistant,
          tier: ['lite', 'standard', 'pro'].includes(String(data.tier)) ? String(data.tier) as SwicoTier : state.assistant.tier,
          tier_label: data.tier_label ? String(data.tier_label) : state.assistant.tier_label,
          input_tokens: Number(data.input_tokens ?? 0), output_tokens: Number(data.output_tokens ?? 0),
          usage_source: data.usage_source === 'actual' ? 'actual' : 'estimated',
          charge_micros: Number(data.charged_micros ?? 0),
        } : null,
      }
    case 'wallet':
      return { ...state, wallet: data as Wallet }
    case 'done':
      return {
        ...state, done: true, phase: data.cancelled ? 'stopped' : 'complete',
        assistant: state.assistant ? {
          ...state.assistant, id: data.message_id ? String(data.message_id) : state.assistant.id,
          status: data.cancelled ? 'cancelled' : 'complete',
          input_mode: data.input_mode === 'voice' ? 'voice' : 'text',
          voice_turn_id: data.voice_turn_id ? String(data.voice_turn_id) : null,
          reply_language: data.reply_language === 'ta' ? 'ta' : data.reply_language === 'en' ? 'en' : null,
        } : null,
      }
    case 'error':
      return {
        ...state, done: true, phase: 'error',
        error: { code: String(data.code ?? 'generation_failed'), message: String(data.message ?? 'Generation failed.') },
        assistant: state.assistant ? { ...state.assistant, status: 'retryable' } : null,
      }
    default:
      return state
  }
}
