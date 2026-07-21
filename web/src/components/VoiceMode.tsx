import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import type { CreditBucket, VoiceTuning } from '../types'
import { useRealtimeVoice, type VoiceTurnDone } from '../hooks/useRealtimeVoice'

export function VoiceMode({ user, threadId, close, addCredits, onTurnDone, tuning, internalDiagnostics = false }: {
  user: User; threadId: string | null; close: () => void;
  addCredits: (bucket: CreditBucket) => void; onTurnDone?: (turn: VoiceTurnDone) => void;
  tuning?: VoiceTuning; internalDiagnostics?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const finishingRef = useRef(false)
  const [finishing, setFinishing] = useState(false)
  const voice = useRealtimeVoice({ user, threadId, onTurnDone, tuning, collectDiagnostics:internalDiagnostics })
  const endVoice = voice.end

  const finish = useCallback(async () => {
    if (finishingRef.current) return
    finishingRef.current = true
    setFinishing(true)
    try {
      await endVoice()
    } catch {
      // The hook normally cleans up safely; the overlay must still close if it rejects.
    } finally {
      close()
    }
  }, [close, endVoice])

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
  }, [finish])

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
        <button ref={closeRef} className="voice-close" aria-label="Close Voice Mode" aria-busy={finishing} disabled={finishing} onClick={() => void finish()}><X /></button>
      </header>

      <div className="voice-stage">
        <div className={`voice-orb ${voice.phase}`} aria-hidden="true">
          <div className="voice-orb-core" /><div className="voice-orb-glow" />
        </div>
        <h2>{status}</h2>
        <span className="voice-status-live" aria-live="polite">{status}</span>
        {voice.phase === 'endpoint_pending' && <p className="voice-take-time" aria-hidden="true">Take your time</p>}
        {(voice.partial.trim() || voice.assistant.trim()) && <div className="voice-captions" aria-label="Voice captions">
          {voice.partial.trim() && <p className="voice-transcript"><span>You</span>{voice.partial}</p>}
          {voice.assistant.trim() && <p className="voice-transcript assistant"><span>Swico</span>{voice.assistant}</p>}
        </div>}
        {voice.phase === 'interrupted' && <p className="voice-interruption" role="status">Listening for you now.</p>}
        <div className="voice-microphone-level" aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voice.microphoneLevel * 100)}>
          <span style={{ transform:`scaleX(${Math.max(.02, voice.microphoneLevel)})` }} />
        </div>
        {voice.cannotHear && !voice.muted && ['listening', 'endpoint_pending'].includes(voice.phase) && <p className="voice-interruption" role="status">We cannot hear you. Move closer to the microphone or check its input level.</p>}
        {voice.playbackWarning && <div className="voice-playback-warning" role="status"><p>{voice.playbackWarning}</p>
          {voice.playbackState === 'autoplay_blocked' && <button className="primary voice-tap-play" onClick={() => void voice.manualPlay()}>Tap to play</button>}
          {voice.playbackState === 'playback_error' && voice.canReplay && <button className="primary voice-tap-play" onClick={() => void voice.manualPlay()}>Replay full spoken answer</button>}
          {(voice.playbackState === 'autoplay_blocked' || voice.playbackState === 'playback_error') && <button onClick={voice.skipPlayback}>Skip audio</button>}
        </div>}
        {voice.error && <div className="voice-error" role="alert">
          <p>{voice.error}</p>
          <div className="voice-error-actions">
            <button className="primary" onClick={() => void voice.retry()}><RefreshCw size={18} />Try again</button>
            {voice.creditRequired === 'voice' && <button onClick={() => addCredits('voice')}>Add Voice credits</button>}
          </div>
        </div>}
      </div>
    </section>
  </div>
}
