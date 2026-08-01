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

it.each([
  ['searching_repository', 'Swico is reading the repository'],
  ['running_code_checks', 'Swico is running safe code checks'],
])('renders the safe Phase 4 status for %s', (phase, label) => {
  controlledAnimationFrames()
  render(<Conversation messages={[]} retry={vi.fn()} suggest={vi.fn()} phase={phase} />)
  expect(screen.getByRole('status')).toHaveTextContent(label)
  expect(document.body.textContent).not.toMatch(/provider|model|command|stdout|stderr/i)
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

it('offers regeneration only for a completed assistant answer', () => {
  controlledAnimationFrames()
  const regenerate = vi.fn()
  const completed = message('completed-answer')
  render(<Conversation messages={[completed]} retry={vi.fn()} suggest={vi.fn()}
    editingAvailable regenerateResponse={regenerate} />)
  const button = screen.getByRole('button', { name:'Regenerate answer' })
  expect(button).toHaveClass('regenerate-answer')
  expect(button).not.toHaveClass('icon-button')
  fireEvent.click(button)
  expect(regenerate).toHaveBeenCalledWith(completed)
})

it('shows top response tools only after non-empty assistant completion', () => {
  const { rerender } = render(<Conversation
    messages={[message('streaming-tools', {
      status: 'streaming',
      content: 'Partial answer',
    })]}
    retry={vi.fn()}
    suggest={vi.fn()}
  />)
  expect(screen.queryByRole('toolbar', { name: 'Response tools' })).not.toBeInTheDocument()

  rerender(<Conversation
    messages={[message('completed-tools', { content: 'Complete answer' })]}
    retry={vi.fn()}
    suggest={vi.fn()}
  />)
  expect(screen.getByRole('toolbar', { name: 'Response tools' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Edit response' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Copy response' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Download response' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open response editor' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copy answer' })).not.toBeInTheDocument()

  rerender(<Conversation
    messages={[message('empty-tools', { content: '' })]}
    retry={vi.fn()}
    suggest={vi.fn()}
  />)
  expect(screen.queryByRole('toolbar', { name: 'Response tools' })).not.toBeInTheDocument()
})

it('keeps assistant edits local and uses the working copy for toolbar copy', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  render(<Conversation
    messages={[message('local-edit', { content: 'Original response' })]}
    retry={vi.fn()}
    suggest={vi.fn()}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Edit response' }))
  fireEvent.change(screen.getByLabelText('Response Markdown source'), {
    target: { value: 'Locally edited response' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close response editor' }))

  expect(screen.getByText('Locally edited response')).toBeInTheDocument()
  expect(screen.queryByText('Original response')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Copy response' }))
  await act(async () => undefined)
  expect(writeText).toHaveBeenCalledWith('Locally edited response')
  expect(document.body.textContent).not.toMatch(
    /openai|gpt-|sarvam|internal model/i,
  )
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

it('renders safe source labels and locators without provider names', () => {
  render(<Conversation messages={[message('sourced', { sources:[{
    id:'S1', label:'employee-guide.pdf', locator:'employee-guide.pdf — page 4',
    confidence:0.9, source_kind:'temporary_upload',
  }] })]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(screen.getByRole('region', { name:'Sources' })).toBeInTheDocument()
  expect(screen.getByText('employee-guide.pdf')).toBeInTheDocument()
  expect(screen.getByText('employee-guide.pdf — page 4')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|sarvam/i)
})

it('renders persisted quality without provider or model details', () => {
  render(<Conversation messages={[message('quality', { quality:{
    status:'grounded', retrieval_status:'sufficient',
    repository_validation_mode:null,
    checks:[{ type:'citation_validity', status:'passed' }],
  } })]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(screen.getByText('Sources checked')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|sarvam|model/i)
})

it('labels historical messages without a tier simply as Swico', () => {
  render(<Conversation messages={[{ ...message('historical'), tier:null, tier_label:'Swico' }]} retry={vi.fn()} suggest={vi.fn()} />)
  fireEvent.click(screen.getByText('Details'))
  expect(screen.getByText('Swico')).toBeInTheDocument()
})

it('shows Continue for provider or local structural truncation only', () => {
  const continueResponse = vi.fn()
  const { rerender } = render(<Conversation messages={[{
    ...message('long'), truncated:true, can_continue:true,
    finish_reason:'local_incomplete', completion_status:'incomplete',
  }]} retry={vi.fn()} suggest={vi.fn()} continueResponse={continueResponse} />)
  fireEvent.click(screen.getByRole('button', { name:'Continue response' }))
  expect(continueResponse).toHaveBeenCalledWith(expect.objectContaining({ id:'long' }))
  rerender(<Conversation messages={[{
    ...message('done'), truncated:false, can_continue:false, finish_reason:'stop',
  }]} retry={vi.fn()} suggest={vi.fn()} continueResponse={continueResponse} />)
  expect(screen.queryByRole('button', { name:'Continue response' })).not.toBeInTheDocument()
})

it('renders inherited HTML continuation as safe code and does not double-prefix', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable:true, value:{ writeText },
  })
  const raw = '  <meta name="theme-color" content="#6757ff">\n  <style>:root { color: red; }</style>\n```'
  const { container, rerender } = render(<Conversation messages={[message('continued', {
    content:raw,
    continuation_render_prefix:'```html\n',
  })]} retry={vi.fn()} suggest={vi.fn()} />)
  const code = container.querySelector('.code-block code')
  expect(code?.textContent).toContain('<meta name="theme-color"')
  expect(container.querySelector('meta')).not.toBeInTheDocument()
  expect(container.querySelector('style')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name:'Copy code' }))
  await act(async () => undefined)
  expect(writeText).toHaveBeenCalledWith(raw.replace(/\n```$/, ''))
  fireEvent.click(screen.getByRole('button', { name:'Open response editor' }))
  fireEvent.click(screen.getByRole('button', { name:'Edit' }))
  expect(screen.getByLabelText('Response Markdown source')).toHaveValue(`\`\`\`html\n${raw}`)

  fireEvent.click(screen.getByRole('button', { name:'Close response editor' }))
  rerender(<Conversation messages={[message('continued', {
    content:'```html\n<div>already fenced</div>\n```',
    continuation_render_prefix:'```html\n',
  })]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(container.querySelectorAll('.code-block')).toHaveLength(1)
  expect(container.querySelector('.code-block code')?.textContent).toBe('<div>already fenced</div>')
})

it('hides continuation controls and manages parent/child Continue buttons', () => {
  const parent = message('parent', {
    truncated:true, can_continue:true,
  })
  const control = message('control', {
    role:'user', content:'Continue response', is_continuation_control:true,
  })
  const child = message('child', {
    truncated:true, can_continue:true,
    continuation_parent_message_id:'parent',
  })
  const { rerender } = render(<Conversation
    messages={[parent, control]}
    continuingMessageId="parent"
    retry={vi.fn()} suggest={vi.fn()}
  />)
  expect(screen.queryByText('Continue response', { selector:'.user-bubble' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Continue response' })).toBeDisabled()

  rerender(<Conversation messages={[
    { ...parent, can_continue:false }, child,
  ]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(screen.getAllByRole('button', { name:'Continue response' })).toHaveLength(1)
  expect(screen.getByRole('button', { name:'Continue response' })).toBeEnabled()
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

it('copies every visible prompt exactly and edits only the latest visible prompt', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  Object.defineProperty(navigator, 'clipboard', {
    configurable:true, value:{ writeText },
  })
  const older = message('older-prompt', {
    role:'user',
    content:'First line\n  indented second line',
  })
  const hiddenControl = message('hidden-control', {
    role:'user',
    content:'Continue response',
    is_continuation_control:true,
  })
  const latest = message('latest-prompt', {
    role:'user',
    content:'Latest prompt',
  })
  render(<Conversation
    messages={[older, hiddenControl, latest]}
    retry={vi.fn()}
    suggest={vi.fn()}
    editingAvailable
  />)

  const copyButtons = screen.getAllByRole('button', { name:'Copy prompt' })
  expect(copyButtons).toHaveLength(2)
  fireEvent.click(copyButtons[0])
  await act(async () => undefined)
  expect(writeText).toHaveBeenCalledWith(
    'First line\n  indented second line'
  )
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(screen.getAllByRole('button', { name:'Edit message' })).toHaveLength(1)
  expect(screen.queryByText('Continue response')).not.toBeInTheDocument()
  expect(screen.getAllByRole('toolbar', { name:'Prompt actions' })).toHaveLength(2)
  fetchSpy.mockRestore()
})

it('keeps Copy enabled while generation disables Edit and honors the edit feature flag', () => {
  const prompt = message('active-prompt', {
    role:'user',
    content:'Question',
  })
  const { rerender } = render(<Conversation
    messages={[prompt]}
    retry={vi.fn()}
    suggest={vi.fn()}
    editingAvailable
    editingDisabled
  />)
  expect(screen.getByRole('button', { name:'Copy prompt' })).toBeEnabled()
  expect(screen.getByRole('button', { name:'Edit message' })).toBeDisabled()

  rerender(<Conversation
    messages={[prompt]}
    retry={vi.fn()}
    suggest={vi.fn()}
    editingAvailable={false}
  />)
  expect(screen.getByRole('button', { name:'Copy prompt' })).toBeEnabled()
  expect(screen.queryByRole('button', { name:'Edit message' })).not.toBeInTheDocument()
})

it('announces clipboard rejection and cleans its feedback timer in StrictMode', async () => {
  vi.useFakeTimers()
  const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
  Object.defineProperty(navigator, 'clipboard', {
    configurable:true,
    value:{ writeText:vi.fn().mockRejectedValue(new Error('denied')) },
  })
  const prompt = message('copy-failure', {
    role:'user',
    content:'Prompt text',
  })
  const { unmount } = render(<StrictMode><Conversation
    messages={[prompt]}
    retry={vi.fn()}
    suggest={vi.fn()}
  /></StrictMode>)

  fireEvent.click(screen.getByRole('button', { name:'Copy prompt' }))
  await act(async () => undefined)
  expect(screen.getByRole('button', { name:'Copy failed' })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Copy failed')
  unmount()
  expect(clearTimeoutSpy).toHaveBeenCalled()
  clearTimeoutSpy.mockRestore()
  vi.useRealTimers()
})

it('enables a capacity retry when retry_at passes without a reload', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-31T10:00:00Z'))
  const retry = vi.fn()
  const prompt = message('capacity-prompt', {
    role:'user',
    content:'Try this',
    status:'retryable',
    failure_code:'service_budget_reached',
    retry_at:'2026-07-31T10:00:01Z',
  })
  render(<Conversation
    messages={[prompt]}
    retry={retry}
    suggest={vi.fn()}
  />)

  const retryButton = screen.getByRole('button', { name:'Retry' })
  expect(retryButton).toBeDisabled()
  act(() => vi.advanceTimersByTime(1000))
  expect(retryButton).toBeEnabled()
  fireEvent.click(retryButton)
  expect(retry).toHaveBeenCalledWith(prompt)
  vi.useRealTimers()
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
  fireEvent.click(screen.getByRole('button', { name:'Top up' }))
  expect(addCredits).toHaveBeenCalled()
})
