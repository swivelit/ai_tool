import type { User } from 'firebase/auth'
import type { SSEEvent } from '../types'
import { publicConfig } from '../config/publicConfig'
import { consumeSSE } from './sse'

export const API_BASE = publicConfig.apiBaseUrl.replace(/\/$/, '')

function apiDetailMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('detail' in body)) return null
  const detail = (body as { detail: unknown }).detail
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const message = (detail as { message: unknown }).message
    return typeof message === 'string' && message.trim() ? message : null
  }
  return null
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(apiDetailMessage(body) ?? `Request failed (${status})`)
  }
}

export class ApiNetworkError extends Error {
  constructor() { super('We could not reach the server. Please try again.') }
}

export class SSEStreamError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export async function publicApiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new ApiNetworkError()
  }
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw new ApiError(response.status, body)
  return body as T
}

export async function authorizedFetch(user: User, path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await user.getIdToken(!retry)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (response.status === 401 && retry) {
    await user.getIdToken(true)
    return authorizedFetch(user, path, init, false)
  }
  return response
}

export async function apiJson<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  const response = await authorizedFetch(user, path, init)
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw new ApiError(response.status, body)
  return body as T
}

export async function streamChat(
  user: User, payload: { request_id: string; message: string; thread_id?: string },
  onEvent: (event: SSEEvent) => void, signal: AbortSignal,
) {
  const response = await authorizedFetch(user, '/api/web/chat/stream', { method: 'POST', body: JSON.stringify(payload), signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as unknown
    throw new ApiError(response.status, body)
  }
  let streamError: SSEStreamError | null = null
  await consumeSSE(response, event => {
    onEvent(event)
    if (event.event === 'error') {
      const data = typeof event.data === 'object' && event.data ? event.data as Record<string, unknown> : {}
      streamError = new SSEStreamError(String(data.code ?? 'generation_failed'), String(data.message ?? 'Generation failed.'))
    }
  }, signal)
  if (streamError) throw streamError
}
