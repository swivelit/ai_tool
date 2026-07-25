import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ApiError, apiJson, deleteUpload, streamChat, synthesizeAudio, transcribeAudio, uploadDocument, uploadVirtualText } from '../api/client'
import { chatErrorMessage } from '../chatErrors'
import { ChatPage } from './ChatPage'

const user = { getIdToken: vi.fn().mockResolvedValue('token') }
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user, signOut:vi.fn() }) }))
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson:vi.fn(), streamChat:vi.fn(), uploadDocument:vi.fn(), uploadVirtualText:vi.fn(), deleteUpload:vi.fn(), transcribeAudio:vi.fn(), synthesizeAudio:vi.fn() }
})

const assistant = { tier:'lite' as const, tier_label:'Swico Lite', tier_description:'Fast and efficient for everyday questions.', tier_selection_enabled:true, tiers:[
  { id:'lite' as const, label:'Swico Lite', description:'Fast and efficient for everyday questions.', available:true, selected:true },
  { id:'standard' as const, label:'Swico', description:'Balanced quality and speed for most tasks.', available:true, selected:false },
  { id:'pro' as const, label:'Swico Pro', description:'Best for complex reasoning, planning, and coding.', available:false, selected:false },
] }
const bootstrap = { user:{ id:1, name:'Hari', email:'h@example.com', reply_language:'en' }, wallet:{ balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1 }, billing:{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test_key', razorpay_mode:'test', checkout_enabled:true, custom_topup_enabled:true, min_topup_paise:1500, max_topup_paise:50000, packages:[{ gross_amount_paise:1500, credited_amount_micros:7_500_000, platform_share_paise:750 }, { gross_amount_paise:29900, credited_amount_micros:149_500_000, platform_share_paise:14950 }] }, assistant, features:{ web_chat:true, prepaid_billing:true, web_attachments:true, web_voice_recording:true, web_voice_reply:true, web_voice_billing:true }, uploads:{ available:true, ttl_seconds:600, max_file_bytes:10485760, max_files_per_message:5, max_total_bytes:26214400, supported_extensions:['.txt','.pdf'] } } as const

it.each([
  [401, 'session expired'],
  [402, 'more AI credit'],
  [409, 'already being processed'],
  [422, 'Review your message'],
  [429, 'too quickly'],
  [500, 'temporarily unavailable'],
])('maps HTTP %i to a distinct actionable message', (status, expected) => {
  expect(chatErrorMessage(new ApiError(status, {}), false)).toContain(expected)
})

it('prioritises the offline state over an HTTP error', () => {
  expect(chatErrorMessage(new ApiError(500, {}), true)).toContain('offline')
})

it('surfaces only allowlisted safe document confirmation errors', () => {
  expect(chatErrorMessage(new ApiError(422, { error:{
    code:'full_document_confirmation_required',
    message:'Narrow the request or explicitly confirm a larger document operation.',
  } }), false)).toContain('explicitly confirm')
  expect(chatErrorMessage(new ApiError(422, { error:{
    code:'private_internal_error', message:'postgresql://private-host',
  } }), false)).toBe('Review your message and try again.')
})

function mockApi() {
  vi.mocked(apiJson).mockReset()
  vi.mocked(streamChat).mockReset().mockResolvedValue(undefined)
  vi.mocked(uploadDocument).mockReset()
  vi.mocked(uploadVirtualText).mockReset()
  vi.mocked(deleteUpload).mockReset().mockResolvedValue(undefined)
  vi.mocked(transcribeAudio).mockReset()
  vi.mocked(synthesizeAudio).mockReset()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    if (path.includes('/billing/ledger') || path === '/api/web/billing/payments') return { items:[] } as never
    return {} as never
  })
}

const uploaded = {
  id:'upload-1', name:'notes.txt', media_type:'text/plain', size_bytes:5,
  created_at:new Date().toISOString(), expires_at:new Date(Date.now() + 600_000).toISOString(),
  status:'ready' as const, warnings:[],
}

