import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ApiError, SSEStreamError, apiJson, deleteRepository, deleteUpload, streamChat, synthesizeAudio, transcribeAudio, uploadDocument, uploadRepository, uploadVirtualText } from '../api/client'
import { chatErrorMessage } from '../chatErrors'
import { ChatPage } from './ChatPage'

const user = { uid:'firebase-owner', getIdToken: vi.fn().mockResolvedValue('token') }
let currentUser = user
const signOutMock = vi.fn()
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ user:currentUser, signOut:signOutMock }),
}))
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson:vi.fn(), streamChat:vi.fn(), uploadDocument:vi.fn(), uploadVirtualText:vi.fn(), uploadRepository:vi.fn(), deleteRepository:vi.fn(), deleteUpload:vi.fn(), transcribeAudio:vi.fn(), synthesizeAudio:vi.fn() }
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
  currentUser = user
  signOutMock.mockReset()
  vi.mocked(apiJson).mockReset()
  vi.mocked(streamChat).mockReset().mockResolvedValue(undefined)
  vi.mocked(uploadDocument).mockReset()
  vi.mocked(uploadVirtualText).mockReset()
  vi.mocked(uploadRepository).mockReset()
  vi.mocked(deleteRepository).mockReset().mockResolvedValue(undefined)
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => { resolve = nextResolve })
  return { promise, resolve }
}

it('opens the persisted video chat card from an authenticated email deep link without generation', async () => {
  mockApi()
  const id = '11111111-1111-1111-1111-111111111111'
  window.history.replaceState({}, '', `/?video=${id}`)
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.includes('/videos/jobs/')) return { id, thread_id:'video-thread', state:'expired', expires_at:'2020-01-01T00:00:00Z' } as never
    if (path.includes('/video-thread/messages')) return { items:[{ id:'video-message', thread_id:'video-thread', role:'assistant', content:'Your AI-edited video', status:'complete', video:{ job_id:id, version:1 } }] } as never
    return { items:[], has_more:false } as never
  })
  const view = render(<ChatPage />)
  try {
    expect(await screen.findByText(/Expired — the temporary video/)).toBeInTheDocument()
    expect(streamChat).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name:'Regenerate answer' })).not.toBeInTheDocument()
  } finally { view.unmount(); window.history.replaceState({}, '', '/') }
})

it('does not let a delayed video deep link override the user selecting New chat', async () => {
  mockApi()
  const pending = deferred<{ thread_id:string }>()
  const original = vi.mocked(apiJson).getMockImplementation()!
  window.history.replaceState({}, '', '/?video=11111111-1111-1111-1111-111111111111')
  vi.mocked(apiJson).mockImplementation(async (...args) => args[1].includes('/videos/jobs/') ? pending.promise as never : original(...args))
  const view = render(<ChatPage />)
  try {
    await screen.findByRole('textbox', { name:'Message Swico' })
    await userEvent.click(screen.getAllByRole('button', { name:'New chat' })[0])
    await act(async () => { pending.resolve({ thread_id:'stale-video-thread' }); await pending.promise })
    expect(vi.mocked(apiJson).mock.calls.some(call => call[1].includes('/stale-video-thread/messages'))).toBe(false)
  } finally { view.unmount(); window.history.replaceState({}, '', '/') }
})

const uploaded = {
  id:'upload-1', name:'notes.txt', media_type:'text/plain', size_bytes:5,
  created_at:new Date().toISOString(), expires_at:new Date(Date.now() + 600_000).toISOString(),
  status:'ready' as const, warnings:[],
}
const repositoryBootstrap = {
  ...bootstrap,
  features:{
    ...bootstrap.features,
    web_message_edit:true,
    web_repository_upload:true,
    web_repository_chat:true,
    web_repository_validation:false,
  },
  repositories:{
    ttl_seconds:3600,
    max_archive_bytes:26_214_400,
    validation_capability:'static_only' as const,
  },
}

const repositorySnapshot = (id: string, displayName = 'swico.zip') => ({
  id,
  display_name:displayName,
  source_version:'source-version',
  content_hash:'content-hash',
  file_count:12,
  symbol_count:30,
  status:'ready' as const,
  created_at:new Date().toISOString(),
  expires_at:new Date(Date.now() + 3_600_000).toISOString(),
  languages:['Python'],
  frameworks:[],
})

it('renders the authenticated empty chat as a compact personalized home', async () => {
  mockApi()
  render(<ChatPage />)
  expect(await screen.findByRole('heading', { name:'Hey, Hari. How can I help you?' })).toBeInTheDocument()
  expect(screen.getByTestId('composer')).toBeInTheDocument()
  expect(screen.queryByText('Help me plan a focused week')).not.toBeInTheDocument()
  expect(document.querySelector('.empty-state')).not.toBeInTheDocument()
  expect(document.querySelector('.chat-main')).toHaveClass('empty-chat')
  expect(screen.queryByRole('button', { name:'Expand composer' })).not.toBeInTheDocument()
  expect(document.querySelector('#composer-character-count')).toHaveClass('sr-only')
})

it('uses a safe fallback when the bootstrap name is not usable', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return { ...bootstrap, user:{ ...bootstrap.user, name:'   ' } } as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  expect(await screen.findByRole('heading', { name:'How can I help you?' })).toBeInTheDocument()
  expect(screen.queryByText(/^Hey,/u)).not.toBeInTheDocument()
})

it('shows a recoverable bootstrap error instead of an endless loading state', async () => {
  mockApi()
  let attempts = 0
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') {
      attempts += 1
      if (attempts === 1) throw new Error('bootstrap unavailable')
      return bootstrap as never
    }
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your Swico workspace.')
  await userEvent.click(screen.getByRole('button', { name:'Retry' }))
  expect(await screen.findByRole('heading', { name:'Hey, Hari. How can I help you?' })).toBeInTheDocument()
})

it('keeps the compact composer for a new chat and after the first message', async () => {
  mockApi()
  render(<ChatPage />)
  const textarea = await screen.findByRole('textbox', { name:'Message Swico' })
  fireEvent.change(textarea, { target:{ value:'Keep this draft' } })
  expect(textarea).toHaveValue('Keep this draft')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(document.querySelector('.chat-main')).not.toHaveClass('empty-chat'))
})

