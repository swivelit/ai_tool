import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AssistantSettings, ComposerAttachment, Message, MessageAttachment, Bootstrap, ProfileSettings, ReadyAttachment, SwicoTier, Thread, Wallet, SSEEvent } from '../types'
import { ApiError, SSEStreamError, apiJson, deleteUpload, streamChat, uploadDocument } from '../api/client'
import { chatErrorMessage } from '../chatErrors'
import { chatStreamReducer, emptyStreamState } from '../chatStreamReducer'
import { useAuth } from '../auth/useAuth'
import { Sidebar, SidebarTrigger } from '../components/Sidebar'
import { Conversation } from '../components/Conversation'
import { Composer } from '../components/Composer'
import { SwicoTierSelector } from '../components/SwicoTierSelector'
import { applyTheme, resolveTheme, type Theme } from '../theme'

const BillingModal = lazy(() => import('../billing/BillingModal').then(module => ({ default: module.BillingModal })))
const SettingsModal = lazy(() => import('../components/SettingsModal').then(module => ({ default: module.SettingsModal })))

type DialogState = { type: 'rename' | 'delete'; thread: Thread; value: string } | null

export function ChatPage() {
  const { user, signOut } = useAuth()
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [threads, setThreads] = useState<Thread[]>([]); const [hasMore, setHasMore] = useState(false)
  const [active, setActive] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState(''); const [streaming, setStreaming] = useState(false)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [drawer, setDrawer] = useState(false); const [collapsed, setCollapsed] = useState(localStorage.getItem('swico-sidebar-collapsed') === 'true')
  const [archived, setArchived] = useState(false); const [query, setQuery] = useState('')
  const [billing, setBilling] = useState(false); const [settings, setSettings] = useState(false); const [dialog, setDialog] = useState<DialogState>(null)
  const [error, setError] = useState(''); const [offline, setOffline] = useState(!navigator.onLine)
  const [theme, setTheme] = useState<Theme>(resolveTheme)
  const [controller, setController] = useState<AbortController | null>(null); const [requestId, setRequestId] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState('initial'); const [streamState, dispatchStream] = useReducer(chatStreamReducer, emptyStreamState)
  const [tierSaving, setTierSaving] = useState(false)
  const billingButtonRef = useRef<HTMLElement | null>(null)
  const removedLocalUploads = useRef(new Set<string>())
  const threadCountRef = useRef(0)
  useEffect(() => { threadCountRef.current = threads.length }, [threads.length])

  const loadThreads = useCallback(async (reset = true) => {
    if (!user) return
    const offset = reset ? 0 : threadCountRef.current
    const params = new URLSearchParams({ archived: String(archived), limit: '50', offset: String(offset) })
    if (query.trim()) params.set('q', query.trim())
    const page = await apiJson<{ items: Thread[]; has_more: boolean }>(user, `/api/web/threads?${params}`)
    setThreads(value => reset ? page.items : [...value, ...page.items]); setHasMore(page.has_more)
  }, [archived, query, user])
  const refreshWallet = useCallback(async () => {
    if (!user) return
    const wallet = await apiJson<Wallet>(user, '/api/web/billing/wallet')
    setBootstrap(value => value ? { ...value, wallet } : value)
  }, [user])
  const saveTier = useCallback(async (tier: SwicoTier) => {
    if (!user || !bootstrap || streaming || tierSaving || tier === bootstrap.assistant.tier) return
    const previous = bootstrap.assistant
    const option = previous.tiers.find(item => item.id === tier)
    if (!option?.available) return
    const optimistic: AssistantSettings = {
      ...previous, tier, tier_label: option.label, tier_description: option.description,
      tiers: previous.tiers.map(item => ({ ...item, selected: item.id === tier })),
    }
    setTierSaving(true); setError('')
    setBootstrap(value => value ? { ...value, assistant: optimistic } : value)
    let saved: AssistantSettings
    try {
      saved = await apiJson<AssistantSettings>(user, '/api/web/settings/assistant', {
        method: 'PATCH', body: JSON.stringify({ tier }),
      })
      setBootstrap(value => value ? { ...value, assistant: saved } : value)
    } catch {
      setBootstrap(value => value ? { ...value, assistant: previous } : value)
      setError('Swico mode could not be changed. Your previous mode is still active.')
      setTierSaving(false)
      throw new Error('Swico mode could not be changed.')
    }
    try {
      const refreshed = await apiJson<Bootstrap>(user, '/api/web/bootstrap')
      setBootstrap(refreshed)
    } catch {
      setError('Your Swico mode was saved, but token estimates could not be refreshed yet.')
    } finally { setTierSaving(false) }
  }, [bootstrap, streaming, tierSaving, user])
  useEffect(() => {
    if (!user) return
    const refreshVisibleWallet = () => {
      if (document.visibilityState === 'visible') void refreshWallet().catch(() => undefined)
    }
    window.addEventListener('focus', refreshVisibleWallet)
    document.addEventListener('visibilitychange', refreshVisibleWallet)
    return () => {
      window.removeEventListener('focus', refreshVisibleWallet)
      document.removeEventListener('visibilitychange', refreshVisibleWallet)
    }
  }, [refreshWallet, user])
  useEffect(() => {
    if (!user) return
    void apiJson<Bootstrap>(user, '/api/web/bootstrap').then(setBootstrap).catch(() => setError('Could not load your Swico workspace.'))
  }, [user])
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadThreads(true).catch(() => setError('Chat history could not be loaded.')) }, 250)
    return () => window.clearTimeout(timer)
  }, [archived, query, user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => { localStorage.setItem('swico-sidebar-collapsed', String(collapsed)) }, [collapsed])
  useEffect(() => {
    const online = () => setOffline(false); const off = () => setOffline(true)
    window.addEventListener('online', online); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', off) }
  }, [])
  useEffect(() => {
    if (!user || !active) { if (!streaming) { setMessages([]); setAttachments([]) }; return }
    if (streaming && streamState.assistant?.thread_id === active) return
    void apiJson<{ items: Message[] }>(user, `/api/web/threads/${active}/messages`).then(data => {
      setMessages(data.items)
      const restored = new Map<string, MessageAttachment>()
      for (const message of data.items) {
        for (const attachment of message.attachments ?? []) {
          if (attachment.status === 'ready' && new Date(attachment.expires_at).getTime() > Date.now()) restored.set(attachment.id, attachment)
        }
      }
      setAttachments(Array.from(restored.values()).slice(-5))
    }).catch(() => setError('Conversation could not be loaded.'))
  }, [user, active]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!attachments.some(item => item.status === 'ready')) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      setAttachments(value => value.map(item => item.status === 'ready' && new Date(item.expires_at).getTime() <= now
        ? { ...item, status: 'expired' as const } : item))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [attachments])
  useEffect(() => {
    const assistant = streamState.assistant
    if (!assistant) return
    setMessages(value => {
      const without = value.filter(item => !(item.role === 'assistant' && item.request_id === assistant.request_id))
      return [...without, assistant]
    })
  }, [streamState.assistant])
  useEffect(() => {
    if (streamState.wallet) setBootstrap(value => value ? { ...value, wallet: streamState.wallet! } : value)
    if (streamState.error) setError(streamState.error.message)
  }, [streamState.wallet, streamState.error])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault(); newChat()
      }
      if (event.key === 'Escape' && dialog) setDialog(null)
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard)
  })

  const handleEvent = (event: SSEEvent) => {
    dispatchStream({ type: 'event', event })
    if (event.event === 'thread' && typeof event.data === 'object' && event.data) {
      const id = String((event.data as Record<string, unknown>).thread_id ?? '')
      if (id) {
        setActive(id)
        setMessages(value => value.map(item => item.thread_id ? item : { ...item, thread_id: id }))
      }
    }
  }

  const send = async (
    text = draft, threadId = active, retryRequestId?: string,
    attachmentOverride?: MessageAttachment[],
  ) => {
    const selectedAttachments = (attachmentOverride ?? attachments).filter((item): item is ReadyAttachment => item.status === 'ready')
    if (!user || !bootstrap || streaming || (!text.trim() && !selectedAttachments.length) || offline || attachments.some(item => item.status === 'uploading')) return
    const nextRequestId = retryRequestId || crypto.randomUUID()
    const existingUser = messages.some(item => item.role === 'user' && item.request_id === nextRequestId)
    if (!existingUser) {
      const content = text.trim() || `Attached: ${selectedAttachments.map(item => item.name).join(', ')}`
      const optimistic: Message = { id: `pending-${nextRequestId}`, thread_id: threadId ?? '', role: 'user', content, request_id: nextRequestId, tier: null, tier_label: 'Swico', input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: 'pending', created_at: new Date().toISOString(), attachments: selectedAttachments }
      setMessages(value => [...value, optimistic])
    }
    setDraft(''); setStreaming(true); setError(''); setRequestId(nextRequestId)
    dispatchStream({ type: 'start', requestId: nextRequestId, threadId: threadId ?? '', tier: bootstrap.assistant.tier, tierLabel: bootstrap.assistant.tier_label })
    const abort = new AbortController(); setController(abort)
    try {
      await streamChat(user, {
        request_id: nextRequestId,
        message: text.trim(),
        attachment_ids: selectedAttachments.map(item => item.id),
        ...(threadId ? { thread_id: threadId } : {}),
      }, handleEvent, abort.signal)
      await loadThreads(true)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        dispatchStream({ type: 'event', event: { event: 'done', data: { cancelled: true } } }); setError('Generation stopped. Partial measured usage may already have been charged.')
      } else {
        const code = caught instanceof ApiError && caught.body && typeof caught.body === 'object' && 'error' in caught.body
          ? String((caught.body as { error?: { code?: string } }).error?.code ?? '') : ''
        if (caught instanceof ApiError && caught.status === 402 && code !== 'usage_limit_reached') setBilling(true)
        setError(chatErrorMessage(caught, !navigator.onLine))
        if (!(caught instanceof SSEStreamError)) dispatchStream({ type: 'event', event: { event: 'error', data: { code: 'request_failed', message: chatErrorMessage(caught, !navigator.onLine) } } })
      }
    } finally { setStreaming(false); setController(null); setRequestId(null); setFocusKey(`complete-${Date.now()}`) }
  }

  const stop = () => {
    if (!user || !requestId || !controller) return
    setError('Stopping generation safely…')
    void apiJson<{ status: string }>(user, `/api/web/chat/requests/${requestId}/cancel`, { method: 'POST' })
      .then(async result => {
        if (result.status === 'stopped') { await refreshWallet().catch(() => undefined); controller.abort() }
        else if (result.status === 'cancelling') setError('Cancellation was requested. Swico is finishing the usage record safely.')
        else setError('Swico had already completed this response.')
      })
      .catch(() => setError('Cancellation could not be confirmed. The stream will remain open until usage settlement finishes.'))
  }
  const retry = (message: Message) => {
    const original = message.role === 'user' ? message : messages.find(item => item.role === 'user' && item.request_id === message.request_id)
    if (!original || !original.request_id || message.status !== 'retryable') return
    const summary = `Attached: ${(original.attachments ?? []).map(item => item.name).join(', ')}`
    const retryText = original.attachments?.length && original.content === summary ? '' : original.content
    void send(retryText, original.thread_id || active, original.request_id, original.attachments)
  }
  const newChat = () => { setActive(null); setMessages([]); setAttachments([]); dispatchStream({ type: 'reset' }); setDrawer(false); setError(''); setFocusKey(`new-${Date.now()}`) }
  const select = (id: string) => { setAttachments([]); setActive(id); setDrawer(false); setError(''); setFocusKey(`select-${id}`) }
  const addFiles = (files: File[]) => {
    if (!user || !bootstrap?.features.web_attachments || !bootstrap.uploads) return
    const limits = bootstrap.uploads
    const usable = attachments.filter(item => item.status !== 'expired' && item.status !== 'unavailable' && item.status !== 'error')
    let count = usable.length
    let total = usable.reduce((sum, item) => sum + item.size_bytes, 0)
    for (const file of files) {
      const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
      if (!limits.supported_extensions.includes(extension)) {
        setError(`“${file.name}” is not supported. Use ${limits.supported_extensions.join(', ')} files.`)
        continue
      }
      if (file.size <= 0) { setError(`“${file.name}” is empty.`); continue }
      if (file.size > limits.max_file_bytes) { setError(`“${file.name}” exceeds the 10 MiB file limit.`); continue }
      if (count >= limits.max_files_per_message) { setError(`You can attach up to ${limits.max_files_per_message} files.`); break }
      if (total + file.size > limits.max_total_bytes) { setError('Pending attachments exceed the 25 MiB total limit.'); break }
      count += 1; total += file.size
      const localId = crypto.randomUUID()
      const pending: ComposerAttachment = {
        local_id: localId, file, name: file.name, media_type: file.type,
        size_bytes: file.size, status: 'uploading', progress: 0,
      }
      setAttachments(value => [...value, pending])
      void uploadDocument(user, file, progress => setAttachments(value => value.map(item => 'local_id' in item && item.local_id === localId ? { ...item, progress } : item)))
        .then(upload => {
          if (removedLocalUploads.current.delete(localId)) {
            void deleteUpload(user, upload.id).catch(() => undefined)
            return
          }
          setAttachments(value => value.map(item => 'local_id' in item && item.local_id === localId ? upload : item))
        })
        .catch(caught => setAttachments(value => value.map(item => 'local_id' in item && item.local_id === localId
          ? { ...item, status: 'error' as const, error: caught instanceof Error ? caught.message : 'Upload failed.' } : item)))
    }
  }
  const removeAttachment = (attachment: ComposerAttachment) => {
    const key = 'local_id' in attachment ? attachment.local_id : attachment.id
    if ('local_id' in attachment && attachment.status === 'uploading') removedLocalUploads.current.add(attachment.local_id)
    setAttachments(value => value.filter(item => ('local_id' in item ? item.local_id : item.id) !== key))
    if (!('local_id' in attachment) && user) void deleteUpload(user, attachment.id).catch(() => setError('The attachment was removed locally, but the temporary cache could not be reached.'))
  }
  const runMutation = async (thread: Thread, action: 'rename' | 'archive' | 'delete', title?: string) => {
    if (!user) return
    if (action === 'rename') await apiJson(user, `/api/web/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    else if (action === 'archive') await apiJson(user, `/api/web/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !archived }) })
    else await apiJson(user, `/api/web/threads/${thread.id}`, { method: 'DELETE' })
    if (active === thread.id && action !== 'rename') newChat()
    await loadThreads(true)
  }
  const mutate = (thread: Thread, action: 'rename' | 'archive' | 'delete') => {
    if (action === 'archive') { void runMutation(thread, action); return }
    setDialog({ type: action, thread, value: thread.title })
  }
  const openBilling = () => { billingButtonRef.current = document.activeElement as HTMLElement; setBilling(true) }
  const closeBilling = () => { setBilling(false); window.setTimeout(() => billingButtonRef.current?.focus(), 0) }
  const openSettings = () => { billingButtonRef.current = document.activeElement as HTMLElement; setSettings(true) }
  const closeSettings = () => { setSettings(false); window.setTimeout(() => billingButtonRef.current?.focus(), 0) }

  if (!user || !bootstrap) return <div className="app-loading"><div className="brand-mark">S</div><span>Opening Swico…</span></div>
  return <main className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <Sidebar threads={threads} activeId={active} wallet={bootstrap.wallet} userName={bootstrap.user.name} open={drawer} collapsed={collapsed} archived={archived} hasMore={hasMore} query={query} setQuery={setQuery}
      select={select} newChat={newChat} addCredit={openBilling} openSettings={openSettings} mutate={mutate} signOut={() => void signOut()} close={() => setDrawer(false)} toggleCollapsed={() => setCollapsed(!collapsed)} toggleArchived={() => { setArchived(!archived); setActive(null) }} loadMore={() => void loadThreads(false)} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} />
    <section className="chat-main"><header className="chat-head"><SidebarTrigger open={() => setDrawer(true)} /><SwicoTierSelector assistant={bootstrap.assistant} disabled={streaming} saving={tierSaving} onSelect={saveTier} /><span className="header-title">{threads.find(item => item.id === active)?.title || ''}</span></header>
      {offline && <div className="offline" role="status">You’re offline. Reconnect to send messages.</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      <Conversation messages={messages} phase={streamState.phase} retry={retry} suggest={text => { setDraft(text); setFocusKey(`suggest-${Date.now()}`) }} />
      <Composer user={user} value={draft} setValue={setDraft} send={() => void send()} stop={stop} streaming={streaming} disabled={offline} focusKey={focusKey}
        attachments={attachments} attachmentsEnabled={Boolean(bootstrap.features.web_attachments)} voiceEnabled={Boolean(bootstrap.features.web_voice_recording)}
        supportedExtensions={bootstrap.uploads?.supported_extensions ?? []} addFiles={addFiles} removeAttachment={removeAttachment} />
    </section>
    {billing && !bootstrap.wallet.billing_exempt && <Suspense fallback={null}><BillingModal user={user} config={bootstrap.billing} close={closeBilling} refreshed={() => { void refreshWallet() }} /></Suspense>}
    {settings && <Suspense fallback={null}><SettingsModal user={user} theme={theme} setTheme={setTheme} assistant={bootstrap.assistant} tierSaving={tierSaving || streaming} saveTier={saveTier} close={closeSettings} addCredits={() => { setSettings(false); setBilling(true) }} openArchived={() => { setSettings(false); setArchived(true); setActive(null); if (window.matchMedia('(max-width: 900px)').matches) setDrawer(true) }} savedProfile={(profile: ProfileSettings) => setBootstrap(value => value ? { ...value, user: { ...value.user, name: profile.name, reply_language: profile.reply_language } } : value)} /></Suspense>}
    {dialog && <ThreadDialog state={dialog} setState={setDialog} confirm={() => { const current = dialog; setDialog(null); void runMutation(current.thread, current.type, current.value.trim()) }} />}
  </main>
}

function ThreadDialog({ state, setState, confirm }: { state: NonNullable<DialogState>; setState: (value: DialogState) => void; confirm: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setState(null) }}><section className="thread-dialog" role="dialog" aria-modal="true" aria-labelledby="thread-dialog-title">
    <h2 id="thread-dialog-title">{state.type === 'rename' ? 'Rename chat' : 'Delete chat?'}</h2>
    {state.type === 'rename' ? <input ref={inputRef} maxLength={120} value={state.value} onChange={event => setState({ ...state, value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && state.value.trim()) confirm() }} /> : <p>“{state.thread.title}” will be permanently deleted. This cannot be undone.</p>}
    <div className="dialog-actions"><button onClick={() => setState(null)}>Cancel</button><button className={state.type === 'delete' ? 'danger-button' : 'primary'} disabled={state.type === 'rename' && !state.value.trim()} onClick={confirm}>{state.type === 'rename' ? 'Save' : 'Delete'}</button></div>
  </section></div>
}
