import { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, Download, Pencil, RotateCcw, X } from 'lucide-react'
import { downloadMarkdown } from '../responseExport'
import { MarkdownMessage } from './MarkdownMessage'

export type ResponseEditorMode = 'preview' | 'source'

export function ResponseEditor({
  content,
  original,
  initialMode,
  hasLocalEdit,
  onApply,
  onReset,
  onClose,
}: {
  content: string
  original: string
  initialMode: ResponseEditorMode
  hasLocalEdit: boolean
  onApply: (content: string) => void
  onReset: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const [mode, setMode] = useState<ResponseEditorMode>(initialMode)
  const [draft, setDraft] = useState(content)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    if (mode === 'preview') closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [mode, onClose])

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(draft)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1200)
    } catch {
      setCopyState('failed')
    }
  }

  return <div className="response-editor-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="response-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header>
        <div>
          <h2 id={titleId}>Response editor</h2>
          <p>Edits stay on this device until you leave this conversation.</p>
        </div>
        <button ref={closeRef} type="button" aria-label="Close response editor" title="Close" onClick={onClose}><X size={18} /></button>
      </header>
      <nav aria-label="Editor view">
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button>
        <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>Markdown source</button>
      </nav>
      <main>
        {mode === 'source'
          ? <textarea aria-label="Response Markdown source" autoFocus value={draft} onChange={event => setDraft(event.target.value)} />
          : <div className="response-editor-preview"><MarkdownMessage>{draft}</MarkdownMessage></div>}
      </main>
      <footer>
        <div className="response-editor-secondary">
          <button type="button" onClick={() => setMode('source')}><Pencil size={15} /> Edit</button>
          <button type="button" onClick={() => void copy()}><Copy size={15} /> {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}</button>
          <button type="button" onClick={() => downloadMarkdown(draft)}><Download size={15} /> Download</button>
          {hasLocalEdit && <button type="button" onClick={() => {
            setDraft(original)
            onReset()
          }}><RotateCcw size={15} /> Reset to original</button>}
        </div>
        <div className="response-editor-primary">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" disabled={!draft.trim() || draft === content} onClick={() => {
            onApply(draft)
            setMode('preview')
          }}><Check size={15} /> Apply changes</button>
        </div>
      </footer>
    </section>
  </div>
}