it('does not bind a delayed first-thread event after New chat', async () => {
  mockApi()
  const first = deferred<void>()
  let firstEvent: ((event: { event:string; data:unknown }) => void) | undefined
  vi.mocked(streamChat)
    .mockImplementationOnce(async (_user, _payload, onEvent) => {
      firstEvent = onEvent
      await first.promise
    })
    .mockResolvedValueOnce(undefined)
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'old request')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())

  await userEvent.click(screen.getByTestId('new-chat-button'))
  await act(async () => { firstEvent?.({ event:'thread', data:{ thread_id:'old-thread' } }) })
  await userEvent.type(composer, 'new request')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect(vi.mocked(streamChat).mock.calls[1][1]).not.toHaveProperty('thread_id')
  await act(async () => { first.resolve(undefined); await first.promise })
})

it('keeps newer history and search responses ahead of older requests', async () => {
  mockApi()
  const threadA = { id:'history-a', title:'History A', archived:false, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }
  const threadB = { id:'history-b', title:'History B', archived:false, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }
  const historyA = deferred<{ items: unknown[] }>()
  const historyB = deferred<{ items: unknown[] }>()
  const searchOld = deferred<{ items: unknown[] }>()
  const searchNew = deferred<{ items: unknown[] }>()
  let searchCalls = 0
  const searchBootstrap = { ...bootstrap, features:{ ...bootstrap.features, web_content_search:true } }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return searchBootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[threadA, threadB], has_more:false } as never
    if (path.includes('/history-a/messages')) return historyA.promise as never
    if (path.includes('/history-b/messages')) return historyB.promise as never
    if (path.startsWith('/api/web/search?')) return (++searchCalls === 1 ? searchOld.promise : searchNew.promise) as never
    return {} as never
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'History A' }))
  await userEvent.click(await screen.findByRole('button', { name:'History B' }))
  await act(async () => { historyB.resolve({ items:[{ id:'b-answer', thread_id:'history-b', role:'assistant', content:'Newer history', status:'complete' }] }) })
  expect(await screen.findByText('Newer history')).toBeInTheDocument()
  await act(async () => { historyA.resolve({ items:[{ id:'a-answer', thread_id:'history-a', role:'assistant', content:'Older history', status:'complete' }] }) })
  expect(screen.queryByText('Older history')).not.toBeInTheDocument()

  const search = screen.getByRole('textbox', { name:'Search chats' })
  fireEvent.change(search, { target:{ value:'old query' } })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 350)) })
  fireEvent.change(search, { target:{ value:'new query' } })
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 350)) })
  await act(async () => { searchNew.resolve({ items:[{ thread_id:'history-b', message_id:'new-result', source_kind:'message', snippet:'new result', updated_at:new Date().toISOString() }] }) })
  expect(await screen.findByText('new result')).toBeInTheDocument()
  await act(async () => { searchOld.resolve({ items:[{ thread_id:'history-a', message_id:'old-result', source_kind:'message', snippet:'old result', updated_at:new Date().toISOString() }] }) })
  expect(screen.queryByText('old result')).not.toBeInTheDocument()
})

it('restores a failed PDF prompt without deleting its server upload', async () => {
  mockApi()
  const pdf = { ...uploaded, id:'pdf-upload', name:'report.pdf', media_type:'application/pdf' }
  vi.mocked(uploadDocument).mockResolvedValue(pdf)
  vi.mocked(streamChat).mockRejectedValueOnce(new ApiError(503, {}))
  const { container } = render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'Summarize this PDF')
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'report.pdf', { type:'application/pdf' }))
  await screen.findByText(/remaining/)
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable'))
  expect(composer).toHaveValue('Summarize this PDF')
  expect(deleteUpload).not.toHaveBeenCalled()
})

it('clears the pending PDF chip after success while retaining server context for the thread', async () => {
  mockApi()
  const pdf = { ...uploaded, id:'successful-pdf', name:'successful.pdf', media_type:'application/pdf' }
  vi.mocked(uploadDocument).mockResolvedValue(pdf)
  vi.mocked(streamChat).mockImplementation(async (_user, _payload, onEvent) => {
    onEvent({ event:'thread', data:{ thread_id:'pdf-thread' } })
    onEvent({ event:'done', data:{ message_id:'pdf-answer', request_id:'pdf-request' } })
  })
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[], has_more:false } as never
    if (path.includes('/pdf-thread/messages')) return { items:[{
      id:'pdf-answer', thread_id:'pdf-thread', role:'assistant', content:'Read', request_id:'pdf-request',
      status:'complete', attachments:[pdf],
    }] } as never
    return {} as never
  })
  const { container } = render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'Read this PDF')
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'successful.pdf', { type:'application/pdf' }))
  await screen.findByText('successful.pdf')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByLabelText('Pending attachments')).not.toBeInTheDocument())
  expect(screen.getByLabelText('Active attachment context')).toHaveTextContent('successful.pdf')
  expect(deleteUpload).not.toHaveBeenCalled()
  expect(screen.getByText('Read')).toBeInTheDocument()
})

