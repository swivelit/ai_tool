import { useEffect, useRef, useState } from 'react'
import { Captions, Mic, MicOff, PhoneOff, RefreshCw, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import type { CreditBucket, VoiceTuning } from '../types'
import { useRealtimeVoice, type VoiceTurnDone } from '../hooks/useRealtimeVoice'
import { apiJson } from '../api/client'

type InternalVoiceDiagnostics = {
  backend_release: string; alembic_head: string;
  features: { web_realtime_voice:boolean; separate_voice_credits:boolean; web_voice_billing:boolean };
  valkey: { configured:boolean; reachable:boolean }; sarvam: { configured:boolean };
  origin: { request_origin_allowed:boolean };
}

export function VoiceMode({ user, threadId, close, addCredits, onTurnDone, tuning, frontendRelease = 'dev', backendRelease = 'unavailable', internalDiagnostics = false }: {
  user: User; threadId: string | null; close: () => void;
  addCredits: (bucket: CreditBucket) => void; onTurnDone?: (turn: VoiceTurnDone) => void;
  tuning?: VoiceTuning; frontendRelease?: string; backendRelease?: string; internalDiagnostics?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [captions, setCaptions] = useState(true)
  const [diagnostics, setDiagnostics] = useState<InternalVoiceDiagnostics | null>(null)
  const voice = useRealtimeVoice({ user, threadId, onTurnDone, tuning })
  const endVoice = voice.end

  useEffect(() => {
    if (!internalDiagnostics) return
    let active = true
    void apiJson<InternalVoiceDiagnostics>(user, '/api/web/voice/diagnostics')
      .then(value => { if (active) setDiagnostics(value) })
      .catch(() => undefined)
    return () => { active = false }
  }, [internalDiagnostics, user])

  const finish = async () => {
    await endVoice()
    close()
  }

  useEffect(() => {
    closeRef.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); void finish(); return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
      if (!focusable.length) return
      const first = focusable[0]; const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
    // `finish` intentionally follows the current hook instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, endVoice])

  const status = voice.phase === 'listening' ? 'Listening'
    : voice.phase === 'endpoint_pending' ? 'Still listening…'
      : voice.phase === 'thinking' ? 'Thinking'
        : voice.phase === 'speaking' ? 'Speaking'
          : voice.phase === 'interrupted' ? 'Listening'
            : voice.phase === 'connecting' ? 'Connecting'
              : voice.phase === 'closing' ? 'Ending conversation'
                : voice.phase === 'error' ? 'Voice needs attention' : 'Ended'

  return <div className="voice-mode-backdrop">
    <section ref={dialogRef} className={`voice-mode voice-state-${voice.phase}`} role="dialog" aria-modal="true" aria-labelledby="voice-mode-title">
      <header className="voice-mode-header">
        <div className="voice-mode-identity">
          <strong id="voice-mode-title">Voice</strong>
          <span>{voice.ticketInfo?.tier_label ?? 'Swico'} · {voice.ticketInfo?.language === 'ta' ? 'Tamil' : 'English'}</span>
        </div>
        <button ref={closeRef} className="voice-close" aria-label="Close Voice Mode" onClick={() => void finish()}><X /></button>
      </header>

      <div className="voice-stage">
        <div className={`voice-orb ${voice.phase}`} aria-hidden="true">
          <div className="voice-orb-core" /><div className="voice-orb-glow" />
        </div>
        <h2>{status}</h2>
        <span className="voice-status-live" aria-live="polite">{status}</span>
        {captions && <div className="voice-captions" aria-label="Voice captions">
          {voice.partial && <p className="voice-transcript"><span>You</span>{voice.partial}</p>}
          {voice.assistant && <p className="voice-transcript assistant"><span>Swico</span>{voice.assistant}</p>}
        </div>}
        {voice.phase === 'interrupted' && <p className="voice-interruption" role="status">Listening for you now.</p>}
        <div className="voice-microphone-level" aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voice.microphoneLevel * 100)}>
          <span style={{ transform:`scaleX(${Math.max(.02, voice.microphoneLevel)})` }} />
        </div>
        {voice.cannotHear && !voice.muted && <p className="voice-interruption" role="status">We cannot hear you. Move closer to the microphone or check its input level.</p>}
        {voice.playbackWarning && <div className="voice-playback-warning" role="status"><p>{voice.playbackWarning}</p>
          {voice.playbackState === 'autoplay_blocked' && <button className="primary voice-tap-play" onClick={() => void voice.manualPlay()}>Tap to play</button>}
          {(voice.playbackState === 'autoplay_blocked' || voice.playbackState === 'playback_error') && <button onClick={voice.skipPlayback}>Skip audio</button>}
        </div>}
        {voice.error && <div className="voice-error" role="alert">
          <p>{voice.error}</p>
          <div className="voice-error-actions">
            <button className="primary" onClick={() => void voice.retry()}><RefreshCw size={18} />Try again</button>
            {voice.creditRequired === 'chat' && <button onClick={() => addCredits('chat')}>Add Chat credits</button>}
            {voice.creditRequired === 'voice' && <button onClick={() => addCredits('voice')}>Add Voice credits</button>}
          </div>
        </div>}
        {internalDiagnostics && <details className="voice-diagnostics"><summary>Voice diagnostics</summary>
          <dl><dt>Frontend release</dt><dd>{frontendRelease}</dd><dt>Backend release</dt><dd>{diagnostics?.backend_release ?? backendRelease}</dd>
            <dt>Alembic head</dt><dd>{diagnostics?.alembic_head ?? 'loading'}</dd>
            <dt>Features ready</dt><dd>{diagnostics ? String(Object.values(diagnostics.features).every(Boolean)) : 'loading'}</dd>
            <dt>Valkey ready</dt><dd>{diagnostics ? String(diagnostics.valkey.configured && diagnostics.valkey.reachable) : 'loading'}</dd>
            <dt>Sarvam configured</dt><dd>{diagnostics ? String(diagnostics.sarvam.configured) : 'loading'}</dd>
            <dt>Origin allowed</dt><dd>{diagnostics ? String(diagnostics.origin.request_origin_allowed) : 'loading'}</dd>
            <dt>HTTP status</dt><dd>{voice.errorStatus ?? 'none'}</dd><dt>Error code</dt><dd>{voice.errorCode || 'none'}</dd>
            <dt>Playback state</dt><dd>{voice.playbackState}</dd></dl>
        </details>}
      </div>

      <footer className="voice-controls">
        <button aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voice.muted} onClick={voice.toggleMute}>
          {voice.muted ? <MicOff /> : <Mic />}<span>{voice.muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button aria-label={captions ? 'Hide captions' : 'Show captions'} aria-pressed={captions} onClick={() => setCaptions(value => !value)}>
          <Captions /><span>Captions</span>
        </button>
        <button className="end-voice" aria-label="End conversation" onClick={() => void finish()}><PhoneOff /><span>End conversation</span></button>
      </footer>
    </section>
  </div>
}
