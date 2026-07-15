import type { Message, SSEEvent, Wallet } from './types'

export type StreamState = {
  assistant: Message | null
  phase: string
  wallet: Wallet | null
  error: { code: string; message: string } | null
  done: boolean
}

export type StreamAction =
  | { type: 'start'; requestId: string; threadId: string }
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
      request_id: action.requestId, provider: null, model: null, input_tokens: 0, output_tokens: 0,
      usage_source: null, charge_micros: 0, status: 'streaming', created_at: new Date().toISOString(),
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
          ...state.assistant, provider: data.provider ? String(data.provider) : null,
          model: data.model ? String(data.model) : null,
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