it('accounts for active PDF context, exposes removal, and allows a replacement upload', async () => {
  mockApi()
  const files = Array.from({ length:5 }, (_, index) => ({
    ...uploaded, id:`context-${index}`, name:`context-${index}.pdf`, media_type:'application/pdf',
  }))
  const replacement = { ...uploaded, id:'replacement-upload', name:'replacement.pdf', media_type:'application/pdf' }
  const uploadResponses = [...files, replacement]
  let uploadIndex = 0
  vi.mocked(uploadDocument).mockImplementation(async () => uploadResponses[uploadIndex++])
  const submitted: unknown[] = []
  vi.mocked(streamChat).mockImplementation(async (_user, _payload, onEvent) => {
    submitted.push(_payload)
    onEvent({ event:'thread', data:{ thread_id:'context-thread' } })
    onEvent({ event:'done', data:{ message_id:`context-answer-${submitted.length}`, request_id:`context-request-${submitted.length}` } })
  })
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[], has_more:false } as never
    if (path.includes('/context-thread/messages')) return { items:[{
      id:'context-answer', thread_id:'context-thread', role:'assistant', content:'Done', request_id:'context-request',
      status:'complete', attachments:files,
    }] } as never
    return {} as never
  })
  const { container } = render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  for (const file of files) {
    await userEvent.upload(input, new File(['pdf'], file.name, { type:'application/pdf' }))
    await screen.findByText(file.name)
  }
  await userEvent.type(screen.getByRole('textbox', { name:'Message Swico' }), 'Review these files')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByLabelText('Pending attachments')).not.toBeInTheDocument())
  expect(screen.getByLabelText('Active attachment context')).toHaveTextContent('context-0.pdf')
  await userEvent.upload(input, new File(['pdf'], 'blocked.pdf', { type:'application/pdf' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/up to 5 files/i)
  await userEvent.click(screen.getByRole('button', { name:'Remove active context context-0.pdf' }))
  await userEvent.upload(input, new File(['pdf'], 'replacement.pdf', { type:'application/pdf' }))
  expect(await screen.findByText('replacement.pdf')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('replacement.pdf')).not.toHaveTextContent(/Uploading/i))
  await userEvent.type(screen.getByRole('textbox', { name:'Message Swico' }), 'Use the replacement')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect((submitted[1] as { attachment_ids?: string[] }).attachment_ids).toEqual(expect.arrayContaining(['replacement-upload']))
  expect((submitted[1] as { attachment_ids?: string[] }).attachment_ids).not.toContain('context-0')
})

it('keeps an explicitly removed attachment detached when an older history response arrives', async () => {
  mockApi()
  const thread = { id:'detached-thread', title:'Detached', archived:false, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }
  const attachment = { ...uploaded, id:'detached-pdf', name:'detached.pdf', media_type:'application/pdf' }
  const olderHistory = deferred<{ items: unknown[] }>()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[thread], has_more:false } as never
    if (path.includes('/detached-thread/messages')) return olderHistory.promise as never
    return {} as never
  })
  vi.mocked(uploadDocument).mockResolvedValue(attachment)
  const submitted: unknown[] = []
  vi.mocked(streamChat).mockImplementation(async (_user, _payload, onEvent) => {
    submitted.push(_payload)
    onEvent({ event:'thread', data:{ thread_id:thread.id } })
    onEvent({ event:'done', data:{ message_id:`detached-answer-${submitted.length}`, request_id:`detached-request-${submitted.length}` } })
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Detached' }))
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'Read this')
  await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'detached.pdf', { type:'application/pdf' }))
  await screen.findByText('detached.pdf')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  await userEvent.click(screen.getByRole('button', { name:'Remove detached.pdf' }))
  await act(async () => { olderHistory.resolve({ items:[{ id:'detached-answer-1', thread_id:thread.id, role:'assistant', content:'Older', request_id:'detached-request-1', status:'complete', attachments:[attachment] }] }); await olderHistory.promise })
  expect(await screen.findByText('Older')).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByLabelText('Active attachment context')).not.toBeInTheDocument())
  await userEvent.type(composer, 'Follow up without the removed file')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect((submitted[1] as { attachment_ids?: string[] }).attachment_ids || []).not.toContain('detached-pdf')
})

it('transfers new-chat removal intent when the first SSE event assigns a server thread', async () => {
  mockApi()
  const thread = { id:'assigned-thread', title:'Assigned', archived:false, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }
  const attachment = { ...uploaded, id:'new-chat-pdf', name:'new-chat.pdf', media_type:'application/pdf' }
  const streamGate = deferred<void>()
  const history = deferred<{ items: unknown[] }>()
  const pendingDelete = deferred<void>()
  let streamCallback: ((event: { event:string; data:unknown }) => void) | undefined
  const submitted: unknown[] = []
  vi.mocked(uploadDocument).mockResolvedValue(attachment)
  vi.mocked(deleteUpload).mockReturnValue(pendingDelete.promise)
  vi.mocked(streamChat).mockImplementation(async (_user, payload, onEvent) => {
    submitted.push(payload)
    streamCallback = onEvent
    await streamGate.promise
  })
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[], has_more:false } as never
    if (path.includes(`/threads/${thread.id}/messages`)) return history.promise as never
    return {} as never
  })
  const { container } = render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'Read this')
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'new-chat.pdf', { type:'application/pdf' }))
  await screen.findByText('new-chat.pdf')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  await userEvent.click(screen.getByRole('button', { name:'Remove new-chat.pdf' }))
  streamCallback?.({ event:'thread', data:{ thread_id:thread.id } })
  streamCallback?.({ event:'done', data:{ message_id:'assigned-answer', request_id:'assigned-request' } })
  await act(async () => { streamGate.resolve(undefined); await streamGate.promise })
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes(`/threads/${thread.id}/messages`))).toBe(true))
  await act(async () => { history.resolve({ items:[{ id:'assigned-answer', thread_id:thread.id, role:'assistant', content:'Assigned history', request_id:'assigned-request', status:'complete', attachments:[attachment] }] }); await history.promise })
  expect(await screen.findByText('Assigned history')).toBeInTheDocument()
  expect(screen.queryByLabelText('Active attachment context')).not.toBeInTheDocument()
  await userEvent.type(composer, 'Follow up')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect((submitted[1] as { attachment_ids?: string[] }).attachment_ids || []).not.toContain(attachment.id)
})

it('keeps an explicitly selected expired PDF recoverable instead of silently sending text', async () => {
  mockApi()
  const expired = { ...uploaded, id:'expired-pdf', name:'expired.pdf', media_type:'application/pdf', expires_at:new Date(Date.now() - 1_000).toISOString() }
  vi.mocked(uploadDocument).mockResolvedValue(expired)
  const { container } = render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'Explain this')
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'expired.pdf', { type:'application/pdf' }))
  await screen.findByText('expired.pdf')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i)
  expect(streamChat).not.toHaveBeenCalled()
  expect(screen.getByText('Expired')).toBeInTheDocument()
})

