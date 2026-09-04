import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Message, SSEEvent } from '../types'
import {
  ApiError, ApiNetworkError, clearStoredGuestToken, createGuestSession,
  getStoredGuestToken, cancelGuestChatRequest, streamGuestChat,
} from '../api/client'
import { chatErrorMessage } from '../chatErrors'
import { chatStreamReducer, emptyStreamState } from '../chatStreamReducer'
import { Composer } from '../components/Composer'
import { Conversation } from '../components/Conversation'
import { applyTheme, resolveTheme } from '../theme'

const guestAssistant = {
  tier: 'free' as const, tier_label: 'Swico Free', tier_description: 'Free AI for everyday questions.',
  tier_selection_enabled: false,
  tiers: [{ id: 'free' as const, label: 'Swico Free', description: 'Free AI for everyday questions.', available: true, selected: true }],
}

function guestMessage(content: string, requestId: string, threadId: string | null): Message {
  return {
    id: `guest-user-${requestId}`, thread_id: threadId ?? '', role: 'user', content,
    request_id: requestId, tier: 'free', tier_label: 'Swico Free', input_tokens: 0,
    output_tokens: 0, usage_source: null, charge_micros: 0, status: 'complete',
    created_at: new Date().toISOString(), input_mode: 'text', voice_turn_id: null,
    reply_language: 'en',
  }
}

export function GuestChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [focusKey, setFocusKey] = useState('guest-initial')
  const [controller, setController] = useState<AbortController | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [streamState, dispatchStream] = useReducer(chatStreamReducer, emptyStreamState)
  const tokenRef = useRef<string | null>(getStoredGuestToken())
  const acceptedRef = useRef(false)
  const theme = resolveTheme()

  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    if (!streamState.assistant) return
    const assistant = streamState.assistant
    if (assistant.thread_id) setActiveThread(assistant.thread_id)
    setMessages(value => [
      ...value.filter(item => item.request_id !== assistant.request_id || item.role !== 'assistant'),
      assistant,
    ])
  }, [streamState.assistant])

  const ensureToken = async (): Promise<string> => {
    if (tokenRef.current) return tokenRef.current
    const session = await createGuestSession()
    tokenRef.current = session.guest_token
    return session.guest_token
  }

  const send = async (text = draft) => {
    const message = text.trim()
    if (!message || streaming || message.length > 16_000) {
      if (message.length > 16_000) setError('Your message is longer than the 16,000-character guest limit.')
      return
    }
    const nextRequestId = crypto.randomUUID()
    const originalThread = activeThread
    const optimistic = guestMessage(message, nextRequestId, originalThread)
    setMessages(value => [...value, optimistic])
    setDraft(''); setError(''); setStreaming(true); setRequestId(nextRequestId)
    setController(null); acceptedRef.current = false; dispatchStream({
      type: 'start', requestId: nextRequestId, threadId: originalThread ?? '', tier: 'free', tierLabel: 'Swico Free',
    })

    let token = tokenRef.current
    let retriedExpiredSession = false
    const abort = new AbortController()
    setController(abort)
    try {
      while (true) {
        token ??= await ensureToken()
        tokenRef.current = token
        try {
          await streamGuestChat(token, {
            request_id: nextRequestId, message, input_mode: 'text',
            ...(originalThread ? { thread_id: originalThread } : {}),
          }, (event: SSEEvent) => {
            dispatchStream({ type: 'event', event })
            if (event.event === 'thread' && event.data && typeof event.data === 'object') {
              const id = String((event.data as Record<string, unknown>).thread_id ?? '')
              if (id) {
                setActiveThread(id)
                setMessages(value => value.map(item => item.id === optimistic.id ? { ...item, thread_id: id } : item))
              }
            }
          }, abort.signal, () => { acceptedRef.current = true })
          break
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 401 && !retriedExpiredSession) {
            retriedExpiredSession = true
            clearStoredGuestToken(); tokenRef.current = null; token = null
            continue
          }
          throw caught
        }
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        dispatchStream({ type: 'event', event: { event: 'done', data: { cancelled: true } } })
        setError('Generation stopped.')
      } else {
        setError(caught instanceof ApiNetworkError ? caught.message : chatErrorMessage(caught, !navigator.onLine))
        if (!(caught instanceof ApiError && caught.status === 401)) {
          const body = caught instanceof ApiError && caught.body && typeof caught.body === 'object' && 'error' in caught.body
            ? (caught.body as { error?: { code?: string; message?: string } }).error : undefined
          dispatchStream({ type: 'event', event: { event: 'error', data: { code: body?.code ?? 'request_failed', message: body?.message ?? (caught instanceof Error ? caught.message : 'Swico could not finish this response.') } } })
        }
      }
    } finally {
      setStreaming(false); setController(null); setRequestId(null); acceptedRef.current = false
      setFocusKey(`guest-complete-${Date.now()}`)
    }
  }

  const stop = () => {
    const token = tokenRef.current
    const currentRequestId = requestId
    if (!token || !currentRequestId || !controller) return
    void cancelGuestChatRequest(token, currentRequestId)
      .catch(() => setError('Cancellation could not be confirmed.'))
      .finally(() => controller.abort())
  }

  const retry = (message: Message) => {
    const original = message.role === 'user'
      ? message
      : messages.find(item => item.role === 'user' && item.request_id === message.request_id)
    if (original) void send(original.content)
  }

  const newChat = () => {
    if (streaming) return
    setMessages([]); setActiveThread(null); setDraft(''); setError('')
    dispatchStream({ type: 'reset' }); setFocusKey(`guest-new-${Date.now()}`)
  }

  return <main className="app-shell guest-app-shell">
    <aside className="guest-sidebar">
      <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true">S</span><strong>Swico</strong></div>
      <button className="rail-action guest-new-chat" type="button" onClick={newChat} disabled={streaming}>＋ <span>New chat</span></button>
      <p className="guest-note">You’re using Swico Free as a guest. Sign up to save chats and access more features.</p>
      <nav className="guest-legal"><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link><Link to="/legal/contact">Help</Link></nav>
    </aside>
    <section className="chat-main guest-chat-main">
      <header className="guest-header"><div className="guest-mobile-brand"><span className="brand-mark" aria-hidden="true">S</span><strong>Swico</strong></div><div className="guest-auth-actions"><Link to="/login">Log in</Link><Link className="primary guest-signup" to="/signup">Sign up for free</Link></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      <Conversation messages={messages} phase={streamState.phase} queuePosition={streamState.queuePosition} estimatedWaitSeconds={streamState.estimatedWaitSeconds}
        retry={retry} suggest={setDraft} editingAvailable={false} continuationAvailable={false} voiceReplyEnabled={false} feedbackEnabled={false} emptyTitle="How can Swico help?" />
      <Composer value={draft} setValue={setDraft} send={() => void send()} stop={stop} cancellationReady={acceptedRef.current} streaming={streaming} disabled={false} focusKey={focusKey}
        assistant={guestAssistant} showTierSelector={false} showRealtimeVoiceControls={false} attachmentsEnabled={false} repositoryUploadEnabled={false} voiceEnabled={false}
        inlineThreshold={16_000} maxCharacters={16_000} />
      <p className="guest-composer-note">Swico Free · Guest chat is not saved to an account</p>
    </section>
  </main>
}
