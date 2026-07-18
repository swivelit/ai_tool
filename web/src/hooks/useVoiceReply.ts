import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { ApiError, synthesizeAudio } from '../api/client'
import type { VoiceReplyState, Wallet } from '../types'

type CachedReply = {
  blob: Blob
  url: string
  audio: HTMLAudioElement
  voiceTurnId: string
}

function audioBlob(base64: string, mimeType: string): Blob {
  const normalized = base64.trim()
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('The voice reply audio was invalid.')
  }
  const binary = window.atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType || 'audio/wav' })
}

export function useVoiceReply({
  user,
  scopeKey,
  enabled,
  onWallet,
}: {
  user: User | null
  scopeKey: string
  enabled: boolean
  onWallet?: (wallet: Wallet) => void
}) {
  const [states, setStates] = useState<Record<string, VoiceReplyState>>({})
  const cacheRef = useRef(new Map<string, CachedReply>())
  const inflightRef = useRef(new Map<string, AbortController>())
  const currentRef = useRef<string | null>(null)
  const generationRef = useRef(0)

  const update = useCallback((messageId: string, next: VoiceReplyState) => {
    setStates(value => ({ ...value, [messageId]: next }))
  }, [])

  const clearResources = useCallback(() => {
    generationRef.current += 1
    inflightRef.current.forEach(controller => controller.abort())
    inflightRef.current.clear()
    cacheRef.current.forEach(item => {
      item.audio.pause()
      item.audio.removeAttribute('src')
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(item.url)
    })
    cacheRef.current.clear()
    currentRef.current = null
  }, [])

  useEffect(() => {
    clearResources()
    setStates({})
    return clearResources
  }, [clearResources, scopeKey, user])

  const pauseCurrent = useCallback((exceptMessageId?: string) => {
    const current = currentRef.current
    if (!current || current === exceptMessageId) return
    cacheRef.current.get(current)?.audio.pause()
  }, [])

  const play = useCallback(async (messageId: string) => {
    const item = cacheRef.current.get(messageId)
    if (!item) return
    pauseCurrent(messageId)
    currentRef.current = messageId
    if (item.audio.ended) item.audio.currentTime = 0
    try {
      await item.audio.play()
    } catch {
      update(messageId, { status: 'ready', error: null, insufficientCredits: false })
    }
  }, [pauseCurrent, update])

  const pause = useCallback((messageId: string) => {
    cacheRef.current.get(messageId)?.audio.pause()
  }, [])

  const generate = useCallback(async (
    messageId: string, voiceTurnId: string, autoPlay = true,
  ) => {
    if (!enabled || !user || !messageId || !voiceTurnId) return
    if (cacheRef.current.has(messageId)) {
      if (autoPlay) await play(messageId)
      return
    }
    if (inflightRef.current.has(messageId)) return
    const controller = new AbortController()
    const generation = generationRef.current
    inflightRef.current.set(messageId, controller)
    update(messageId, { status: 'generating', error: null, insufficientCredits: false })
    try {
      const result = await synthesizeAudio(user, {
        operation_id: crypto.randomUUID(), message_id: messageId, voice_turn_id: voiceTurnId,
      }, controller.signal)
      if (controller.signal.aborted || generation !== generationRef.current) return
      const blob = audioBlob(result.audio_base64, result.mime_type)
      const url = URL.createObjectURL(blob)
      const audio = document.createElement('audio')
      audio.preload = 'auto'
      audio.src = url
      const cached: CachedReply = { blob, url, audio, voiceTurnId }
      cacheRef.current.set(messageId, cached)
      audio.addEventListener('play', () => update(messageId, { status: 'playing', error: null, insufficientCredits: false }))
      audio.addEventListener('pause', () => {
        if (!audio.ended) update(messageId, { status: 'paused', error: null, insufficientCredits: false })
      })
      audio.addEventListener('ended', () => {
        if (currentRef.current === messageId) currentRef.current = null
        update(messageId, { status: 'ended', error: null, insufficientCredits: false })
      })
      audio.addEventListener('error', () => update(messageId, {
        status: 'error', error: 'This voice reply could not be played.', insufficientCredits: false,
      }))
      onWallet?.(result.wallet)
      update(messageId, { status: 'ready', error: null, insufficientCredits: false })
      if (autoPlay) await play(messageId)
    } catch (error) {
      if (controller.signal.aborted || generation !== generationRef.current) return
      const insufficient = error instanceof ApiError && error.status === 402
      const canRetry = error instanceof ApiError && error.status !== 409
      update(messageId, {
        status: 'error',
        error: insufficient
          ? 'Not enough Voice credits to play this reply'
          : error instanceof ApiError ? error.message
            : 'Voice reply status could not be confirmed. It was not retried to avoid a duplicate charge.',
        insufficientCredits: insufficient,
        canRetry,
      })
    } finally {
      if (inflightRef.current.get(messageId) === controller) inflightRef.current.delete(messageId)
    }
  }, [enabled, onWallet, play, update, user])

  const retry = useCallback((messageId: string, voiceTurnId: string) => {
    void generate(messageId, voiceTurnId, true)
  }, [generate])

  return { states, generate, play, pause, retry, clear: clearResources }
}
