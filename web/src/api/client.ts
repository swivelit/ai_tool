import type { User } from 'firebase/auth'
import type { ReadyAttachment, SSEEvent } from '../types'
import { publicConfig } from '../config/publicConfig'
import { consumeSSE } from './sse'

export const API_BASE = publicConfig.apiBaseUrl.replace(/\/$/, '')

function apiDetailMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  if ('error' in body) {
    const error = (body as { error: unknown }).error
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message: unknown }).message
      if (typeof message === 'string' && message.trim()) return message
    }
  }
  if (!('detail' in body)) return null
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
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (init.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
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
  user: User, payload: { request_id: string; message: string; thread_id?: string; attachment_ids?: string[] },
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

export async function uploadDocument(
  user: User, file: File, onProgress?: (progress: number) => void,
): Promise<ReadyAttachment> {
  const form = new FormData()
  form.append('file', file, file.name)
  const send = (token: string) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${API_BASE}/api/web/uploads`)
    request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)))
    }
    request.onerror = () => reject(new ApiNetworkError())
    request.onabort = () => reject(new ApiNetworkError())
    request.onload = () => {
      let body: unknown = {}
      try { body = JSON.parse(request.responseText || '{}') as unknown } catch { body = {} }
      resolve({ status:request.status, body })
    }
    onProgress?.(0)
    request.send(form)
  })
  let result = await send(await user.getIdToken())
  if (result.status === 401) result = await send(await user.getIdToken(true))
  if (result.status < 200 || result.status >= 300) throw new ApiError(result.status, result.body)
  onProgress?.(100)
  return result.body as ReadyAttachment
}

export async function deleteUpload(user: User, uploadId: string): Promise<void> {
  const response = await authorizedFetch(user, `/api/web/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as unknown
    throw new ApiError(response.status, body)
  }
}

export async function transcribeAudio(
  user: User, blob: Blob,
): Promise<{ transcript: string; detected_language: string; duration_seconds: number }> {
  const extension = blob.type.includes('mp4') ? 'mp4' : 'webm'
  const form = new FormData()
  form.append('file', blob, `recording.${extension}`)
  const response = await authorizedFetch(user, '/api/web/audio/transcribe', { method: 'POST', body: form })
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw new ApiError(response.status, body)
  return body as { transcript: string; detected_language: string; duration_seconds: number }
}
