import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ApiNetworkError, authorizedFetch, publicApiJson, SSEStreamError, streamChat } from './client'

describe('authorizedFetch', () => {
  afterEach(() => vi.restoreAllMocks())
  it('attaches a Firebase bearer token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const user = { getIdToken: vi.fn().mockResolvedValue('firebase-token') }
    await authorizedFetch(user as never, '/api/web/bootstrap')
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer firebase-token')
  })
  it('refreshes an expired token once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{}'))
    const user = { getIdToken: vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('fresh').mockResolvedValueOnce('fresh') }
    const response = await authorizedFetch(user as never, '/x')
    expect(response.ok).toBe(true); expect(user.getIdToken).toHaveBeenCalledWith(true)
  })
  it('does not set application/json Content-Type for FormData', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const user = { getIdToken: vi.fn().mockResolvedValue('firebase-token') }
    const body = new FormData(); body.append('file', new Blob(['hello'], { type:'text/plain' }), 'notes.txt')
    await authorizedFetch(user as never, '/api/web/uploads', { method:'POST', body })
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.has('Content-Type')).toBe(false)
  })
})

it('treats an event:error as a failed stream even when HTTP status is 200', async () => {
  const body = 'event: error\ndata: {"code":"provider_failed","message":"Try again"}\n\n'
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
  const user = { getIdToken: vi.fn().mockResolvedValue('token') }
  const seen = vi.fn()
  await expect(streamChat(user as never, { request_id:'r', message:'hello', input_mode:'text' }, seen, new AbortController().signal)).rejects.toBeInstanceOf(SSEStreamError)
  expect(seen).toHaveBeenCalledWith({ event:'error', data:{ code:'provider_failed', message:'Try again' } })
})

it('preserves a structured FastAPI error message', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    detail: { code: 'otp_cooldown', message: 'Please wait 42 seconds before requesting another code.' },
  }), { status: 429, headers: { 'Content-Type': 'application/json' } }))

  await expect(publicApiJson('/auth/email-otp/signup/request')).rejects.toMatchObject({
    status: 429,
    message: 'Please wait 42 seconds before requesting another code.',
  } satisfies Partial<ApiError>)
})

it('maps fetch failures to a frontend-safe network error', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

  await expect(publicApiJson('/auth/email-otp/signup/request')).rejects.toEqual(
    new ApiNetworkError(),
  )
})
