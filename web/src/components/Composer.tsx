import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { User } from 'firebase/auth'
import { ArrowUp, AudioLines, Camera, FileArchive, FileText, ImageOff, Mic, Plus, Square, Upload, X } from 'lucide-react'
import type { AssistantSettings, ComposerAttachment, ComposerRepository, LongInputMode, SwicoTier, Wallet } from '../types'
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

function AttachmentVisual({ attachment }: { attachment: ComposerAttachment }) {
  const [imageFailed, setImageFailed] = useState(false)
  const isImage = attachment.media_type.startsWith('image/')
  useEffect(() => { setImageFailed(false) }, [attachment.preview_url])
  if (isImage && attachment.preview_url && !imageFailed) {
    return <img className="attachment-thumbnail" src={attachment.preview_url} alt="" onError={() => setImageFailed(true)} />
  }
  return isImage && imageFailed
    ? <ImageOff size={18} aria-label="Image preview unavailable" />
    : <FileText size={18} aria-hidden="true" />
}

export function Composer({
  user = null,
  value,
  setValue,
  send,
  stop,
  cancellationReady = false,
  streaming,
  disabled,
  focusKey = '',
  attachments = [],
  pendingAttachments,
  activeAttachments = [],
  attachmentsEnabled = false,
  repository = null,
  repositoryUploadEnabled = false,
  repositoryChatEnabled = false,
  repositoryValidationCapability = 'static_only',
  voiceEnabled = false,
  realtimeVoiceEnabled = false,
  realtimeVoiceUnavailableReason = 'Voice Mode is not enabled for this account.',
  assistant = DEFAULT_ASSISTANT,
  showTierSelector = true,
  showRealtimeVoiceControls = true,
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
  addRepository = () => undefined,
  removeRepository = () => undefined,
  inlineThreshold = 16000,
  maxCharacters = 16000,
  longInputMode = 'analyze',
  setLongInputMode = () => undefined,
}: {
  user?: User | null;
  value: string; setValue: (value: string) => void; send: () => void; stop: () => void;
  cancellationReady?: boolean;
  streaming: boolean; disabled?: boolean; focusKey?: string;
  attachments?: ComposerAttachment[]; pendingAttachments?: ComposerAttachment[]; activeAttachments?: ComposerAttachment[]; attachmentsEnabled?: boolean; voiceEnabled?: boolean;
  repository?: ComposerRepository | null; repositoryUploadEnabled?: boolean;
  repositoryChatEnabled?: boolean;
  repositoryValidationCapability?: 'static_only' | 'executable';
  realtimeVoiceEnabled?: boolean; realtimeVoiceUnavailableReason?: string; assistant?: AssistantSettings;
  showTierSelector?: boolean; showRealtimeVoiceControls?: boolean;
  tierDisabled?: boolean; tierSaving?: boolean;
  onTierSelect?: (tier: SwicoTier) => Promise<void>; onRealtimeVoice?: () => void;
  voiceResetKey?: string;
  onVoiceDraft?: (voiceTurnId: string) => void; onVoiceCancel?: () => void;
  onComposerClear?: () => void;
  onVoiceWallet?: (wallet: Wallet) => void;
  supportedExtensions?: string[]; addFiles?: (files: File[]) => void;
  removeAttachment?: (attachment: ComposerAttachment) => void;
  addRepository?: (file: File) => void; removeRepository?: () => void;
  inlineThreshold?: number; maxCharacters?: number; longInputMode?: LongInputMode;
  setLongInputMode?: (mode: LongInputMode) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Camera input for the "Take a photo" option.
  const cameraRef = useRef<HTMLInputElement>(null)

  const repositoryFileRef = useRef<HTMLInputElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const composing = useRef(false)
  const [now, setNow] = useState(Date.now())
  const [menuOpen, setMenuOpen] = useState(false)
  const visibleAttachments = pendingAttachments ?? attachments

  useEffect(() => { valueRef.current = value }, [value])

  useEffect(() => {
    if (!visibleAttachments.some(item => item.status === 'ready')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visibleAttachments])

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
  const uploadBusy = visibleAttachments.some(item => item.status === 'uploading')
  const repositoryUploadBusy = repository?.status === 'uploading'
  const readyAttachments = visibleAttachments.filter(item => item.status === 'ready')
  const hasSendableContent = !!value.trim() || readyAttachments.length > 0
  const overLimit = value.length > maxCharacters
  const nearLimit = value.length >= Math.floor(maxCharacters * 0.8)

  const canSend = !disabled && !streaming && !uploadBusy
    && !repositoryUploadBusy && !audioBusy && hasSendableContent && !overLimit

  const resize = () => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }

  useEffect(resize, [value])

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [focusKey])

  useEffect(() => {
    if (!menuOpen) return

    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !plusRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuOpen(false)
        plusRef.current?.focus()
        return
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

    window.setTimeout(
      () => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
      0,
    )

    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', keyboard, true)
    }
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

  const chooseRepository = (files: FileList | null) => {
    const file = files?.item(0)
    if (file) addRepository(file)
    if (repositoryFileRef.current) repositoryFileRef.current.value = ''
  }

  const statusText = recorder.state.error
    ?? (recorder.state.status === 'requesting' ? 'Requesting microphone access…'
      : recorder.state.status === 'recording' ? `Recording ${elapsed(recorder.state.elapsed_seconds)}`
        : recorder.state.status === 'transcribing' ? 'Transcribing recording…'
          : repositoryUploadBusy ? 'Uploading repository…'
            : uploadBusy ? 'Uploading attachment…' : '')

  useEffect(() => {
    const element = wrapRef.current
    const host = element?.closest<HTMLElement>('.chat-main')
    if (!element || !host || typeof ResizeObserver === 'undefined') return

    let lastHeight = -1
    let lastScrollbarReserve = -1

    const conversation = host.querySelector<HTMLElement>('.conversation')

    const update = () => {
      const height = Math.max(0, Math.round(element.getBoundingClientRect().height))

      if (height !== lastHeight) {
        lastHeight = height
        host.style.setProperty('--composer-reserved-height', `${height}px`)
      }

      const scrollbarReserve = conversation
        ? Math.max(
          0,
          Math.round((conversation.offsetWidth - conversation.clientWidth) / 2),
        )
        : 0

      if (scrollbarReserve !== lastScrollbarReserve) {
        lastScrollbarReserve = scrollbarReserve
        host.style.setProperty(
          '--chat-scrollbar-inline-reserve',
          `${scrollbarReserve}px`,
        )
      }
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(element)

    if (conversation) observer.observe(conversation)

    return () => {
      observer.disconnect()
      host.style.removeProperty('--composer-reserved-height')
      host.style.removeProperty('--chat-scrollbar-inline-reserve')
    }
  }, [])

  return <div className="composer-wrap" ref={wrapRef}>
    <div className="composer-shell">

      {visibleAttachments.length > 0 && <div className="attachment-tray" aria-label="Pending attachments">
        {visibleAttachments.map(attachment => <div
          className={`attachment-chip ${attachment.status}`}
          key={'local_id' in attachment ? attachment.local_id : attachment.id}
        >
          <span className="attachment-visual">
            <AttachmentVisual attachment={attachment} />
          </span>

          <span className="attachment-copy">
            <strong title={attachment.name}>{attachment.name}</strong>

            <small>
              {attachment.media_type || attachment.name.split('.').pop()?.toUpperCase()}
              {' · '}
              {humanSize(attachment.size_bytes)}
            </small>

            <small>
              {attachment.status === 'uploading'
                ? `Uploading… ${attachment.progress}%`
                : attachment.status === 'error'
                  ? attachment.error || 'Upload failed'
                  : attachment.status === 'ready'
                    ? remaining(attachment.expires_at, now)
                    : attachment.status === 'unavailable'
                      ? 'Unavailable'
                      : 'Expired'}
            </small>

            {'warnings' in attachment && attachment.warnings.map(warning =>
              <small className="attachment-warning" role="status" key={warning}>
                {warning}
              </small>,
            )}
          </span>

          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            title={`Remove ${attachment.name}`}
            onClick={() => removeAttachment(attachment)}
          >
            <X size={15} />
          </button>
        </div>)}
      </div>}

      {activeAttachments.length > 0 && <div className="attachment-tray attachment-context-tray" aria-label="Active attachment context">
        <div className="attachment-context-note" role="status">
          Active context is included in follow-ups. Remove a file here to make room for another upload.
        </div>
        {activeAttachments.map(attachment => <div className={`attachment-chip ${attachment.status}`} key={`context-${'local_id' in attachment ? attachment.local_id : attachment.id}`}>
          <span className="attachment-visual"><AttachmentVisual attachment={attachment} /></span>
          <span className="attachment-copy"><strong title={attachment.name}>{attachment.name}</strong><small>{attachment.status === 'expired' ? 'Expired context — remove or re-upload' : 'Active for this chat'}</small></span>
          <button type="button" aria-label={`Remove active context ${attachment.name}`} title={`Remove active context ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X size={15} /></button>
        </div>)}
      </div>}

      {repository && <div className="attachment-tray repository-tray" aria-label="Active code repository">
        <div className={`attachment-chip repository-chip ${repository.status}`}>
          <FileArchive size={18} aria-hidden="true" />

          <span className="attachment-copy">
            <strong title={repository.display_name}>{repository.display_name}</strong>

            <small>
              {repository.languages.length
                ? repository.languages.slice(0, 3).join(', ')
                : 'Code repository'}
              {repository.file_count > 0
                ? ` · ${repository.file_count} files`
                : repository.symbol_count > 0
                  ? ` · ${repository.symbol_count} symbols`
                  : ''}
            </small>

            <small>
              {repository.status === 'uploading'
                ? `Uploading repository… ${Math.min(100, Math.max(0, repository.progress))}%`
                : repository.status === 'ready'
                  ? 'Repository ready'
                  : repository.status === 'expired'
                    ? 'Repository expired'
                    : repository.error || 'Repository upload failed'}
            </small>

            {repository.status === 'ready' && <small>
              {!repositoryChatEnabled
                ? 'Validation unavailable'
                : repositoryValidationCapability === 'static_only'
                  ? 'Static checks only'
                  : 'Executable validation available'}
            </small>}
          </span>

          <button
            type="button"
            aria-label={`Remove ${repository.display_name}`}
            title={`Remove ${repository.display_name}`}
            onClick={removeRepository}
          >
            <X size={15} />
          </button>
        </div>
      </div>}

      {readyAttachments.length > 0 &&
        <div className="attachment-context-note" role="status">
          These files stay active for this chat until removed or expired.
        </div>}

      {repository?.status === 'ready' &&
        <div className="attachment-context-note" role="status">
          Repository context will be used for this chat.
        </div>}

      {recorder.state.status === 'recording' || recorder.state.status === 'stopping'
        ? <div className="recording-row" role="status">
          <span className="recording-dot" aria-hidden="true" />
          <strong>Recording {elapsed(recorder.state.elapsed_seconds)}</strong>

          <button type="button" onClick={recorder.stop} aria-label="Stop recording">
            <Square size={14} fill="currentColor" /> Stop
          </button>

          <button type="button" onClick={recorder.cancel} aria-label="Cancel recording">
            <X size={15} /> Cancel
          </button>
        </div>
        : null}

      {recorder.state.status === 'transcribing' &&
        <div className="recording-row" role="status">
          <span className="spinner" />Transcribing…
        </div>}

      {recorder.state.error &&
        <div className="composer-error" role="alert">
          <span>{recorder.state.error}</span>
          <button type="button" onClick={recorder.resetError}>Dismiss</button>
        </div>}

      {overLimit &&
        <div className="composer-error" role="alert">
          Pasted text exceeds the {maxCharacters.toLocaleString()}-character limit. No characters were removed.
        </div>}

      {value.length > inlineThreshold && !overLimit &&
        <label className="long-input-mode">
          Large text action
          <select
            value={longInputMode}
            onChange={event => setLongInputMode(event.target.value as LongInputMode)}
          >
            <option value="summarize">Summarize</option>
            <option value="analyze">Analyze</option>
            <option value="ask_questions">Ask questions</option>
            <option value="rewrite">Rewrite</option>
            <option value="translate">Translate</option>
          </select>
        </label>}

      <div className="composer" data-testid="composer">
        <div className="composer-input-surface">
          <textarea
            ref={ref}
            aria-label="Message Swico"
            value={value}
            disabled={disabled}
            onChange={event => {
              setValue(event.target.value)
              if (!event.target.value) onComposerClear()
            }}
            onKeyDown={keyDown}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            placeholder={disabled ? 'Reconnect to send a message' : 'Message Swico'}
            rows={1}
            aria-describedby="composer-character-count"
          />
        </div>

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">

            {(attachmentsEnabled || repositoryUploadEnabled) &&
              <div className="composer-plus-wrap">

                {/* Existing file upload input */}
                <input
                  ref={fileRef}
                  className="hidden-file-input"
                  type="file"
                  multiple
                  aria-label="Upload files"
                  accept={supportedExtensions.join(',')}
                  onChange={event => chooseFiles(event.target.files)}
                />

                {/* NEW: Camera input */}
                <input
                  ref={cameraRef}
                  className="hidden-file-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  aria-label="Take a photo"
                  onChange={event => chooseFiles(event.target.files)}
                />

                {/* Existing repository upload input */}
                <input
                  ref={repositoryFileRef}
                  className="hidden-file-input"
                  type="file"
                  aria-label="Upload code repository"
                  accept=".zip"
                  onChange={event => chooseRepository(event.target.files)}
                />

                <button
                  ref={plusRef}
                  className="composer-tool composer-plus"
                  type="button"
                  aria-label="Add to prompt"
                  title="Add to prompt"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  disabled={
                    disabled ||
                    streaming ||
                    audioBusy ||
                    repositoryUploadBusy ||
                    (!attachmentsEnabled && !repositoryUploadEnabled)
                  }
                  onClick={() => setMenuOpen(value => !value)}
                >
                  <Plus size={20} />
                </button>

                {menuOpen &&
                  <div
                    ref={menuRef}
                    className="composer-add-menu"
                    role="menu"
                    aria-label="Add to prompt options"
                  >

                    {/* Existing Upload files option */}
                    {attachmentsEnabled &&
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false)
                          fileRef.current?.click()
                          window.setTimeout(() => plusRef.current?.focus(), 0)
                        }}
                      >
                        <Upload size={18} />

                        <span>
                          <strong>Upload files</strong>
                          <small>Add documents from this device</small>
                        </span>
                      </button>}

                    {/* NEW: Take a photo option */}
                    {attachmentsEnabled &&
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false)
                          cameraRef.current?.click()
                          window.setTimeout(() => plusRef.current?.focus(), 0)
                        }}
                      >
                        <Camera size={18} />

                        <span>
                          <strong>Take a photo</strong>
                          <small>Use your camera to add a photo</small>
                        </span>
                      </button>}

                    {/* Existing repository option */}
                    {repositoryUploadEnabled &&
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false)
                          repositoryFileRef.current?.click()
                          window.setTimeout(() => plusRef.current?.focus(), 0)
                        }}
                      >
                        <FileArchive size={18} />

                        <span>
                          <strong>Upload code repository</strong>
                          <small>Add one temporary ZIP snapshot</small>
                        </span>
                      </button>}

                  </div>}
              </div>}
          </div>

          <div className="composer-toolbar-right">

            {showTierSelector
              ? <SwicoTierSelector
                assistant={assistant}
                disabled={tierDisabled || streaming}
                saving={tierSaving}
                onSelect={onTierSelect}
                context="composer"
              />
              : <span className="guest-tier-label" aria-label="Swico Free">
                Swico Free
              </span>}

            {voiceEnabled &&
              recorder.state.status !== 'recording' &&
              recorder.state.status !== 'stopping' &&
              <button
                className="composer-tool"
                type="button"
                aria-label="Start voice dictation"
                title="Start voice dictation"
                disabled={
                  disabled ||
                  streaming ||
                  uploadBusy ||
                  repositoryUploadBusy ||
                  recorder.state.status === 'transcribing'
                }
                onClick={() => void recorder.start()}
              >
                <Mic size={19} />
              </button>}

            {streaming
              ? <button
                className="send stop"
                type="button"
                aria-label="Stop generation"
                title="Stop generation"
                data-testid="stop-generation-button"
                data-cancellation-ready={cancellationReady ? 'true' : 'false'}
                onClick={stop}
              >
                <Square size={15} fill="currentColor" />
              </button>

              : hasSendableContent
                ? <button
                  className="send"
                  type="button"
                  aria-label="Send message"
                  title="Send message"
                  disabled={!canSend}
                  onClick={send}
                >
                  <ArrowUp size={20} />
                </button>

                : showRealtimeVoiceControls &&
                <button
                  className="voice-mode-button"
                  type="button"
                  aria-label="Start real-time Voice Mode"
                  title={
                    realtimeVoiceEnabled
                      ? 'Start real-time Voice Mode'
                      : realtimeVoiceUnavailableReason
                  }
                  disabled={
                    disabled ||
                    !realtimeVoiceEnabled ||
                    audioBusy ||
                    uploadBusy ||
                    repositoryUploadBusy
                  }
                  onClick={onRealtimeVoice}
                >
                  <AudioLines size={21} />
                </button>}
          </div>
        </div>
      </div>

      <small
        id="composer-character-count"
        className={`character-count sr-only${nearLimit ? ' near-limit' : ''}${overLimit ? ' over-limit' : ''}`}
        aria-live="polite"
      >
        {value.length.toLocaleString()} / {maxCharacters.toLocaleString()} characters
        {value.length > inlineThreshold && !overLimit
          ? ' · will be sent as a temporary text attachment'
          : ''}
      </small>
    </div>

    <span className="sr-status" aria-live="polite">
      {statusText}
    </span>

    <p>Swico can make mistakes. Check important information.</p>
  </div>
}
