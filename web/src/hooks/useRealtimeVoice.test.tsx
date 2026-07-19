import { StrictMode, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { ApiError, apiJson } from '../api/client'
import { useRealtimeVoice, validatedSocketUrl } from './useRealtimeVoice'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson:vi.fn() }
})

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  static CLOSING = 2
  static instances: FakeWebSocket[] = []
  static autoEvent: 'open' | 'close' | 'error' | 'none' = 'open'
  static autoReady = true
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: unknown[] = []
  closed = false
  constructor(public url: string) {
    super(); FakeWebSocket.instances.push(this)
    window.setTimeout(() => {
      if (FakeWebSocket.autoEvent === 'open') { this.readyState = 1; this.dispatchEvent(new Event('open')) }
      else if (FakeWebSocket.autoEvent === 'close') { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code:4401, reason:'voice_session_expired' })) }
      else if (FakeWebSocket.autoEvent === 'error') this.dispatchEvent(new Event('error'))
    }, 0)
  }
  send(value: unknown) {
    this.sent.push(value)
    if (FakeWebSocket.autoReady && typeof value === 'string' && value.includes('"type":"session.start"')) {
      window.setTimeout(() => {
        if (this.readyState !== FakeWebSocket.OPEN) return
        this.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
          protocol_version:1, type:'session.ready', state:'listening', preroll_ms:320, barge_in_min_ms:180,
        }) }))
      }, 0)
    }
  }
  close(code = 1000, reason = '') { this.readyState = 3; this.closed = true; this.dispatchEvent(new CloseEvent('close', { code, reason })) }
}

class FakeWorkletNode {
  static latest: FakeWorkletNode | null = null
  disconnect = vi.fn()
  port = {
    onmessage:null as ((event: MessageEvent<{ type:string; pcm:ArrayBuffer; rms:number }>) => void) | null,
    postMessage:vi.fn(),
  }
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
  sampleRate = 48000
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
  static isTypeSupported = () => true
  readyState = 'open'
  buffer = new FakeSourceBuffer()
  endOfStream = vi.fn()
  constructor() {
    super(); FakeMediaSource.latest = this
    window.setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0)
  }
  addSourceBuffer() { return this.buffer }
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = []
  static rejectPlay = false
  src = ''
  pause = vi.fn()
  play = vi.fn(() => FakeAudio.rejectPlay
    ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : Promise.resolve())
  constructor() { super(); FakeAudio.instances.push(this) }
}

afterEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); FakeWebSocket.instances = []; FakeWebSocket.autoEvent = 'open'; FakeWebSocket.autoReady = true; FakeAudio.instances = []; FakeAudio.rejectPlay = false; FakeWorkletNode.latest = null; FakeMediaSource.latest = null
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
})

function stubBrowser({ mediaSource = true }: { mediaSource?: boolean } = {}) {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  if (mediaSource) vi.stubGlobal('MediaSource', FakeMediaSource)
  else vi.stubGlobal('MediaSource', class { static isTypeSupported() { return false } })
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-voice')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
    getUserMedia:vi.fn().mockResolvedValue({
      getTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
      getAudioTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
    }),
  } })
}

const ticket = (id = 'session-test') => ({
  protocol_version:1 as const, session_id:id, ticket:`fresh-${id}`,
  websocket_url:'ws://localhost:8000/api/web/voice/ws', tier:'lite', tier_label:'Swico Lite',
  language:'en' as const, wallets:{ chat:{} as never, voice:{} as never },
})
const testUser = {} as never

