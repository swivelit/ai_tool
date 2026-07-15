import type { SSEEvent } from '../types'

export class SSEParser {
  private buffer = ''

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const events: SSEEvent[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const parsed = this.parseFrame(frame)
      if (parsed) events.push(parsed)
      boundary = this.buffer.indexOf('\n\n')
    }
    return events
  }

  finish(): SSEEvent[] {
    if (!this.buffer.trim()) return []
    const parsed = this.parseFrame(this.buffer)
    this.buffer = ''
    return parsed ? [parsed] : []
  }

  private parseFrame(frame: string): SSEEvent | null {
    let event = 'message'
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      if (field === 'data') data.push(value)
    }
    if (!data.length) return null
    const raw = data.join('\n')
    try { return { event, data: JSON.parse(raw) as unknown } }
    catch { return { event, data: raw } }
  }
}

export async function consumeSSE(response: Response, onEvent: (event: SSEEvent) => void, signal?: AbortSignal) {
  if (!response.body) throw new Error('Streaming response body is unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SSEParser()
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      for (const event of parser.push(decoder.decode(value, { stream: true }))) onEvent(event)
    }
    for (const event of parser.push(decoder.decode())) onEvent(event)
    for (const event of parser.finish()) onEvent(event)
  } finally {
    reader.releaseLock()
  }
}
