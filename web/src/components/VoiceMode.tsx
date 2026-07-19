import { useEffect, useRef } from 'react'
import { Mic, MicOff, PhoneOff, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import type { CreditBucket } from '../types'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice'

export function VoiceMode({ user, threadId, close, addCredits }: {
  user: User; threadId: string | null; close: () => void; addCredits: (bucket: CreditBucket) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const voice = useRealtimeVoice({ user, threadId })
  const endVoice = voice.end
  useEffect(() => {
    closeRef.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); endVoice(); close() }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [close, endVoice])
  const status = voice.phase === 'listening' ? 'Listening' : voice.phase === 'thinking' ? 'Thinking'
    : voice.phase === 'speaking' ? 'Speaking' : voice.phase === 'interrupted' ? 'Interrupted'
      : voice.phase === 'connecting' ? 'Connecting' : voice.phase === 'error' ? 'Connection error' : 'Ended'
  return <div className="voice-mode-backdrop">
    <section className="voice-mode" role="dialog" aria-modal="true" aria-labelledby="voice-mode-title">
      <header><div><strong id="voice-mode-title">Voice Mode</strong><span>{voice.ticketInfo?.tier_label ?? 'Swico'} · {voice.ticketInfo?.language === 'ta' ? 'Tamil' : 'English'}</span></div><button ref={closeRef} aria-label="Close Voice Mode" onClick={() => { endVoice(); close() }}><X /></button></header>
      <div className={`voice-orb ${voice.phase}`} aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <h2 aria-live="polite">{status}</h2>
      {voice.partial && <p className="voice-transcript"><span>You</span>{voice.partial}</p>}
      {voice.assistant && <p className="voice-transcript assistant"><span>Swico</span>{voice.assistant}</p>}
      {voice.phase === 'interrupted' && <p role="status">The assistant was interrupted. Listening for you now.</p>}
      {voice.error && <div className="voice-error" role="alert"><p>{voice.error}</p><small>Voice Mode does not reconnect automatically. Close and start a fresh session.</small></div>}
      <footer><button aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? <MicOff /> : <Mic />}<span>{voice.muted ? 'Unmute' : 'Mute'}</span></button><button className="end-voice" onClick={() => { endVoice(); close() }}><PhoneOff /><span>End conversation</span></button></footer>
      {voice.creditRequired === 'chat' && <button className="primary" onClick={() => addCredits('chat')}>Add Chat credits</button>}
      {voice.creditRequired === 'voice' && <button className="primary" onClick={() => addCredits('voice')}>Add Voice credits</button>}
    </section>
  </div>
}
