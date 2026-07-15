import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizedFetch } from './client'

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
})