it('keeps a pending upload visible while history refreshes', async () => {
  mockApi()
  const pending = deferred<typeof uploaded>()
  vi.mocked(uploadDocument).mockReturnValue(pending.promise)
  const { container } = render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'pending.pdf', { type:'application/pdf' }))
  await screen.findByText('Uploading… 0%')
  await userEvent.click(screen.getByRole('button', { name:'Archived chats' }))
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes('archived=true'))).toBe(true))
  expect(screen.getByText('Uploading… 0%')).toBeInTheDocument()
  await act(async () => { pending.resolve({ ...uploaded, id:'pending-upload', name:'pending.pdf', media_type:'application/pdf' }); await pending.promise })
})

it('does not attach a deferred upload from chat A after navigating to chat B', async () => {
  mockApi()
  const pending = deferred<typeof uploaded>()
  vi.mocked(uploadDocument).mockReturnValue(pending.promise)
  const threadB = { id:'thread-b-upload', title:'Chat B', archived:false, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[threadB], has_more:false } as never
    if (path.includes('/thread-b-upload/messages')) return { items:[] } as never
    return {} as never
  })
  const { container } = render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['pdf'], 'abandoned.pdf', { type:'application/pdf' }))
  await screen.findByText('Uploading… 0%')
  await userEvent.click(await screen.findByRole('button', { name:'Chat B' }))
  await act(async () => { pending.resolve({ ...uploaded, id:'abandoned-upload', name:'abandoned.pdf' }); await pending.promise })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByText('abandoned.pdf')).not.toBeInTheDocument()
  expect(deleteUpload).toHaveBeenCalledWith(user, 'abandoned-upload')
})

it('continues without an optimistic control bubble and consumes the parent button', async () => {
  const thread = {
    id:'continue-thread', title:'Long answer', archived:false,
    created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  }
  const parent = {
    id:'parent-answer', thread_id:thread.id, role:'assistant' as const,
    content:'```html\n<main>', request_id:'root-request', tier:'lite' as const,
    tier_label:'Swico Lite', input_tokens:10, output_tokens:10,
    usage_source:'actual' as const, charge_micros:1, status:'complete',
    created_at:new Date().toISOString(), input_mode:'text' as const,
    voice_turn_id:null, reply_language:'en' as const,
    truncated:true, can_continue:true,
  }
  const child = {
    ...parent, id:'child-answer', request_id:'child-request',
    content:'</main>\n```', truncated:false, can_continue:false,
    continuation_render_prefix:'```html\n',
    continuation_parent_message_id:parent.id,
    continuation_root_message_id:parent.id,
    continuation_segment_index:1,
  }
  let messageLoads = 0
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[thread], has_more:false } as never
    if (path.includes('/messages')) {
      messageLoads += 1
      return { items:messageLoads === 1 ? [parent] : [{ ...parent, can_continue:false }, child] } as never
    }
    return {} as never
  })
  let finish!: () => void
  let emit!: (event: { event:string; data:unknown }) => void
  vi.mocked(streamChat).mockReset().mockImplementation(async (_user, _payload, onEvent) => {
    emit = onEvent
    await new Promise<void>(resolve => { finish = resolve })
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByText('Long answer'))
  await userEvent.click(await screen.findByRole('button', { name:'Continue response' }))

  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({
    continue_message_id:'parent-answer',
    message:'Continue response',
  })
  expect(screen.queryByText('Continue response', { selector:'.user-bubble' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Continue response' })).toBeDisabled()

  await act(async () => {
    emit({ event:'thread', data:{
      thread_id:thread.id,
      continuation_render_prefix:'```html\n',
      continuation_parent_message_id:parent.id,
    } })
    emit({ event:'delta', data:{ text:'</main>\n```' } })
    emit({ event:'done', data:{
      message_id:'child-answer', truncated:false, can_continue:false,
      continuation_parent_message_id:parent.id, parent_can_continue:false,
    } })
    finish()
  })
  await waitFor(() => expect(screen.queryByRole('button', { name:'Continue response' })).not.toBeInTheDocument())
  await waitFor(() => expect(
    Array.from(document.querySelectorAll('.code-block code')).some(
      element => element.textContent?.includes('</main>'),
    ),
  ).toBe(true))
  expect(document.querySelectorAll('.message.assistant')).toHaveLength(1)
  expect(document.querySelectorAll('.code-block')).toHaveLength(1)
})

it('keeps the authoritative SSE thread for follow-ups, supports selection, and clears it for New chat', async () => {
  const existingThread = {
    id:'thread-existing', title:'New chat', archived:false,
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

  const titledNewChatButtons = await screen.findAllByRole('button', {
    name:'New chat',
  })
  const conversationRow = titledNewChatButtons.find(button => (
    button.classList.contains('thread-select')
  ))
  expect(conversationRow).toBeDefined()
  await userEvent.click(conversationRow!)
  await userEvent.type(composer, 'selected chat follow-up')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(3))
  expect(vi.mocked(streamChat).mock.calls[2][1]).toMatchObject({ thread_id:'thread-existing' })

  expect(screen.getAllByRole('button', { name:'New chat' })).toHaveLength(2)
  await userEvent.click(screen.getByTestId('new-chat-button'))
  await userEvent.type(composer, 'fresh topic')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(4))
  expect(vi.mocked(streamChat).mock.calls[3][1]).not.toHaveProperty('thread_id')
})

it('keeps a verified-buffered assistant visible and refreshes the persisted prompt for editing', async () => {
  const editableBootstrap = {
    ...bootstrap,
    features:{ ...bootstrap.features, web_message_edit:true },
  }
  const persistedUser = {
    id:'persisted-user', thread_id:'new-thread', role:'user' as const,
    content:'Long architecture request', request_id:'request-editable',
    tier:null, tier_label:'Swico', input_tokens:0, output_tokens:0,
    usage_source:null, charge_micros:0, status:'complete',
    created_at:new Date().toISOString(), input_mode:'text' as const,
    voice_turn_id:null, reply_language:'en' as const,
  }
  const persistedAssistant = {
    ...persistedUser, id:'persisted-assistant', role:'assistant' as const,
    content:'Complete architecture answer.', tier:'standard' as const,
    input_tokens:20, output_tokens:30, usage_source:'actual' as const,
  }
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return editableBootstrap as never
    if (path.includes('/new-thread/messages')) {
      return { items:[persistedUser, persistedAssistant] } as never
    }
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(streamChat).mockReset().mockImplementation(async (
    _user, _payload, onEvent,
  ) => {
    onEvent({ event:'thread', data:{ thread_id:'new-thread' } })
    await Promise.resolve()
    onEvent({ event:'delta', data:{ text:'Complete architecture answer.' } })
    onEvent({ event:'done', data:{
      message_id:'persisted-assistant', thread_id:'new-thread',
    } })
  })
  render(<ChatPage />)
  await userEvent.type(await screen.findByRole('textbox', {
    name:'Message Swico',
  }), 'Long architecture request')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByText('Complete architecture answer.'))
    .toBeInTheDocument()
  expect(await screen.findByRole('button', { name:'Edit message' }))
    .toBeEnabled()
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

it('uses a bounded trailing Question line as the virtual-text retrieval query', async () => {
  mockApi()
  const longBootstrap = {
    ...bootstrap,
    features:{ ...bootstrap.features, web_long_input:true },
    uploads:{
      ...bootstrap.uploads, long_input_enabled:true,
      long_input_inline_threshold_chars:12000, long_input_max_chars:64000,
    },
  }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return longBootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  vi.mocked(uploadVirtualText).mockResolvedValue({
    ...uploaded, id:'virtual-question', name:'Pasted text — questions.txt',
    size_bytes:50_000,
  })
  render(<ChatPage />)
  const question = 'What exact value follows FINAL ACCEPTANCE MARKER?'
  const paste = `${'x'.repeat(49_000)}\nQuestion: ${question}\nTAIL-EXAMPLE`
  fireEvent.change(await screen.findByRole('textbox', {
    name:'Message Swico',
  }), { target:{ value:paste } })
  await userEvent.selectOptions(screen.getByLabelText('Large text action'), 'ask_questions')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({
    message:question,
    attachment_ids:['virtual-question'],
  })
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
  expect(await screen.findByRole('dialog', { name:'Billing' })).toBeInTheDocument()
})

it('applies the released wallet and delays Retry for service capacity', async () => {
  mockApi()
  const retryAt = '2099-08-01T00:00:00+00:00'
  vi.mocked(streamChat).mockImplementation(async (
    _user, _payload, onEvent,
  ) => {
    onEvent({ event:'wallet', data:{
      ...bootstrap.wallet,
      reserved_micros:0,
      available_micros:5_000_000,
      version:2,
      token_estimate:{
        tier:'lite',
        tier_label:'Swico Lite',
        pricing_as_of:'2026-07-17T00:00:00Z',
        estimated_blended_tokens:1234,
        range_min_tokens:1000,
        range_max_tokens:1500,
        explanation:'Safe wallet refresh marker.',
      },
    } })
    onEvent({ event:'error', data:{
      code:'service_budget_reached',
      message:'Swico has reached today’s service capacity.',
      retryable:true,
      retry_at:retryAt,
    } })
    throw new SSEStreamError(
      'service_budget_reached',
      'Swico has reached today’s service capacity.',
      true,
      retryAt,
    )
  })
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'Keep my prompt visible')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    /service capacity.*Try again after/i
  )
  expect(screen.getByRole('textbox', { name:'Message Swico' })).toHaveValue('Keep my prompt visible')
  expect(screen.getByText('≈ 1.2K tokens')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Retry answer' })).toBeDisabled()
  expect(screen.queryByRole('dialog', { name:/Billing/i })).not.toBeInTheDocument()
})

it('queues an early stop until the streaming request is accepted', async () => {
  mockApi()
  let accepted: (() => void) | undefined
  vi.mocked(streamChat).mockImplementation(
    (_user, _payload, _onEvent, _signal, onAccepted) => {
      accepted = onAccepted
      return new Promise(() => undefined)
    },
  )
  render(<ChatPage />); const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'long answer'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(screen.getByRole('button', { name:'Swico Lite' })).toBeDisabled()
  const stop = await screen.findByRole('button', { name:'Stop generation' })
  expect(stop).toHaveAttribute('data-cancellation-ready', 'false')
  await userEvent.click(stop)
  expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes('/cancel'))).toBe(false)
  await act(async () => { accepted?.() })
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes('/cancel'))).toBe(true))
})

