import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUp, Square } from 'lucide-react'

export function Composer({ value, setValue, send, stop, streaming, disabled, focusKey = '' }: {
  value: string; setValue: (value: string) => void; send: () => void; stop: () => void;
  streaming: boolean; disabled?: boolean; focusKey?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const resize = () => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }
  useEffect(resize, [value])
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [focusKey])
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) {
      event.preventDefault(); send()
    }
  }
  return <div className="composer-wrap">
    <div className="composer" data-testid="composer">
      <textarea ref={ref} aria-label="Message Swico" value={value} disabled={disabled}
        onChange={event => setValue(event.target.value)} onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        placeholder={disabled ? 'Reconnect to send a message' : 'Message Swico'} rows={1} maxLength={16000} />
      {streaming
        ? <button className="send stop" type="button" aria-label="Stop generation" title="Stop generation" onClick={stop}><Square size={15} fill="currentColor" /></button>
        : <button className="send" type="button" aria-label="Send message" title="Send message" disabled={disabled || !value.trim()} onClick={send}><ArrowUp size={20} /></button>}
    </div>
    <p>Swico can make mistakes. Check important information.</p>
  </div>
}
