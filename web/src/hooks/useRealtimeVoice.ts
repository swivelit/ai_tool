import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { API_BASE, ApiError, apiJson } from '../api/client'
import type { CreditBucket, VoiceTuning, Wallets } from '../types'

export type VoicePhase = 'connecting' | 'listening' | 'endpoint_pending' | 'thinking' | 'speaking' | 'interrupted' | 'closing' | 'error' | 'closed'
export type PlaybackState = 'provider_stream_open' | 'provider_stream_finished' | 'media_buffer_draining' | 'playing' | 'playback_finished' | 'interrupted' | 'playback_error' | 'autoplay_blocked'
export type VoiceTurnDone = {
  thread_id: string; user_message_id: string; assistant_message_id: string;
  turn_number: number; input_mode: 'realtime_voice'; completion_status: 'complete';
}
type Ticket = {
  protocol_version: 1; session_id: string; ticket: string; websocket_url: string;
  tier: string; tier_label: string; language: 'en' | 'ta'; wallets: Wallets;
  approved_websocket_hosts?: string[];
}
type ProtocolMessage = { protocol_version: 1; type: string; [key: string]: unknown }
type VoiceError = { code: string; message: string; credit_bucket?: CreditBucket }
export type MicrophoneDiagnostics = {
  selectedDeviceLabel: string; browserSampleRate: number; resampledSampleRate: 16000;
  currentRms: number; calibratedNoiseFloor: number; activeThreshold: number;
  emittedFrameCount: number; backpressureDroppedFrameCount: number;
}

const OPEN_TIMEOUT_MS = 12_000
const PING_INTERVAL_MS = 20_000
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_AUDIO_CHUNKS = 96
const DEFAULT_TUNING: VoiceTuning = {
  calibration_ms:400, noise_multiplier:2.4, threshold_min:0.012,
  threshold_max:0.065, quiet_fallback:0.008, no_speech_warning_ms:10_000,
}

const CLOSE_ERRORS: Record<number, VoiceError> = {
  4400:{ code:'voice_protocol_mismatch', message:'Voice protocol mismatch. Refresh Swico and try again.' },
  4401:{ code:'voice_session_expired', message:'This Voice session ticket expired or was already used. Try again for a fresh ticket.' },
  4403:{ code:'voice_origin_rejected', message:'Voice Mode was blocked for this site origin. Check the configured web origin.' },
  4409:{ code:'voice_session_active', message:'Another Voice Mode session is already active.' },
  4429:{ code:'voice_rate_limit', message:'Too many Voice Mode starts. Wait a moment, then try again.' },
  4450:{ code:'insufficient_chat_credit', message:'Add Chat credits to continue Voice Mode.', credit_bucket:'chat' },
  4451:{ code:'insufficient_voice_credit', message:'Add Voice credits to continue Voice Mode.', credit_bucket:'voice' },
  4460:{ code:'sarvam_authentication_failed', message:'Voice provider authentication failed. Please contact support.' },
  4461:{ code:'sarvam_quota_exhausted', message:'Voice provider quota is exhausted. Please try again later.' },
  4462:{ code:'sarvam_temporarily_unavailable', message:'Voice provider is temporarily unavailable. Try again with a fresh session.' },
  4463:{ code:'sarvam_protocol_error', message:'Voice provider protocol is incompatible. Please try again later.' },
  4470:{ code:'voice_idle_timeout', message:'Voice Mode ended after being idle. Try again to start a fresh session.' },
  4471:{ code:'voice_maximum_duration', message:'Voice Mode reached its maximum duration. Start a fresh session to continue.' },
  4472:{ code:'voice_network_interrupted', message:'The Voice connection was interrupted. Check your network and try again.' },
  4500:{ code:'voice_internal_failure', message:'Voice Mode stopped safely. Try again with a fresh session.' },
}

let activeOwner: symbol | null = null

