import type { User } from 'firebase/auth'
import type { InputMode, KnowledgeDocument, KnowledgeDocumentResult, KnowledgeJobSummary, LongInputMode, QualityCheckStatus, QualityOutcome, ReadyAttachment, RepositorySnapshot, ResponseQuality, SSEEvent, SourceSummary, SynthesisResponse, TranscriptionResponse } from '../types'
import { publicConfig } from '../config/publicConfig'
import { consumeSSE } from './sse'

export const API_BASE = publicConfig.apiBaseUrl.replace(/\/$/, '')
export const GUEST_TOKEN_STORAGE_KEY = 'swico:guest-session:v1:token'

export type GuestSession = {
  guest_token: string
  expires_at: string
  assistant: { tier: 'free'; tier_label: 'Swico Free' }
  limits: { max_message_characters: number; daily_message_limit: number }
}

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
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public retry_at: string | null = null,
  ) { super(message) }
}

function normalizeSourcesEvent(event: SSEEvent): SSEEvent {
  if (event.event !== 'sources' || !event.data || typeof event.data !== 'object') return event
  const values = (event.data as { sources?: unknown }).sources
  if (!Array.isArray(values)) return { event: 'sources', data: { sources: [] } }
  const sources = values.filter(value => value && typeof value === 'object').map(value => {
    const source = value as Record<string, unknown>
    return {
      id: String(source.id ?? '').slice(0, 16),
      label: String(source.label ?? '').slice(0, 128),
      locator: String(source.locator ?? '').slice(0, 256),
      confidence: Math.max(0, Math.min(1, Number(source.confidence ?? 0))),
      source_kind: String(source.source_kind ?? '').slice(0, 32),
    } satisfies SourceSummary
  }).filter(source => source.id && source.label && source.locator)
  return { event: 'sources', data: { sources } }
}

function normalizeQualityEvent(event: SSEEvent): SSEEvent {
  if (event.event !== 'quality' || !event.data || typeof event.data !== 'object') return event
  const data = event.data as Record<string, unknown>
  const status = String(data.status ?? '')
  const outcomes: QualityOutcome[] = ['verified', 'grounded', 'best_effort', 'unverified', 'insufficient_evidence']
  if (!outcomes.includes(status as QualityOutcome)) {
    return { event: 'quality', data: null }
  }
  const allowedChecks: QualityCheckStatus[] = ['passed', 'failed', 'warning', 'skipped', 'error']
  const checks = (Array.isArray(data.checks) ? data.checks : []).flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const check = value as Record<string, unknown>
    const type = String(check.type ?? '').slice(0, 64)
    const checkStatus = String(check.status ?? '')
    return type && allowedChecks.includes(checkStatus as QualityCheckStatus)
      ? [{ type, status: checkStatus as QualityCheckStatus }] : []
  })
  const quality: ResponseQuality = {
    status: status as QualityOutcome,
    retrieval_status: typeof data.retrieval_status === 'string'
      ? data.retrieval_status.slice(0, 32) : null,
    repository_validation_mode: ['static_only', 'executable', 'unavailable']
      .includes(String(data.repository_validation_mode ?? ''))
      ? data.repository_validation_mode as ResponseQuality['repository_validation_mode']
      : null,
    checks: checks.slice(0, 24),
  }
  return { event: 'quality', data: quality }
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

export function getStoredGuestToken(): string | null {
  try { return localStorage.getItem(GUEST_TOKEN_STORAGE_KEY) }
  catch { return null }
}

export function storeGuestToken(token: string): void {
  try { localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, token) }
  catch { /* Private browsing can disable storage; the page still works in memory. */ }
}

export function clearStoredGuestToken(): void {
  try { localStorage.removeItem(GUEST_TOKEN_STORAGE_KEY) }
  catch { /* Best effort. */ }
}

export async function createGuestSession(): Promise<GuestSession> {
  const session = await publicApiJson<GuestSession>('/api/web/guest/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  })
  storeGuestToken(session.guest_token)
  return session
}

async function guestFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Swico-Guest-Token', token)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  try { return await fetch(`${API_BASE}${path}`, { ...init, headers }) }
  catch { throw new ApiNetworkError() }
}

