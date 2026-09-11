import test from 'node:test'
import assert from 'node:assert/strict'
import { SSEParser } from '../dist/sse.js'

test('SSE parser handles split UTF-8 frames, comments and additive events', () => {
  const parser = new SSEParser()
  assert.deepEqual(parser.feed(': keep\n\nevent: delta\ndata: {"text":"தமிழ்"}\n\n'.slice(0, 20)), [])
  const events = parser.feed(': keep\n\nevent: delta\ndata: {"text":"தமிழ்"}\n\nevent: usage\ndata: {"tokens":2}\n\n'.slice(20))
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { event: 'delta', data: { text: 'தமிழ்' } })
})