function apiVoiceError(caught: ApiError): VoiceError | null {
  if (!caught.body || typeof caught.body !== 'object' || !('error' in caught.body)) return null
  const raw = (caught.body as { error?: unknown }).error
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { code?: unknown; message?: unknown; credit_bucket?: unknown }
  const bucket = value.credit_bucket === 'chat' || value.credit_bucket === 'voice' ? value.credit_bucket : undefined
  return { code:String(value.code || 'voice_start_failed'), message:String(value.message || 'Voice Mode could not start.'), ...(bucket ? { credit_bucket:bucket } : {}) }
}

export function validatedSocketUrl(
  raw: string, approvedHosts: string[] = [], pageProtocol = window.location.protocol,
): URL {
  const url = new URL(raw)
  const api = new URL(API_BASE || window.location.origin, window.location.origin)
  const allowed = new Set([api.host, ...approvedHosts])
  if (!allowed.has(url.host)) throw new Error('Voice connection returned an unexpected host.')
  if (pageProtocol === 'https:' && url.protocol !== 'wss:') {
    throw new Error('Voice connection was blocked because it was not secure.')
  }
  if (pageProtocol === 'http:' && !['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Voice connection returned an invalid WebSocket URL.')
  }
  if (url.pathname !== '/api/web/voice/ws') throw new Error('Voice connection returned an unexpected path.')
  return url
}