it('keeps the authoritative SSE thread for follow-ups, supports selection, and clears it for New chat', async () => {
  const existingThread = {
    id:'thread-existing', title:'Existing topic', archived:false,
    created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  }
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[existingThread], has_more:false } as never
    if (path.includes('/messages')) return { items:[] } as never
    return {} as never
  })
  vi.mocked(streamChat).mockReset().mockImplementation(async (_user, _payload, onEvent) => {
    if (vi.mocked(streamChat).mock.calls.length === 1) {
      onEvent({ event:'thread', data:{ thread_id:'thread-from-sse' } })
    }
  })
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })

  await userEvent.type(composer, 'first message')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
  expect(vi.mocked(streamChat).mock.calls[0][1]).not.toHaveProperty('thread_id')

  await userEvent.type(composer, 'same chat follow-up')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect(vi.mocked(streamChat).mock.calls[1][1]).toMatchObject({ thread_id:'thread-from-sse' })

  await userEvent.click(await screen.findByRole('button', { name:'Existing topic' }))
  await userEvent.type(composer, 'selected chat follow-up')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(3))
  expect(vi.mocked(streamChat).mock.calls[2][1]).toMatchObject({ thread_id:'thread-existing' })

  await userEvent.click(screen.getByRole('button', { name:'New chat' }))
  await userEvent.type(composer, 'fresh topic')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(4))
  expect(vi.mocked(streamChat).mock.calls[3][1]).not.toHaveProperty('thread_id')
})

it('regenerates a completed answer with the existing backend contract', async () => {
  const thread = {
    id:'regen-thread', title:'Regeneration', archived_at:null,
    created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  }
  const original = {
    id:'regen-user-message', thread_id:thread.id, role:'user' as const,
    content:'Explain indexes', request_id:'regen-original-request',
    tier:null, tier_label:'Swico', input_tokens:0, output_tokens:0,
    usage_source:null, charge_micros:0, status:'complete',
    created_at:new Date().toISOString(), input_mode:'text' as const,
    voice_turn_id:null, reply_language:'en' as const,
  }
  const answer = {
    ...original, id:'regen-assistant-message', role:'assistant' as const,
    content:'Indexes speed up selected reads.', tier:'lite' as const,
    tier_label:'Swico Lite', input_tokens:10, output_tokens:8,
    usage_source:'actual' as const, charge_micros:10,
  }
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return {
      ...bootstrap,
      features:{ ...bootstrap.features, web_message_edit:true },
    } as never
    if (path.startsWith('/api/web/threads?')) return {
      items:[thread], has_more:false,
    } as never
    if (path.includes('/regen-thread/messages')) return {
      items:[original, answer],
    } as never
    return {} as never
  })
  vi.mocked(streamChat).mockReset().mockResolvedValue(undefined)
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Regeneration' }))
  await userEvent.click(await screen.findByRole('button', { name:'Regenerate answer' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({
    message:'Explain indexes',
    thread_id:'regen-thread',
    regenerate_message_id:'regen-assistant-message',
    input_mode:'text',
  })
})

it('isolates late stream events from a different selected thread', async () => {
  const threads = [
    { id:'thread-a', title:'Thread A', archived_at:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
    { id:'thread-b', title:'Thread B', archived_at:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
  ]
  const historical = (threadId: string, content: string) => ({
    id:`message-${threadId}`, thread_id:threadId, role:'assistant' as const, content, request_id:null,
    tier:'lite' as const, tier_label:'Swico Lite', input_tokens:1, output_tokens:1,
    usage_source:'actual' as const, charge_micros:1, status:'complete', created_at:new Date().toISOString(),
    input_mode:'text' as const, voice_turn_id:null, reply_language:'en' as const,
  })
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.includes('/thread-a/messages')) return { items:[historical('thread-a', 'History A')] } as never
    if (path.includes('/thread-b/messages')) return { items:[historical('thread-b', 'History B')] } as never
    if (path.startsWith('/api/web/threads')) return { items:threads, has_more:false } as never
    return {} as never
  })
  let emit: ((event: Parameters<Parameters<typeof streamChat>[2]>[0]) => void) | undefined
  let finish: (() => void) | undefined
  vi.mocked(streamChat).mockReset().mockImplementation(async (_user, _payload, onEvent) => {
    emit = onEvent
    await new Promise<void>(resolve => { finish = resolve })
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Thread A' }))
  expect(await screen.findByText('History A')).toBeInTheDocument()
  await userEvent.type(screen.getByRole('textbox', { name:'Message Swico' }), 'stream in A')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())

  await userEvent.click(screen.getByRole('button', { name:'Thread B' }))
  expect(await screen.findByText('History B')).toBeInTheDocument()
  await act(async () => { emit?.({ event:'delta', data:{ text:'Late answer from A' } }) })
  expect(screen.queryByText('Late answer from A')).not.toBeInTheDocument()
  expect(screen.getByText('History B')).toBeInTheDocument()
  await act(async () => {
    emit?.({ event:'done', data:{ message_id:'persisted-a', thread_id:'thread-a' } })
    finish?.()
  })
})

it('does not start a second request while a stream is active', async () => {
  mockApi()
  vi.mocked(streamChat).mockImplementation(() => new Promise(() => undefined))
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'first request')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  fireEvent.change(composer, { target:{ value:'second request' } })
  fireEvent.keyDown(composer, { key:'Enter', code:'Enter' })
  expect(streamChat).toHaveBeenCalledOnce()
})