export async function streamGuestChat(
  token: string,
  payload: { request_id: string; message: string; thread_id?: string; input_mode: 'text' },
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal,
  onAccepted?: () => void,
) {
  const response = await guestFetch(token, '/api/web/guest/chat/stream', {
    method: 'POST', body: JSON.stringify(payload), signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as unknown
    throw new ApiError(response.status, body)
  }
  onAccepted?.()
  let streamError: SSEStreamError | null = null
  let terminalEventReceived = false
  await consumeSSE(response, event => {
    const normalizedEvent = normalizeQualityEvent(normalizeSourcesEvent(event))
    onEvent(normalizedEvent)
    if (event.event === 'done') terminalEventReceived = true
    if (event.event === 'error') {
      terminalEventReceived = true
      const data = typeof event.data === 'object' && event.data ? event.data as Record<string, unknown> : {}
      streamError = new SSEStreamError(
        String(data.code ?? 'generation_failed'), String(data.message ?? 'Generation failed.'),
        data.retryable === true, typeof data.retry_at === 'string' ? data.retry_at : null,
      )
    }
  }, signal)
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  if (streamError) throw streamError
  if (!terminalEventReceived) {
    const code = 'stream_interrupted'; const message = 'The connection ended before Swico finished. Retry.'
    onEvent({ event: 'error', data: { code, message } })
    throw new SSEStreamError(code, message)
  }
}

export async function cancelGuestChatRequest(token: string, requestId: string): Promise<{ status: string }> {
  const response = await guestFetch(token, `/api/web/guest/chat/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' })
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw new ApiError(response.status, body)
  return body as { status: string }
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
  user: User, payload: { request_id: string; message: string; thread_id?: string; attachment_ids?: string[]; repository_id?: string; input_mode: InputMode; voice_turn_id?: string; continue_message_id?: string; edit_message_id?: string; regenerate_message_id?: string },
  onEvent: (event: SSEEvent) => void, signal: AbortSignal, onAccepted?: () => void,
) {
  const response = await authorizedFetch(user, '/api/web/chat/stream', { method: 'POST', body: JSON.stringify(payload), signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as unknown
    throw new ApiError(response.status, body)
  }
  onAccepted?.()
  let streamError: SSEStreamError | null = null
  let terminalEventReceived = false
  await consumeSSE(response, event => {
    const normalizedEvent = normalizeQualityEvent(
      normalizeSourcesEvent(event),
    )
    onEvent(normalizedEvent)
    if (event.event === 'done') terminalEventReceived = true
    if (event.event === 'error') {
      terminalEventReceived = true
      const data = typeof event.data === 'object' && event.data ? event.data as Record<string, unknown> : {}
      streamError = new SSEStreamError(
        String(data.code ?? 'generation_failed'),
        String(data.message ?? 'Generation failed.'),
        data.retryable === true,
        typeof data.retry_at === 'string' ? data.retry_at : null,
      )
    }
  }, signal)
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  if (streamError) throw streamError
  if (!terminalEventReceived) {
    const code = 'stream_interrupted'
    const message = 'The connection ended before Swico finished. Retry.'
    onEvent({ event: 'error', data: { code, message } })
    throw new SSEStreamError(code, message)
  }
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

export async function approveKnowledgeDocument(
  user: User,
  uploadId: string,
): Promise<KnowledgeDocumentResult> {
  return apiJson<KnowledgeDocumentResult>(user, '/api/web/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      upload_id: uploadId,
      confirm_persistence: true,
    }),
  })
}

export async function listKnowledgeDocuments(
  user: User,
): Promise<KnowledgeDocument[]> {
  const result = await apiJson<{ items: KnowledgeDocument[] }>(
    user,
    '/api/web/knowledge',
  )
  return result.items
}

export async function deleteKnowledgeDocument(
  user: User,
  documentId: string,
): Promise<void> {
  await apiJson<void>(
    user,
    `/api/web/knowledge/${encodeURIComponent(documentId)}`,
    { method: 'DELETE' },
  )
}

export async function reindexKnowledgeDocument(
  user: User,
  documentId: string,
): Promise<KnowledgeDocumentResult> {
  return apiJson<KnowledgeDocumentResult>(
    user,
    `/api/web/knowledge/${encodeURIComponent(documentId)}/reindex`,
    {
      method: 'POST',
      body: JSON.stringify({ operation_id: crypto.randomUUID() }),
    },
  )
}

export async function getKnowledgeJobStatus(
  user: User,
  documentId: string,
): Promise<KnowledgeJobSummary> {
  const result = await apiJson<{ job: KnowledgeJobSummary }>(
    user,
    `/api/web/knowledge/${encodeURIComponent(documentId)}/job`,
  )
  return result.job
}

export async function cancelKnowledgeJob(
  user: User,
  documentId: string,
): Promise<KnowledgeJobSummary> {
  const result = await apiJson<{ job: KnowledgeJobSummary }>(
    user,
    `/api/web/knowledge/${encodeURIComponent(documentId)}/job`,
    { method: 'DELETE' },
  )
  return result.job
}

export async function uploadRepository(
  user: User, file: File, repositoryId: string,
  onProgress?: (progress: number) => void,
): Promise<RepositorySnapshot> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('repository_id', repositoryId)
  const send = (token: string) => new Promise<{
    status: number; body: unknown;
  }>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${API_BASE}/api/web/repositories`)
    request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.onprogress = event => {
      if (event.lengthComputable) {
        onProgress?.(Math.min(
          99, Math.max(0, Math.round((event.loaded / event.total) * 100)),
        ))
      }
    }
    request.onerror = () => reject(new ApiNetworkError())
    request.onabort = () => reject(new ApiNetworkError())
    request.onload = () => {
      let body: unknown = {}
      try {
        body = JSON.parse(request.responseText || '{}') as unknown
      } catch {
        body = {}
      }
      resolve({ status: request.status, body })
    }
    onProgress?.(0)
    request.send(form)
  })
  let result = await send(await user.getIdToken())
  if (result.status === 401) {
    result = await send(await user.getIdToken(true))
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(result.status, result.body)
  }
  onProgress?.(100)
  return result.body as RepositorySnapshot
}

