import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { ApiError, apiJson } from '../api/client'
import type { CreditBucket, Wallets } from '../types'

export type VoicePhase = 'connecting' | 'listening' | 'endpoint_pending' | 'thinking' | 'speaking' | 'interrupted' | 'closing' | 'error' | 'closed'
export type VoiceTurnDone = {
  thread_id: string; user_message_id: string; assistant_message_id: string;
  turn_number: number; input_mode: 'realtime_voice'; completion_status: 'complete';
}
type Ticket = {
  protocol_version: 1; session_id: string; ticket: string; websocket_url: string;
  tier: string; tier_label: string; language: 'en' | 'ta'; wallets: Wallets;
}
type ProtocolMessage = { protocol_version: 1; type: string; [key: string]: unknown }
type VoiceError = { code: string; message: string; credit_bucket?: CreditBucket }

const CLOSE_ERRORS: Record<number, VoiceError> = {
  4400: { code:'voice_protocol_mismatch', message:'Voice protocol mismatch. Refresh Swico and try again.' },
  4401: { code:'voice_session_expired', message:'This Voice session ticket expired or was already used. Try again for a fresh ticket.' },
  4403: { code:'voice_origin_rejected', message:'Voice Mode was blocked for this site origin. Check the configured web origin.' },
  4409: { code:'voice_session_active', message:'Another Voice Mode session is already active.' },
  4429: { code:'voice_rate_limit', message:'Too many Voice Mode starts. Wait a moment, then try again.' },
  4450: { code:'insufficient_chat_credit', message:'Add Chat credits to continue Voice Mode.', credit_bucket:'chat' },
  4451: { code:'insufficient_voice_credit', message:'Add Voice credits to continue Voice Mode.', credit_bucket:'voice' },
  4460: { code:'sarvam_authentication_failed', message:'Voice provider authentication failed. Please contact support.' },
  4461: { code:'sarvam_quota_exhausted', message:'Voice provider quota is exhausted. Please try again later.' },
  4462: { code:'sarvam_temporarily_unavailable', message:'Voice provider is temporarily unavailable. Try again with a fresh session.' },
  4463: { code:'sarvam_protocol_error', message:'Voice provider protocol is incompatible. Please try again later.' },
  4470: { code:'voice_idle_timeout', message:'Voice Mode ended after being idle. Try again to start a fresh session.' },
  4471: { code:'voice_maximum_duration', message:'Voice Mode reached its maximum duration. Start a fresh session to continue.' },
  4472: { code:'voice_network_interrupted', message:'The Voice connection was interrupted. Check your network and try again.' },
  4500: { code:'voice_internal_failure', message:'Voice Mode stopped safely. Try again with a fresh session.' },
}

let activeOwner: symbol | null = null

function apiVoiceError(caught: ApiError): VoiceError | null {
  if (!caught.body || typeof caught.body !== 'object' || !('error' in caught.body)) return null
  const raw = (caught.body as { error?: unknown }).error
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { code?: unknown; message?: unknown; credit_bucket?: unknown }
  const bucket = value.credit_bucket === 'chat' || value.credit_bucket === 'voice' ? value.credit_bucket : undefined
  return {
    code:String(value.code || 'voice_start_failed'),
    message:String(value.message || 'Voice Mode could not start.'),
    ...(bucket ? { credit_bucket:bucket } : {}),
  }
}