it('mints one ticket in Strict Mode, parses events, sends mute, and releases media resources', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-voice')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
    getUserMedia:vi.fn().mockResolvedValue({
      getTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
      getAudioTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
    }),
  } })
  vi.mocked(apiJson).mockResolvedValue({
    protocol_version:1, session_id:'session-1', ticket:'one-use-secret',
    websocket_url:'ws://localhost:8000/api/web/voice/ws', tier:'lite', tier_label:'Swico Lite',
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
  await waitFor(() => expect(result.current.phase).toBe('listening'))
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
  const bargePcm = new ArrayBuffer(1024)
  act(() => {
    for (let index = 0; index < 65; index += 1) {
      FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', { data:{ type:'pcm', pcm:bargePcm.slice(0), rms:0.2 } }))
    }
  })
  expect(result.current.phase).toBe('speaking')
  expect(socket.sent.some(value => value instanceof Uint8Array)).toBe(true)
  expect(socket.sent.some(value => typeof value === 'string' && value.includes('"type":"interrupt"'))).toBe(false)
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'warning', code:'assistant_interrupted' }) })))
  expect(result.current.phase).toBe('interrupted')
  act(() => result.current.toggleMute())
  expect(socket.sent.at(-1)).toContain('"type":"mute"')

  const pcm = new ArrayBuffer(1024)
  act(() => FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', { data:{ type:'pcm', pcm, rms:0.01 } })))
  expect(socket.sent.some(value => value instanceof Uint8Array)).toBe(true)
  unmount()
  expect(socket.closed).toBe(true)
  await waitFor(() => expect(stopTrack).toHaveBeenCalled())
  expect(closeContext).toHaveBeenCalled()
  expect(FakeWorkletNode.latest?.disconnect).toHaveBeenCalled()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-voice')
})

it('preserves a structured error across close and retry mints a fresh ticket after cleanup', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-voice')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
    getUserMedia:vi.fn().mockResolvedValue({
      getTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
      getAudioTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
    }),
  } })
  vi.mocked(apiJson)
    .mockResolvedValueOnce({
      protocol_version:1, session_id:'session-1', ticket:'ticket-one', websocket_url:'ws://localhost:8000/api/web/voice/ws',
      tier:'lite', tier_label:'Swico Lite', language:'en', wallets:{ chat:{} as never, voice:{} as never },
    })
    .mockResolvedValueOnce({
      protocol_version:1, session_id:'session-2', ticket:'ticket-two', websocket_url:'ws://localhost:8000/api/web/voice/ws',
      tier:'lite', tier_label:'Swico Lite', language:'en', wallets:{ chat:{} as never, voice:{} as never },
    })
  const user = {} as never
  const { result } = renderHook(() => useRealtimeVoice({ user, threadId:null }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const first = FakeWebSocket.instances[0]
  act(() => first.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'error', code:'insufficient_voice_credit', credit_bucket:'voice',
    message:'Add Voice credits to continue.',
  }) })))
  act(() => first.dispatchEvent(new CloseEvent('close', { code:4451, reason:'insufficient_voice_credit' })))
  expect(result.current.error).toBe('Add Voice credits to continue.')
  expect(result.current.creditRequired).toBe('voice')

  await act(async () => { await result.current.retry() })
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
  expect(first.closed).toBe(true)
  expect(String(FakeWebSocket.instances[1].url)).toContain('ticket=ticket-two')
  expect(String(FakeWebSocket.instances[1].url)).not.toContain('ticket-one')
  expect(apiJson).toHaveBeenCalledTimes(2)
})

it('maps known application close codes without replacing an earlier server error', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-voice')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
    getUserMedia:vi.fn().mockResolvedValue({
      getTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
      getAudioTracks:() => [{ stop:stopTrack, label:'Test microphone' }],
    }),
  } })
  vi.mocked(apiJson).mockResolvedValue({
    protocol_version:1, session_id:'session-close', ticket:'ticket-close', websocket_url:'ws://localhost:8000/api/web/voice/ws',
    tier:'lite', tier_label:'Swico Lite', language:'en', wallets:{ chat:{} as never, voice:{} as never },
  })
  const user = {} as never
  const { result } = renderHook(() => useRealtimeVoice({ user, threadId:null }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  act(() => FakeWebSocket.instances[0].dispatchEvent(new CloseEvent('close', { code:4401, reason:'voice_session_expired' })))
  expect(result.current.errorCode).toBe('voice_session_expired')
  expect(result.current.error).toMatch(/fresh ticket/i)
})