it('opens the accessible composer mode selector with all public names and closes on Escape', async () => {
  mockApi(); render(<ChatPage />)
  const trigger = await screen.findByRole('button', { name:'Swico Lite' })
  await userEvent.click(trigger)
  expect(screen.getByRole('listbox', { name:'Swico modes' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name:/Fast and efficient/ })).toBeInTheDocument()
  const standardOption = screen.getByRole('option', { name:/Balanced quality and speed/ })
  expect(standardOption).toBeInTheDocument()
  expect(screen.getByRole('option', { name:/Best for complex reasoning/ })).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|chatgpt|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
  fireEvent.keyDown(screen.getByRole('listbox'), { key:'ArrowDown' })
  expect(standardOption).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('listbox'), { key:'Escape' })
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
  await userEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
})

it('turns a 50000-character paste into a virtual attachment without sending it inline', async () => {
  mockApi()
  const longBootstrap = {
    ...bootstrap,
    features: { ...bootstrap.features, web_long_input:true },
    uploads: {
      ...bootstrap.uploads, long_input_enabled:true,
      long_input_inline_threshold_chars:12000, long_input_max_chars:64000,
    },
  }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return longBootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  const virtual = { ...uploaded, id:'virtual-50000', name:'Pasted text — analyze.txt', size_bytes:50_000 }
  vi.mocked(uploadVirtualText).mockResolvedValue(virtual)
  render(<ChatPage />)
  const paste = 'x'.repeat(50_000)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  fireEvent.change(composer, { target:{ value:paste } })
  expect(screen.getByText(/50,000 \/ 64,000 characters/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  expect(uploadVirtualText).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text:paste, operation:'analyze' }))
  const payload = vi.mocked(streamChat).mock.calls[0][1]
  expect(payload.message).toMatch(/^Analyze the attached pasted text/)
  expect(payload.message.length).toBeLessThan(200)
  expect(payload.attachment_ids).toEqual(['virtual-50000'])
})

