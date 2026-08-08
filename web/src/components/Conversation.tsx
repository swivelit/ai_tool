import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FileText, Pause, Play, RefreshCw, RotateCcw, ThumbsDown, ThumbsUp, Volume2, X } from 'lucide-react'
import type { Message, MessageAttachment, VoiceReplyState } from '../types'
import { messageRenderKey } from '../messageRenderKey'
import { MarkdownMessage } from './MarkdownMessage'
import { ResponseToolbar } from './ResponseToolbar'
import { PromptToolbar } from './PromptToolbar'
import { continuationMarkdown, stitchContinuationMarkdown } from '../continuationMarkdown'
import { SourceCitations } from './SourceCitations'
import { ResponseQualityPanel } from './ResponseQualityPanel'

const BOTTOM_THRESHOLD_PX = 120

export function Conversation({ messages, phase, queuePosition = null, estimatedWaitSeconds = null, retry, suggest, continueResponse = () => undefined, continuingMessageId = null, regenerateResponse = () => undefined, editMessage = () => undefined, editingAvailable = true, editingDisabled = false, voiceReplyEnabled = true, voiceStates = {}, generateVoice = () => undefined, playVoice = () => undefined, pauseVoice = () => undefined, retryVoice = () => undefined, addCredits = () => undefined, feedbackEnabled = false, submitFeedback = async () => undefined, highlightMessageId = null }: {
  messages: Message[]; phase?: string; queuePosition?: number | null; estimatedWaitSeconds?: number | null; retry: (message: Message) => void; suggest: (text: string) => void;
  continueResponse?: (message: Message) => void;
  continuingMessageId?: string | null;
  regenerateResponse?: (message: Message) => void;
  editMessage?: (message: Message, content: string) => void; editingAvailable?: boolean; editingDisabled?: boolean;
  voiceReplyEnabled?: boolean; voiceStates?: Record<string, VoiceReplyState>; playVoice?: (messageId: string) => void;
  generateVoice?: (messageId: string, voiceTurnId: string) => void;
  pauseVoice?: (messageId: string) => void; retryVoice?: (messageId: string, voiceTurnId: string) => void;
  addCredits?: () => void;
  feedbackEnabled?: boolean; submitFeedback?: (message: Message, rating: 'up' | 'down') => Promise<void>;
  highlightMessageId?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const lastAlignedScrollTop = useRef(0)
  const frameRef = useRef<number | null>(null)
  const previousMessagesRef = useRef<Message[]>([])
  const [showBottom, setShowBottom] = useState(false)

  const setBottomButtonVisible = useCallback((visible: boolean) => {
    setShowBottom(current => current === visible ? current : visible)
  }, [])
  const alignToBottom = useCallback(() => {
    const element = scrollRef.current
    if (element) {
      element.scrollTop = element.scrollHeight
      lastAlignedScrollTop.current = element.scrollTop
    }
  }, [])
  const scheduleBottomAlignment = useCallback(() => {
    if (!pinnedToBottom.current || frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      if (pinnedToBottom.current) alignToBottom()
    })
  }, [alignToBottom])
  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const nextPinned = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
    // A scroll event from the previous immediate alignment can arrive after a
    // rapid content-height change. Keep following unless the position actually
    // moved upward from the last aligned point.
    if (!nextPinned && pinnedToBottom.current && element.scrollTop >= lastAlignedScrollTop.current - 1) {
      scheduleBottomAlignment()
      return
    }
    if (nextPinned === pinnedToBottom.current) return
    pinnedToBottom.current = nextPinned
    setBottomButtonVisible(!nextPinned)
  }, [scheduleBottomAlignment, setBottomButtonVisible])

  useEffect(() => {
    const previous = previousMessagesRef.current
    const latest = messages.at(-1)
    const latestKey = latest ? messageRenderKey(latest) : null
    const previousLatest = previous.at(-1)
    const isNewTail = Boolean(latest && (!previousLatest || messageRenderKey(previousLatest) !== latestKey))
    const isNewUserMessage = isNewTail && latest?.role === 'user'
    const isNewAssistantStream = latest?.role === 'assistant' && latest.status === 'streaming'
      && !previous.some(message => messageRenderKey(message) === latestKey)
    previousMessagesRef.current = messages

    if (isNewUserMessage || isNewAssistantStream) {
      pinnedToBottom.current = true
      setBottomButtonVisible(false)
      alignToBottom()
    }
    scheduleBottomAlignment()
  }, [alignToBottom, messages, scheduleBottomAlignment, setBottomButtonVisible])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => scheduleBottomAlignment())
    observer.observe(content)
    return () => observer.disconnect()
  }, [scheduleBottomAlignment])

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!highlightMessageId) return
    const element = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
    ).find(item => item.dataset.messageId === highlightMessageId)
    if (element) {
      pinnedToBottom.current = false
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [highlightMessageId, messages])

  const scrollBottom = useCallback(() => {
    pinnedToBottom.current = true
    setBottomButtonVisible(false)
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    alignToBottom()
  }, [alignToBottom, setBottomButtonVisible])
  const visibleMessages = messages.filter(
    message => !message.is_continuation_control
  )
  const continuationChildren = new Set(
    visibleMessages.filter(message => message.continuation_root_message_id)
      .map(message => message.id),
  )
  const logicalMessages = visibleMessages.flatMap(message => {
    if (continuationChildren.has(message.id)) return []
    if (message.role !== 'assistant') return [message]
    const continuations = visibleMessages.filter(candidate => (
      candidate.role === 'assistant'
      && candidate.continuation_root_message_id === message.id
    )).sort((left, right) => (
      Number(left.continuation_segment_index ?? 0)
      - Number(right.continuation_segment_index ?? 0)
    ))
    if (!continuations.length) return [message]
    const segments = [message, ...continuations]
    const last = segments.at(-1)!
    return [{
      ...last,
      content:stitchContinuationMarkdown(segments),
      continuation_render_prefix:'',
      sources:last.sources?.length ? last.sources : message.sources,
      quality:last.quality ?? message.quality,
    }]
  })
  const latestVisibleUserId = [...visibleMessages].reverse().find(
    message => message.role === 'user'
  )?.id

  return <div className="conversation-frame">
    <div className="conversation" ref={scrollRef} onScroll={onScroll} aria-live="polite" data-testid="conversation">
      <div className="conversation-content" ref={contentRef}>
        {!logicalMessages.length && <EmptyState suggest={suggest} />}
        {logicalMessages.map(message => <MessageView key={messageRenderKey(message)} message={message} retry={retry} continueResponse={continueResponse} regenerateResponse={regenerateResponse}
          continuationActive={message.id === continuingMessageId}
          canEdit={editingAvailable && message.role === 'user' && message.id === latestVisibleUserId}
          regenerationAvailable={editingAvailable}
          editMessage={editMessage} editingDisabled={editingDisabled}
          voiceReplyEnabled={voiceReplyEnabled} voiceState={voiceStates[message.id]} generateVoice={generateVoice} playVoice={playVoice} pauseVoice={pauseVoice}
          retryVoice={retryVoice} addCredits={addCredits} feedbackEnabled={feedbackEnabled}
          submitFeedback={submitFeedback} highlighted={message.id === highlightMessageId} />)}
        {phase === 'queued' && <div className="thinking" role="status"><span />Waiting for Swico Free{queuePosition ? ` · Position ${queuePosition}` : ''}{estimatedWaitSeconds !== null ? ` · Estimated wait ~${estimatedWaitSeconds} seconds` : ''}</div>}
        {phase === 'starting' && <div className="thinking" role="status"><span />Starting…</div>}
        {phase && [
          'connecting', 'routing', 'reserved', 'understanding_request',
          'searching_context', 'searching_documents', 'searching_repository',
          'evaluating_evidence', 'running_code_checks',
          'preparing_answer', 'generating', 'verifying_sources', 'repairing',
          'responding',
        ].includes(phase) && <div className="thinking" role="status"><span />{
          phase === 'verifying_sources' ? 'Swico is checking the answer'
            : phase === 'searching_repository' ? 'Swico is reading the repository'
              : phase === 'running_code_checks' ? 'Swico is running safe code checks'
            : phase === 'repairing' ? 'Swico is improving the answer'
              : 'Swico is thinking'
        }</div>}
      </div>
    </div>
    {showBottom && <button className="scroll-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" onClick={scrollBottom}><ChevronDown size={19} /></button>}
  </div>
}

