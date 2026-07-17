import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, RefreshCw } from 'lucide-react'
import type { Message } from '../types'
import { MarkdownMessage } from './MarkdownMessage'

export function Conversation({ messages, phase, retry, suggest }: {
  messages: Message[]; phase?: string; retry: (message: Message) => void; suggest: (text: string) => void;
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
      {messages.map(message => <MessageView key={message.id} message={message} retry={retry} />)}
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

function MessageView({ message, retry }: { message: Message; retry: (message: Message) => void }) {
  const [copied, setCopied] = useState(false)
  if (message.role === 'user') return <article className="message user"><div className="user-bubble">{message.content}</div>{message.status === 'retryable' && <button className="retry" onClick={() => retry(message)}><RefreshCw size={14} /> Retry</button>}</article>
  return <article className={`message assistant ${message.status === 'streaming' ? 'streaming' : ''}`}><div className="message-body">
    {message.content ? <MarkdownMessage>{message.content}</MarkdownMessage> : message.status === 'streaming' ? null : <p>Generation stopped.</p>}
    {message.status === 'streaming' && message.content && <span className="cursor" />}
    {message.status !== 'streaming' && <div className="answer-actions">
      <button aria-label="Copy answer" title="Copy answer" onClick={() => void navigator.clipboard.writeText(message.content).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) })}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      {message.status === 'retryable' && <button aria-label="Retry answer" title="Retry answer" onClick={() => retry(message)}><RefreshCw size={16} /></button>}
      {(message.usage_source || message.input_tokens || message.output_tokens) && <details className="message-details"><summary>Details</summary><div>
        <span>{message.tier_label || 'Swico'}</span>
        <span>Input {message.input_tokens.toLocaleString()} · Output {message.output_tokens.toLocaleString()} · Total {(message.input_tokens + message.output_tokens).toLocaleString()} tokens</span>
        <span>{message.usage_source === 'actual' ? 'Measured usage' : 'Estimated usage'}</span>
      </div></details>}
    </div>}
  </div></article>
}