it('saves a selected mode and refreshes the tier-sensitive token estimate', async () => {
  let selected = false
  const standard = { ...assistant, tier:'standard' as const, tier_label:'Swico', tier_description:'Balanced quality and speed for most tasks.', tiers:assistant.tiers.map(item => ({ ...item, selected:item.id === 'standard' })) }
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path, init) => {
    if (path === '/api/web/settings/assistant' && init?.method === 'PATCH') { selected = true; return standard as never }
    if (path === '/api/web/bootstrap') return { ...bootstrap, assistant:selected ? standard : assistant, wallet:{ ...bootstrap.wallet, token_estimate:{ tier:selected ? 'standard' : 'lite', tier_label:selected ? 'Swico' : 'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:selected ? 12_000 : 60_000, range_min_tokens:5_000, range_max_tokens:20_000, explanation:'Estimate for the selected Swico mode.' } } } as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Swico Lite' }))
  await userEvent.click(screen.getByRole('option', { name:/Balanced quality and speed/ }))
  await waitFor(() => expect(screen.getByRole('button', { name:'Swico' })).toBeInTheDocument())
  expect(vi.mocked(apiJson)).toHaveBeenCalledWith(expect.anything(), '/api/web/settings/assistant', expect.objectContaining({ body:'{"tier":"standard"}' }))
  expect(await screen.findByText('≈ 12K tokens')).toBeInTheDocument()
})

it('restores the previous mode and reports a safe error when saving fails', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path, init) => {
    if (path === '/api/web/settings/assistant' && init?.method === 'PATCH') throw new Error('private routing failure')
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Swico Lite' }))
  await userEvent.click(screen.getByRole('option', { name:/Balanced quality and speed/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('previous mode is still active')
  expect(screen.getByRole('button', { name:'Swico Lite' })).toBeInTheDocument()
  expect(screen.queryByText('private routing failure')).not.toBeInTheDocument()
})

it('opens billing when the API reports insufficient credit', async () => {
  mockApi(); vi.mocked(streamChat).mockRejectedValueOnce(new ApiError(402, {}))
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'hello'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('dialog', { name:'Add credits' })).toBeInTheDocument()
})

it('shows stop generation and sends a cooperative cancellation request', async () => {
  mockApi(); vi.mocked(streamChat).mockImplementation(() => new Promise(() => undefined))
  render(<ChatPage />); const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'long answer'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(screen.getByRole('button', { name:'Swico Lite' })).toBeDisabled()
  await userEvent.click(await screen.findByRole('button', { name:'Stop generation' }))
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes('/cancel'))).toBe(true))
})

it('shows usage-limit reset metadata without opening add-credit checkout', async () => {
  mockApi(); vi.mocked(streamChat).mockRejectedValueOnce(new ApiError(402, { error:{ code:'usage_limit_reached', reset_at:'2026-08-01T00:00:00Z' } }))
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'hello'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/monthly AI usage limit has been reached.*resets/i)
  expect(screen.queryByRole('dialog', { name:'Add AI credits' })).not.toBeInTheDocument()
})

it('refreshes the wallet estimate when the tab regains focus without polling', async () => {
  mockApi()
  render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  window.dispatchEvent(new Event('focus'))
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => call[1] === '/api/web/billing/wallet')).toBe(true))
})

