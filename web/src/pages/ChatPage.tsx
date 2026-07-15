import { useCallback, useEffect, useState } from 'react'
import type { Message, Bootstrap, Thread, Wallet, SSEEvent } from '../types'
import { ApiError, apiJson, streamChat } from '../api/client'
import { useAuth } from '../auth/useAuth'
import { Sidebar } from '../components/Sidebar'
import { Conversation } from '../components/Conversation'
import { Composer } from '../components/Composer'
import { BillingModal } from '../billing/BillingModal'

export function ChatPage() {
  const { user, signOut } = useAuth()
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [billing, setBilling] = useState(false)
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(!navigator.onLine)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('swico-theme') as 'light' | 'dark') || 'light')
  const [controller, setController] = useState<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!user) return
    const [boot, threadPage] = await Promise.all([
      apiJson<Bootstrap>(user, '/api/web/bootstrap'),
      apiJson<{ items: Thread[] }>(user, '/api/web/threads'),
    ])
    setBootstrap(boot); setThreads(threadPage.items)
  }, [user])
  useEffect(() => { void refresh().catch(() => setError('Could not load your Swico workspace.')) }, [refresh])
  useEffect(() => {
    document.documentElement.dataset.theme = theme; localStorage.setItem('swico-theme', theme)
  }, [theme])
  useEffect(() => {
    const online = () => setOffline(false), off = () => setOffline(true)
    window.addEventListener('online', online); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', off) }
  }, [])
  useEffect(() => {
    if (!user || !active) { setMessages([]); return }
    void apiJson<{ items: Message[] }>(user, `/api/web/threads/${active}/messages`).then(data => setMessages(data.items)).catch(() => setError('Conversation could not be loaded.'))
  }, [user, active])

  const handleEvent = (event: SSEEvent) => {
    const data = event.data as Record<string, unknown>
    if (event.event === 'thread') setActive(String(data.thread_id))
    if (event.event === 'delta') setPending(value => value + String(data.text ?? ''))
    if (event.event === 'wallet') setBootstrap(value => value ? { ...value, wallet: data as unknown as Wallet } : value)
  }

  const send = async (text = draft, threadId = active) => {
    if (!user || streaming || !text.trim() || offline) return
    const requestId = crypto.randomUUID()
    const optimistic: Message = { id: `pending-${requestId}`, thread_id: threadId ?? '', role: 'user', content: text.trim(), request_id: requestId, provider: null, model: null, input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: 'pending', created_at: new Date().toISOString() }
    setMessages(value => [...value, optimistic]); setDraft(''); setPending(''); setStreaming(true); setError('')
    const abort = new AbortController(); setController(abort)
    try {
      await streamChat(user, { request_id: requestId, message: text.trim(), ...(threadId ? { thread_id: threadId } : {}) }, handleEvent, abort.signal)
      setPending(''); await refresh()
      const currentThread = active || (await apiJson<{ items: Thread[] }>(user, '/api/web/threads')).items[0]?.id
      if (currentThread) { setActive(currentThread); const page = await apiJson<{ items: Message[] }>(user, `/api/web/threads/${currentThread}/messages`); setMessages(page.items) }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') setError('Generation stopped.')
      else if (caught instanceof ApiError && caught.status === 402) { setBilling(true); setError('Add AI credit to continue.') }
      else setError('Swico could not finish that response. You can retry.')
      setMessages(value => value.map(item => item.id === optimistic.id ? { ...item, status: 'retryable' } : item))
    } finally { setStreaming(false); setController(null); setPending('') }
  }

  const select = (id: string) => { setActive(id); setDrawer(false); setError('') }
  const mutate = async (thread: Thread, action: 'rename' | 'archive' | 'delete') => {
    if (!user) return
    if (action === 'rename') {
      const title = window.prompt('Rename conversation', thread.title)?.trim(); if (!title) return
      await apiJson(user, `/api/web/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    } else if (action === 'archive') await apiJson(user, `/api/web/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) })
    else if (window.confirm('Delete this conversation permanently?')) await apiJson(user, `/api/web/threads/${thread.id}`, { method: 'DELETE' })
    if (active === thread.id) setActive(null); await refresh()
  }

  if (!user || !bootstrap) return <div className="app-loading"><div className="orb">S</div><span>Opening your workspace…</span></div>
  return <main className="app-shell">
    <Sidebar threads={threads} activeId={active} wallet={bootstrap.wallet} userName={bootstrap.user.name} open={drawer}
      select={select} newChat={() => { setActive(null); setMessages([]); setDrawer(false) }} addCredit={() => setBilling(true)}
      mutate={(thread, action) => void mutate(thread, action)} signOut={() => void signOut()} close={() => setDrawer(false)} />
    <section className="chat-main"><header className="chat-head"><button className="menu-button" aria-label="Open menu" onClick={() => setDrawer(true)}>☰</button><div><strong>{threads.find(item => item.id === active)?.title || 'New conversation'}</strong><span>Cloud AI · usage billed after each response</span></div><button className="theme-button" aria-label="Toggle color theme" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '☾' : '☀'}</button></header>
      {offline && <div className="offline" role="status">You’re offline. Drafts stay here until you reconnect.</div>}
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      <Conversation messages={messages} pendingText={pending} retry={message => void send(message.content, message.thread_id || active)} />
      <Composer value={draft} setValue={setDraft} send={() => void send()} stop={() => controller?.abort()} streaming={streaming} disabled={offline} />
    </section>
    {billing && <BillingModal user={user} config={bootstrap.billing} close={() => setBilling(false)} refreshed={() => void refresh()} />}
  </main>
}