export function useRealtimeVoice({ user, threadId, onTurnDone, tuning = DEFAULT_TUNING, collectDiagnostics = false }: {
  user: User; threadId: string | null; onTurnDone?: (turn: VoiceTurnDone) => void; tuning?: VoiceTuning;
  collectDiagnostics?: boolean;
}) {
  const owner = useRef(Symbol('voice-session'))
  const initialThreadId = useRef(threadId)
  const [phase, setPhase] = useState<VoicePhase>('connecting')
  const [playbackState, setPlaybackState] = useState<PlaybackState>('playback_finished')
  const [partial, setPartial] = useState('')
  const [assistant, setAssistant] = useState('')
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [playbackWarning, setPlaybackWarning] = useState('')
  const [ticketInfo, setTicketInfo] = useState<Ticket | null>(null)
  const [creditRequired, setCreditRequired] = useState<CreditBucket | null>(null)
  const [microphoneLevel, setMicrophoneLevel] = useState(0)
  const [cannotHear, setCannotHear] = useState(false)
  const [microphoneDiagnostics, setMicrophoneDiagnostics] = useState<MicrophoneDiagnostics>({
    selectedDeviceLabel:'unavailable', browserSampleRate:0, resampledSampleRate:16000,
    currentRms:0, calibratedNoiseFloor:0, activeThreshold:tuning.threshold_min,
    emittedFrameCount:0, backpressureDroppedFrameCount:0,
  })
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
  const fallbackChunks = useRef<ArrayBuffer[]>([])
  const audioBytes = useRef(0)
  const fallbackMode = useRef(false)
  const providerFinished = useRef(false)
  const audioEnded = useRef(true)
  const audioSequences = useRef(new Set<number>())
  const mutedRef = useRef(false)
  const phaseRef = useRef<VoicePhase>('connecting')
  const closing = useRef(false)
  const actionableError = useRef<VoiceError | null>(null)
  const startInFlight = useRef<Promise<void> | null>(null)
  const onTurnDoneRef = useRef(onTurnDone)
  const preRollMs = useRef(320)
  const bargeMinMs = useRef(180)
  const preRoll = useRef<Array<{ pcm:ArrayBuffer; duration:number }>>([])
  const preRollDuration = useRef(0)
  const voicedDuration = useRef(0)
  const silenceDuration = useRef(0)
  const gateOpen = useRef(false)
  const calibrationElapsed = useRef(0)
  const calibrationEnergy = useRef(0)
  const calibrationFrames = useRef(0)
  const adaptiveThreshold = useRef(tuning.threshold_min)
  const noGatedAudioMs = useRef(0)
  const lastLevelUpdate = useRef(0)
  const pingTimer = useRef<number | null>(null)
  const playbackListeners = useRef<Array<() => void>>([])
  const readyForAudio = useRef(false)
  const readyWaiter = useRef<{ resolve:() => void; reject:(error:Error) => void } | null>(null)
  const emittedFrameCount = useRef(0)
  const backpressureDroppedFrameCount = useRef(0)

  useEffect(() => {
    mutedRef.current = muted
    if (muted) { setCannotHear(false); noGatedAudioMs.current = 0 }
  }, [muted])
  useEffect(() => {
    phaseRef.current = phase
    if (!['listening', 'endpoint_pending'].includes(phase)) {
      setCannotHear(false); noGatedAudioMs.current = 0
    }
  }, [phase])
  useEffect(() => { onTurnDoneRef.current = onTurnDone }, [onTurnDone])

  const rememberError = useCallback((value: VoiceError) => {
    if (actionableError.current) return
    actionableError.current = value
    setError(value.message); setErrorCode(value.code); setCreditRequired(value.credit_bucket ?? null); setPhase('error')
  }, [])

  const clearPing = useCallback(() => {
    if (pingTimer.current !== null) window.clearInterval(pingTimer.current)
    pingTimer.current = null
  }, [])

  const revokeObjectUrl = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
  }, [])

  const detachPlaybackListeners = useCallback(() => {
    for (const remove of playbackListeners.current.splice(0)) remove()
  }, [])

  const stopPlayback = useCallback((state: PlaybackState = 'interrupted') => {
    detachPlaybackListeners()
    audio.current?.pause()
    audioQueue.current = []; fallbackChunks.current = []; audioBytes.current = 0
    audioEnded.current = true
    if (sourceBuffer.current?.updating) {
      try { sourceBuffer.current.abort() } catch { /* already detached */ }
    }
    audio.current = null; sourceBuffer.current = null; mediaSource.current = null
    providerFinished.current = false; fallbackMode.current = false
    audioSequences.current.clear(); revokeObjectUrl(); setPlaybackState(state)
  }, [detachPlaybackListeners, revokeObjectUrl])

  const finishPlayback = useCallback(() => {
    detachPlaybackListeners(); revokeObjectUrl()
    audio.current = null; sourceBuffer.current = null; mediaSource.current = null
    audioQueue.current = []; fallbackChunks.current = []; audioBytes.current = 0
    audioEnded.current = true; setPlaybackState('playback_finished'); setPlaybackWarning('')
    if (!closing.current && phaseRef.current !== 'error') setPhase('listening')
  }, [detachPlaybackListeners, revokeObjectUrl])

  const playbackFailed = useCallback((message = 'The spoken reply could not be played. The text is still available.') => {
    stopPlayback('playback_error'); setPlaybackWarning(message)
    if (!closing.current && phaseRef.current !== 'error') setPhase('listening')
  }, [stopPlayback])

  const attachAudioListeners = useCallback((element: HTMLAudioElement) => {
    const onPlaying = () => { setPlaybackState('playing'); setPhase('speaking'); setPlaybackWarning('') }
    const onWaiting = () => { if (!audioEnded.current) { setPlaybackState('media_buffer_draining'); setPhase('speaking') } }
    const onEnded = () => finishPlayback()
    const onError = () => playbackFailed()
    element.addEventListener('playing', onPlaying); element.addEventListener('waiting', onWaiting)
    element.addEventListener('ended', onEnded); element.addEventListener('error', onError)
    playbackListeners.current.push(
      () => element.removeEventListener('playing', onPlaying),
      () => element.removeEventListener('waiting', onWaiting),
      () => element.removeEventListener('ended', onEnded),
      () => element.removeEventListener('error', onError),
    )
  }, [finishPlayback, playbackFailed])

  const requestPlay = useCallback(async () => {
    const element = audio.current
    if (!element) return
    try { await element.play(); setPlaybackState('playing'); setPlaybackWarning('') }
    catch { setPlaybackState('autoplay_blocked'); setPlaybackWarning('Tap to play the spoken reply.') }
  }, [])

  const maybeEndMediaStream = useCallback(() => {
    const source = mediaSource.current; const buffer = sourceBuffer.current
    if (!providerFinished.current || audioQueue.current.length || buffer?.updating) return
    if (source?.readyState === 'open') {
      setPlaybackState('media_buffer_draining')
      try { source.endOfStream() } catch { playbackFailed() }
    }
  }, [playbackFailed])

  const drainQueue = useCallback(() => {
    const buffer = sourceBuffer.current
    if (!buffer || buffer.updating) return
    const next = audioQueue.current.shift()
    if (next) {
      try { buffer.appendBuffer(next) } catch { playbackFailed() }
      return
    }
    maybeEndMediaStream()
  }, [maybeEndMediaStream, playbackFailed])

  const appendAudio = useCallback((packet: ArrayBuffer) => {
    if (audioEnded.current || packet.byteLength <= 4) return
    if (!fallbackMode.current && mediaSource.current?.readyState === 'ended') return
    const sequenceNumber = new DataView(packet).getUint32(0)
    if (audioSequences.current.has(sequenceNumber)) return
    audioSequences.current.add(sequenceNumber)
    const chunk = packet.slice(4)
    if (audioBytes.current + chunk.byteLength > MAX_AUDIO_BYTES ||
        (fallbackMode.current ? fallbackChunks.current.length : audioQueue.current.length) >= MAX_AUDIO_CHUNKS) {
      fallbackChunks.current = []; audioQueue.current = []; audioEnded.current = true
      playbackFailed('The spoken reply was too large to play safely. The text is still available.')
      return
    }
    audioBytes.current += chunk.byteLength
    if (fallbackMode.current) { fallbackChunks.current.push(chunk); return }
    audioQueue.current.push(chunk); drainQueue()
  }, [drainQueue, playbackFailed])

  const playFallback = useCallback(() => {
    if (audioEnded.current) return
    const element = audio.current
    if (!element) return playbackFailed()
    const blob = new Blob(fallbackChunks.current, { type:'audio/mpeg' })
    fallbackChunks.current = []
    revokeObjectUrl(); objectUrl.current = URL.createObjectURL(blob); element.src = objectUrl.current
    setPlaybackState('media_buffer_draining'); void requestPlay()
  }, [playbackFailed, requestPlay, revokeObjectUrl])

  const setupPlayback = useCallback((contentType = 'audio/mpeg') => {
    stopPlayback('provider_stream_open')
    audioEnded.current = false; providerFinished.current = false; setPlaybackWarning(''); setPhase('speaking')
    const element = new Audio(); audio.current = element; attachAudioListeners(element)
    const progressiveSupported = typeof MediaSource !== 'undefined' &&
      (typeof MediaSource.isTypeSupported !== 'function' || MediaSource.isTypeSupported(contentType))
    if (!progressiveSupported) { fallbackMode.current = true; return }
    const source = new MediaSource(); mediaSource.current = source
    objectUrl.current = URL.createObjectURL(source); element.src = objectUrl.current
    const onOpen = () => {
      if (source.readyState !== 'open' || audioEnded.current) return
      try {
        const buffer = source.addSourceBuffer(contentType); sourceBuffer.current = buffer
        const onUpdate = () => drainQueue()
        const onBufferError = () => playbackFailed()
        const onAbort = () => { if (!audioEnded.current) playbackFailed() }
        buffer.addEventListener('updateend', onUpdate); buffer.addEventListener('error', onBufferError); buffer.addEventListener('abort', onAbort)
        playbackListeners.current.push(
          () => buffer.removeEventListener('updateend', onUpdate),
          () => buffer.removeEventListener('error', onBufferError),
          () => buffer.removeEventListener('abort', onAbort),
        )
        drainQueue(); void requestPlay()
      } catch { playbackFailed() }
    }
    source.addEventListener('sourceopen', onOpen, { once:true })
    const onSourceError = () => playbackFailed()
    source.addEventListener('error', onSourceError)
    playbackListeners.current.push(
      () => source.removeEventListener('sourceopen', onOpen),
      () => source.removeEventListener('error', onSourceError),
    )
  }, [attachAudioListeners, drainQueue, playbackFailed, requestPlay, stopPlayback])

  const completeProviderAudio = useCallback(() => {
    if (audioEnded.current) return
    providerFinished.current = true; setPlaybackState('provider_stream_finished')
    if (fallbackMode.current) playFallback()
    else { setPlaybackState('media_buffer_draining'); drainQueue() }
  }, [drainQueue, playFallback])

  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data instanceof Blob) { void event.data.arrayBuffer().then(appendAudio); return }
    if (event.data instanceof ArrayBuffer) { appendAudio(event.data); return }
    let message: ProtocolMessage
    try { message = JSON.parse(String(event.data)) as ProtocolMessage } catch { return }
    if (message.protocol_version !== 1) { rememberError(CLOSE_ERRORS[4400]); return }
    if (message.type === 'session.ready') {
      if (message.state === 'listening') {
        readyForAudio.current = true; setPhase('listening'); setCannotHear(false)
        readyWaiter.current?.resolve(); readyWaiter.current = null
      }
      if (typeof message.preroll_ms === 'number') preRollMs.current = message.preroll_ms
      if (typeof message.barge_in_min_ms === 'number') bargeMinMs.current = message.barge_in_min_ms
    } else if (message.type === 'state.changed') {
      const next = String(message.state) as VoicePhase
      if (['connecting','listening','endpoint_pending','thinking','speaking','interrupted','closing','error','closed'].includes(next)) {
        if (next === 'thinking' || next === 'speaking') setCannotHear(false)
        setPhase(next)
      }
    } else if (message.type === 'speech_start') setCannotHear(false)
    else if (message.type === 'stt.partial') { setCannotHear(false); setPartial(String(message.transcript ?? '')) }
    else if (message.type === 'stt.final') { setCannotHear(false); setPartial(String(message.transcript ?? '')); setPhase('thinking') }
    else if (message.type === 'assistant.start') { setAssistant(''); setPhase('thinking') }
    else if (message.type === 'assistant.delta') setAssistant(value => value + String(message.delta ?? ''))
    else if (message.type === 'audio.start') setupPlayback(String(message.content_type ?? 'audio/mpeg'))
    else if (message.type === 'audio.end') completeProviderAudio()
    else if (message.type === 'turn.done' && message.completion_status === 'complete') {
      const turn = message as ProtocolMessage & VoiceTurnDone
      onTurnDoneRef.current?.({
        thread_id:String(turn.thread_id), user_message_id:String(turn.user_message_id),
        assistant_message_id:String(turn.assistant_message_id), turn_number:Number(turn.turn_number),
        input_mode:'realtime_voice', completion_status:'complete',
      })
      setPartial('')
      if (audioEnded.current) setPhase('listening')
    } else if (message.type === 'warning' && message.code === 'assistant_interrupted') {
      stopPlayback('interrupted'); setPhase('interrupted')
    } else if (message.type === 'warning' && message.credit_bucket) setCreditRequired(message.credit_bucket as CreditBucket)
    else if (message.type === 'error') {
      const bucket = message.credit_bucket === 'chat' || message.credit_bucket === 'voice' ? message.credit_bucket : undefined
      rememberError({ code:String(message.code ?? 'voice_internal_failure'), message:String(message.message ?? 'Voice Mode stopped safely.'), ...(bucket ? { credit_bucket:bucket } : {}) })
    } else if (message.type === 'session.closed') { readyForAudio.current = false; setCannotHear(false); setPhase('closed') }
  }, [appendAudio, completeProviderAudio, rememberError, setupPlayback, stopPlayback])

  const sendPcm = useCallback((pcm: ArrayBuffer) => {
    const ws = socket.current
    if (!readyForAudio.current || !ws || ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount > 256 * 1024) {
      backpressureDroppedFrameCount.current += 1
      setMicrophoneDiagnostics(value => ({
        ...value, backpressureDroppedFrameCount:backpressureDroppedFrameCount.current,
      }))
      return false
    }
    const packet = new Uint8Array(4 + pcm.byteLength)
    new DataView(packet.buffer).setUint32(0, ++sequence.current); packet.set(new Uint8Array(pcm), 4); ws.send(packet)
    return true
  }, [])

  const cleanup = useCallback(async () => {
    closing.current = true; clearPing()
    readyForAudio.current = false
    readyWaiter.current?.reject(new Error('Voice session closed before it became ready.'))
    readyWaiter.current = null
    if (activeOwner === owner.current) activeOwner = null
    const ws = socket.current; socket.current = null
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'client_closed')
    worklet.current?.port.postMessage({ type:'shutdown' })
    if (worklet.current) worklet.current.port.onmessage = null
    worklet.current?.disconnect(); worklet.current = null
    const audioContext = context.current; context.current = null
    if (audioContext) await Promise.resolve(audioContext.close()).catch(() => undefined)
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null
    stopPlayback(); preRoll.current = []; preRollDuration.current = 0; voicedDuration.current = 0
    silenceDuration.current = 0; gateOpen.current = false; calibrationElapsed.current = 0
    calibrationEnergy.current = 0; calibrationFrames.current = 0; noGatedAudioMs.current = 0
    setCannotHear(false)
  }, [clearPing, stopPlayback])

  const start = useCallback(async () => {
    if (startInFlight.current) return startInFlight.current
    const operation = (async () => {
      if (activeOwner && activeOwner !== owner.current) { rememberError({ code:'voice_session_active', message:'Voice Mode is already open in this tab.' }); return }
      activeOwner = owner.current; closing.current = false; actionableError.current = null
      setError(''); setErrorCode(''); setErrorStatus(null); setCreditRequired(null); setPlaybackWarning(''); setCannotHear(false)
      setPhase('connecting'); setPartial(''); setAssistant(''); sequence.current = 0
      readyForAudio.current = false; emittedFrameCount.current = 0; backpressureDroppedFrameCount.current = 0
      try {
        let microphone: MediaStream
        try {
          microphone = await navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true } })
        } catch (caught) {
          const name = caught instanceof DOMException ? caught.name : ''
          if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('Microphone permission was denied. Allow microphone access and try again.')
          throw caught
        }
        stream.current = microphone
        if (closing.current) { microphone.getTracks().forEach(track => track.stop()); stream.current = null; return }
        const audioContext = new AudioContext(); context.current = audioContext
        await audioContext.audioWorklet.addModule('/audio-worklet.js')
        const source = audioContext.createMediaStreamSource(microphone)
        const node = new AudioWorkletNode(audioContext, 'swico-pcm16'); worklet.current = node
        const silent = audioContext.createGain(); silent.gain.value = 0
        source.connect(node); node.connect(silent); silent.connect(audioContext.destination)
        const microphoneTrack = microphone.getAudioTracks?.()[0] ?? microphone.getTracks()[0]
        if (collectDiagnostics) setMicrophoneDiagnostics(value => ({
          ...value,
          selectedDeviceLabel:microphoneTrack?.label || 'default microphone',
          browserSampleRate:Number(audioContext.sampleRate || 0), resampledSampleRate:16000,
          currentRms:0, calibratedNoiseFloor:0, activeThreshold:tuning.threshold_min,
          emittedFrameCount:0, backpressureDroppedFrameCount:0,
        }))
        let finishCalibration: (() => void) | null = null
        let calibrationFinished = false
        const calibrationComplete = new Promise<void>(resolve => { finishCalibration = resolve })
        const completeCalibration = () => {
          if (calibrationFinished) return
          calibrationFinished = true
          const floor = calibrationEnergy.current / Math.max(1, calibrationFrames.current)
          adaptiveThreshold.current = Math.min(
            tuning.threshold_max, Math.max(tuning.threshold_min, floor * tuning.noise_multiplier),
          )
          if (collectDiagnostics) setMicrophoneDiagnostics(value => ({
            ...value, calibratedNoiseFloor:floor, activeThreshold:adaptiveThreshold.current,
          }))
          finishCalibration?.()
        }
        const calibrationTimer = window.setTimeout(completeCalibration, tuning.calibration_ms)
        node.port.onmessage = (workletMessage: MessageEvent<{ type:string; pcm:ArrayBuffer; rms:number }>) => {
          if (workletMessage.data.type !== 'pcm') return
          const { pcm, rms } = workletMessage.data
          if (pcm.byteLength !== 1024) return
          const duration = pcm.byteLength / 2 / 16_000 * 1000
          emittedFrameCount.current += 1
          const now = performance.now()
          if (now - lastLevelUpdate.current >= 80) {
            lastLevelUpdate.current = now
            setMicrophoneLevel(Math.min(1, rms / Math.max(adaptiveThreshold.current, 0.01)))
            if (collectDiagnostics) setMicrophoneDiagnostics(value => ({
              ...value, currentRms:rms, activeThreshold:adaptiveThreshold.current,
              emittedFrameCount:emittedFrameCount.current,
              backpressureDroppedFrameCount:backpressureDroppedFrameCount.current,
            }))
          }
          if (!calibrationFinished) {
            calibrationElapsed.current += duration; calibrationEnergy.current += rms; calibrationFrames.current += 1
            if (calibrationElapsed.current >= tuning.calibration_ms) completeCalibration()
            return
          }
          if (mutedRef.current || !readyForAudio.current) return
          if (phaseRef.current === 'listening' || phaseRef.current === 'endpoint_pending') {
            noGatedAudioMs.current += duration
            if (noGatedAudioMs.current >= tuning.no_speech_warning_ms) setCannotHear(true)
          }
          const quietFallback = noGatedAudioMs.current >= 2_000 ? tuning.quiet_fallback : adaptiveThreshold.current
          const echoThreshold = phaseRef.current === 'speaking' ? Math.max(adaptiveThreshold.current * 2.2, 0.055) : 0
          const speaking = rms >= Math.max(Math.min(adaptiveThreshold.current, quietFallback), echoThreshold)
          preRoll.current.push({ pcm, duration }); preRollDuration.current += duration
          while (preRollDuration.current > preRollMs.current && preRoll.current.length > 1) {
            const removed = preRoll.current.shift(); preRollDuration.current -= removed?.duration ?? 0
          }
          if (speaking) { voicedDuration.current += duration; silenceDuration.current = 0 }
          else { voicedDuration.current = 0; silenceDuration.current += duration }
          if (!gateOpen.current && voicedDuration.current >= bargeMinMs.current) {
            gateOpen.current = true; noGatedAudioMs.current = 0; setCannotHear(false)
            for (const buffered of preRoll.current) sendPcm(buffered.pcm)
            preRoll.current = []; preRollDuration.current = 0; return
          }
          if (gateOpen.current) {
            sendPcm(pcm)
            if (silenceDuration.current >= 1_800) { gateOpen.current = false; silenceDuration.current = 0 }
          }
        }
        await calibrationComplete
        window.clearTimeout(calibrationTimer)
        if (closing.current) return

        const info = await apiJson<Ticket>(user, '/api/web/voice/sessions', { method:'POST' })
        if (closing.current) return
        setTicketInfo(info)
        const url = validatedSocketUrl(info.websocket_url, info.approved_websocket_hosts)
        url.searchParams.set('ticket', info.ticket)
        const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; socket.current = ws
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const finish = (callback: () => void) => { if (!settled) { settled = true; window.clearTimeout(timeout); callback() } }
          const timeout = window.setTimeout(() => finish(() => reject(new Error('Voice connection timed out before opening.'))), OPEN_TIMEOUT_MS)
          ws.addEventListener('message', handleMessage)
          ws.addEventListener('close', event => {
            clearPing(); readyForAudio.current = false; setCannotHear(false)
            readyWaiter.current?.reject(new Error('Voice connection closed before it was ready.')); readyWaiter.current = null
            if (socket.current !== ws || closing.current || (event.code === 1000 && event.reason === 'client_closed')) return
            const mapped = CLOSE_ERRORS[event.code] ?? { code:'voice_network_interrupted', message:'Voice connection closed unexpectedly. Try again for a fresh session.' }
            if (!actionableError.current) rememberError(mapped)
            finish(() => reject(new Error(mapped.message)))
          })
          ws.addEventListener('error', () => {
            const value = { code:'voice_network_interrupted', message:'Voice connection failed before it was ready.' }
            if (!actionableError.current) rememberError(value)
            finish(() => reject(new Error(value.message)))
          })
          ws.addEventListener('open', () => finish(resolve), { once:true })
        })
        if (closing.current) { ws.close(1000, 'client_closed'); return }
        pingTimer.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ protocol_version:1, type:'ping' }))
        }, PING_INTERVAL_MS)
        let readyTimeout = 0
        const ready = new Promise<void>((resolve, reject) => {
          readyWaiter.current = {
            resolve:() => { window.clearTimeout(readyTimeout); resolve() },
            reject:error => { window.clearTimeout(readyTimeout); reject(error) },
          }
          readyTimeout = window.setTimeout(() => {
            readyWaiter.current = null
            reject(new Error('Voice connection opened but the listening session did not become ready.'))
          }, OPEN_TIMEOUT_MS)
        })
        ws.send(JSON.stringify({ protocol_version:1, type:'session.start', audio:{ encoding:'pcm_s16le', sample_rate:16000, channels:1, frame_samples:512 }, ...(initialThreadId.current ? { thread_id:initialThreadId.current } : {}) }))
        await ready
      } catch (caught) {
        const structured = caught instanceof ApiError ? apiVoiceError(caught) : null
        if (caught instanceof ApiError) setErrorStatus(caught.status)
        await cleanup()
        if (structured) rememberError(structured)
        else if (!actionableError.current && caught instanceof Error && caught.message.includes('Microphone permission')) rememberError({ code:'microphone_permission_denied', message:caught.message })
        else if (!actionableError.current) rememberError({ code:'voice_network_interrupted', message:caught instanceof Error ? caught.message : 'Voice Mode could not start.' })
      }
    })()
    startInFlight.current = operation
    try { await operation } finally { startInFlight.current = null }
  }, [cleanup, clearPing, collectDiagnostics, handleMessage, rememberError, sendPcm, tuning, user])

  useEffect(() => {
    const timer = window.setTimeout(() => void start(), 0)
    return () => { window.clearTimeout(timer); void cleanup() }
  }, [cleanup, start])

  useEffect(() => {
    const unload = () => {
      readyForAudio.current = false
      const ws = socket.current
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'client_closed')
      stream.current?.getTracks().forEach(track => track.stop())
    }
    window.addEventListener('pagehide', unload)
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('pagehide', unload)
      window.removeEventListener('beforeunload', unload)
    }
  }, [])

  const retry = useCallback(async () => {
    const pending = startInFlight.current
    if (pending) await pending
    await cleanup(); closing.current = false; await start()
  }, [cleanup, start])
  const toggleMute = useCallback(() => setMuted(value => {
    const next = !value
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ protocol_version:1, type:next ? 'mute' : 'unmute' }))
    if (next) {
      gateOpen.current = false; preRoll.current = []; preRollDuration.current = 0
      noGatedAudioMs.current = 0; setMicrophoneLevel(0); setCannotHear(false)
    }
    return next
  }), [])
  const manualPlay = useCallback(async () => { await requestPlay() }, [requestPlay])
  const skipPlayback = useCallback(() => { stopPlayback('playback_finished'); setPlaybackWarning(''); if (!closing.current) setPhase('listening') }, [stopPlayback])
  const end = useCallback(async () => {
    setPhase('closing')
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ protocol_version:1, type:'session.close' }))
    await cleanup(); setPhase('closed')
  }, [cleanup])

  return {
    phase, playbackState, partial, assistant, muted, error, errorCode, errorStatus, playbackWarning,
    ticketInfo, creditRequired, microphoneLevel, cannotHear, microphoneDiagnostics,
    toggleMute, manualPlay, skipPlayback, retry, end,
  }
}