function EmptyState({ suggest }: { suggest: (text: string) => void }) {
  const suggestions = ['Help me plan a focused week', 'Explain a complex idea simply', 'Draft a thoughtful message']
  return <div className="empty-state"><div className="swico-mark" aria-hidden="true">S</div><h1>How can I help?</h1>
    <div className="prompts">{suggestions.map(item => <button key={item} onClick={() => suggest(item)}>{item}</button>)}</div>
  </div>
}

function MessageView({ message, retry, continueResponse, continuationActive, regenerateResponse, canEdit, regenerationAvailable, editMessage, editingDisabled, voiceReplyEnabled, voiceState, generateVoice, playVoice, pauseVoice, retryVoice, addCredits, feedbackEnabled, submitFeedback, highlighted }: {
  message: Message; retry: (message: Message) => void; voiceState?: VoiceReplyState;
  continueResponse: (message: Message) => void;
  continuationActive: boolean;
  regenerateResponse: (message: Message) => void;
  canEdit: boolean; regenerationAvailable: boolean; editMessage: (message: Message, content: string) => void; editingDisabled: boolean; voiceReplyEnabled: boolean;
  generateVoice: (messageId: string, voiceTurnId: string) => void;
  playVoice: (messageId: string) => void; pauseVoice: (messageId: string) => void;
  retryVoice: (messageId: string, voiceTurnId: string) => void; addCredits: () => void;
  feedbackEnabled: boolean; submitFeedback: (message: Message, rating: 'up' | 'down') => Promise<void>;
  highlighted: boolean;
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(message.content)
  const [feedback, setFeedback] = useState(message.feedback_rating ?? null)
  const [workingCopy, setWorkingCopy] = useState<string | null>(null)
  const retryAtMilliseconds = message.retry_at
    ? Date.parse(message.retry_at)
    : Number.NaN
  const [retryBlocked, setRetryBlocked] = useState(
    Number.isFinite(retryAtMilliseconds)
      && retryAtMilliseconds > Date.now()
  )
  useEffect(() => { setFeedback(message.feedback_rating ?? null) }, [message.feedback_rating])
  useEffect(() => { setWorkingCopy(null) }, [message.content])
  useEffect(() => {
    if (!Number.isFinite(retryAtMilliseconds)) {
      setRetryBlocked(false)
      return
    }
    const remaining = retryAtMilliseconds - Date.now()
    setRetryBlocked(remaining > 0)
    if (remaining <= 0) return
    const timer = window.setTimeout(
      () => setRetryBlocked(false),
      Math.min(remaining, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [retryAtMilliseconds])
  const rate = (rating: 'up' | 'down') => {
    const previous = feedback
    setFeedback(rating)
    void submitFeedback(message, rating).catch(() => setFeedback(previous))
  }
  if (message.role === 'user') return <article className={`message user ${highlighted ? 'search-highlight' : ''}`} data-message-id={message.id}>
    {!!message.attachments?.length && <div className="message-attachments">{message.attachments.map(attachment => <AttachmentCard attachment={attachment} key={attachment.id} />)}</div>}
    {editing ? <div className="message-editor">
      <label htmlFor={`edit-${message.id}`}>Edit message</label>
      <textarea id={`edit-${message.id}`} autoFocus value={editValue} maxLength={64000} onChange={event => setEditValue(event.target.value)} />
      <small>Regenerating creates a new revision and may use additional credits.</small>
      <div><button type="button" onClick={() => { setEditing(false); setEditValue(message.content) }}><X size={14} /> Cancel</button>
        <button type="button" disabled={!editValue.trim() || editValue.trim() === message.content.trim()} onClick={() => { editMessage(message, editValue.trim()); setEditing(false) }}><Check size={14} /> Save and regenerate</button></div>
    </div> : <>{message.content && <div className="user-bubble">{message.content}</div>}
      <PromptToolbar
        content={message.content}
        canEdit={canEdit && message.status === 'complete'}
        editDisabled={editingDisabled}
        onEdit={() => { setEditValue(message.content); setEditing(true) }}
      /></>}
    {message.status === 'retryable' && <button className="retry" disabled={retryBlocked} title={retryBlocked ? `Retry available after ${new Date(retryAtMilliseconds).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' })}` : 'Retry'} onClick={() => retry(message)}><RefreshCw size={14} /> Retry</button>}
  </article>
  const originalDisplayContent = continuationMarkdown(
    message.content, message.continuation_render_prefix,
  )
  const displayedContent = workingCopy ?? originalDisplayContent
  return <article className={`message assistant ${message.status === 'streaming' ? 'streaming' : ''} ${highlighted ? 'search-highlight' : ''}`}
    data-message-id={message.id} data-request-id={message.request_id ?? undefined}><div className="message-body">
    {message.status === 'complete' && displayedContent && <ResponseToolbar
      content={displayedContent}
      original={originalDisplayContent}
      hasLocalEdit={workingCopy !== null}
      onApply={setWorkingCopy}
      onReset={() => setWorkingCopy(null)}
    />}
    {displayedContent ? <MarkdownMessage streaming={message.status === 'streaming'}>{displayedContent}</MarkdownMessage> : message.status === 'streaming' ? null : <p>Generation stopped.</p>}
    {message.status === 'streaming' && message.content && <span className="cursor" />}
    {!!message.sources?.length && <SourceCitations sources={message.sources} />}
    {message.quality && <ResponseQualityPanel quality={message.quality} />}
    {!!message.provenance?.length && <div className="provenance-chips">{message.provenance.map(value => <span key={value}>{{ memory: 'Used memory', document: 'Used document', repository: 'Repository context used', cached_answer: 'Cached answer', semantic_cache: 'Semantic cache', backend_tool: 'Backend tool', web_search: 'Web search' }[value]}</span>)}</div>}
    {message.status !== 'streaming' && <div className="answer-actions">
      {feedbackEnabled && message.status === 'complete' && <><button className={feedback === 'up' ? 'selected' : ''} aria-label="Good answer" title="Good answer" aria-pressed={feedback === 'up'} onClick={() => rate('up')}><ThumbsUp size={15} /></button>
        <button className={feedback === 'down' ? 'selected' : ''} aria-label="Bad answer" title="Bad answer" aria-pressed={feedback === 'down'} onClick={() => rate('down')}><ThumbsDown size={15} /></button></>}
      {voiceState?.status === 'generating' && <span className="voice-reply-status" role="status"><Volume2 size={16} aria-hidden="true" /> Generating voice reply…</span>}
      {voiceReplyEnabled && !voiceState && message.status === 'complete' && message.voice_turn_id && <button aria-label="Play voice reply" title="Play voice reply" onClick={() => generateVoice(message.id, message.voice_turn_id!)}><Play size={16} /></button>}
      {voiceState && ['ready', 'paused'].includes(voiceState.status) && <button aria-label="Play voice reply" title="Play voice reply" onClick={() => playVoice(message.id)}><Play size={16} /></button>}
      {voiceState?.status === 'playing' && <button aria-label="Pause voice reply" title="Pause voice reply" onClick={() => pauseVoice(message.id)}><Pause size={16} /></button>}
      {voiceState?.status === 'ended' && <button aria-label="Replay voice reply" title="Replay voice reply" onClick={() => playVoice(message.id)}><RotateCcw size={16} /></button>}
      {voiceState?.status === 'error' && <span className="voice-reply-error" role="status">{voiceState.error}{voiceState.canRetry !== false && <button aria-label="Retry voice reply" onClick={() => message.voice_turn_id && retryVoice(message.id, message.voice_turn_id)}><RefreshCw size={15} /> Retry</button>}{voiceState.insufficientCredits && <button onClick={addCredits}>Top up</button>}</span>}
      {message.status === 'retryable' && <button aria-label="Retry answer" title={retryBlocked ? `Retry available after ${new Date(retryAtMilliseconds).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' })}` : 'Retry answer'} disabled={retryBlocked} onClick={() => retry(message)}><RefreshCw size={16} /></button>}
      {regenerationAvailable && message.status === 'complete' && <button className="regenerate-answer" aria-label="Regenerate answer" title="Regenerate answer" disabled={editingDisabled} onClick={() => regenerateResponse(message)}><RotateCcw size={16} /> Regenerate</button>}
      {message.status === 'complete' && message.truncated && message.can_continue && <button className="continue-response" aria-label="Continue response" disabled={continuationActive} onClick={() => continueResponse(message)}><RefreshCw size={16} /> {continuationActive ? 'Continuing…' : 'Continue response'}</button>}
      {(message.usage_source || message.input_tokens || message.output_tokens) && <details className="message-details"><summary>Details</summary><div>
        <span>{message.tier_label || 'Swico'}</span>
        <span>Input {message.input_tokens.toLocaleString()} · Output {message.output_tokens.toLocaleString()} · Total {(message.input_tokens + message.output_tokens).toLocaleString()} tokens</span>
        <span>{message.usage_source === 'actual' ? 'Measured usage' : 'Estimated usage'}</span>
      </div></details>}
    </div>}
  </div></article>
}

function AttachmentCard({ attachment }: { attachment: MessageAttachment }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (attachment.status !== 'ready') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [attachment.status])
  const expired = attachment.status !== 'ready' || new Date(attachment.expires_at).getTime() <= now
  const size = attachment.size_bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(attachment.size_bytes / 1024))} KiB`
    : `${(attachment.size_bytes / (1024 * 1024)).toFixed(1)} MiB`
  return <div className={`message-attachment-card ${expired ? 'expired' : 'ready'}`}>
    <FileText size={18} aria-hidden="true" />
    <span><strong>{attachment.name}</strong><small>{attachment.media_type} · {size}</small></span>
    {expired ? <span className="attachment-badge">Expired</span> : <span className="attachment-badge">Active</span>}
    {!!attachment.warnings.length && <span className="attachment-warning" role="status">{attachment.warnings.join(' ')}</span>}
  </div>
}
