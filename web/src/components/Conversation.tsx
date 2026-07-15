import { useState } from 'react'
import type { Message } from '../types'
import { MarkdownMessage } from './MarkdownMessage'

export function Conversation({ messages, pendingText, retry }: { messages: Message[]; pendingText: string; retry: (message: Message) => void }) {
  return <div className="conversation" aria-live="polite">
    {!messages.length && !pendingText && <EmptyState />}
    {messages.map(message => <MessageView key={message.id} message={message} retry={retry} />)}
    {pendingText && <article className="message assistant"><div className="assistant-glyph">S</div><div className="message-body"><MarkdownMessage>{pendingText}</MarkdownMessage><span className="cursor" /></div></article>}
  </div>
}

function EmptyState() {
  return <div className="empty-state"><div className="orb">S</div><p className="eyebrow">Your thinking space</p><h1>What are we working through?</h1><p>Explore a question, shape an idea, or turn a messy problem into a clear next step.</p><div className="prompts"><span>Plan a focused week</span><span>Explain something complex</span><span>Draft with the right tone</span></div></div>
}

function MessageView({ message, retry }: { message: Message; retry: (message: Message) => void }) {
  const [copied, setCopied] = useState(false)
  if (message.role === 'user') return <article className="message user"><div className="user-bubble">{message.content}</div>{message.status === 'retryable' && <button className="retry" onClick={() => retry(message)}>Retry</button>}</article>
  return <article className="message assistant"><div className="assistant-glyph">S</div><div className="message-body">
    <MarkdownMessage>{message.content}</MarkdownMessage>
    <div className="message-meta"><span>{[message.provider, message.model].filter(Boolean).join(' · ') || 'Swico'}</span>
      {message.charge_micros > 0 && <span>{message.usage_source} · ₹{(message.charge_micros / 1_000_000).toFixed(4)}</span>}
      <button aria-label="Copy answer" onClick={() => void navigator.clipboard.writeText(message.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  </div></article>
}
