import { describe, expect, it, vi } from 'vitest'
import { consumeSSE, SSEParser } from './sse'

describe('SSEParser', () => {
  it('assembles split chunks and multiline data', () => {
    const parser = new SSEParser()
    expect(parser.push('event: del')).toEqual([])
    expect(parser.push('ta\ndata: {"text":"hel')).toEqual([])
    expect(parser.push('lo"}\n\nevent: done\ndata: {"ok":true}\n\n')).toEqual([
      { event: 'delta', data: { text: 'hello' } }, { event: 'done', data: { ok: true } },
    ])
  })
  it('supports comments and plain text data', () => {
    const parser = new SSEParser()
    expect(parser.push(': ping\nevent: status\ndata: working\n\n')).toEqual([{ event: 'status', data: 'working' }])
  })
})

it('aborts stream consumption', async () => {
  const abort = new AbortController()
  const reader = { read: vi.fn(async () => { abort.abort(); return { value: new TextEncoder().encode('event: x\ndata: {}\n\n'), done: false } }), releaseLock: vi.fn() }
  const response = { body: { getReader: () => reader } } as unknown as Response
  await expect(consumeSSE(response, vi.fn(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(reader.releaseLock).toHaveBeenCalled()
})
