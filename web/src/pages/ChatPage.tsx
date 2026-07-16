import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { Message, Bootstrap, Thread, Wallet, SSEEvent } from '../types'
import { ApiError, SSEStreamError, apiJson, streamChat } from '../api/client'
import { chatErrorMessage } from '../chatErrors'
import { chatStreamReducer, emptyStreamState } from '../chatStreamReducer'
import { useAuth } from '../auth/useAuth'
import { Sidebar, SidebarTrigger } from '../components/Sidebar'
import { Conversation } from '../components/Conversation'
import { Composer } from '../components/Composer'
import { applyTheme, resolveTheme, type Theme } from '../theme'

const BillingModal = lazy(() => import('../billing/BillingModal').then(module => ({ default: module.BillingModal })))

type DialogState = { type: 'rename' | 'delete'; thread: Thread; value: string } | null

export function ChatPage() {
  const { user, signOut } = useAuth()
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [threads, setThreads] = useState<Thread[]>([]); const [hasMore, setHasMore] = useState(false)
  const [active, setActive] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState(''); const [streaming, setStreaming] = useState(false)
  const [drawer, setDrawer] = useState(false); const [collapsed, setCollapsed] = useState(localStorage.getItem('swico-sidebar-collapsed') === 'true')
  const [archived, setArchived] = useState(false); const [query, setQuery] = useState('')
  const [billing, setBilling] = useState(false); const [dialog, setDialog] = useState<DialogState>(null)
  const [error, setError] = useState(''); const [offline, setOffline] = useState(!navigator.onLine)
  const [theme, setTheme] = useState<Theme>(resolveTheme)
  const [controller, setController] = useState<AbortController | null>(null); const [requestId, setRequestId] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState('initial'); const [streamState, dispatchStream] = useReducer(chatStreamReducer, emptyStreamState)
  const billingButtonRef = useRef<HTMLElement | null>(null)
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
    if (!user || !active) { if (!streaming) setMessages([]); return }
    if (streaming && streamState.assistant?.thread_id === active) return
    void apiJson<{ items: Message[] }>(user, `/api/web/threads/${active}/messages`).then(data => setMessages(data.items)).catch(() => setError('Conversation could not be loaded.'))
  }, [user, active]) // eslint-disable-line react-hooks/exhaustive-deps
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

  const send = async (text = draft, threadId = active, retryRequestId?: string) => {
    if (!user || streaming || !text.trim() || offline) return
    const nextRequestId = retryRequestId || crypto.randomUUID()
    const existingUser = messages.some(item => item.role === 'user' && item.request_id === nextRequestId)
    if (!existingUser) {
      const optimistic: Message = { id: `pending-${nextRequestId}`, thread_id: threadId ?? '', role: 'user', content: text.trim(), request_id: nextRequestId, provider: null, model: null, input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: 'pending', created_at: new Date().toISOString() }
      setMessages(value => [...value, optimistic])
    }
    setDraft(''); setStreaming(true); setError(''); setRequestId(nextRequestId)
    dispatchStream({ type: 'start', requestId: nextRequestId, threadId: threadId ?? '' })
    const abort = new AbortController(); setController(abort)
    try {
      await streamChat(user, { request_id: nextRequestId, message: text.trim(), ...(threadId ? { thread_id: threadId } : {}) }, handleEvent, abort.signal)
      await loadThreads(true)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        dispatchStream({ type: 'event', event: { event: 'done', data: { cancelled: true } } }); setError('Generation stopped. Partial provider usage may already have been charged.')
      } else {
        if (caught instanceof ApiError && caught.status === 402) setBilling(true)
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
        else if (result.status === 'cancelling') setError('Cancellation was requested. Swico is waiting for the provider to close safely.')
        else setError('The provider had already completed this response.')
      })
      .catch(() => setError('Cancellation could not be confirmed. The stream will remain open until provider settlement finishes.'))
  }
  const retry = (message: Message) => {
    const original = message.role === 'user' ? message : messages.find(item => item.role === 'user' && item.request_id === message.request_id)
    if (!original || !original.request_id || message.status !== 'retryable') return
    void send(original.content, original.thread_id || active, original.request_id)
  }
  const newChat = () => { setActive(null); setMessages([]); dispatchStream({ type: 'reset' }); setDrawer(false); setError(''); setFocusKey(`new-${Date.now()}`) }
  const select = (id: string) => { setActive(id); setDrawer(false); setError(''); setFocusKey(`select-${id}`) }
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

  if (!user || !bootstrap) return <div className="app-loading"><div className="brand-mark">S</div><span>Opening Swico…</span></div>
  return <main className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <Sidebar threads={threads} activeId={active} wallet={bootstrap.wallet} userName={bootstrap.user.name} open={drawer} collapsed={collapsed} archived={archived} hasMore={hasMore} query={query} setQuery={setQuery}
      select={select} newChat={newChat} addCredit={openBilling} mutate={mutate} signOut={() => void signOut()} close={() => setDrawer(false)} toggleCollapsed={() => setCollapsed(!collapsed)} toggleArchived={() => { setArchived(!archived); setActive(null) }} loadMore={() => void loadThreads(false)} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} />
    <section className="chat-main"><header className="chat-head"><SidebarTrigger open={() => setDrawer(true)} /><span className="product-selector">Swico <ChevronDown size={15} aria-hidden="true" /></span><span className="header-title">{threads.find(item => item.id === active)?.title || ''}</span></header>
      {offline && <div className="offline" role="status">You’re offline. Reconnect to send messages.</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      <Conversation messages={messages} phase={streamState.phase} retry={retry} suggest={text => { setDraft(text); setFocusKey(`suggest-${Date.now()}`) }} />
      <Composer value={draft} setValue={setDraft} send={() => void send()} stop={stop} streaming={streaming} disabled={offline} focusKey={focusKey} />
    </section>
    {billing && <Suspense fallback={null}><BillingModal user={user} config={bootstrap.billing} close={closeBilling} refreshed={() => { void refreshWallet() }} /></Suspense>}
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