it('exposes readiness and cancels exactly once after acceptance', async () => {
  mockApi()
  vi.mocked(streamChat).mockImplementation(
    async (_user, _payload, _onEvent, _signal, onAccepted) => {
      onAccepted?.()
      await new Promise(() => undefined)
    },
  )
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'accepted long answer')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  const stop = await screen.findByRole('button', { name:'Stop generation' })
  await waitFor(() => expect(stop).toHaveAttribute('data-cancellation-ready', 'true'))
  await userEvent.click(stop)
  await userEvent.click(stop)
  await waitFor(() => expect(
    vi.mocked(apiJson).mock.calls.filter(call => String(call[1]).includes('/cancel')),
  ).toHaveLength(1))
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
  expect(screen.queryByText(/stay active for this chat/i)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Remove notes.txt' })).not.toBeInTheDocument()
})

it('keeps an explicitly selected expired image recoverable until removed', async () => {
  mockApi()
  const imageBootstrap = { ...bootstrap, uploads:{ ...bootstrap.uploads, supported_extensions:['.txt', '.pdf', '.png'] } }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return imageBootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:expired-image')
  vi.mocked(uploadDocument).mockResolvedValue({
    ...uploaded, name:'expired.png', media_type:'image/png',
    expires_at:new Date(Date.now() - 1_000).toISOString(),
    preview_url:'blob:expired-image',
  })
  const { container } = render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['image'], 'expired.png', { type:'image/png' }))
  await waitFor(() => expect(uploadDocument).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name:'Remove expired.png' })).toBeInTheDocument()
  expect(screen.getByText('Expired')).toBeInTheDocument()
  expect(revoke).not.toHaveBeenCalledWith('blob:expired-image')
})