it.each([
  [402, 'insufficient_chat_credit', 'chat', 'Add Chat credits to start the selected Swico mode.'],
  [402, 'insufficient_voice_credit', 'voice', 'Add Voice credits to start Voice Mode.'],
  [503, 'voice_ticket_store_unavailable', null, 'Voice Mode is temporarily unavailable.'],
  [409, 'voice_session_active', null, 'Another Voice Mode session may already be active.'],
] as const)('preserves pre-WebSocket HTTP %s/%s and never opens a socket', async (status, code, bucket, message) => {
  stubBrowser()
  vi.mocked(apiJson).mockRejectedValue(new ApiError(status, { error:{ code, message, ...(bucket ? { credit_bucket:bucket } : {}) } }))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(result.current.errorCode).toBe(code))
  expect(result.current.errorStatus).toBe(status)
  expect(result.current.error).toBe(message)
  expect(result.current.creditRequired).toBe(bucket)
  expect(FakeWebSocket.instances).toHaveLength(0)
})

it('captures close and error events that occur before open', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('early-close'))
  FakeWebSocket.autoEvent = 'close'
  const close = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(close.result.current.errorCode).toBe('voice_session_expired'))
  close.unmount()

  vi.mocked(apiJson).mockResolvedValue(ticket('early-error'))
  FakeWebSocket.autoEvent = 'error'
  const error = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(error.result.current.error).toMatch(/before it was ready/i))
  expect(error.result.current.errorCode).toBe('voice_network_interrupted')
  error.unmount()
})

it('rejects mixed-content, unexpected hosts and unexpected paths without rewriting them', () => {
  expect(() => validatedSocketUrl('ws://localhost:8000/api/web/voice/ws', [], 'https:')).toThrow(/not secure/i)
  expect(() => validatedSocketUrl('ws://evil.example/api/web/voice/ws', [], 'http:')).toThrow(/unexpected host/i)
  expect(() => validatedSocketUrl('ws://localhost:8000/not-voice', [], 'http:')).toThrow(/unexpected path/i)
  expect(validatedSocketUrl('wss://voice.example/api/web/voice/ws', ['voice.example'], 'https:').protocol).toBe('wss:')
})

it('bounds the WebSocket opening wait and closes the unused ticket socket', async () => {
  vi.useFakeTimers()
  stubBrowser()
  FakeWebSocket.autoEvent = 'none'
  vi.mocked(apiJson).mockResolvedValue(ticket('timeout'))
  const { result, unmount } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await act(async () => { await vi.advanceTimersByTimeAsync(401) })
  expect(FakeWebSocket.instances).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001) })
  expect(result.current.error).toMatch(/timed out before opening/i)
  expect(FakeWebSocket.instances[0].closed).toBe(true)
  unmount()
})

it('sends JSON ping keepalives and stops the interval during cleanup', async () => {
  vi.useFakeTimers()
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('ping'))
  const { unmount } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await act(async () => { await vi.advanceTimersByTimeAsync(405) })
  const ws = FakeWebSocket.instances[0]
  expect(ws.sent.some(value => typeof value === 'string' && value.includes('"type":"session.start"'))).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(ws.sent.some(value => typeof value === 'string' && value.includes('"type":"ping"'))).toBe(true)
  const sentAtCleanup = ws.sent.length
  unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
  expect(ws.sent).toHaveLength(sentAtCleanup)
})

it('drains progressive audio after audio.end and waits for the media ended event', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('drain'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.start', content_type:'audio/mpeg' }) })))
  await waitFor(() => expect(FakeMediaSource.latest?.buffer).toBeDefined())
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0, 0, 0, 1, 1, 2, 3]).buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled()
  expect(FakeMediaSource.latest?.buffer.abort).not.toHaveBeenCalled()
  expect(FakeMediaSource.latest?.endOfStream).toHaveBeenCalled()
  expect(result.current.phase).toBe('speaking')
  act(() => FakeAudio.instances[0].dispatchEvent(new Event('ended')))
  expect(result.current.phase).toBe('listening')
  expect(result.current.playbackState).toBe('playback_finished')
})