export function useRealtimeVoice({ user, threadId, onTurnDone }: {
  user: User; threadId: string | null; onTurnDone?: (turn: VoiceTurnDone) => void;
}) {
  const owner = useRef(Symbol('voice-session'))
  const [phase, setPhase] = useState<VoicePhase>('connecting')
  const [partial, setPartial] = useState('')
  const [assistant, setAssistant] = useState('')
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [ticketInfo, setTicketInfo] = useState<Ticket | null>(null)
  const [creditRequired, setCreditRequired] = useState<CreditBucket | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const context = useRef<AudioContext | null>(null)
  const worklet = useRef<AudioWorkletNode | null>(null)
  const sequence = useRef(0)
  const mediaSource = useRef<MediaSource | null>(null)
  const sourceBuffer = useRef<SourceBuffer | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const objectUrl = useRef<string | null>(null)
  const audioQueue = useRef<ArrayBuffer[]>([])
  const mutedRef = useRef(false)
  const phaseRef = useRef<VoicePhase>('connecting')
  const closing = useRef(false)
  const actionableError = useRef<VoiceError | null>(null)
  const startInFlight = useRef<Promise<void> | null>(null)
  const onTurnDoneRef = useRef(onTurnDone)
  const messageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const preRollMs = useRef(320)
  const bargeMinMs = useRef(180)
  const preRoll = useRef<Array<{ pcm:ArrayBuffer; duration:number }>>([])
  const preRollDuration = useRef(0)
  const voicedDuration = useRef(0)
  const silenceDuration = useRef(0)
  const gateOpen = useRef(false)

  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { onTurnDoneRef.current = onTurnDone }, [onTurnDone])

  const rememberError = useCallback((value: VoiceError) => {
    if (actionableError.current) return
    actionableError.current = value
    setError(value.message); setErrorCode(value.code); setCreditRequired(value.credit_bucket ?? null)
    setPhase('error')
  }, [])

  const stopPlayback = useCallback(() => {
    audio.current?.pause()
    audioQueue.current = []
    if (sourceBuffer.current?.updating) {
      try { sourceBuffer.current.abort() } catch { /* detached playback buffer */ }
    }
  }, [])

  const cleanup = useCallback(async () => {
    closing.current = true
    const ws = socket.current; socket.current = null
    if (ws && messageHandlerRef.current) ws.removeEventListener('message', messageHandlerRef.current)
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'client_closed')
    if (worklet.current) worklet.current.port.onmessage = null
    worklet.current?.disconnect(); worklet.current = null
    const audioContext = context.current; context.current = null
    if (audioContext) await Promise.resolve(audioContext.close()).catch(() => undefined)
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null
    stopPlayback()
    audio.current = null; sourceBuffer.current = null; mediaSource.current = null
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    preRoll.current = []; preRollDuration.current = 0; voicedDuration.current = 0
    silenceDuration.current = 0; gateOpen.current = false
    if (activeOwner === owner.current) activeOwner = null
  }, [stopPlayback])

  const appendAudio = useCallback((chunk: ArrayBuffer) => {
    const buffer = sourceBuffer.current
    if (!buffer || buffer.updating || audioQueue.current.length) {
      if (audioQueue.current.length < 32) audioQueue.current.push(chunk)
      return
    }
    try { buffer.appendBuffer(chunk) } catch { rememberError({ code:'voice_playback_failed', message:'Audio playback could not continue.' }) }
  }, [rememberError])

  const setupPlayback = useCallback((contentType = 'audio/mpeg') => {
    stopPlayback()
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    const element = new Audio()
    const source = new MediaSource()
    const url = URL.createObjectURL(source)
    objectUrl.current = url; audio.current = element; mediaSource.current = source
    element.src = url
    source.addEventListener('sourceopen', () => {
      if (source.readyState !== 'open') return
      const buffer = source.addSourceBuffer(contentType)
      sourceBuffer.current = buffer
      buffer.addEventListener('updateend', () => {
        const next = audioQueue.current.shift()
        if (next && !buffer.updating) buffer.appendBuffer(next)
      })
      void element.play().catch(() => rememberError({ code:'voice_playback_permission', message:'Press Unmute to allow audio playback.' }))
    }, { once:true })
  }, [rememberError, stopPlayback])

  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then(value => appendAudio(value.slice(4)))
      return
    }
    if (event.data instanceof ArrayBuffer) { appendAudio(event.data.slice(4)); return }
    let message: ProtocolMessage
    try { message = JSON.parse(String(event.data)) as ProtocolMessage } catch { return }
    if (message.protocol_version !== 1) {
      rememberError(CLOSE_ERRORS[4400]); return
    }
    if (message.type === 'session.ready') {
      if (message.state === 'listening') setPhase('listening')
      if (typeof message.preroll_ms === 'number') preRollMs.current = message.preroll_ms
      if (typeof message.barge_in_min_ms === 'number') bargeMinMs.current = message.barge_in_min_ms
    } else if (message.type === 'state.changed') {
      const next = String(message.state) as VoicePhase
      if (['connecting','listening','endpoint_pending','thinking','speaking','interrupted','closing','error','closed'].includes(next)) setPhase(next)
    } else if (message.type === 'stt.partial') setPartial(String(message.transcript ?? ''))
    else if (message.type === 'stt.final') { setPartial(String(message.transcript ?? '')); setAssistant(''); setPhase('thinking') }
    else if (message.type === 'assistant.start') { setAssistant(''); setPhase('thinking') }
    else if (message.type === 'assistant.delta') setAssistant(value => value + String(message.delta ?? ''))
    else if (message.type === 'audio.start') { setPhase('speaking'); setupPlayback(String(message.content_type ?? 'audio/mpeg')) }
    else if (message.type === 'audio.end') { stopPlayback(); setPhase('listening') }
    else if (message.type === 'turn.done' && message.completion_status === 'complete') {
      const turn = message as ProtocolMessage & VoiceTurnDone
      onTurnDoneRef.current?.({
        thread_id:String(turn.thread_id), user_message_id:String(turn.user_message_id),
        assistant_message_id:String(turn.assistant_message_id), turn_number:Number(turn.turn_number),
        input_mode:'realtime_voice', completion_status:'complete',
      })
      setPartial(''); setAssistant(''); setPhase('listening')
    } else if (message.type === 'warning' && message.code === 'assistant_interrupted') {
      stopPlayback(); setPhase('interrupted')
    } else if (message.type === 'warning' && message.credit_bucket) {
      setCreditRequired(message.credit_bucket as CreditBucket)
    } else if (message.type === 'error') {
      const bucket = message.credit_bucket === 'chat' || message.credit_bucket === 'voice' ? message.credit_bucket : undefined
      rememberError({
        code:String(message.code ?? 'voice_internal_failure'),
        message:String(message.message ?? 'Voice Mode stopped safely.'),
        ...(bucket ? { credit_bucket:bucket } : {}),
      })
    } else if (message.type === 'session.closed') setPhase('closed')
  }, [appendAudio, rememberError, setupPlayback, stopPlayback])
  useEffect(() => { messageHandlerRef.current = handleMessage }, [handleMessage])

  const sendPcm = useCallback((pcm: ArrayBuffer) => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 * 1024) return
    const packet = new Uint8Array(4 + pcm.byteLength)
    new DataView(packet.buffer).setUint32(0, ++sequence.current)
    packet.set(new Uint8Array(pcm), 4)
    ws.send(packet)
  }, [])

  const start = useCallback(async () => {
    if (startInFlight.current) return startInFlight.current
    const operation = (async () => {
      if (activeOwner && activeOwner !== owner.current) {
        rememberError({ code:'voice_session_active', message:'Voice Mode is already open in this tab.' }); return
      }
      activeOwner = owner.current; closing.current = false
      actionableError.current = null; setError(''); setErrorCode(''); setCreditRequired(null)
      setPhase('connecting'); setPartial(''); setAssistant(''); sequence.current = 0
      try {
        const info = await apiJson<Ticket>(user, '/api/web/voice/sessions', { method:'POST' })
        if (closing.current) return
        setTicketInfo(info)
        const url = new URL(info.websocket_url)
        url.searchParams.set('ticket', info.ticket)
        const ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'; socket.current = ws
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once:true })
          ws.addEventListener('error', () => reject(new Error('Voice connection failed.')), { once:true })
        })
        if (closing.current) { ws.close(1000, 'client_closed'); return }
        ws.addEventListener('message', handleMessage)
        ws.addEventListener('close', event => {
          if (socket.current !== ws) return
          if (closing.current || (event.code === 1000 && event.reason === 'client_closed')) return
          // A structured server error always wins over the following close.
          if (actionableError.current) return
          const mapped = CLOSE_ERRORS[event.code]
            ?? (event.code === 1006
              ? { code:'voice_network_interrupted', message:'The Voice connection was interrupted. Check your network and try again.' }
              : { code:'voice_network_interrupted', message:'Voice connection closed unexpectedly. Try again for a fresh session.' })
          rememberError(mapped)
        })
        ws.send(JSON.stringify({
          protocol_version:1, type:'session.start',
          audio:{ encoding:'pcm_s16le', sample_rate:16000, channels:1 },
          ...(threadId ? { thread_id:threadId } : {}),
        }))
        let microphone: MediaStream
        try {
          microphone = await navigator.mediaDevices.getUserMedia({
            audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true },
          })
        } catch (caught) {
          const name = caught instanceof DOMException ? caught.name : ''
          if (name === 'NotAllowedError' || name === 'SecurityError') {
            throw new Error('Microphone permission was denied. Allow microphone access and try again.')
          }
          throw caught
        }
        stream.current = microphone
        const audioContext = new AudioContext(); context.current = audioContext
        await audioContext.audioWorklet.addModule('/audio-worklet.js')
        const source = audioContext.createMediaStreamSource(microphone)
        const node = new AudioWorkletNode(audioContext, 'swico-pcm16'); worklet.current = node
        const silent = audioContext.createGain(); silent.gain.value = 0
        source.connect(node); node.connect(silent); silent.connect(audioContext.destination)
        node.port.onmessage = (workletMessage: MessageEvent<{ type:string; pcm:ArrayBuffer; rms:number }>) => {
          if (mutedRef.current || socket.current?.readyState !== WebSocket.OPEN) return
          const pcm = workletMessage.data.pcm
          const duration = pcm.byteLength / 2 / 16_000 * 1000
          const speaking = workletMessage.data.rms >= 0.035
          preRoll.current.push({ pcm, duration }); preRollDuration.current += duration
          while (preRollDuration.current > preRollMs.current && preRoll.current.length > 1) {
            const removed = preRoll.current.shift(); preRollDuration.current -= removed?.duration ?? 0
          }
          if (speaking) {
            voicedDuration.current += duration; silenceDuration.current = 0
          } else {
            voicedDuration.current = 0; silenceDuration.current += duration
          }
          if (!gateOpen.current && voicedDuration.current >= bargeMinMs.current) {
            gateOpen.current = true
            for (const buffered of preRoll.current) sendPcm(buffered.pcm)
            preRoll.current = []; preRollDuration.current = 0
            return
          }
          if (gateOpen.current) {
            sendPcm(pcm)
            // Bound provider-billed trailing silence while still allowing VAD
            // enough time to produce END_SPEECH.
            if (silenceDuration.current >= 1_800) {
              gateOpen.current = false; silenceDuration.current = 0
            }
          }
        }
      } catch (caught) {
        const structured = caught instanceof ApiError ? apiVoiceError(caught) : null
        await cleanup()
        if (structured) rememberError(structured)
        else if (caught instanceof Error && caught.message.includes('Microphone permission')) {
          rememberError({ code:'microphone_permission_denied', message:caught.message })
        } else rememberError({
          code:'voice_network_interrupted',
          message:caught instanceof Error ? caught.message : 'Voice Mode could not start.',
        })
      }
    })()
    startInFlight.current = operation
    try { await operation } finally { startInFlight.current = null }
  }, [cleanup, handleMessage, rememberError, sendPcm, threadId, user])

  useEffect(() => {
    // The deferred start is discarded by React development Strict Mode before
    // it can mint a ticket on the first effect pass.
    const timer = window.setTimeout(() => void start(), 0)
    return () => { window.clearTimeout(timer); void cleanup() }
  }, [cleanup, start])

  const retry = useCallback(async () => {
    if (startInFlight.current) return
    await cleanup()
    closing.current = false
    await start()
  }, [cleanup, start])

  const toggleMute = useCallback(() => setMuted(value => {
    const next = !value
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ protocol_version:1, type:next ? 'mute' : 'unmute' }))
    }
    if (next) { gateOpen.current = false; preRoll.current = []; preRollDuration.current = 0 }
    return next
  }), [])

  const end = useCallback(async () => {
    setPhase('closing')
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ protocol_version:1, type:'session.close' }))
    }
    await cleanup(); setPhase('closed')
  }, [cleanup])

  return {
    phase, partial, assistant, muted, error, errorCode, ticketInfo, creditRequired,
    toggleMute, retry, end,
  }
}