export async function deleteRepository(
  user: User, repositoryId: string,
): Promise<void> {
  const response = await authorizedFetch(
    user,
    `/api/web/repositories/${encodeURIComponent(repositoryId)}`,
    { method: 'DELETE' },
  )
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as unknown
    throw new ApiError(response.status, body)
  }
}

export async function endVoiceSession(user: User): Promise<void> {
  await apiJson<void>(user, '/api/web/voice/sessions', { method:'DELETE' })
}

export async function uploadVirtualText(
  user: User, payload: { upload_id: string; text: string; operation: LongInputMode },
): Promise<ReadyAttachment> {
  return apiJson<ReadyAttachment>(user, '/api/web/uploads/text', {
    method: 'POST', body: JSON.stringify(payload),
  })
}

export async function transcribeAudio(
  user: User, blob: Blob, operationId: string, voiceTurnId: string, language?: string,
): Promise<TranscriptionResponse> {
  const extension = blob.type.includes('mp4') ? 'mp4' : 'webm'
  const form = new FormData()
  form.append('file', blob, `recording.${extension}`)
  form.append('operation_id', operationId)
  form.append('voice_turn_id', voiceTurnId)
  if (language) form.append('language', language)
  const response = await authorizedFetch(user, '/api/web/audio/transcribe', { method: 'POST', body: form })
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) throw new ApiError(response.status, body)
  return body as TranscriptionResponse
}

export async function synthesizeAudio(
  user: User, payload: { operation_id: string; message_id: string; voice_turn_id: string },
  signal?: AbortSignal,
): Promise<SynthesisResponse> {
  return apiJson<SynthesisResponse>(user, '/api/web/audio/synthesize', {
    method: 'POST', body: JSON.stringify(payload), signal,
  })
}