it('uses a bounded Blob fallback and keeps autoplay failure non-fatal', async () => {
  stubBrowser({ mediaSource:false })
  FakeAudio.rejectPlay = true
  vi.mocked(apiJson).mockResolvedValue(ticket('fallback'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'assistant.delta', delta:'Visible answer' }) })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.start', content_type:'audio/mpeg' }) })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0, 0, 0, 1, 4, 5, 6]).buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  await waitFor(() => expect(result.current.playbackState).toBe('autoplay_blocked'))
  expect(result.current.assistant).toBe('Visible answer')
  expect(result.current.phase).toBe('speaking')
  expect(result.current.error).toBe('')
  expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.OPEN)
  await act(async () => { await result.current.manualPlay() })
  expect(result.current.playbackState).toBe('autoplay_blocked')
  FakeAudio.rejectPlay = false
  await act(async () => { await result.current.manualPlay() })
  expect(result.current.playbackState).toBe('playing')
  act(() => result.current.skipPlayback())
  expect(result.current.phase).toBe('listening')
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})

it('does not mint a duplicate ticket when chat synchronization changes the thread prop', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('thread-stable'))
  const { result, rerender } = renderHook(
    ({ threadId }: { threadId:string | null }) => useRealtimeVoice({ user:testUser, threadId }),
    { initialProps:{ threadId:null as string | null } },
  )
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  rerender({ threadId:'voice-created-thread' })
  await new Promise(resolve => window.setTimeout(resolve, 20))
  expect(apiJson).toHaveBeenCalledTimes(1)
  expect(FakeWebSocket.instances).toHaveLength(1)
})

it('calibrates locally, rejects spikes/echo, admits quiet sustained speech with pre-roll, and bounds trailing silence', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('adaptive-gate'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(FakeWorkletNode.latest?.port.onmessage).toBeTypeOf('function'))
  const feed = (rms: number, count: number, marker = 1) => act(() => {
    for (let index = 0; index < count; index += 1) {
      const pcm = new Uint8Array(1024); pcm[0] = marker
      FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', { data:{ type:'pcm', pcm:pcm.buffer, rms } }))
    }
  })

  feed(0.004, 13) // 416 ms local-only calibration
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.instances[0]
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const media = vi.mocked(navigator.mediaDevices.getUserMedia)
  expect(media.mock.invocationCallOrder[0]).toBeLessThan(addModule.mock.invocationCallOrder[0])
  expect(addModule.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(apiJson).mock.invocationCallOrder[0])
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(0)
  feed(0.2, 1); feed(0.004, 10) // one spike is not sustained speech
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(0)
  feed(0.01, 70, 7) // bounded quiet-speaker fallback after two seconds
  const speechPackets = ws.sent.filter((value): value is Uint8Array => value instanceof Uint8Array)
  expect(speechPackets.length).toBeGreaterThan(18)
  expect(speechPackets[0][4]).toBe(7) // pre-roll retained the first syllable marker
  const beforeSilence = speechPackets.length
  feed(0.001, 65)
  const afterTrailing = ws.sent.filter(value => value instanceof Uint8Array).length
  expect(afterTrailing - beforeSilence).toBeLessThanOrEqual(57)
  feed(0.001, 20)
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(afterTrailing)

  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'state.changed', state:'speaking' }) })))
  feed(0.04, 80) // assistant echo remains below the elevated playback threshold
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(afterTrailing)
  act(() => result.current.toggleMute())
  feed(0.2, 80)
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(afterTrailing)
})

it('raises the adaptive threshold in a noisy room but still admits sustained nearby speech', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('noisy-gate'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(FakeWorkletNode.latest?.port.onmessage).toBeTypeOf('function'))
  const feed = (rms: number, count: number) => act(() => {
    for (let index = 0; index < count; index += 1) {
      FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', { data:{ type:'pcm', pcm:new ArrayBuffer(1024), rms } }))
    }
  })
  feed(0.04, 13)
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.instances[0]
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  feed(0.05, 25)
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(0)
  feed(0.09, 20)
  expect(ws.sent.some(value => value instanceof Uint8Array)).toBe(true)
})

it('does not mint a ticket when microphone permission is denied', async () => {
  stubBrowser()
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
    new DOMException('denied', 'NotAllowedError'),
  )
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(result.current.errorCode).toBe('microphone_permission_denied'))
  expect(apiJson).not.toHaveBeenCalled()
  expect(FakeWebSocket.instances).toHaveLength(0)
})

