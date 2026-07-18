import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { transcribeAudio } from '../api/client'
import type { AudioRecorderState } from '../types'

const MAX_RECORDING_SECONDS = 300
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]

const initialState: AudioRecorderState = {
  status: 'idle', elapsed_seconds: 0, mime_type: null, error: null,
}

function recorderError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : String((error as { name?: unknown })?.name ?? '')
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied. Allow microphone access in your browser settings and try again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect a microphone and try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is unavailable or is being used by another application.'
  }
  return 'Voice dictation could not start. Please try again.'
}

function preferredMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  if (typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_CANDIDATES.find(value => MediaRecorder.isTypeSupported(value)) ?? ''
}

export function useAudioRecorder({
  user,
  enabled,
  onTranscript,
  transcribe = transcribeAudio,
}: {
  user: User | null;
  enabled: boolean;
  onTranscript: (text: string) => void;
  transcribe?: typeof transcribeAudio;
}) {
  const [state, setState] = useState<AudioRecorderState>(initialState)
  const stateRef = useRef(state)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)
  const intervalRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const operationRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => { stateRef.current = state }, [state])

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current)
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current)
    intervalRef.current = null
    maxTimerRef.current = null
  }, [])

  const stopTracks = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach(track => track.stop())
  }, [])

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    clearTimers()
    setState(value => ({ ...value, status: 'stopping' }))
    stopTracks()
    recorder.stop()
  }, [clearTimers, stopTracks])

  const cancel = useCallback(() => {
    operationRef.current += 1
    cancelledRef.current = true
    clearTimers()
    stopTracks()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    recorderRef.current = null
    chunksRef.current = []
    stateRef.current = initialState
    if (mountedRef.current) setState(initialState)
  }, [clearTimers, stopTracks])

  const start = useCallback(async () => {
    if (!enabled || !user) return
    if (!['idle', 'error'].includes(stateRef.current.status)) return
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState({ ...initialState, status: 'error', error: 'Voice recording is not supported by this browser.' })
      return
    }
    const operation = operationRef.current + 1
    operationRef.current = operation
    cancelledRef.current = false
    const requestingState: AudioRecorderState = { ...initialState, status: 'requesting' }
    stateRef.current = requestingState
    setState(requestingState)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mountedRef.current || operationRef.current !== operation) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = stream
      const mimeType = preferredMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        cancelledRef.current = true
        operationRef.current += 1
        clearTimers(); stopTracks(); recorderRef.current = null; chunksRef.current = []
        if (mountedRef.current) setState({ ...initialState, status: 'error', error: 'The recording failed. Please try again.' })
      }
      recorder.onstop = () => {
        clearTimers(); stopTracks(); recorderRef.current = null
        const chunks = chunksRef.current
        chunksRef.current = []
        if (cancelledRef.current || !mountedRef.current) return
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
        if (!blob.size) {
          setState({ ...initialState, status: 'error', error: 'No audio was recorded. Please try again.' })
          return
        }
        setState(value => ({ ...value, status: 'transcribing', error: null }))
        void transcribe(user, blob).then(result => {
          if (!mountedRef.current || operationRef.current !== operation) return
          onTranscript(result.transcript)
          setState(initialState)
        }).catch(() => {
          if (mountedRef.current && operationRef.current === operation) {
            setState({ ...initialState, status: 'error', error: 'The recording could not be transcribed. Please try again.' })
          }
        })
      }
      recorder.start(250)
      startedAtRef.current = Date.now()
      setState({ status: 'recording', elapsed_seconds: 0, mime_type: recorder.mimeType || mimeType || null, error: null })
      intervalRef.current = window.setInterval(() => {
        const elapsed = Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - startedAtRef.current) / 1000))
        setState(value => ({ ...value, elapsed_seconds: elapsed }))
      }, 250)
      maxTimerRef.current = window.setTimeout(stop, MAX_RECORDING_SECONDS * 1000)
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop())
      stopTracks(); clearTimers(); recorderRef.current = null
      if (mountedRef.current && operationRef.current === operation) {
        setState({ ...initialState, status: 'error', error: recorderError(error) })
      }
    }
  }, [clearTimers, enabled, onTranscript, stop, stopTracks, transcribe, user])

  const resetError = useCallback(() => setState(initialState), [])

  useEffect(() => () => {
    mountedRef.current = false
    operationRef.current += 1
    cancelledRef.current = true
    clearTimers()
    stopTracks()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    recorderRef.current = null
    chunksRef.current = []
  }, [clearTimers, stopTracks])

  return { state, start, stop, cancel, resetError }
}
