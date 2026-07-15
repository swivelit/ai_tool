import { useRef, type KeyboardEvent } from 'react'

export function Composer({ value, setValue, send, stop, streaming, disabled }: {
  value: string; setValue: (value: string) => void; send: () => void; stop: () => void;
  streaming: boolean; disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); send()
    }
  }
  return <div className="composer-wrap">
    <div className="composer">
      <textarea ref={ref} aria-label="Message Swico" value={value} disabled={disabled}
        onChange={event => setValue(event.target.value)} onKeyDown={keyDown}
        placeholder="Ask, explore, or work through an idea…" rows={1} maxLength={16000} />
      {streaming
        ? <button className="send stop" aria-label="Stop generation" onClick={stop}>■</button>
        : <button className="send" aria-label="Send message" disabled={disabled || !value.trim()} onClick={send}>↑</button>}
    </div>
    <p>Swico can make mistakes. Check important information.</p>
  </div>
}
