import { ApiError, SSEStreamError } from './api/client'

export function chatErrorMessage(error: unknown, offline: boolean): string {
  if (offline) return 'You’re offline. Reconnect and try again.'
  if (error instanceof SSEStreamError) return error.message || 'The AI provider could not finish this response. Retry when you’re ready.'
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session expired. Sign in again to continue.'
    if (error.status === 402) {
      const payload = error.body && typeof error.body === 'object' && 'error' in error.body
        ? (error.body as { error?: { code?: string; reset_at?: string } }).error : undefined
      if (payload?.code === 'usage_limit_reached') {
        const reset = payload.reset_at ? ` It resets ${new Date(payload.reset_at).toLocaleString()}.` : ''
        return `Your monthly AI usage limit has been reached.${reset}`
      }
      return 'You need more AI credit to continue.'
    }
    if (error.status === 409) return 'That request is already being processed.'
    if (error.status === 422) return 'Review your message and try again.'
    if (error.status === 429) return 'You’re sending messages too quickly. Wait a moment and retry.'
    if (error.status >= 500) return 'The AI provider is temporarily unavailable. Your unused reservation will be released.'
  }
  return 'Swico could not finish that response. You can retry.'
}
