import { StrictMode, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { apiJson } from '../api/client'
import { useRealtimeVoice } from './useRealtimeVoice'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson:vi.fn() }
})

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: unknown[] = []
  closed = false
  constructor(public url: string) {
    super(); FakeWebSocket.instances.push(this)
    window.setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }, 0)
  }
  send(value: unknown) { this.sent.push(value) }
  close() { this.readyState = 3; this.closed = true }
}

class FakeWorkletNode {
  static latest: FakeWorkletNode | null = null
  disconnect = vi.fn()
  port: { onmessage: ((event: MessageEvent<{ type:string; pcm:ArrayBuffer; rms:number }>) => void) | null } = { onmessage:null }
  constructor() { FakeWorkletNode.latest = this }
  connect() { return this }
}

const stopTrack = vi.fn()
const closeContext = vi.fn().mockResolvedValue(undefined)
const addModule = vi.fn().mockResolvedValue(undefined)
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

class FakeAudioContext {
  audioWorklet = { addModule }
  destination = {}
  createMediaStreamSource() { return { connect:vi.fn() } }
  createGain() { return { gain:{ value:1 }, connect:vi.fn() } }
  close = closeContext
}

class FakeSourceBuffer extends EventTarget {
  updating = false
  appended: ArrayBuffer[] = []
  appendBuffer(value: ArrayBuffer) { this.appended.push(value) }
  abort = vi.fn()
}

class FakeMediaSource extends EventTarget {
  static latest: FakeMediaSource | null = null
  readyState = 'open'
  buffer = new FakeSourceBuffer()
  constructor() {
    super(); FakeMediaSource.latest = this
    window.setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0)
  }
  addSourceBuffer() { return this.buffer }
}

class FakeAudio {
  src = ''
  pause = vi.fn()
  play = vi.fn().mockResolvedValue(undefined)
}

afterEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals(); FakeWebSocket.instances = []; FakeWorkletNode.latest = null; FakeMediaSource.latest = null
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

it('mints one ticket in Strict Mode, parses events, sends mute, and releases media resources', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-voice')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
    getUserMedia:vi.fn().mockResolvedValue({ getTracks:() => [{ stop:stopTrack }] }),
  } })
  vi.mocked(apiJson).mockResolvedValue({
    protocol_version:1, session_id:'session-1', ticket:'one-use-secret',
    websocket_url:'wss://api.example.test/api/web/voice/ws', tier:'lite', tier_label:'Swico Lite',
    language:'en', wallets:{ chat:{} as never, voice:{} as never },
  })
  const user = {} as never
  const wrapper = ({ children }: { children:ReactNode }) => <StrictMode>{children}</StrictMode>
  const { result, unmount } = renderHook(
    () => useRealtimeVoice({ user, threadId:'thread-1' }), { wrapper },
  )
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  await waitFor(() => expect(addModule).toHaveBeenCalledWith('/audio-worklet.js'))
  expect(apiJson).toHaveBeenCalledTimes(1)
  expect(apiJson).toHaveBeenCalledWith(expect.anything(), '/api/web/voice/sessions', { method:'POST' })
  const socket = FakeWebSocket.instances[0]
  expect(String(socket.url)).toContain('ticket=one-use-secret')
  expect(socket.sent[0]).toContain('"type":"session.start"')

  act(() => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'stt.partial', transcript:'live words' }) })))
  expect(result.current.partial).toBe('live words')
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'stt.final', transcript:'final words' }) })))
  expect(result.current.phase).toBe('thinking')
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'assistant.delta', delta:'Hello' }) })))
  expect(result.current.assistant).toBe('Hello')
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.start', content_type:'audio/mpeg' }) })))
  await waitFor(() => expect(result.current.phase).toBe('speaking'))
  await waitFor(() => expect(FakeMediaSource.latest).not.toBeNull())
  const progressive = new Uint8Array([0, 0, 0, 1, 10, 20, 30]).buffer
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:progressive })))
  expect(FakeMediaSource.latest?.buffer.appended[0].byteLength).toBe(3)
  const bargePcm = new ArrayBuffer(320)
  act(() => FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', { data:{ type:'pcm', pcm:bargePcm, rms:0.2 } })))
  expect(result.current.phase).toBe('interrupted')
  expect(socket.sent.some(value => typeof value === 'string' && value.includes('"type":"interrupt"'))).toBe(true)
  act(() => result.current.toggleMute())
  expect(socket.sent.at(-1)).toContain('"type":"mute"')

  const pcm = new ArrayBuffer(320)
  act(() => FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', { data:{ type:'pcm', pcm, rms:0.01 } })))
  expect(socket.sent.some(value => value instanceof Uint8Array)).toBe(true)
  unmount()
  expect(socket.closed).toBe(true)
  expect(stopTrack).toHaveBeenCalled()
  expect(closeContext).toHaveBeenCalled()
  expect(FakeWorkletNode.latest?.disconnect).toHaveBeenCalled()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-voice')
})