const DEFAULT_TEST_TUNING = {
  calibration_ms:1, noise_multiplier:2.4, threshold_min:0.012,
  threshold_max:0.065, quiet_fallback:0.008, no_speech_warning_ms:64,
}

it('sends no audio before listening-ready and reports WebSocket backpressure safely', async () => {
  stubBrowser(); FakeWebSocket.autoReady = false
  vi.mocked(apiJson).mockResolvedValue(ticket('ready-gate'))
  const { result } = renderHook(() => useRealtimeVoice({
    user:testUser, threadId:null, tuning:DEFAULT_TEST_TUNING, collectDiagnostics:true,
  }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  const ws = FakeWebSocket.instances[0]
  const feed = (rms: number, count: number) => act(() => {
    for (let index = 0; index < count; index += 1) {
      FakeWorkletNode.latest?.port.onmessage?.(new MessageEvent('message', {
        data:{ type:'pcm', pcm:new ArrayBuffer(1024), rms },
      }))
    }
  })
  feed(0.2, 20)
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(0)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'session.ready', state:'listening',
  }) })))
  ws.bufferedAmount = 300 * 1024
  feed(0.2, 8)
  expect(ws.sent.filter(value => value instanceof Uint8Array)).toHaveLength(0)
  expect(result.current.microphoneDiagnostics.backpressureDroppedFrameCount).toBeGreaterThan(0)
})

it('shows cannot-hear only while listening and clears it on STT/thinking/mute activity', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('warning-state'))
  const { result } = renderHook(() => useRealtimeVoice({
    user:testUser, threadId:null, tuning:DEFAULT_TEST_TUNING,
  }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => {
    for (let index = 0; index < 3; index += 1) FakeWorkletNode.latest?.port.onmessage?.(
      new MessageEvent('message', { data:{ type:'pcm', pcm:new ArrayBuffer(1024), rms:0 } }),
    )
  })
  expect(result.current.cannotHear).toBe(true)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'stt.partial', transcript:'activity',
  }) })))
  expect(result.current.cannotHear).toBe(false)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'state.changed', state:'thinking',
  }) })))
  expect(result.current.cannotHear).toBe(false)
  act(() => result.current.toggleMute())
  expect(result.current.cannotHear).toBe(false)
})

it('completes two continuous mocked turns with stable message IDs and returns to listening', async () => {
  stubBrowser({ mediaSource:false })
  vi.mocked(apiJson).mockResolvedValue(ticket('two-turns'))
  const completed = vi.fn()
  const { result } = renderHook(() => useRealtimeVoice({
    user:testUser, threadId:'existing-thread', onTurnDone:completed,
    tuning:DEFAULT_TEST_TUNING,
  }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  const emit = (message: object) => act(() => ws.dispatchEvent(new MessageEvent('message', {
    data:JSON.stringify({ protocol_version:1, ...message }),
  })))
  for (const turn of [1, 2]) {
    emit({ type:'speech_start', turn_number:turn })
    emit({ type:'stt.partial', transcript:`turn ${turn}`, turn_number:turn })
    emit({ type:'stt.final', transcript:`turn ${turn} final`, turn_number:turn })
    emit({ type:'state.changed', state:'endpoint_pending', turn_number:turn })
    emit({ type:'state.changed', state:'thinking', turn_number:turn })
    emit({ type:'assistant.start', turn_number:turn })
    emit({ type:'assistant.delta', delta:`answer ${turn}`, turn_number:turn })
    emit({
      type:'turn.done', thread_id:'existing-thread', user_message_id:`user-${turn}`,
      assistant_message_id:`assistant-${turn}`, turn_number:turn,
      input_mode:'realtime_voice', completion_status:'complete',
    })
    expect(result.current.phase).toBe('listening')
  }
  expect(completed.mock.calls.map(call => call[0])).toEqual([
    expect.objectContaining({ user_message_id:'user-1', assistant_message_id:'assistant-1', turn_number:1 }),
    expect.objectContaining({ user_message_id:'user-2', assistant_message_id:'assistant-2', turn_number:2 }),
  ])
  await act(async () => { await result.current.end() })
  expect(result.current.phase).toBe('closed')
})
