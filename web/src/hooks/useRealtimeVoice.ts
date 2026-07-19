import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { ApiError, apiJson } from '../api/client'
import type { CreditBucket, Wallets } from '../types'

export type VoicePhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error' | 'closed'
type Ticket = {
  protocol_version: 1; session_id: string; ticket: string; websocket_url: string;
  tier: string; tier_label: string; language: 'en' | 'ta'; wallets: Wallets;
}
type ProtocolMessage = { protocol_version: 1; type: string; [key: string]: unknown }

let activeOwner: symbol | null = null

export function useRealtimeVoice({ user, threadId }: {
  user: User; threadId: string | null;
}) {
  const owner = useRef(Symbol('voice-session'))
  const [phase, setPhase] = useState<VoicePhase>('connecting')
  const [partial, setPartial] = useState('')
  const [assistant, setAssistant] = useState('')
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
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

  useEffect(() => { mutedRef.current = muted }, [muted])
  useEffect(() => { phaseRef.current = phase }, [phase])

  const stopPlayback = useCallback(() => {
    audio.current?.pause()
    audioQueue.current = []
    if (sourceBuffer.current?.updating) {
      try { sourceBuffer.current.abort() } catch { /* already detached */ }
    }
  }, [])

  const cleanup = useCallback(() => {
    closing.current = true
    socket.current?.removeEventListener('message', handleMessage)
    socket.current?.close()
    socket.current = null
    if (worklet.current) worklet.current.port.onmessage = null
    worklet.current?.disconnect(); worklet.current = null
    if (context.current) void Promise.resolve(context.current.close()).catch(() => undefined)
    context.current = null
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null
    stopPlayback()
    audio.current = null; sourceBuffer.current = null; mediaSource.current = null
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
    if (activeOwner === owner.current) activeOwner = null
  // handleMessage is stable for the life of this hook and cleanup is invoked on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPlayback])

  const appendAudio = useCallback((chunk: ArrayBuffer) => {
    const buffer = sourceBuffer.current
    if (!buffer || buffer.updating || audioQueue.current.length) {
      if (audioQueue.current.length < 32) audioQueue.current.push(chunk)
      return
    }
    try { buffer.appendBuffer(chunk) } catch { setError('Audio playback could not continue.') }
  }, [])

  const setupPlayback = useCallback(() => {
    stopPlayback()
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    const element = new Audio()
    const source = new MediaSource()
    const url = URL.createObjectURL(source)
    objectUrl.current = url; audio.current = element; mediaSource.current = source
    element.src = url
    source.addEventListener('sourceopen', () => {
      if (source.readyState !== 'open') return
      const buffer = source.addSourceBuffer('audio/mpeg')
      sourceBuffer.current = buffer
      buffer.addEventListener('updateend', () => {
        const next = audioQueue.current.shift()
        if (next && !buffer.updating) buffer.appendBuffer(next)
      })
      void element.play().catch(() => setError('Press Unmute to allow audio playback.'))
    }, { once: true })
  }, [stopPlayback])

  function handleMessage(event: MessageEvent) {
    if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then(value => appendAudio(value.slice(4)))
      return
    }
    if (event.data instanceof ArrayBuffer) { appendAudio(event.data.slice(4)); return }
    let message: ProtocolMessage
    try { message = JSON.parse(String(event.data)) as ProtocolMessage } catch { return }
    if (message.protocol_version !== 1) { setError('Voice protocol mismatch.'); setPhase('error'); return }
    if (message.type === 'session.ready' && message.state === 'listening') setPhase('listening')
    else if (message.type === 'stt.partial') setPartial(String(message.transcript ?? ''))
    else if (message.type === 'stt.final') { setPartial(String(message.transcript ?? '')); setAssistant(''); setPhase('thinking') }
    else if (message.type === 'assistant.start') { setAssistant(''); setPhase('thinking') }
    else if (message.type === 'assistant.delta') setAssistant(value => value + String(message.delta ?? ''))
    else if (message.type === 'audio.start') { setPhase('speaking'); setupPlayback() }
    else if (message.type === 'audio.end') setPhase('listening')
    else if (message.type === 'turn.done') { setPartial(''); setPhase('listening') }
    else if (message.type === 'warning' && message.code === 'assistant_interrupted') setPhase('interrupted')
    else if (message.type === 'warning' && message.credit_bucket) setCreditRequired(message.credit_bucket as CreditBucket)
    else if (message.type === 'error') {
      if (message.credit_bucket) setCreditRequired(message.credit_bucket as CreditBucket)
      setError(String(message.message ?? 'Voice Mode stopped.')); setPhase('error')
    } else if (message.type === 'session.closed') setPhase('closed')
  }

  const start = useCallback(async () => {
    if (activeOwner && activeOwner !== owner.current) {
      setError('Voice Mode is already open in this tab.'); setPhase('error'); return
    }
    activeOwner = owner.current; closing.current = false
    try {
      const info = await apiJson<Ticket>(user, '/api/web/voice/sessions', { method: 'POST' })
      if (closing.current) return
      setTicketInfo(info)
      const url = new URL(info.websocket_url)
      url.searchParams.set('ticket', info.ticket)
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'; socket.current = ws
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true })
        ws.addEventListener('error', () => reject(new Error('Voice connection failed.')), { once: true })
      })
      ws.addEventListener('message', handleMessage)
      ws.addEventListener('close', () => { if (!closing.current) { setError('Voice connection closed. Start again to reconnect safely.'); setPhase('error') } })
      ws.send(JSON.stringify({ protocol_version: 1, type: 'session.start', audio: { encoding: 'pcm_s16le', sample_rate: 16000, channels: 1 }, ...(threadId ? { thread_id: threadId } : {}) }))
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      stream.current = microphone
      const audioContext = new AudioContext(); context.current = audioContext
      await audioContext.audioWorklet.addModule('/audio-worklet.js')
      const source = audioContext.createMediaStreamSource(microphone)
      const node = new AudioWorkletNode(audioContext, 'swico-pcm16'); worklet.current = node
      const silent = audioContext.createGain(); silent.gain.value = 0
      source.connect(node); node.connect(silent); silent.connect(audioContext.destination)
      node.port.onmessage = (message: MessageEvent<{ type: string; pcm: ArrayBuffer; rms: number }>) => {
        if (mutedRef.current || socket.current?.readyState !== WebSocket.OPEN) return
        if (phaseRef.current === 'speaking' && message.data.rms > 0.035) {
          stopPlayback(); socket.current.send(JSON.stringify({ protocol_version: 1, type: 'interrupt' })); setPhase('interrupted')
        }
        if (socket.current.bufferedAmount > 256 * 1024) return
        const packet = new Uint8Array(4 + message.data.pcm.byteLength)
        new DataView(packet.buffer).setUint32(0, ++sequence.current)
        packet.set(new Uint8Array(message.data.pcm), 4)
        socket.current.send(packet)
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 402 && caught.body && typeof caught.body === 'object') {
        const detail = 'error' in caught.body ? (caught.body as { error?: unknown }).error : undefined
        if (detail && typeof detail === 'object' && 'credit_bucket' in detail) {
          const bucket = (detail as { credit_bucket?: unknown }).credit_bucket
          if (bucket === 'chat' || bucket === 'voice') setCreditRequired(bucket)
        }
      }
      cleanup(); setError(caught instanceof Error ? caught.message : 'Voice Mode could not start.'); setPhase('error')
    }
  // handleMessage intentionally belongs to this session instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup, setupPlayback, stopPlayback, threadId, user])

  useEffect(() => {
    // Deferring one task prevents React development Strict Mode's discarded
    // first effect pass from minting an extra billable session ticket.
    const timer = window.setTimeout(() => void start(), 0)
    return () => { window.clearTimeout(timer); cleanup() }
  }, [cleanup, start])
  const toggleMute = useCallback(() => setMuted(value => {
    const next = !value
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ protocol_version: 1, type: next ? 'mute' : 'unmute' }))
    }
    return next
  }), [])
  const end = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ protocol_version: 1, type: 'session.close' }))
    cleanup(); setPhase('closed')
  }, [cleanup])
  return { phase, partial, assistant, muted, error, ticketInfo, creditRequired, toggleMute, end }
}
