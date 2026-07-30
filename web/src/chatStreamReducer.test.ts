import { describe, expect, it } from 'vitest'
import { chatStreamReducer, emptyStreamState } from './chatStreamReducer'
import type { SSEEvent } from './types'

describe('chatStreamReducer', () => {
  it('handles the complete typed SSE lifecycle in one assistant message', () => {
    let state = chatStreamReducer(emptyStreamState, { type: 'start', requestId: 'r1', threadId: '', tier:'lite', tierLabel:'Swico Lite' })
    const events: SSEEvent[] = [
      { event: 'thread', data: { thread_id: 't1' } }, { event: 'status', data: { phase: 'routing' } },
      { event: 'delta', data: { text: 'Hello ' } }, { event: 'delta', data: { text: 'world' } },
      { event: 'usage', data: { tier:'lite', tier_label:'Swico Lite', input_tokens: 4, output_tokens: 2, usage_source: 'actual', charged_micros: 12 } },
      { event: 'wallet', data: { balance_micros: 100, reserved_micros: 0, available_micros: 100, version: 2 } },
      { event: 'done', data: { message_id: 'm1', thread_id: 't1' } },
    ]
    for (const event of events) state = chatStreamReducer(state, { type: 'event', event })
    expect(state.assistant).toMatchObject({ id: 'm1', thread_id: 't1', content: 'Hello world', tier:'lite', tier_label:'Swico Lite', status: 'complete' })
    expect(state.wallet?.available_micros).toBe(100); expect(state.done).toBe(true)
  })
  it('makes an SSE error visible and retryable without creating another assistant', () => {
    let state = chatStreamReducer(emptyStreamState, { type: 'start', requestId: 'r1', threadId: 't1', tier:'standard', tierLabel:'Swico' })
    const id = state.assistant?.id
    state = chatStreamReducer(state, { type: 'event', event: { event: 'error', data: { code: 'provider_failed', message: 'Try again' } } })
    expect(state.error).toEqual({ code: 'provider_failed', message: 'Try again' })
    expect(state.assistant?.status).toBe('retryable'); expect(state.assistant?.id).toBe(id)
  })
  it('preserves partial text and makes an interrupted stream retryable', () => {
    let state = chatStreamReducer(emptyStreamState, { type:'start', requestId:'r-partial', threadId:'t1', tier:'standard', tierLabel:'Swico' })
    state = chatStreamReducer(state, { type:'event', event:{ event:'delta', data:{ text:'Partial answer' } } })
    state = chatStreamReducer(state, { type:'event', event:{ event:'error', data:{
      code:'stream_interrupted',
      message:'The connection ended before Swico finished. Retry.',
    } } })
    expect(state.assistant).toMatchObject({
      content:'Partial answer',
      status:'retryable',
    })
    expect(state.done).toBe(true)
    expect(state.phase).toBe('error')
  })
  it('records truncation and enables explicit continuation only from done metadata', () => {
    let state = chatStreamReducer(emptyStreamState, { type:'start', requestId:'long', threadId:'t1', tier:'lite', tierLabel:'Swico Lite' })
    state = chatStreamReducer(state, { type:'event', event:{ event:'done', data:{
      message_id:'m-long', finish_reason:'length', truncated:true,
      can_continue:true, completion_status:'incomplete',
    } } })
    expect(state.assistant).toMatchObject({
      id:'m-long', finish_reason:'length', truncated:true,
      can_continue:true, completion_status:'incomplete',
    })
  })
  it('ignores malformed and unknown events safely', () => {
    const state = chatStreamReducer(emptyStreamState, { type: 'event', event: { event: 'future', data: 'bad' } })
    expect(state).toBe(emptyStreamState)
  })
})
