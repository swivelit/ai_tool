import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { User } from 'firebase/auth'
import { ArrowUp, FileText, Mic, Paperclip, Square, X } from 'lucide-react'
import type { ComposerAttachment, Wallet } from '../types'
import { useAudioRecorder } from '../hooks/useAudioRecorder'

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000))
  if (!seconds) return 'Expired'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} remaining`
}

function elapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function Composer({
  user = null,
  value,
  setValue,
  send,
  stop,
  streaming,
  disabled,
  focusKey = '',
  attachments = [],
  attachmentsEnabled = false,
  voiceEnabled = false,
  voiceResetKey = '',
  onVoiceDraft = () => undefined,
  onVoiceCancel = () => undefined,
  onComposerClear = () => undefined,
  onVoiceWallet = () => undefined,
  supportedExtensions = [],
  addFiles = () => undefined,
  removeAttachment = () => undefined,
}: {
  user?: User | null;
  value: string; setValue: (value: string) => void; send: () => void; stop: () => void;
  streaming: boolean; disabled?: boolean; focusKey?: string;
  attachments?: ComposerAttachment[]; attachmentsEnabled?: boolean; voiceEnabled?: boolean;
  voiceResetKey?: string;
  onVoiceDraft?: (voiceTurnId: string) => void; onVoiceCancel?: () => void;
  onComposerClear?: () => void;
  onVoiceWallet?: (wallet: Wallet) => void;
  supportedExtensions?: string[]; addFiles?: (files: File[]) => void;
  removeAttachment?: (attachment: ComposerAttachment) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  const composing = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { valueRef.current = value }, [value])
  useEffect(() => {
    if (!attachments.some(item => item.status === 'ready')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [attachments])

  const insertTranscript = useCallback((transcript: string, voiceTurnId: string, wallet: Wallet) => {
    const current = valueRef.current
    const next = current.trim() ? `${current.trimEnd()} ${transcript.trim()}` : transcript.trim()
    valueRef.current = next
    setValue(next)
    onVoiceDraft(voiceTurnId)
    onVoiceWallet(wallet)
    window.setTimeout(() => ref.current?.focus(), 0)
  }, [onVoiceDraft, onVoiceWallet, setValue])
  const recorder = useAudioRecorder({
    user, enabled: voiceEnabled && !disabled, onTranscript: insertTranscript,
    onRecordingStarted: onVoiceDraft, onCancel: onVoiceCancel, resetKey: voiceResetKey,
  })
  const audioBusy = ['requesting', 'recording', 'stopping', 'transcribing'].includes(recorder.state.status)
  const uploadBusy = attachments.some(item => item.status === 'uploading')
  const readyAttachments = attachments.filter(item => item.status === 'ready')
  const canSend = !disabled && !streaming && !uploadBusy && !audioBusy && (!!value.trim() || readyAttachments.length > 0)

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
      event.preventDefault()
      if (canSend) send()
    }
  }
  const chooseFiles = (files: FileList | null) => {
    if (files?.length) addFiles(Array.from(files))
    if (fileRef.current) fileRef.current.value = ''
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false)
    if (attachmentsEnabled && !disabled && !streaming) chooseFiles(event.dataTransfer.files)
  }

  const statusText = recorder.state.error
    ?? (recorder.state.status === 'requesting' ? 'Requesting microphone access…'
      : recorder.state.status === 'recording' ? `Recording ${elapsed(recorder.state.elapsed_seconds)}`
        : recorder.state.status === 'transcribing' ? 'Transcribing recording…'
          : uploadBusy ? 'Uploading attachment…' : '')

  return <div className="composer-wrap">
    <div className={`composer-shell ${dragging ? 'dragging' : ''}`}
      onDragEnter={event => { event.preventDefault(); if (attachmentsEnabled) setDragging(true) }}
      onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={drop}>
      {attachments.length > 0 && <div className="attachment-tray" aria-label="Active attachments">
        {attachments.map(attachment => <div className={`attachment-chip ${attachment.status}`} key={'local_id' in attachment ? attachment.local_id : attachment.id}>
          <FileText size={18} aria-hidden="true" />
          <span className="attachment-copy"><strong title={attachment.name}>{attachment.name}</strong>
            <small>{attachment.media_type || attachment.name.split('.').pop()?.toUpperCase()} · {humanSize(attachment.size_bytes)}</small>
            <small>{attachment.status === 'uploading' ? `Uploading… ${attachment.progress}%`
              : attachment.status === 'error' ? attachment.error || 'Upload failed'
                : attachment.status === 'ready' ? remaining(attachment.expires_at, now)
                  : attachment.status === 'unavailable' ? 'Unavailable' : 'Expired'}</small>
          </span>
          <button type="button" aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X size={15} /></button>
        </div>)}
      </div>}
      {readyAttachments.length > 0 && <div className="attachment-context-note" role="status">These files stay active for this chat until removed or expired.</div>}
      {recorder.state.status === 'recording' || recorder.state.status === 'stopping' ? <div className="recording-row" role="status">
        <span className="recording-dot" aria-hidden="true" /><strong>Recording {elapsed(recorder.state.elapsed_seconds)}</strong>
        <button type="button" onClick={recorder.stop} aria-label="Stop recording"><Square size={14} fill="currentColor" /> Stop</button>
        <button type="button" onClick={recorder.cancel} aria-label="Cancel recording"><X size={15} /> Cancel</button>
      </div> : null}
      {recorder.state.status === 'transcribing' && <div className="recording-row" role="status"><span className="spinner" />Transcribing…</div>}
      {recorder.state.error && <div className="composer-error" role="alert"><span>{recorder.state.error}</span><button type="button" onClick={recorder.resetError}>Dismiss</button></div>}
      <div className="composer" data-testid="composer">
        <div className="composer-tools">
          {attachmentsEnabled && <><input ref={fileRef} className="hidden-file-input" type="file" multiple accept={supportedExtensions.join(',')}
            onChange={event => chooseFiles(event.target.files)} />
            <button className="composer-tool" type="button" aria-label="Attach documents" title="Attach documents" disabled={disabled || streaming || audioBusy} onClick={() => fileRef.current?.click()}><Paperclip size={19} /></button></>}
          {voiceEnabled && recorder.state.status !== 'recording' && recorder.state.status !== 'stopping' && <button className="composer-tool" type="button" aria-label="Start voice dictation" title="Start voice dictation" disabled={disabled || streaming || uploadBusy || recorder.state.status === 'transcribing'} onClick={() => void recorder.start()}><Mic size={19} /></button>}
        </div>
        <textarea ref={ref} aria-label="Message Swico" value={value} disabled={disabled}
          onChange={event => { setValue(event.target.value); if (!event.target.value) onComposerClear() }} onKeyDown={keyDown}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          placeholder={disabled ? 'Reconnect to send a message' : 'Message Swico'} rows={1} maxLength={16000} />
        {streaming
          ? <button className="send stop" type="button" aria-label="Stop generation" title="Stop generation" onClick={stop}><Square size={15} fill="currentColor" /></button>
          : <button className="send" type="button" aria-label="Send message" title="Send message" disabled={!canSend} onClick={send}><ArrowUp size={20} /></button>}
      </div>
      {dragging && <div className="drop-overlay" aria-hidden="true"><Paperclip size={20} /> Drop documents to attach</div>}
    </div>
    <span className="sr-status" aria-live="polite">{statusText}</span>
    <p>Swico can make mistakes. Check important information.</p>
  </div>
}
