import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ApiNetworkError, authorizedFetch, endVoiceSession, publicApiJson, revokeCliSession, SSEStreamError, streamChat } from './client'

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

it('ends the authenticated Voice session with DELETE', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status:204 }))
  const user = { getIdToken:vi.fn().mockResolvedValue('firebase-token') }

  await endVoiceSession(user as never)

  expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/web/voice/sessions')
  expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE')
})

it('revokes the selected terminal session with an encoded DELETE path', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ status:'revoked' }), { status:200 }),
  )
  const user = { getIdToken:vi.fn().mockResolvedValue('firebase-token') }

  await revokeCliSession(user as never, 'terminal/123')

  expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/web/cli/sessions/terminal%2F123')
  expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE')
})

it('propagates generation_incomplete from an HTTP 200 SSE stream', async () => {
  const message = 'Swico reached its response limit before it could start the answer. Please retry.'
  const body = `event: error\ndata: {"code":"generation_incomplete","message":"${message}"}\n\n`
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
  const user = { getIdToken: vi.fn().mockResolvedValue('token') }
  const seen = vi.fn()
  await expect(streamChat(user as never, { request_id:'r', message:'hello', input_mode:'text' }, seen, new AbortController().signal)).rejects.toMatchObject({
    code: 'generation_incomplete',
    message,
  } satisfies Partial<SSEStreamError>)
  expect(seen).toHaveBeenCalledWith({ event:'error', data:{ code:'generation_incomplete', message } })
})

it('retains safe capacity metadata from an HTTP 200 SSE error', async () => {
  const retryAt = '2099-08-01T00:00:00+00:00'
  const body = `event: error\ndata: {"code":"service_budget_reached","message":"Swico has reached today’s service capacity.","retryable":true,"retry_at":"${retryAt}"}\n\n`
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status:200 }),
  )
  const user = { getIdToken:vi.fn().mockResolvedValue('token') }

  await expect(streamChat(
    user as never,
    { request_id:'capacity', message:'hello', input_mode:'text' },
    vi.fn(),
    new AbortController().signal,
  )).rejects.toMatchObject({
    code:'service_budget_reached',
    retryable:true,
    retry_at:retryAt,
  } satisfies Partial<SSEStreamError>)
})

describe('streamChat terminal events', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts EOF after a done event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'event: delta\ndata: {"text":"Done"}\n\nevent: done\ndata: {}\n\n',
      { status:200 },
    ))
    const seen = vi.fn()
    const user = { getIdToken:vi.fn().mockResolvedValue('token') }

    await expect(streamChat(
      user as never,
      { request_id:'done', message:'hello', input_mode:'text' },
      seen,
      new AbortController().signal,
    )).resolves.toBeUndefined()
    expect(seen).toHaveBeenLastCalledWith({ event:'done', data:{} })
  })

  it('normalizes quality events without retaining internal fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'event: quality\ndata: {"status":"grounded","retrieval_status":"sufficient","checks":[{"type":"citation_validity","status":"passed"}],"provider":"hidden","model":"hidden"}\n\nevent: done\ndata: {}\n\n',
      { status:200 },
    ))
    const seen = vi.fn()
    const user = { getIdToken:vi.fn().mockResolvedValue('token') }

    await streamChat(
      user as never,
      { request_id:'quality', message:'hello', input_mode:'text' },
      seen,
      new AbortController().signal,
    )
    expect(seen).toHaveBeenCalledWith({
      event:'quality',
      data:{
        status:'grounded',
        retrieval_status:'sufficient',
        repository_validation_mode:null,
        checks:[{ type:'citation_validity', status:'passed' }],
      },
    })
    expect(JSON.stringify(seen.mock.calls)).not.toMatch(/hidden/)
  })

  it('dispatches one synthetic retryable error before throwing on premature EOF', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'event: delta\ndata: {"text":"Partial"}\n\n',
      { status:200 },
    ))
    const seen = vi.fn()
    const user = { getIdToken:vi.fn().mockResolvedValue('token') }
    const expected = {
      event:'error',
      data:{
        code:'stream_interrupted',
        message:'The connection ended before Swico finished. Retry.',
      },
    }

    await expect(streamChat(
      user as never,
      { request_id:'early-eof', message:'hello', input_mode:'text' },
      seen,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code:'stream_interrupted',
      message:'The connection ended before Swico finished. Retry.',
    } satisfies Partial<SSEStreamError>)
    expect(seen).toHaveBeenCalledWith(expected)
    expect(seen.mock.calls.filter(([event]) => event.event === 'error')).toHaveLength(1)
  })

  it('does not synthesize a second error after an explicit backend error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'event: error\ndata: {"code":"generation_failed","message":"Retry."}\n\n',
      { status:200 },
    ))
    const seen = vi.fn()
    const user = { getIdToken:vi.fn().mockResolvedValue('token') }

    await expect(streamChat(
      user as never,
      { request_id:'backend-error', message:'hello', input_mode:'text' },
      seen,
      new AbortController().signal,
    )).rejects.toMatchObject({ code:'generation_failed', message:'Retry.' })
    expect(seen.mock.calls.filter(([event]) => event.event === 'error')).toHaveLength(1)
  })

  it('keeps an intentional abort distinct from premature EOF', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status:200 }))
    const abort = new AbortController()
    const seen = vi.fn()
    const user = { getIdToken:vi.fn().mockResolvedValue('token') }

    await expect(streamChat(
      user as never,
      { request_id:'stopped', message:'hello', input_mode:'text' },
      seen,
      abort.signal,
      () => abort.abort(),
    )).rejects.toMatchObject({ name:'AbortError' })
    expect(seen).not.toHaveBeenCalled()
  })
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
