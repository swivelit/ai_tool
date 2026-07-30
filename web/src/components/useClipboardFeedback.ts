import { useCallback, useEffect, useRef, useState } from 'react'

export type ClipboardFeedbackState = 'idle' | 'copied' | 'failed'

export function useClipboardFeedback(content: string, resetAfterMs = 1200) {
  const [copyState, setCopyState] = useState<ClipboardFeedbackState>('idle')
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const copy = useCallback(async () => {
    clearTimer()
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable')
      }
      await navigator.clipboard.writeText(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    timerRef.current = window.setTimeout(() => {
      setCopyState('idle')
      timerRef.current = null
    }, resetAfterMs)
  }, [clearTimer, content, resetAfterMs])

  return { copy, copyState }
}