it('revokes an active image preview when the pending attachment is removed', async () => {
  mockApi()
  const imageBootstrap = { ...bootstrap, uploads:{ ...bootstrap.uploads, supported_extensions:['.txt', '.pdf', '.png'] } }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return imageBootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:removed-image')
  vi.mocked(uploadDocument).mockImplementation(() => new Promise(() => undefined))
  const { container } = render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['image'], 'removed.png', { type:'image/png' }))
  await screen.findByText('Uploading… 0%')
  await userEvent.click(screen.getByRole('button', { name:'Remove removed.png' }))
  expect(revoke).toHaveBeenCalledWith('blob:removed-image')
})

it('rejects unsupported documents before upload', async () => {
  mockApi(); render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(fileInput, new File(['bad'], 'script.exe', { type:'application/octet-stream' }), { applyAccept:false })
  expect(await screen.findByRole('alert')).toHaveTextContent('not supported')
  expect(uploadDocument).not.toHaveBeenCalled()
})

it('rejects a dropped upload during first-thread assignment without leaving the composer busy', async () => {
  mockApi()
  const streamGate = deferred<void>()
  const submitted: unknown[] = []
  vi.mocked(streamChat).mockImplementation(async (_user, payload, onEvent) => {
    submitted.push(payload)
    if (submitted.length === 1) {
      onEvent({ event:'thread', data:{ thread_id:'drop-assigned-thread' } })
      onEvent({ event:'done', data:{ message_id:'drop-answer', request_id:'drop-request' } })
      await streamGate.promise
    }
  })
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads?')) return { items:[], has_more:false } as never
    if (path.includes('/drop-assigned-thread/messages')) return { items:[{
      id:'drop-answer', thread_id:'drop-assigned-thread', role:'assistant', content:'First answer',
      request_id:'drop-request', status:'complete', attachments:[],
    }] } as never
    return {} as never
  })
  render(<ChatPage />)
  const textbox = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(textbox, 'First request')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  const dropTarget = screen.getByTestId('conversation')
  fireEvent.drop(dropTarget, {
    dataTransfer:{ types:['Files'], files:[new File(['late'], 'late.pdf', { type:'application/pdf' })] },
  })
  expect(uploadDocument).not.toHaveBeenCalled()
  await act(async () => { streamGate.resolve(undefined); await streamGate.promise })
  expect(await screen.findByText('First answer')).toBeInTheDocument()
  await userEvent.type(textbox, 'Second request')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument()
})

it('accepts a file dropped over the main chat area and prevents send while pending', async () => {
  mockApi(); vi.mocked(uploadDocument).mockImplementation(() => new Promise(() => undefined))
  render(<ChatPage />)
  const textbox = await screen.findByRole('textbox', { name:'Message Swico' })
  const dropTarget = screen.getByTestId('conversation')
  const file = new File(['hello'], 'notes.txt', { type:'text/plain' })
  fireEvent.dragEnter(dropTarget, { dataTransfer:{ types:['Files'], files:[file] } })
  expect(screen.getByText('Drop files or images to attach')).toBeInTheDocument()
  fireEvent.drop(dropTarget, { dataTransfer:{ types:['Files'], files:[file] } })
  expect(screen.queryByText('Drop files or images to attach')).not.toBeInTheDocument()
  expect(await screen.findByText('Uploading… 0%')).toBeInTheDocument()
  await userEvent.type(textbox, 'question')
  expect(screen.getByRole('button', { name:'Send message' })).toBeDisabled()
  expect(streamChat).not.toHaveBeenCalled()
})

it('uploads exactly once when a file is dropped over the composer', async () => {
  mockApi(); vi.mocked(uploadDocument).mockResolvedValue(uploaded)
  render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  const file = new File(['hello'], 'notes.txt', { type:'text/plain' })
  const composer = screen.getByTestId('composer')
  fireEvent.dragEnter(composer, { dataTransfer:{ types:['Files'], files:[file] } })
  fireEvent.drop(composer, { dataTransfer:{ types:['Files'], files:[file] } })
  await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('Drop files or images to attach')).not.toBeInTheDocument()
})

it('shows no file drop state for text or link drags and clears nested drag depth', async () => {
  mockApi(); render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  const main = screen.getByTestId('conversation').closest('.chat-main')!
  const file = new File(['hello'], 'notes.txt', { type:'text/plain' })
  fireEvent.dragEnter(main, { dataTransfer:{ types:['text/plain'], files:[] } })
  fireEvent.dragEnter(main, { dataTransfer:{ types:['text/uri-list'], files:[] } })
  expect(screen.queryByText('Drop files or images to attach')).not.toBeInTheDocument()
  const fileData = { types:['Files'], files:[file] }
  fireEvent.dragEnter(main, { dataTransfer:fileData })
  fireEvent.dragEnter(screen.getByTestId('conversation'), { dataTransfer:fileData })
  fireEvent.dragLeave(screen.getByTestId('conversation'), { dataTransfer:fileData })
  expect(screen.getByText('Drop files or images to attach')).toBeInTheDocument()
  fireEvent.dragLeave(main, { dataTransfer:fileData })
  expect(screen.queryByText('Drop files or images to attach')).not.toBeInTheDocument()
  expect(uploadDocument).not.toHaveBeenCalled()
})

it('keeps the ordinary upload control and drop path disabled for Swico Free', async () => {
  mockApi()
  const freeBootstrap = {
    ...bootstrap,
    assistant:{ ...assistant, tier:'free' as const, tier_label:'Swico Free', tier_selection_enabled:false },
    features:{ ...bootstrap.features, web_attachments:false, web_image_uploads:false },
  }
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return freeBootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  expect(screen.queryByRole('button', { name:'Add to prompt' })).not.toBeInTheDocument()
  fireEvent.drop(screen.getByTestId('conversation'), {
    dataTransfer:{ types:['Files'], files:[new File(['hello'], 'notes.txt', { type:'text/plain' })] },
  })
  expect(uploadDocument).not.toHaveBeenCalled()
})

it('keeps repository upload hidden when bootstrap capability is disabled', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return {
      ...bootstrap,
      future_repository_capability:{ mode:'unknown' },
    } as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', {
    name:'Add to prompt',
  }))
  expect(screen.queryByRole('menuitem', {
    name:/Upload code repository/,
  })).not.toBeInTheDocument()
})

