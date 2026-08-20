import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AssistantSettings, ComposerAttachment, ComposerRepository, InputMode, LongInputMode, Message, MessageAttachment, Bootstrap, ProfileSettings, ReadyAttachment, RepositorySnapshot, SearchResult, SwicoTier, Thread, Wallet, Wallets } from '../types'
import { ApiError, SSEStreamError, apiJson, deleteRepository, deleteUpload, streamChat, uploadDocument, uploadRepository, uploadVirtualText } from '../api/client'
import { chatErrorMessage, serviceCapacityMessage } from '../chatErrors'
import { chatStreamReducer, emptyStreamState } from '../chatStreamReducer'
import { useAuth } from '../auth/useAuth'
import { Sidebar, SidebarTrigger } from '../components/Sidebar'
import { Conversation } from '../components/Conversation'
import { Composer } from '../components/Composer'
import { applyTheme, resolveTheme, type Theme } from '../theme'
import { useVoiceReply } from '../hooks/useVoiceReply'
import type { VoiceTurnDone } from '../hooks/useRealtimeVoice'
import { frontendRelease } from '../config/publicConfig'
import { voiceAvailability } from '../voiceReadiness'
import { isReplyLanguage } from '../language'

const BillingModal = lazy(() => import('../billing/BillingModal').then(module => ({ default: module.BillingModal })))
const SettingsModal = lazy(() => import('../components/SettingsModal').then(module => ({ default: module.SettingsModal })))
const VoiceMode = lazy(() => import('../components/VoiceMode').then(module => ({ default: module.VoiceMode })))

type DialogState = { type: 'rename' | 'delete'; thread: Thread; value: string } | null
type ActiveRepository = ComposerRepository & {
  owner_uid: string;
  thread_id: string | null;
}

function safeRepositoryFilename(value: string): string {
  const basename = value.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const cleaned = [...basename].filter(character => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  }).join('').trim()
  return cleaned.toLowerCase().endsWith('.zip')
    ? cleaned.slice(0, 128)
    : 'Repository.zip'
}

function repositoryUploadError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Repository upload failed. Please try again.'
  }
  if (error.status === 413) return 'The repository ZIP exceeds the upload limit.'
  if (error.status === 415) return 'Select a ZIP archive for the code repository.'
  if (error.status === 422) return 'The repository ZIP did not pass safety checks.'
  if (error.status === 429) return 'Repository uploads are happening too quickly. Try again shortly.'
  if (error.status === 503) return 'Repository uploads are temporarily unavailable.'
  return 'Repository upload failed. Please try again.'
}

