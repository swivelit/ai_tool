export type SSEEvent = { event: string; data: unknown }

export class SSEParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSEParseError'
  }
}

export class SSEParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk
    const events: SSEEvent[] = []
    let boundary = this.buffer.indexOf('\n')
    while (boundary >= 0) {
      let line = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) {
        if (this.data.length) {
          const raw = this.data.join('\n')
          let value: unknown = raw
          try { value = JSON.parse(raw) } catch { /* additive/non-JSON event */ }
          events.push({ event: this.event || 'message', data: value })
        }
        this.event = ''; this.data = []
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':')
        const field = separator < 0 ? line : line.slice(0, separator)
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
        if (field === 'event') this.event = value
        if (field === 'data') this.data.push(value)
      }
      boundary = this.buffer.indexOf('\n')
    }
    return events
  }
  finish(): SSEEvent[] {
    // A streamed response may end immediately after its final data line.
    // Feed the same delimiter used by ordinary input so final-frame handling
    // cannot diverge from parser.feed().
    return this.feed('\n\n')
  }
}