it('uploads, sends, replaces, and explicitly deletes a temporary repository without persistence', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository).mockImplementation(
    async (_user, file, id, progress) => {
      progress?.(67)
      return repositorySnapshot(id, file.name)
    },
  )
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  const { container } = render(<ChatPage />)
  const uploadArchive = async (name: string) => {
    await userEvent.click(await screen.findByRole('button', {
      name:'Add to prompt',
    }))
    await userEvent.click(screen.getByRole('menuitem', {
      name:/Upload code repository/,
    }))
    const file = new File(['PRIVATE SOURCE SHOULD NOT RENDER'], name, {
      type:'application/zip',
    })
    await userEvent.upload(container.querySelector(
      'input[aria-label="Upload code repository"]',
    ) as HTMLInputElement, file)
    return file
  }
  const firstFile = await uploadArchive('swico.zip')
  expect(uploadRepository).toHaveBeenCalledWith(
    user, firstFile, expect.stringMatching(/^[0-9a-f-]{36}$/),
    expect.any(Function),
  )
  expect(await screen.findByText('Repository ready')).toBeInTheDocument()
  expect(screen.getByText('Python · 12 files')).toBeInTheDocument()
  expect(screen.getByText('Static checks only')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('PRIVATE SOURCE SHOULD NOT RENDER')
  const firstId = vi.mocked(uploadRepository).mock.calls[0][2]

  await userEvent.type(
    screen.getByRole('textbox', { name:'Message Swico' }),
    'Fix the repository',
  )
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledOnce())
  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({
    repository_id:firstId,
    message:'Fix the repository',
  })
  expect(storage.mock.calls.flat().join(' ')).not.toContain(firstId)

  const secondFile = await uploadArchive('replacement.zip')
  await waitFor(() => expect(uploadRepository).toHaveBeenCalledTimes(2))
  expect(secondFile.name).toBe('replacement.zip')
  await waitFor(() => expect(deleteRepository).toHaveBeenCalledWith(
    user, firstId,
  ))
  const secondId = vi.mocked(uploadRepository).mock.calls[1][2]
  await userEvent.click(screen.getByRole('button', {
    name:'Remove replacement.zip',
  }))
  await waitFor(() => expect(deleteRepository).toHaveBeenCalledWith(
    user, secondId,
  ))
  expect(screen.queryByText('Repository ready')).not.toBeInTheDocument()
  storage.mockRestore()
})

it('shows safe repository upload failure and expiry without leaking server details', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository)
    .mockRejectedValueOnce(new ApiError(422, {
      error:{ message:'SECRET_TOKEN raw/source.py' },
    }))
    .mockImplementationOnce(async (_user, _file, id) => ({
      ...repositorySnapshot(id, 'expired.zip'),
      expires_at:new Date(Date.now() - 1_000).toISOString(),
    }))
  const { container } = render(<ChatPage />)
  const choose = async (name: string) => {
    await userEvent.click(await screen.findByRole('button', {
      name:'Add to prompt',
    }))
    await userEvent.click(screen.getByRole('menuitem', {
      name:/Upload code repository/,
    }))
    await userEvent.upload(container.querySelector(
      'input[aria-label="Upload code repository"]',
    ) as HTMLInputElement, new File(['private'], name, {
      type:'application/zip',
    }))
  }
  await choose('unsafe.zip')
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'did not pass safety checks',
  )
  expect(document.body.textContent).not.toMatch(/SECRET_TOKEN|raw\/source\.py/)
  await choose('expired.zip')
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'expired and was detached',
  )
  expect(screen.queryByLabelText('Active code repository')).not.toBeInTheDocument()
})

it('rebinds a fresh-chat repository before activating its SSE thread', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository).mockImplementation(
    async (_user, _file, id) => repositorySnapshot(id),
  )
  vi.mocked(streamChat).mockImplementation(async (
    _user, payload, onEvent,
  ) => {
    onEvent({ event:'thread', data:{ thread_id:'fresh-repository-thread' } })
    onEvent({ event:'delta', data:{ text:'Repository answer.' } })
    onEvent({ event:'done', data:{
      message_id:`answer-${payload.request_id}`, truncated:false,
    } })
  })
  const { container } = render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Add to prompt' }))
  await userEvent.click(screen.getByRole('menuitem', {
    name:/Upload code repository/,
  }))
  await userEvent.upload(container.querySelector(
    'input[aria-label="Upload code repository"]',
  ) as HTMLInputElement, new File(['private'], 'fresh.zip', {
    type:'application/zip',
  }))
  await screen.findByText('Repository ready')
  const repositoryId = vi.mocked(uploadRepository).mock.calls[0][2]

  const composer = screen.getByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'First repository question')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
  expect(vi.mocked(streamChat).mock.calls[0][1]).toMatchObject({
    repository_id:repositoryId,
  })
  expect(vi.mocked(streamChat).mock.calls[0][1]).not.toHaveProperty('thread_id')
  expect(await screen.findByText('Repository ready')).toBeInTheDocument()

  await userEvent.type(composer, 'Second repository question')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect(vi.mocked(streamChat).mock.calls[1][1]).toMatchObject({
    repository_id:repositoryId,
    thread_id:'fresh-repository-thread',
  })
  expect(screen.queryByText(/detached from this chat/i)).not.toBeInTheDocument()
})

it('clears an expired repository with a visible re-upload notice', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository).mockImplementation(
    async (_user, _file, id) => repositorySnapshot(id),
  )
  vi.mocked(streamChat).mockRejectedValue(new ApiError(404, {
    error:{ code:'repository_expired', message:'private server detail' },
  }))
  const { container } = render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Add to prompt' }))
  await userEvent.click(screen.getByRole('menuitem', {
    name:/Upload code repository/,
  }))
  await userEvent.upload(container.querySelector(
    'input[aria-label="Upload code repository"]',
  ) as HTMLInputElement, new File(['private'], 'expired-on-send.zip', {
    type:'application/zip',
  }))
  await screen.findByText('Repository ready')
  await userEvent.type(
    screen.getByRole('textbox', { name:'Message Swico' }),
    'Read the repository',
  )
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'no longer attached',
  )
  expect(screen.queryByLabelText('Active code repository')).not.toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('private server detail')
})

