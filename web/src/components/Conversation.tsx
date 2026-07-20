import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, FileText, Pause, Pencil, Play, RefreshCw, RotateCcw, Volume2, X } from 'lucide-react'
import type { Message, MessageAttachment, VoiceReplyState } from '../types'
import { MarkdownMessage } from './MarkdownMessage'

export function Conversation({ messages, phase, retry, suggest, continueResponse = () => undefined, editMessage = () => undefined, editingAvailable = true, editingDisabled = false, voiceStates = {}, playVoice = () => undefined, pauseVoice = () => undefined, retryVoice = () => undefined, addCredits = () => undefined }: {
  messages: Message[]; phase?: string; retry: (message: Message) => void; suggest: (text: string) => void;
  continueResponse?: (message: Message) => void;
  editMessage?: (message: Message, content: string) => void; editingAvailable?: boolean; editingDisabled?: boolean;
  voiceStates?: Record<string, VoiceReplyState>; playVoice?: (messageId: string) => void;
  pauseVoice?: (messageId: string) => void; retryVoice?: (messageId: string, voiceTurnId: string) => void;
  addCredits?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const [showBottom, setShowBottom] = useState(false)
  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
    setShowBottom(!nearBottom.current)
  }
  useEffect(() => {
    if (!nearBottom.current) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])
  const scrollBottom = () => {
    nearBottom.current = true; setShowBottom(false)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }
  return <div className="conversation-frame">
    <div className="conversation" ref={scrollRef} onScroll={onScroll} aria-live="polite" data-testid="conversation">
      {!messages.length && <EmptyState suggest={suggest} />}
      {messages.map(message => <MessageView key={message.id} message={message} retry={retry} continueResponse={continueResponse}
        canEdit={editingAvailable && message.role === 'user' && message.id === [...messages].reverse().find(item => item.role === 'user')?.id}
        editMessage={editMessage} editingDisabled={editingDisabled}
        voiceState={voiceStates[message.id]} playVoice={playVoice} pauseVoice={pauseVoice}
        retryVoice={retryVoice} addCredits={addCredits} />)}
      {phase && ['connecting', 'routing', 'reserved'].includes(phase) && <div className="thinking" role="status"><span />Swico is thinking</div>}
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

function MessageView({ message, retry, continueResponse, canEdit, editMessage, editingDisabled, voiceState, playVoice, pauseVoice, retryVoice, addCredits }: {
  message: Message; retry: (message: Message) => void; voiceState?: VoiceReplyState;
  continueResponse: (message: Message) => void;
  canEdit: boolean; editMessage: (message: Message, content: string) => void; editingDisabled: boolean;
  playVoice: (messageId: string) => void; pauseVoice: (messageId: string) => void;
  retryVoice: (messageId: string, voiceTurnId: string) => void; addCredits: () => void;
}) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(message.content)
  if (message.role === 'user') return <article className="message user">
    {!!message.attachments?.length && <div className="message-attachments">{message.attachments.map(attachment => <AttachmentCard attachment={attachment} key={attachment.id} />)}</div>}
    {editing ? <div className="message-editor">
      <label htmlFor={`edit-${message.id}`}>Edit message</label>
      <textarea id={`edit-${message.id}`} autoFocus value={editValue} maxLength={64000} onChange={event => setEditValue(event.target.value)} />
      <small>Regenerating creates a new revision and may use additional credits.</small>
      <div><button type="button" onClick={() => { setEditing(false); setEditValue(message.content) }}><X size={14} /> Cancel</button>
        <button type="button" disabled={!editValue.trim() || editValue.trim() === message.content.trim()} onClick={() => { editMessage(message, editValue.trim()); setEditing(false) }}><Check size={14} /> Save and regenerate</button></div>
    </div> : <>{message.content && <div className="user-bubble">{message.content}</div>}
      {canEdit && message.status === 'complete' && <button className="edit-message" type="button" aria-label="Edit message" title="Edit and regenerate" disabled={editingDisabled} onClick={() => { setEditValue(message.content); setEditing(true) }}><Pencil size={14} /> Edit</button>}</>}
    {message.status === 'retryable' && <button className="retry" onClick={() => retry(message)}><RefreshCw size={14} /> Retry</button>}
  </article>
  return <article className={`message assistant ${message.status === 'streaming' ? 'streaming' : ''}`}><div className="message-body">
    {message.content ? <MarkdownMessage>{message.content}</MarkdownMessage> : message.status === 'streaming' ? null : <p>Generation stopped.</p>}
    {message.status === 'streaming' && message.content && <span className="cursor" />}
    {message.status !== 'streaming' && <div className="answer-actions">
      <button aria-label="Copy answer" title="Copy answer" onClick={() => void navigator.clipboard.writeText(message.content).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) })}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      {voiceState?.status === 'generating' && <span className="voice-reply-status" role="status"><Volume2 size={16} aria-hidden="true" /> Generating voice reply…</span>}
      {voiceState && ['ready', 'paused'].includes(voiceState.status) && <button aria-label="Play voice reply" title="Play voice reply" onClick={() => playVoice(message.id)}><Play size={16} /></button>}
      {voiceState?.status === 'playing' && <button aria-label="Pause voice reply" title="Pause voice reply" onClick={() => pauseVoice(message.id)}><Pause size={16} /></button>}
      {voiceState?.status === 'ended' && <button aria-label="Replay voice reply" title="Replay voice reply" onClick={() => playVoice(message.id)}><RotateCcw size={16} /></button>}
      {voiceState?.status === 'error' && <span className="voice-reply-error" role="status">{voiceState.error}{voiceState.canRetry !== false && <button aria-label="Retry voice reply" onClick={() => message.voice_turn_id && retryVoice(message.id, message.voice_turn_id)}><RefreshCw size={15} /> Retry</button>}{voiceState.insufficientCredits && <button onClick={addCredits}>Add credits</button>}</span>}
      {message.status === 'retryable' && <button aria-label="Retry answer" title="Retry answer" onClick={() => retry(message)}><RefreshCw size={16} /></button>}
      {message.status === 'complete' && message.truncated && message.can_continue && <button className="continue-response" aria-label="Continue response" onClick={() => continueResponse(message)}><RefreshCw size={16} /> Continue response</button>}
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