export function ChatPage() {
  const { user, signOut } = useAuth()
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [threads, setThreads] = useState<Thread[]>([]); const [hasMore, setHasMore] = useState(false)
  const [active, setActive] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState(''); const [streaming, setStreaming] = useState(false)
  const [continuingMessageId, setContinuingMessageId] = useState<string | null>(null)
  const [longInputMode, setLongInputMode] = useState<LongInputMode>('analyze')
  const [draftVoiceTurnId, setDraftVoiceTurnId] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [repository, setRepository] = useState<ActiveRepository | null>(null)
  const [drawer, setDrawer] = useState(false); const [collapsed, setCollapsed] = useState(localStorage.getItem('swico-sidebar-collapsed') === 'true')
  const [archived, setArchived] = useState(false); const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null)
  const [billing, setBilling] = useState(false); const [settings, setSettings] = useState(false); const [dialog, setDialog] = useState<DialogState>(null)
  const [billingBucket, setBillingBucket] = useState<'chat' | 'voice'>('chat')
  const [pendingReferralCode, setPendingReferralCode] = useState('')
  const [voiceMode, setVoiceMode] = useState(false)
  const [error, setError] = useState(''); const [offline, setOffline] = useState(!navigator.onLine)
  const [theme, setTheme] = useState<Theme>(resolveTheme)
  const [controller, setController] = useState<AbortController | null>(null); const [requestId, setRequestId] = useState<string | null>(null)
  const [cancellationReady, setCancellationReady] = useState(false)
  const [focusKey, setFocusKey] = useState('initial'); const [streamState, dispatchStream] = useReducer(chatStreamReducer, emptyStreamState)
  const [tierSaving, setTierSaving] = useState(false)
  const billingButtonRef = useRef<HTMLElement | null>(null)
  const removedLocalUploads = useRef(new Set<string>())
  const removedRepositoryUploads = useRef(new Set<string>())
  const threadCountRef = useRef(0)
  const voiceThreadRef = useRef<string | null>(null)
  const activeRef = useRef<string | null>(active)
  const userUid = user?.uid ?? ''
  const userUidRef = useRef(userUid)
  const streamScopeRef = useRef<{
    requestId: string
    initialThreadId: string | null
    threadId: string | null
    assistantMessageId?: string
  } | null>(null)
  const cancellationReadyRef = useRef(false)
  const queuedStopRef = useRef(false)
  const cancellationSentRef = useRef(false)
  const pendingRepositoryThreadRebindRef = useRef<{
    from: string | null
    to: string
  } | null>(null)
  useEffect(() => { threadCountRef.current = threads.length }, [threads.length])
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => {
    userUidRef.current = userUid
    setRepository(value => value?.owner_uid === userUid ? value : null)
  }, [userUid])
  useEffect(() => {
    if (!user) return
    const candidate = new URLSearchParams(window.location.search).get('ref')?.trim().toUpperCase() ?? ''
    if (!/^[A-Z0-9]{6,32}$/.test(candidate)) return
    setPendingReferralCode(candidate)
    const cleanUrl = `${window.location.pathname}${window.location.hash}`
    window.history.replaceState(window.history.state, document.title, cleanUrl)
  }, [user])
  useEffect(() => {
    if (!repository) return
    const pending = pendingRepositoryThreadRebindRef.current
    if (repository.thread_id === active) {
      if (pending?.to === active) pendingRepositoryThreadRebindRef.current = null
      return
    }
    if (
      pending
      && pending.to === active
      && repository.thread_id === pending.from
    ) {
      setRepository(value => value ? { ...value, thread_id:pending.to } : value)
      pendingRepositoryThreadRebindRef.current = null
      return
    }
    setRepository(null)
    setError(
      'The active code repository was detached from this chat. Upload it again to use repository context.',
    )
  }, [active, repository])

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
    const response = await apiJson<Wallet & { wallet?: Wallet; wallets?: Wallets }>(user, '/api/web/billing/wallet')
    setBootstrap(value => value ? {
      ...value, wallet:response.wallet ?? response,
      ...(response.wallets ? { wallets:response.wallets } : {}),
    } : value)
  }, [user])
  const loadMessages = useCallback(async (
    threadId: string, options: {
      requireAssistantRequestId?: string
      requireAssistantMessageId?: string
    } = {},
  ): Promise<boolean> => {
    if (!user) return false
    const data = await apiJson<{ items: Message[] }>(user, `/api/web/threads/${threadId}/messages`)
    const unique = Array.from(new Map(data.items.map(message => [message.id, message])).values())
    if (
      (options.requireAssistantRequestId || options.requireAssistantMessageId)
      && !unique.some(message => (
        message.role === 'assistant'
        && (
          message.request_id === options.requireAssistantRequestId
          || message.id === options.requireAssistantMessageId
        )
      ))
    ) return false
    if (activeRef.current !== threadId) return false
    setMessages(unique)
    const restored = new Map<string, MessageAttachment>()
    for (const message of unique) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.status === 'ready' && new Date(attachment.expires_at).getTime() > Date.now()) restored.set(attachment.id, attachment)
      }
    }
    setAttachments(Array.from(restored.values()).slice(-5))
    return true
  }, [user])
  const applyWallet = useCallback((wallet: Wallet) => {
    setBootstrap(value => value ? { ...value, wallet } : value)
  }, [])
  const requestServerCancellation = useCallback(async (
    targetRequestId: string,
    targetController: AbortController,
  ) => {
    if (!user || cancellationSentRef.current) return
    cancellationSentRef.current = true
    try {
      const result = await apiJson<{ status: string }>(
        user,
        `/api/web/chat/requests/${targetRequestId}/cancel`,
        { method:'POST' },
      )
      if (result.status === 'stopped') {
        await refreshWallet().catch(() => undefined)
        targetController.abort()
      } else if (result.status === 'cancelling') {
        setError(
          'Cancellation was requested. Swico is finishing the usage record safely.',
        )
      } else {
        setError('Swico had already completed this response.')
      }
    } catch {
      cancellationSentRef.current = false
      setError(
        'Cancellation could not be confirmed. The stream will remain open until usage settlement finishes.',
      )
    }
  }, [refreshWallet, user])
  const voiceReply = useVoiceReply({
    user, scopeKey: active ?? 'new-chat',
    enabled: Boolean(bootstrap?.features.web_voice_reply && bootstrap?.features.web_voice_billing),
    onWallet: applyWallet,
  })
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
  useEffect(() => {
    if (!user || !bootstrap?.features.web_content_search || !query.trim()) {
      setSearchResults([])
      return
    }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim(), limit: '20' })
      void apiJson<{ items: SearchResult[] }>(user, `/api/web/search?${params}`)
        .then(value => setSearchResults(value.items))
        .catch(() => setSearchResults([]))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [bootstrap?.features.web_content_search, query, user])
  useEffect(() => {
    if (!highlightMessageId) return
    const timer = window.setTimeout(() => setHighlightMessageId(null), 4000)
    return () => window.clearTimeout(timer)
  }, [highlightMessageId])
  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => { setDraftVoiceTurnId(null) }, [active])
  useEffect(() => { localStorage.setItem('swico-sidebar-collapsed', String(collapsed)) }, [collapsed])
  useEffect(() => {
    const online = () => setOffline(false); const off = () => setOffline(true)
    window.addEventListener('online', online); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', off) }
  }, [])
  useEffect(() => {
    if (!user || !active) { if (!streaming) { setMessages([]); setAttachments([]) }; return }
    const streamingThread = streamScopeRef.current?.threadId
      ?? streamState.assistant?.thread_id
    if (streaming && streamingThread === active) return
    void loadMessages(active).catch(() => setError('Conversation could not be loaded.'))
  }, [user, active]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user || !active || streaming) return
    const pending = [...messages].reverse().find(message => message.role === 'user' && message.status === 'pending' && message.request_id)
    if (!pending?.request_id) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const status = await apiJson<{ phase?: string; queue_position?: number | null; estimated_wait_seconds?: number | null; status?: string }>(
          user, `/api/web/chat/requests/${encodeURIComponent(pending.request_id!)}/status`,
        )
        if (stopped) return
        if (status.phase === 'queued' || status.phase === 'starting' || status.phase === 'complete') {
          dispatchStream({ type: 'event', event: { event: 'status', data: status } })
        }
        if (status.phase === 'complete') {
          await loadMessages(active)
          dispatchStream({ type: 'reset' })
          return
        }
        if (status.phase === 'stopped' || status.phase === 'error') return
      } catch { /* The normal thread reload remains the source of truth. */ }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer) }
  }, [active, loadMessages, messages, streaming, user])
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
    if (repository?.status !== 'ready' || !repository.expires_at) return
    const updateExpiry = () => {
      if (new Date(repository.expires_at!).getTime() <= Date.now()) {
        setRepository(value => value?.id === repository.id ? null : value)
        setError(
          'The active code repository expired and was detached. Upload it again to continue using repository context.',
        )
      }
    }
    updateExpiry()
    const timer = window.setInterval(updateExpiry, 1000)
    return () => window.clearInterval(timer)
  }, [repository?.expires_at, repository?.id, repository?.status])
  useEffect(() => {
    const assistant = streamState.assistant
    if (!assistant) return
    const scope = streamScopeRef.current
    if (scope?.requestId === assistant.request_id) {
      const streamThread = scope.threadId ?? scope.initialThreadId
      if (activeRef.current !== streamThread) return
    }
    setMessages(value => {
      const without = value.filter(item => !(item.role === 'assistant' && item.request_id === assistant.request_id))
      return [...without, assistant]
    })
  }, [streamState.assistant])
  useEffect(() => {
    if (streamState.wallet) setBootstrap(value => value ? { ...value, wallet: streamState.wallet! } : value)
    if (streamState.error) {
      setError(
        streamState.error.code === 'service_budget_reached'
          ? serviceCapacityMessage(
            streamState.error.message,
            streamState.error.retry_at,
          )
          : streamState.error.message
      )
    }
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

  const send = async (
    text = draft, threadId = active, retryRequestId?: string,
    attachmentOverride?: MessageAttachment[], originOverride?: { inputMode: InputMode; voiceTurnId: string | null },
    requestOptions?: { continueMessageId?: string; editMessageId?: string; regenerateMessageId?: string },
  ) => {
    let selectedAttachments = (attachmentOverride ?? attachments).filter((item): item is ReadyAttachment => item.status === 'ready')
    if (
      !user || !bootstrap || streaming
      || (!text.trim() && !selectedAttachments.length)
      || offline || attachments.some(item => item.status === 'uploading')
      || repository?.status === 'uploading'
    ) return
    const maxCharacters = bootstrap.uploads.long_input_enabled
      ? (bootstrap.uploads.long_input_max_chars ?? 64000) : 16000
    if (text.length > maxCharacters) {
      setError(`Pasted text exceeds the ${maxCharacters.toLocaleString()}-character limit. No characters were removed.`)
      return
    }
    const inlineThreshold = bootstrap.uploads.long_input_enabled
      ? (bootstrap.uploads.long_input_inline_threshold_chars ?? 12000) : 16000
    let providerText = text.trim()
    if (text.length > inlineThreshold) {
      if (!bootstrap.uploads.long_input_enabled) {
        setError('Large pasted-text processing is not enabled.')
        return
      }
      if (selectedAttachments.length >= bootstrap.uploads.max_files_per_message) {
        setError('Remove one attachment before sending this large pasted text.')
        return
      }
      setStreaming(true); setError('Preparing large pasted text…')
      try {
        const virtual = await uploadVirtualText(user, {
          upload_id: crypto.randomUUID(), text, operation: longInputMode,
        })
        selectedAttachments = [...selectedAttachments, virtual]
        setAttachments(value => [...value.filter(item => item.status === 'ready'), virtual].slice(-bootstrap.uploads.max_files_per_message))
        const labels: Record<LongInputMode, string> = {
          summarize: 'Summarize', analyze: 'Analyze', ask_questions: 'Answer questions about',
          rewrite: 'Rewrite', translate: 'Translate',
        }
        const embeddedQuestion = longInputMode === 'ask_questions'
          ? [...text.trimEnd().split(/\r?\n/u)].reverse().map(line => (
            line.match(/^\s*Question\s*:\s*(.{1,2000})\s*$/iu)?.[1]?.trim()
          )).find(Boolean)
          : undefined
        providerText = embeddedQuestion
          ?? `${labels[longInputMode]} the attached pasted text. Preserve its meaning and cite the supplied chunk labels when useful.`
      } catch (caught) {
        setError(chatErrorMessage(caught, !navigator.onLine)); setStreaming(false)
        return
      }
    }
    const nextRequestId = retryRequestId || crypto.randomUUID()
    streamScopeRef.current = { requestId:nextRequestId, initialThreadId:threadId, threadId }
    const origin = originOverride ?? {
      inputMode: draftVoiceTurnId ? 'dictation' as const : 'text' as const,
      voiceTurnId: draftVoiceTurnId,
    }
    const editTarget = requestOptions?.editMessageId
      ? messages.find(item => item.id === requestOptions.editMessageId && item.role === 'user') : undefined
    const regenerateTarget = requestOptions?.regenerateMessageId
      ? messages.find(item => item.id === requestOptions.regenerateMessageId && item.role === 'assistant') : undefined
    const regenerateUser = regenerateTarget
      ? messages.find(item => item.role === 'user' && item.request_id === regenerateTarget.request_id) : undefined
    const revisionTarget = editTarget ?? regenerateUser
    const requestRepositoryId = (
      bootstrap.features.web_repository_chat
      && repository?.status === 'ready'
      && repository.owner_uid === userUid
      && repository.thread_id === threadId
      && (!repository.expires_at
        || new Date(repository.expires_at).getTime() > Date.now())
    ) ? repository.id : null
    const existingUser = messages.some(item => item.role === 'user' && item.request_id === nextRequestId)
    if (!existingUser && !revisionTarget && !requestOptions?.continueMessageId) {
      const content = providerText || `Attached: ${selectedAttachments.map(item => item.name).join(', ')}`
      const optimistic: Message = { id: `pending-${nextRequestId}`, thread_id: threadId ?? '', role: 'user', content, request_id: nextRequestId, tier: null, tier_label: 'Swico', input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: 'pending', created_at: new Date().toISOString(), attachments: selectedAttachments, input_mode: origin.inputMode, voice_turn_id: origin.voiceTurnId, reply_language: isReplyLanguage(bootstrap.user.reply_language) ? bootstrap.user.reply_language : 'en' }
      setMessages(value => [...value, optimistic])
    }
    setDraft(''); setStreaming(true); setError(''); setRequestId(nextRequestId)
    cancellationReadyRef.current = false
    queuedStopRef.current = false
    cancellationSentRef.current = false
    setCancellationReady(false)
    dispatchStream({ type: 'start', requestId: nextRequestId, threadId: threadId ?? '', tier: bootstrap.assistant.tier, tierLabel: bootstrap.assistant.tier_label })
    const abort = new AbortController(); setController(abort)
    try {
      await streamChat(user, {
        request_id: nextRequestId,
        message: providerText,
        attachment_ids: selectedAttachments.map(item => item.id),
        input_mode: origin.inputMode,
        ...(origin.inputMode !== 'text' && origin.voiceTurnId ? { voice_turn_id: origin.voiceTurnId } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(requestRepositoryId ? { repository_id: requestRepositoryId } : {}),
        ...(requestOptions?.continueMessageId ? { continue_message_id: requestOptions.continueMessageId } : {}),
        ...(requestOptions?.editMessageId ? { edit_message_id: requestOptions.editMessageId } : {}),
        ...(requestOptions?.regenerateMessageId ? { regenerate_message_id: requestOptions.regenerateMessageId } : {}),
      }, event => {
        const scope = streamScopeRef.current
        if (!scope || scope.requestId !== nextRequestId) return
        if (event.event === 'sources' && (
          typeof event.data !== 'object' || event.data === null
        )) return
        if (event.event === 'quality' && (
          typeof event.data !== 'object' || event.data === null
        )) return
        dispatchStream({ type: 'event', event })
        if (event.event === 'thread' && typeof event.data === 'object' && event.data) {
          const id = String((event.data as Record<string, unknown>).thread_id ?? '')
          if (id) {
            const stillViewingOrigin = activeRef.current === scope.initialThreadId
            scope.threadId = id
            if (stillViewingOrigin) {
              pendingRepositoryThreadRebindRef.current = {
                from:scope.initialThreadId,
                to:id,
              }
              setRepository(value => (
                value
                && value.owner_uid === userUid
                && value.thread_id === scope.initialThreadId
                  ? { ...value, thread_id:id }
                  : value
              ))
              activeRef.current = id
              setActive(id)
              setMessages(value => value.map(item => item.thread_id ? item : { ...item, thread_id:id }))
            }
          }
        }
        if (event.event === 'done' && typeof event.data === 'object' && event.data
          && Boolean((event.data as Record<string, unknown>).memory_updated)) {
          window.dispatchEvent(new Event('swico:memory-updated'))
        }
        if (event.event === 'done' && typeof event.data === 'object' && event.data) {
          const messageId = String(
            (event.data as Record<string, unknown>).message_id ?? '',
          )
          if (messageId) scope.assistantMessageId = messageId
        }
        if (event.event === 'done' && requestOptions?.continueMessageId) {
          setMessages(value => value.map(item => (
            item.id === requestOptions.continueMessageId
              ? { ...item, can_continue:false }
              : item
          )))
        }
        // Dictation is an input convenience only. Manual speaker playback remains
        // available from completed messages, but is never auto-generated here.
      }, abort.signal, () => {
        cancellationReadyRef.current = true
        setCancellationReady(true)
        if (queuedStopRef.current) {
          queuedStopRef.current = false
          void requestServerCancellation(nextRequestId, abort)
        }
        if (!revisionTarget) return
        const replacement: Message = {
          ...revisionTarget, id: `pending-${nextRequestId}`, content: providerText,
          request_id: nextRequestId, status: 'pending', created_at: new Date().toISOString(),
          replaces_message_id: revisionTarget.id,
          revision_number: (revisionTarget.revision_number ?? 1) + 1,
        }
        setMessages(value => [
          ...value.filter(item => item.request_id !== revisionTarget.request_id && item.request_id !== nextRequestId),
          replacement,
        ])
      })
      setDraftVoiceTurnId(null)
      await loadThreads(true)
      const completedThreadId = streamScopeRef.current?.requestId === nextRequestId
        ? streamScopeRef.current.threadId ?? threadId
        : threadId
      if (completedThreadId) {
        const persisted = await loadMessages(completedThreadId, {
          requireAssistantRequestId:nextRequestId,
          requireAssistantMessageId:streamScopeRef.current?.assistantMessageId,
        })
        if (persisted) {
          // The persisted thread is authoritative after a terminal stream.
          // Clear the optimistic projection only after the matching assistant
          // is observable; eventual-consistency lag must not hide the answer.
          dispatchStream({ type:'reset' })
        }
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        dispatchStream({ type: 'event', event: { event: 'done', data: { cancelled: true } } }); setError('Generation stopped. Partial measured usage may already have been charged.')
      } else {
        if (origin.inputMode === 'dictation' || origin.inputMode === 'voice') { setDraft(text); setDraftVoiceTurnId(origin.voiceTurnId) }
        const code = caught instanceof ApiError && caught.body && typeof caught.body === 'object' && 'error' in caught.body
          ? String((caught.body as { error?: { code?: string } }).error?.code ?? '') : ''
        const repositoryDetached = [
          'repository_expired', 'repository_not_found', 'repository_unavailable',
        ].includes(code)
        if (repositoryDetached) setRepository(null)
        if (caught instanceof ApiError && caught.status === 402 && code !== 'usage_limit_reached') {
          const body = caught.body as { error?: { credit_bucket?: string } } | undefined
          setBillingBucket(body?.error?.credit_bucket === 'voice' ? 'voice' : 'chat'); setBilling(true)
        }
        setError(repositoryDetached
          ? 'The active code repository is no longer attached. Upload it again to continue using repository context.'
          : chatErrorMessage(caught, !navigator.onLine))
        if (!(caught instanceof SSEStreamError) && !repositoryDetached) dispatchStream({ type: 'event', event: { event: 'error', data: { code: 'request_failed', message: chatErrorMessage(caught, !navigator.onLine) } } })
      }
      if (revisionTarget?.thread_id) await loadMessages(revisionTarget.thread_id)
      if (requestOptions?.continueMessageId && threadId) {
        await loadMessages(threadId)
      }
    } finally {
      cancellationReadyRef.current = false
      queuedStopRef.current = false
      setCancellationReady(false)
      setStreaming(false); setContinuingMessageId(null); setController(null); setRequestId(null); setFocusKey(`complete-${Date.now()}`)
    }
  }

  const stop = () => {
    if (!user || !requestId || !controller) return
    setError('Stopping generation safely…')
    if (!cancellationReadyRef.current) {
      queuedStopRef.current = true
      return
    }
    void requestServerCancellation(requestId, controller)
  }
  const retry = (message: Message) => {
    const original = message.role === 'user' ? message : messages.find(item => item.role === 'user' && item.request_id === message.request_id)
    if (!original || !original.request_id || message.status !== 'retryable') return
    const retryAt = message.retry_at ?? original.retry_at
    if (retryAt) {
      const retryAtMilliseconds = Date.parse(retryAt)
      if (
        Number.isFinite(retryAtMilliseconds)
        && retryAtMilliseconds > Date.now()
      ) return
    }
    const summary = `Attached: ${(original.attachments ?? []).map(item => item.name).join(', ')}`
    const retryText = original.attachments?.length && original.content === summary ? '' : original.content
    void send(retryText, original.thread_id || active, original.request_id, original.attachments, {
      inputMode: original.input_mode, voiceTurnId: original.voice_turn_id,
    })
  }
  const continueResponse = (message: Message) => {
    if (
      streaming || offline
      || attachments.some(item => item.status === 'uploading')
      || !message.thread_id || !message.truncated
    ) return
    setContinuingMessageId(message.id)
    void send('Continue response', message.thread_id, undefined, [], {
      inputMode: 'text', voiceTurnId: null,
    }, { continueMessageId: message.id })
  }
  const editMessage = (message: Message, content: string) => {
    if (streaming || !message.thread_id || !content.trim()) return
    void send(content, message.thread_id, undefined, message.attachments, {
      inputMode: message.input_mode, voiceTurnId: message.voice_turn_id,
    }, { editMessageId: message.id })
  }
  const regenerateResponse = (message: Message) => {
    if (streaming || message.status !== 'complete' || !message.thread_id) return
    const original = messages.find(item => (
      item.role === 'user' && item.request_id === message.request_id
    ))
    if (!original) return
    void send(original.content, message.thread_id, undefined, original.attachments, {
      inputMode: original.input_mode, voiceTurnId: original.voice_turn_id,
    }, { regenerateMessageId: message.id })
  }
  const newChat = () => { voiceReply.clear(); setDraft(''); setDraftVoiceTurnId(null); setHighlightMessageId(null); activeRef.current = null; setActive(null); setMessages([]); setAttachments([]); setRepository(null); dispatchStream({ type: 'reset' }); setDrawer(false); setError(''); setFocusKey(`new-${Date.now()}`) }
  const select = (id: string) => { setDraftVoiceTurnId(null); setHighlightMessageId(null); setAttachments([]); setRepository(null); activeRef.current = id; setActive(id); setDrawer(false); setError(''); setFocusKey(`select-${id}`) }
  const selectSearch = (result: SearchResult) => {
    if (!result.thread_id) return
    setDraftVoiceTurnId(null); setAttachments([]); setRepository(null); activeRef.current = result.thread_id
    setActive(result.thread_id); setHighlightMessageId(result.message_id)
    setDrawer(false); setError(''); setFocusKey(`search-${result.thread_id}`)
  }
  const submitFeedback = async (message: Message, rating: 'up' | 'down') => {
    if (!user) return
    const previous = message.feedback_rating ?? null
    setMessages(value => value.map(item => item.id === message.id ? { ...item, feedback_rating: rating } : item))
    try {
      await apiJson(user, `/api/web/messages/${message.id}/feedback`, {
        method: 'POST', body: JSON.stringify({ rating }),
      })
    } catch (caught) {
      setMessages(value => value.map(item => item.id === message.id ? { ...item, feedback_rating: previous } : item))
      setError('Your feedback could not be saved.')
      throw caught
    }
  }
  const addFiles = (files: File[]) => {
    if (!user || !bootstrap?.features.web_attachments || !bootstrap.uploads) return
    const limits = bootstrap.uploads
    const usable = attachments.filter(item => item.status !== 'expired' && item.status !== 'unavailable' && item.status !== 'error')
    let count = usable.length
    let imageCount = usable.filter(item => item.media_type.startsWith('image/')).length
    let total = usable.reduce((sum, item) => sum + item.size_bytes, 0)
    for (const file of files) {
      const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
      if (!limits.supported_extensions.includes(extension)) {
        setError(`“${file.name}” is not supported. Use ${limits.supported_extensions.join(', ')} files.`)
        continue
      }
      if (file.size <= 0) { setError(`“${file.name}” is empty.`); continue }
      const isImage = file.type.startsWith('image/')
      const fileLimit = isImage
        ? limits.image_max_file_bytes ?? limits.max_file_bytes
        : limits.max_file_bytes
      if (file.size > fileLimit) { setError(`“${file.name}” exceeds the configured file limit.`); continue }
      if (isImage && imageCount >= (limits.image_max_count ?? 4)) {
        setError(`You can attach up to ${limits.image_max_count ?? 4} images.`)
        break
      }
      if (count >= limits.max_files_per_message) { setError(`You can attach up to ${limits.max_files_per_message} files.`); break }
      if (total + file.size > limits.max_total_bytes) { setError('Pending attachments exceed the 25 MiB total limit.'); break }
      count += 1; total += file.size
      if (isImage) imageCount += 1
      const localId = crypto.randomUUID()
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined
      const pending: ComposerAttachment = {
        local_id: localId, file, name: file.name, media_type: file.type,
        size_bytes: file.size, status: 'uploading', progress: 0,
        preview_url:previewUrl,
      }
      setAttachments(value => [...value, pending])
      void uploadDocument(user, file, progress => setAttachments(value => value.map(item => 'local_id' in item && item.local_id === localId ? { ...item, progress } : item)))
        .then(upload => {
          if (removedLocalUploads.current.delete(localId)) {
            void deleteUpload(user, upload.id).catch(() => undefined)
            return
          }
          setAttachments(value => value.map(item => 'local_id' in item && item.local_id === localId
            ? { ...upload, preview_url:item.preview_url } : item))
        })
        .catch(caught => setAttachments(value => value.map(item => 'local_id' in item && item.local_id === localId
          ? { ...item, status: 'error' as const, error: caught instanceof Error ? caught.message : 'Upload failed.' } : item)))
    }
  }
  const removeAttachment = (attachment: ComposerAttachment) => {
    const key = 'local_id' in attachment ? attachment.local_id : attachment.id
    if ('local_id' in attachment && attachment.status === 'uploading') removedLocalUploads.current.add(attachment.local_id)
    if (attachment.preview_url) URL.revokeObjectURL(attachment.preview_url)
    setAttachments(value => value.filter(item => ('local_id' in item ? item.local_id : item.id) !== key))
    if (!('local_id' in attachment) && user) void deleteUpload(user, attachment.id).catch(() => setError('The attachment was removed locally, but the temporary cache could not be reached.'))
  }
  const addRepository = (file: File) => {
    if (
      !user || !bootstrap?.features.web_repository_upload
      || !bootstrap.repositories
    ) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Select a ZIP archive for the code repository.')
      return
    }
    if (file.size <= 0) {
      setError('The repository ZIP is empty.')
      return
    }
    if (file.size > bootstrap.repositories.max_archive_bytes) {
      setError('The repository ZIP exceeds the upload limit.')
      return
    }
    const previous = repository
    const repositoryId = crypto.randomUUID()
    const ownerUid = userUid
    const pending: ActiveRepository = {
      id: repositoryId,
      display_name: safeRepositoryFilename(file.name),
      owner_uid: ownerUid,
      thread_id: active,
      status: 'uploading',
      progress: 0,
      languages: [],
      file_count: 0,
      symbol_count: 0,
    }
    setError('')
    setRepository(pending)
    void uploadRepository(user, file, repositoryId, progress => {
      setRepository(value => value?.id === repositoryId
        ? { ...value, progress:Math.min(100, Math.max(0, progress)) }
        : value)
    }).then((snapshot: RepositorySnapshot) => {
      if (removedRepositoryUploads.current.delete(repositoryId)) {
        void deleteRepository(user, snapshot.id).catch(() => undefined)
        return
      }
      if (userUidRef.current !== ownerUid) return
      setRepository(value => value?.id === repositoryId ? {
        id: snapshot.id,
        display_name: safeRepositoryFilename(
          snapshot.display_name || pending.display_name,
        ),
        owner_uid: ownerUid,
        thread_id: pending.thread_id,
        status: 'ready',
        progress: 100,
        expires_at: snapshot.expires_at,
        languages: snapshot.languages.slice(0, 8),
        file_count: Math.max(0, snapshot.file_count),
        symbol_count: Math.max(0, snapshot.symbol_count),
      } : value)
      if (previous && previous.owner_uid === ownerUid) {
        void deleteRepository(user, previous.id).catch(() => {
          setError('The replacement is ready, but the earlier temporary repository could not be cleared.')
        })
      }
    }).catch(caught => {
      if (userUidRef.current !== ownerUid) return
      const message = repositoryUploadError(caught)
      setError(message)
      setRepository(value => value?.id !== repositoryId ? value
        : previous ?? { ...pending, status:'error', error:message })
    })
  }
  const removeRepository = () => {
    const selected = repository
    setRepository(null)
    if (selected?.status === 'uploading') {
      removedRepositoryUploads.current.add(selected.id)
    }
    if (
      !user || !selected || selected.owner_uid !== userUid
      || selected.status === 'error'
    ) return
    void deleteRepository(user, selected.id).catch(() => {
      if (selected.status !== 'uploading') {
        setError('The repository was removed locally, but its temporary cache could not be reached.')
      }
    })
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
  const openBilling = (bucket: 'chat' | 'voice' = 'chat') => { billingButtonRef.current = document.activeElement as HTMLElement; setBillingBucket(bucket); setBilling(true) }
  const closeBilling = () => { setBilling(false); window.setTimeout(() => billingButtonRef.current?.focus(), 0) }
  const openSettings = () => { billingButtonRef.current = document.activeElement as HTMLElement; setSettings(true) }
  const closeSettings = () => { setSettings(false); window.setTimeout(() => billingButtonRef.current?.focus(), 0) }
  const voiceTurnDone = useCallback((turn: VoiceTurnDone) => {
    if (turn.completion_status !== 'complete') return
    voiceThreadRef.current = turn.thread_id
    activeRef.current = turn.thread_id
    setActive(turn.thread_id)
    void Promise.all([loadMessages(turn.thread_id), loadThreads(true), refreshWallet()])
      .catch(() => setError('The Voice turn was saved, but chat history could not be refreshed yet.'))
  }, [loadMessages, loadThreads, refreshWallet])
  const closeVoiceMode = useCallback(() => {
    setVoiceMode(false)
    const authoritativeThread = voiceThreadRef.current ?? active
    if (authoritativeThread) {
      activeRef.current = authoritativeThread
      setActive(authoritativeThread)
      void loadMessages(authoritativeThread).catch(() => setError('Voice messages were saved, but the final refresh failed.'))
    }
    void loadThreads(true).catch(() => undefined)
    void refreshWallet().catch(() => undefined)
    setFocusKey(`voice-close-${Date.now()}`)
  }, [active, loadMessages, loadThreads, refreshWallet])

  const voiceReady = bootstrap ? voiceAvailability(bootstrap, frontendRelease) : { enabled:false, reason:'Voice Mode is loading.' }
  const voiceUnavailableReason = voiceReady.reason
  const realtimeVoiceEnabled = voiceReady.enabled

  if (!user || !bootstrap) return <div className="app-loading"><div className="brand-mark">S</div><span>Opening Swico…</span></div>
  return <main className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <Sidebar threads={threads} activeId={active} wallet={bootstrap.wallet} userName={bootstrap.user.name} open={drawer} collapsed={collapsed} archived={archived} hasMore={hasMore} query={query} setQuery={setQuery}
      searchResults={searchResults} selectSearch={selectSearch} select={select} newChat={newChat} addCredit={() => openBilling('chat')} openSettings={openSettings} mutate={mutate} signOut={() => { setRepository(null); void signOut() }} close={() => setDrawer(false)} toggleCollapsed={() => setCollapsed(!collapsed)} toggleArchived={() => { setArchived(!archived); setRepository(null); setActive(null) }} loadMore={() => void loadThreads(false)} toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} />
    <section className="chat-main"><header className="chat-head"><SidebarTrigger open={() => setDrawer(true)} /><span className="header-title">{threads.find(item => item.id === active)?.title || ''}</span></header>
      {offline && <div className="offline" role="status">You’re offline. Reconnect to send messages.</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      <Conversation messages={messages} phase={streamState.phase} queuePosition={streamState.queuePosition} estimatedWaitSeconds={streamState.estimatedWaitSeconds} retry={retry} continueResponse={continueResponse} continuingMessageId={continuingMessageId} regenerateResponse={regenerateResponse} editMessage={editMessage} editingAvailable={Boolean(bootstrap.features.web_message_edit)} editingDisabled={streaming} suggest={text => { setDraftVoiceTurnId(null); setDraft(text); setFocusKey(`suggest-${Date.now()}`) }}
        voiceReplyEnabled={Boolean(bootstrap.features.web_voice_reply && bootstrap.features.web_voice_billing)} voiceStates={voiceReply.states} generateVoice={(messageId, voiceTurnId) => void voiceReply.generate(messageId, voiceTurnId)} playVoice={messageId => void voiceReply.play(messageId)} pauseVoice={voiceReply.pause}
        retryVoice={voiceReply.retry} addCredits={() => openBilling('voice')}
        feedbackEnabled={Boolean(bootstrap.features.web_answer_feedback)} submitFeedback={submitFeedback}
        highlightMessageId={highlightMessageId} />
      <Composer user={user} value={draft} setValue={setDraft} send={() => void send()} stop={stop} cancellationReady={cancellationReady} streaming={streaming} disabled={offline} focusKey={focusKey}
        attachments={attachments} attachmentsEnabled={Boolean(bootstrap.features.web_attachments)} voiceEnabled={Boolean(bootstrap.features.web_voice_recording && bootstrap.features.web_voice_billing)}
        repository={repository}
        repositoryUploadEnabled={Boolean(bootstrap.features.web_repository_upload)}
        repositoryChatEnabled={Boolean(bootstrap.features.web_repository_chat)}
        repositoryValidationCapability={bootstrap.repositories?.validation_capability ?? 'static_only'}
        inlineThreshold={bootstrap.uploads.long_input_enabled ? bootstrap.uploads.long_input_inline_threshold_chars ?? 12000 : 16000}
        maxCharacters={bootstrap.uploads.long_input_enabled ? bootstrap.uploads.long_input_max_chars ?? 64000 : 16000}
        longInputMode={longInputMode} setLongInputMode={setLongInputMode}
        realtimeVoiceEnabled={realtimeVoiceEnabled} realtimeVoiceUnavailableReason={voiceUnavailableReason}
        assistant={bootstrap.assistant} tierDisabled={streaming || voiceMode} tierSaving={tierSaving} onTierSelect={saveTier}
        onRealtimeVoice={() => { voiceThreadRef.current = active; setVoiceMode(true) }}
        voiceResetKey={`${active ?? 'new-chat'}:${focusKey}`}
        onVoiceDraft={setDraftVoiceTurnId} onVoiceCancel={() => setDraftVoiceTurnId(null)} onComposerClear={() => setDraftVoiceTurnId(null)} onVoiceWallet={applyWallet}
        supportedExtensions={bootstrap.uploads?.supported_extensions ?? []} addFiles={addFiles} removeAttachment={removeAttachment}
        addRepository={addRepository} removeRepository={removeRepository} />
    </section>
    {billing && !bootstrap.wallet.billing_exempt && <Suspense fallback={null}><BillingModal user={user} config={bootstrap.billing} initialBucket={billingBucket} initialReferralCode={pendingReferralCode} close={closeBilling} refreshed={() => { void refreshWallet(); void apiJson<Bootstrap>(user, '/api/web/bootstrap').then(setBootstrap).catch(() => undefined) }} /></Suspense>}
    {voiceMode && <Suspense fallback={null}><VoiceMode user={user} threadId={active} close={closeVoiceMode} onTurnDone={voiceTurnDone}
      tuning={bootstrap.voice_tuning} internalDiagnostics={Boolean(bootstrap.wallet.billing_exempt || bootstrap.wallets?.chat.billing_exempt)}
      addCredits={bucket => { closeVoiceMode(); openBilling(bucket) }} /></Suspense>}
    {settings && <Suspense fallback={null}><SettingsModal user={user} theme={theme} setTheme={setTheme} assistant={bootstrap.assistant} tierSaving={tierSaving || streaming} saveTier={saveTier} close={closeSettings} addCredits={() => { setSettings(false); setBilling(true) }} openArchived={() => { setSettings(false); setArchived(true); setRepository(null); setActive(null); if (window.matchMedia('(max-width: 900px)').matches) setDrawer(true) }} savedProfile={(profile: ProfileSettings) => setBootstrap(value => value ? { ...value, user: { ...value.user, name: profile.name, reply_language: profile.reply_language } } : value)} subscriptions={bootstrap.subscriptions} knowledgeLibraryEnabled={Boolean(bootstrap.features.web_knowledge_library)} knowledgeUploads={attachments.filter((item): item is ReadyAttachment => item.status === 'ready')} /></Suspense>}
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