it('keeps a live repository attached across a transient cache error', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository).mockImplementation(
    async (_user, _file, id) => repositorySnapshot(id),
  )
  vi.mocked(streamChat).mockRejectedValue(new ApiError(503, {
    error:{ code:'repository_cache_unavailable' },
  }))
  const { container } = render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Add to prompt' }))
  await userEvent.click(screen.getByRole('menuitem', {
    name:/Upload code repository/,
  }))
  await userEvent.upload(container.querySelector(
    'input[aria-label="Upload code repository"]',
  ) as HTMLInputElement, new File(['private'], 'temporary.zip', {
    type:'application/zip',
  }))
  await screen.findByText('Repository ready')
  await userEvent.type(
    screen.getByRole('textbox', { name:'Message Swico' }),
    'Read the repository',
  )
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'temporarily unavailable',
  )
  expect(screen.getByText('Repository ready')).toBeInTheDocument()
})

it('clears repository state on logout and Firebase account change', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads')) {
      return { items:[], has_more:false } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository).mockImplementation(
    async (_user, _file, id) => repositorySnapshot(id),
  )
  const view = render(<ChatPage />)
  const upload = async () => {
    await userEvent.click(await screen.findByRole('button', {
      name:'Add to prompt',
    }))
    await userEvent.click(screen.getByRole('menuitem', {
      name:/Upload code repository/,
    }))
    await userEvent.upload(view.container.querySelector(
      'input[aria-label="Upload code repository"]',
    ) as HTMLInputElement, new File(['private'], 'account.zip', {
      type:'application/zip',
    }))
    await screen.findByText('Repository ready')
  }
  await upload()
  await userEvent.click(screen.getByRole('button', { name:/Hari/ }))
  await userEvent.click(screen.getByRole('menuitem', { name:'Sign out' }))
  expect(signOutMock).toHaveBeenCalledOnce()
  expect(screen.queryByText('Repository ready')).not.toBeInTheDocument()

  await upload()
  currentUser = {
    uid:'different-firebase-owner',
    getIdToken:vi.fn().mockResolvedValue('other-token'),
  }
  view.rerender(<ChatPage />)
  await waitFor(() => expect(
    screen.queryByText('Repository ready'),
  ).not.toBeInTheDocument())
  currentUser = user
})

it('keeps the selected repository for edit, regenerate, and continue in one thread', async () => {
  const thread = {
    id:'repo-thread', title:'Repository work', archived_at:null,
    created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  }
  const original = {
    id:'repo-user', thread_id:thread.id, role:'user' as const,
    content:'Fix this function', request_id:'repo-request',
    tier:null, tier_label:'Swico', input_tokens:0, output_tokens:0,
    usage_source:null, charge_micros:0, status:'complete',
    created_at:new Date().toISOString(), input_mode:'text' as const,
    voice_turn_id:null, reply_language:'en' as const,
  }
  const answer = {
    ...original, id:'repo-answer', role:'assistant' as const,
    content:'Proposed fix.', tier:'pro' as const, tier_label:'Swico Pro',
    input_tokens:10, output_tokens:10, usage_source:'actual' as const,
    charge_micros:10, truncated:true, can_continue:true,
  }
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return repositoryBootstrap as never
    if (path.startsWith('/api/web/threads?')) {
      return { items:[thread], has_more:false } as never
    }
    if (path.includes('/repo-thread/messages')) {
      return { items:[original, answer] } as never
    }
    return {} as never
  })
  vi.mocked(uploadRepository).mockImplementation(
    async (_user, _file, id) => repositorySnapshot(id),
  )
  const { container } = render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', {
    name:'Repository work',
  }))
  await userEvent.click(screen.getByRole('button', { name:'Add to prompt' }))
  await userEvent.click(screen.getByRole('menuitem', {
    name:/Upload code repository/,
  }))
  await userEvent.upload(container.querySelector(
    'input[aria-label="Upload code repository"]',
  ) as HTMLInputElement, new File(['private'], 'swico.zip', {
    type:'application/zip',
  }))
  await screen.findByText('Repository ready')
  const repositoryId = vi.mocked(uploadRepository).mock.calls[0][2]

  await userEvent.click(screen.getByRole('button', {
    name:'Regenerate answer',
  }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
  await userEvent.click(screen.getByRole('button', { name:'Edit message' }))
  const editor = screen.getByLabelText('Edit message')
  await userEvent.clear(editor)
  await userEvent.type(editor, 'Fix this function safely')
  await userEvent.click(screen.getByRole('button', {
    name:/Save and regenerate/,
  }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  await userEvent.click(screen.getByRole('button', {
    name:'Continue response',
  }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(3))
  for (const call of vi.mocked(streamChat).mock.calls) {
    expect(call[1].repository_id).toBe(repositoryId)
    expect(call[1].thread_id).toBe('repo-thread')
  }
  expect(vi.mocked(streamChat).mock.calls[0][1]).toHaveProperty(
    'regenerate_message_id', 'repo-answer',
  )
  expect(vi.mocked(streamChat).mock.calls[1][1]).toHaveProperty(
    'edit_message_id', 'repo-user',
  )
  expect(vi.mocked(streamChat).mock.calls[2][1]).toHaveProperty(
    'continue_message_id', 'repo-answer',
  )
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
  expect(await screen.findByText('Visible answer')).toBeInTheDocument()

  await waitFor(() => expect(screen.queryByRole('button', { name:'Stop generation' })).not.toBeInTheDocument())
  await userEvent.type(composer, 'normal typed message')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2))
  expect(vi.mocked(streamChat).mock.calls[1][1]).toMatchObject({ input_mode:'text', thread_id:'thread-voice' })
  expect(vi.mocked(streamChat).mock.calls[1][1]).not.toHaveProperty('voice_turn_id')
  expect(synthesizeAudio).not.toHaveBeenCalled()
  view.unmount()
})
