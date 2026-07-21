import { Profiler, StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Conversation } from './Conversation'
import type { Message } from '../types'

const message = (id: string, overrides: Partial<Message> = {}): Message => ({ id, thread_id:'t', role:'assistant', content:`Answer ${id}`, request_id:id, tier:'lite', tier_label:'Swico Lite', input_tokens:1, output_tokens:1, usage_source:'actual', charge_micros:1, status:'complete', created_at:new Date().toISOString(), input_mode:'text', voice_turn_id:null, reply_language:'en', ...overrides })

function controlledAnimationFrames() {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id) })
  return {
    callbacks,
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      act(() => pending.forEach(callback => callback(performance.now())))
    },
  }
}

function scrollMetrics(element: HTMLElement, initialTop = 0) {
  let top = initialTop
  const writes = vi.fn((value: number) => { top = value })
  Object.defineProperties(element, {
    scrollHeight:{ configurable:true, get:() => 1200 },
    clientHeight:{ configurable:true, get:() => 300 },
    scrollTop:{ configurable:true, get:() => top, set:writes },
  })
  return { writes, setTop:(value: number) => { top = value }, getTop:() => top }
}

it('keeps the same assistant DOM node when completion replaces the temporary database id', () => {
  controlledAnimationFrames()
  const streaming = message('stream-request-1', { request_id:'request-1', content:'Partial', status:'streaming' })
  const { rerender } = render(<Conversation messages={[streaming]} retry={vi.fn()} suggest={vi.fn()} />)
  const original = document.querySelector<HTMLElement>('[data-request-id="request-1"]')
  expect(original).toHaveAttribute('data-message-id', 'stream-request-1')
  rerender(<Conversation messages={[{ ...streaming, id:'database-message-1', content:'Complete', status:'complete' }]} retry={vi.fn()} suggest={vi.fn()} />)
  const completed = document.querySelector<HTMLElement>('[data-request-id="request-1"]')
  expect(completed).toBe(original)
  expect(completed).toHaveAttribute('data-message-id', 'database-message-1')
})

