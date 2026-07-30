import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Maximize2, Pencil } from 'lucide-react'
import { downloadMarkdown } from '../responseExport'
import { ResponseEditor } from './ResponseEditor'
import type { ResponseEditorMode } from './ResponseEditor'

export function ResponseToolbar({
  content,
  original,
  hasLocalEdit,
  onApply,
  onReset,
}: {
  content: string
  original: string
  hasLocalEdit: boolean
  onApply: (content: string) => void
  onReset: () => void
}) {
  const [editorMode, setEditorMode] = useState<ResponseEditorMode | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const openEditor = (
    mode: ResponseEditorMode,
    opener: HTMLButtonElement,
  ) => {
    openerRef.current = opener
    setEditorMode(mode)
  }
  const closeEditor = () => {
    setEditorMode(null)
    const opener = openerRef.current
    queueMicrotask(() => opener?.focus())
  }
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(content)
      setCopyState('copied')
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current)
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopyState('idle')
        copiedTimerRef.current = null
      }, 1200)
    } catch {
      setCopyState('failed')
    }
  }

  return <>
    <div className="response-toolbar" role="toolbar" aria-label="Response tools">
      <button className="response-toolbar-edit" type="button" aria-label="Edit response" title="Edit response" onClick={event => openEditor('source', event.currentTarget)}><Pencil size={14} /> Edit</button>
      <div>
        {copyState !== 'idle' && <span className="response-copy-status" role="status">{copyState === 'copied' ? 'Copied' : 'Copy failed'}</span>}
        <button type="button" aria-label={copyState === 'copied' ? 'Response copied' : copyState === 'failed' ? 'Copy failed' : 'Copy response'} title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'} onClick={() => void copy()}>{copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}</button>
        <button type="button" aria-label="Download response" title="Download response" onClick={() => downloadMarkdown(content)}><Download size={16} /></button>
        <button type="button" aria-label="Open response editor" title="Open editor" onClick={event => openEditor('preview', event.currentTarget)}><Maximize2 size={16} /></button>
      </div>
    </div>
    {editorMode && <ResponseEditor
      content={content}
      original={original}
      initialMode={editorMode}
      hasLocalEdit={hasLocalEdit}
      onApply={onApply}
      onReset={onReset}
      onClose={closeEditor}
    />}
  </>
}