it('selects and uploads a supported document, then sends its attachment id without text', async () => {
  mockApi(); vi.mocked(uploadDocument).mockResolvedValue(uploaded)
  const { container } = render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(input, new File(['hello'], 'notes.txt', { type:'text/plain' }))
  expect(await screen.findByText(/remaining/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalled())
  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({ message:'', attachment_ids:['upload-1'] })
  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({ input_mode:'text' })
  expect(screen.getByText(/stay active for this chat/i)).toBeInTheDocument()
})

it('rejects unsupported documents before upload', async () => {
  mockApi(); render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(fileInput, new File(['bad'], 'script.exe', { type:'application/octet-stream' }), { applyAccept:false })
  expect(await screen.findByRole('alert')).toHaveTextContent('not supported')
  expect(uploadDocument).not.toHaveBeenCalled()
})

it('supports drag-and-drop and prevents send while an upload is pending', async () => {
  mockApi(); vi.mocked(uploadDocument).mockImplementation(() => new Promise(() => undefined))
  render(<ChatPage />)
  const textbox = await screen.findByRole('textbox', { name:'Message Swico' })
  const dropTarget = screen.getByTestId('composer').parentElement!
  fireEvent.drop(dropTarget, { dataTransfer:{ files:[new File(['hello'], 'notes.txt', { type:'text/plain' })] } })
  expect(await screen.findByText('Uploading… 0%')).toBeInTheDocument()
  await userEvent.type(textbox, 'question')
  expect(screen.getByRole('button', { name:'Send message' })).toBeDisabled()
  expect(streamChat).not.toHaveBeenCalled()
})

it('sends an edited transcript as dictation without automatic synthesis, then resets to text', async () => {
  mockApi()
  class VoiceMediaRecorder {
    static isTypeSupported = () => true
    state: RecordingState = 'inactive'
    mimeType = 'audio/webm'
    ondataavailable: ((event: BlobEvent) => void) | null = null
    onstop: (() => void) | null = null
    onerror: ((event: Event) => void) | null = null
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data:new Blob(['voice'], { type:'audio/webm' }) } as BlobEvent)
      this.onstop?.()
    }
  }
  const trackStop = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{ getUserMedia:vi.fn().mockResolvedValue({ getTracks:() => [{ stop:trackStop }] }) } })
  vi.stubGlobal('MediaRecorder', VoiceMediaRecorder)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reply')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event('play')); return Promise.resolve() })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.mocked(transcribeAudio).mockImplementation(async (_user, _blob, _operationId, voiceTurnId) => ({
    transcript:'editable transcript', detected_language:'en', duration_seconds:1,
    duration_milliseconds:1000, voice_turn_id:voiceTurnId,
    stt_charge:{ charged_micros:10, voice_credits:'0.000010' }, wallet:bootstrap.wallet,
  }))
  vi.mocked(synthesizeAudio).mockResolvedValue({
    audio_base64:window.btoa(`RIFF${'\0'.repeat(8)}`), mime_type:'audio/wav', speaker:'anushka',
    target_language_code:'en-IN', model:'bulbul:v2', character_count:12,
    charged_micros:10, voice_credits:'0.000010', wallet:bootstrap.wallet,
  })
  vi.mocked(streamChat).mockImplementation(async (_user, payload, onEvent) => {
    onEvent({ event:'thread', data:{ thread_id:'thread-voice' } })
    await new Promise(resolve => window.setTimeout(resolve, 0))
    onEvent({ event:'delta', data:{ text:'Visible answer' } })
    onEvent({ event:'done', data:{
      message_id:`answer-${payload.request_id}`, thread_id:'thread-voice', cancelled:false,
      input_mode:payload.input_mode, voice_turn_id:payload.voice_turn_id ?? null, reply_language:'en',
    } })
  })

  const view = render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Start voice dictation' }))
  await userEvent.click(await screen.findByRole('button', { name:'Stop recording' }))
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await waitFor(() => expect(composer).toHaveValue('editable transcript'))
  await userEvent.type(composer, ' changed')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  expect(synthesizeAudio).not.toHaveBeenCalled()
  const voicePayload = vi.mocked(streamChat).mock.calls[0][1]
  expect(voicePayload).toMatchObject({ message:'editable transcript changed', input_mode:'dictation' })
  expect(voicePayload.voice_turn_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(vi.mocked(transcribeAudio).mock.calls[0][2]).not.toBe(voicePayload.voice_turn_id)
  expect(screen.getByText('Visible answer')).toBeInTheDocument()

  await userEvent.type(composer, 'normal typed message')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect(vi.mocked(streamChat).mock.calls[1][1]).toMatchObject({ input_mode:'text', thread_id:'thread-voice' })
  expect(vi.mocked(streamChat).mock.calls[1][1]).not.toHaveProperty('voice_turn_id')
  expect(synthesizeAudio).not.toHaveBeenCalled()
  view.unmount()
})
