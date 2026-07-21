import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { User } from 'firebase/auth'
import { ArrowUp, AudioLines, FileText, Mic, Plus, Square, Upload, X } from 'lucide-react'
import type { AssistantSettings, ComposerAttachment, LongInputMode, SwicoTier, Wallet } from '../types'
import { useAudioRecorder } from '../hooks/useAudioRecorder'
import { SwicoTierSelector } from './SwicoTierSelector'

const DEFAULT_ASSISTANT: AssistantSettings = {
  tier: 'lite', tier_label: 'Swico Lite', tier_description: '', tier_selection_enabled: false,
  tiers: [{ id: 'lite', label: 'Swico Lite', description: '', available: true, selected: true }],
}

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
  realtimeVoiceEnabled = false,
  realtimeVoiceUnavailableReason = 'Voice Mode is not enabled for this account.',
  assistant = DEFAULT_ASSISTANT,
  tierDisabled = false,
  tierSaving = false,
  onTierSelect = async () => undefined,
  onRealtimeVoice = () => undefined,
  voiceResetKey = '',
  onVoiceDraft = () => undefined,
  onVoiceCancel = () => undefined,
  onComposerClear = () => undefined,
  onVoiceWallet = () => undefined,
  supportedExtensions = [],
  addFiles = () => undefined,
  removeAttachment = () => undefined,
  inlineThreshold = 16000,
  maxCharacters = 16000,
  longInputMode = 'analyze',
  setLongInputMode = () => undefined,
}: {
  user?: User | null;
  value: string; setValue: (value: string) => void; send: () => void; stop: () => void;
  streaming: boolean; disabled?: boolean; focusKey?: string;
  attachments?: ComposerAttachment[]; attachmentsEnabled?: boolean; voiceEnabled?: boolean;
  realtimeVoiceEnabled?: boolean; realtimeVoiceUnavailableReason?: string; assistant?: AssistantSettings;
  tierDisabled?: boolean; tierSaving?: boolean;
  onTierSelect?: (tier: SwicoTier) => Promise<void>; onRealtimeVoice?: () => void;
  voiceResetKey?: string;
  onVoiceDraft?: (voiceTurnId: string) => void; onVoiceCancel?: () => void;
  onComposerClear?: () => void;
  onVoiceWallet?: (wallet: Wallet) => void;
  supportedExtensions?: string[]; addFiles?: (files: File[]) => void;
  removeAttachment?: (attachment: ComposerAttachment) => void;
  inlineThreshold?: number; maxCharacters?: number; longInputMode?: LongInputMode;
  setLongInputMode?: (mode: LongInputMode) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const composing = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [menuOpen, setMenuOpen] = useState(false)
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
  const hasSendableContent = !!value.trim() || readyAttachments.length > 0
  const overLimit = value.length > maxCharacters
  const nearLimit = value.length >= Math.floor(maxCharacters * 0.8)
  const showCharacterCount = overLimit || nearLimit || value.length >= inlineThreshold
  const canSend = !disabled && !streaming && !uploadBusy && !audioBusy && hasSendableContent && !overLimit

  const resize = () => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }
  useEffect(resize, [value])
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [focusKey])
  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !plusRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setMenuOpen(false); plusRef.current?.focus(); return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!items.length) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', keyboard, true)
    window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), 0)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keyboard, true) }
  }, [menuOpen])
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
    <div className={`composer-shell ${dragging ? 'dragging' : ''} ${showCharacterCount ? 'has-character-count' : ''}`}
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
            {'warnings' in attachment && attachment.warnings.map(warning => <small className="attachment-warning" role="status" key={warning}>{warning}</small>)}
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
      {overLimit && <div className="composer-error" role="alert">Pasted text exceeds the {maxCharacters.toLocaleString()}-character limit. No characters were removed.</div>}
      {value.length > inlineThreshold && !overLimit && <label className="long-input-mode">Large text action<select value={longInputMode} onChange={event => setLongInputMode(event.target.value as LongInputMode)}><option value="summarize">Summarize</option><option value="analyze">Analyze</option><option value="ask_questions">Ask questions</option><option value="rewrite">Rewrite</option><option value="translate">Translate</option></select></label>}
      <div className="composer" data-testid="composer">
        <div className="composer-plus-wrap">
          <input ref={fileRef} className="hidden-file-input" type="file" multiple aria-label="Upload files" accept={supportedExtensions.join(',')}
            onChange={event => chooseFiles(event.target.files)} />
          <button ref={plusRef} className="composer-tool composer-plus" type="button" aria-label="Add to prompt" title="Add to prompt"
            aria-haspopup="menu" aria-expanded={menuOpen} disabled={disabled || streaming || audioBusy || !attachmentsEnabled}
            onClick={() => setMenuOpen(value => !value)}><Plus size={20} /></button>
          {menuOpen && <div ref={menuRef} className="composer-add-menu" role="menu" aria-label="Add to prompt options">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); fileRef.current?.click(); window.setTimeout(() => plusRef.current?.focus(), 0) }}><Upload size={18} /><span><strong>Upload files</strong><small>Add documents from this device</small></span></button>
          </div>}
        </div>
        <textarea ref={ref} aria-label="Message Swico" value={value} disabled={disabled}
          onChange={event => { setValue(event.target.value); if (!event.target.value) onComposerClear() }} onKeyDown={keyDown}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          placeholder={disabled ? 'Reconnect to send a message' : 'Message Swico'} rows={1} aria-describedby="composer-character-count" />
        <SwicoTierSelector assistant={assistant} disabled={tierDisabled || streaming} saving={tierSaving} onSelect={onTierSelect} context="composer" />
        {voiceEnabled && recorder.state.status !== 'recording' && recorder.state.status !== 'stopping' && <button className="composer-tool" type="button" aria-label="Start voice dictation" title="Start voice dictation" disabled={disabled || streaming || uploadBusy || recorder.state.status === 'transcribing'} onClick={() => void recorder.start()}><Mic size={19} /></button>}
        {streaming
          ? <button className="send stop" type="button" aria-label="Stop generation" title="Stop generation" onClick={stop}><Square size={15} fill="currentColor" /></button>
          : hasSendableContent ? <button className="send" type="button" aria-label="Send message" title="Send message" disabled={!canSend} onClick={send}><ArrowUp size={20} /></button>
            : <button className="voice-mode-button" type="button"
              aria-label="Start real-time Voice Mode"
              title={realtimeVoiceEnabled ? 'Start real-time Voice Mode' : realtimeVoiceUnavailableReason}
              disabled={disabled || !realtimeVoiceEnabled || audioBusy || uploadBusy} onClick={onRealtimeVoice}><AudioLines size={21} /></button>}
      </div>
      <small id="composer-character-count" className={`${showCharacterCount ? 'character-count' : 'sr-only'}${overLimit ? ' over-limit' : ''}`} aria-live="polite">{value.length.toLocaleString()} / {maxCharacters.toLocaleString()} characters{value.length > inlineThreshold && !overLimit ? ' · will be sent as a temporary text attachment' : ''}</small>
      {dragging && <div className="drop-overlay" aria-hidden="true"><Upload size={20} /> Drop documents to attach</div>}
    </div>
    <span className="sr-status" aria-live="polite">{statusText}</span>
    <p>Swico can make mistakes. Check important information.</p>
  </div>
}