it('does not collide user and assistant render keys for the same request', () => {
  controlledAnimationFrames()
  render(<Conversation messages={[
    message('user-database-id', { role:'user', request_id:'shared-request', content:'Question' }),
    message('assistant-database-id', { request_id:'shared-request', content:'Answer' }),
  ]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(screen.getByText('Question')).toBeInTheDocument()
  expect(screen.getByText('Answer')).toBeInTheDocument()
  expect(document.querySelectorAll('.message')).toHaveLength(2)
})

it('coalesces a burst of streaming deltas into one immediate animation-frame scroll', () => {
  const frames = controlledAnimationFrames()
  const stream = message('stream-burst', { request_id:'burst', content:'a', status:'streaming' })
  const { rerender } = render(<Conversation messages={[stream]} retry={vi.fn()} suggest={vi.fn()} />)
  const conversation = screen.getByTestId('conversation')
  const metrics = scrollMetrics(conversation)
  const scrollTo = vi.spyOn(conversation, 'scrollTo')
  frames.flush()
  metrics.writes.mockClear()
  for (let index = 0; index < 30; index += 1) {
    rerender(<Conversation messages={[{ ...stream, content:`a${'b'.repeat(index + 1)}` }]} retry={vi.fn()} suggest={vi.fn()} />)
  }
  expect(frames.callbacks.size).toBe(1)
  frames.flush()
  expect(metrics.writes).toHaveBeenCalledTimes(1)
  expect(metrics.getTop()).toBe(1200)
  expect(scrollTo).not.toHaveBeenCalled()
})

it('keeps one live scheduled frame through StrictMode effect cleanup replay', () => {
  const frames = controlledAnimationFrames()
  const stream = message('stream-strict', { request_id:'strict', content:'a', status:'streaming' })
  render(<StrictMode><Conversation messages={[stream]} retry={vi.fn()} suggest={vi.fn()} /></StrictMode>)
  expect(frames.callbacks.size).toBe(1)
  frames.flush()
  expect(frames.callbacks.size).toBe(0)
})

it('does not steal scroll after the user moves upward', () => {
  const frames = controlledAnimationFrames()
  const stream = message('stream-up', { request_id:'up', content:'a', status:'streaming' })
  const { rerender } = render(<Conversation messages={[stream]} retry={vi.fn()} suggest={vi.fn()} />)
  const conversation = screen.getByTestId('conversation')
  const metrics = scrollMetrics(conversation)
  frames.flush()
  metrics.setTop(200); metrics.writes.mockClear()
  fireEvent.scroll(conversation)
  expect(screen.getByRole('button', { name:'Scroll to bottom' })).toBeVisible()
  rerender(<Conversation messages={[{ ...stream, content:'a new token' }]} retry={vi.fn()} suggest={vi.fn()} />)
  frames.flush()
  expect(metrics.writes).not.toHaveBeenCalled()
  expect(metrics.getTop()).toBe(200)
})

it('resumes following after an immediate jump-to-bottom action', () => {
  const frames = controlledAnimationFrames()
  const stream = message('stream-resume', { request_id:'resume', content:'a', status:'streaming' })
  const { rerender } = render(<Conversation messages={[stream]} retry={vi.fn()} suggest={vi.fn()} />)
  const conversation = screen.getByTestId('conversation')
  const metrics = scrollMetrics(conversation)
  frames.flush()
  metrics.setTop(100); metrics.writes.mockClear(); fireEvent.scroll(conversation)
  fireEvent.click(screen.getByRole('button', { name:'Scroll to bottom' }))
  expect(metrics.writes).toHaveBeenCalledTimes(1)
  expect(metrics.getTop()).toBe(1200)
  metrics.writes.mockClear()
  rerender(<Conversation messages={[{ ...stream, content:'another delta' }]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(frames.callbacks.size).toBe(1)
  frames.flush()
  expect(metrics.writes).toHaveBeenCalledTimes(1)
})

it('does not commit repeated visibility state updates while the pinned state is unchanged', () => {
  controlledAnimationFrames()
  let commits = 0
  const stream = message('stream-state', { request_id:'state', status:'streaming' })
  render(<Profiler id="conversation" onRender={() => { commits += 1 }}><Conversation messages={[stream]} retry={vi.fn()} suggest={vi.fn()} /></Profiler>)
  const conversation = screen.getByTestId('conversation')
  const metrics = scrollMetrics(conversation, 100)
  fireEvent.scroll(conversation)
  const afterVisibleChange = commits
  for (let index = 0; index < 10; index += 1) {
    metrics.setTop(100 - index)
    fireEvent.scroll(conversation)
  }
  expect(commits).toBe(afterVisibleChange)
})

it('shows public tier and measured categories without monetary or routing details', () => {
  render(<Conversation messages={[message('cost-hidden')]} retry={vi.fn()} suggest={vi.fn()} />)
  fireEvent.click(screen.getByText('Details'))
  expect(screen.getByText('Swico Lite')).toBeInTheDocument()
  expect(screen.getByText(/Input 1 · Output 1 · Total 2 tokens/)).toBeInTheDocument()
  expect(screen.getByText('Measured usage')).toBeInTheDocument()
  expect(screen.queryByText(/₹/)).not.toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
})

it('labels historical messages without a tier simply as Swico', () => {
  render(<Conversation messages={[{ ...message('historical'), tier:null, tier_label:'Swico' }]} retry={vi.fn()} suggest={vi.fn()} />)
  fireEvent.click(screen.getByText('Details'))
  expect(screen.getByText('Swico')).toBeInTheDocument()
})

it('shows Continue only for provider-confirmed truncated answers', () => {
  const continueResponse = vi.fn()
  const { rerender } = render(<Conversation messages={[{
    ...message('long'), truncated:true, can_continue:true, finish_reason:'length',
  }]} retry={vi.fn()} suggest={vi.fn()} continueResponse={continueResponse} />)
  fireEvent.click(screen.getByRole('button', { name:'Continue response' }))
  expect(continueResponse).toHaveBeenCalledWith(expect.objectContaining({ id:'long' }))
  rerender(<Conversation messages={[{
    ...message('done'), truncated:false, can_continue:false, finish_reason:'stop',
  }]} retry={vi.fn()} suggest={vi.fn()} continueResponse={continueResponse} />)
  expect(screen.queryByRole('button', { name:'Continue response' })).not.toBeInTheDocument()
})

it('edits only the latest active user message with accessible save and cancel controls', () => {
  const editMessage = vi.fn()
  const userMessage = { ...message('user-latest'), role:'user' as const, content:'Original question' }
  render(<Conversation messages={[userMessage]} retry={vi.fn()} suggest={vi.fn()} editMessage={editMessage} />)
  fireEvent.click(screen.getByRole('button', { name:'Edit message' }))
  const editor = screen.getByLabelText('Edit message')
  fireEvent.change(editor, { target:{ value:'Revised question' } })
  expect(screen.getByText(/may use additional credits/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name:/Save and regenerate/i }))
  expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({ id:'user-latest' }), 'Revised question')
})

it('renders user attachment cards and marks expired metadata without an open action', () => {
  const userMessage: Message = {
    ...message('attachment'), role:'user', content:'Attached: report.pdf', attachments:[{
      id:'upload-1', name:'report.pdf', media_type:'application/pdf', size_bytes:2048,
      created_at:new Date(Date.now() - 700_000).toISOString(), expires_at:new Date(Date.now() - 100_000).toISOString(),
      status:'expired', warnings:[],
    }],
  }
  render(<Conversation messages={[userMessage]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(screen.getByText('report.pdf')).toBeInTheDocument()
  expect(screen.getByText('Expired')).toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:/open|download/i })).not.toBeInTheDocument()
})

it('keeps assistant text visible with accessible voice controls and credit recovery', () => {
  const voiceMessage = { ...message('voice'), input_mode:'voice' as const, voice_turn_id:'turn-1' }
  const play = vi.fn(); const pause = vi.fn(); const retryVoice = vi.fn(); const addCredits = vi.fn()
  const props = { messages:[voiceMessage], retry:vi.fn(), suggest:vi.fn(), playVoice:play, pauseVoice:pause, retryVoice, addCredits }
  const { rerender } = render(<Conversation {...props} voiceStates={{ voice:{ status:'ready', error:null, insufficientCredits:false } }} />)
  expect(screen.getByText('Answer voice')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name:'Play voice reply' }))
  expect(play).toHaveBeenCalledWith('voice')
  rerender(<Conversation {...props} voiceStates={{ voice:{ status:'playing', error:null, insufficientCredits:false } }} />)
  fireEvent.click(screen.getByRole('button', { name:'Pause voice reply' }))
  expect(pause).toHaveBeenCalledWith('voice')
  rerender(<Conversation {...props} voiceStates={{ voice:{ status:'ended', error:null, insufficientCredits:false } }} />)
  expect(screen.getByRole('button', { name:'Replay voice reply' })).toBeInTheDocument()
  rerender(<Conversation {...props} voiceStates={{ voice:{ status:'error', error:'Not enough Voice credits to play this reply', insufficientCredits:true } }} />)
  expect(screen.getByText('Not enough Voice credits to play this reply')).toBeInTheDocument()
  expect(screen.getByText('Answer voice')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name:'Add credits' }))
  expect(addCredits).toHaveBeenCalled()
})
