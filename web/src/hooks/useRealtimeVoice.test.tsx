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
  static suspended = false
  static instances: FakeAudioContext[] = []
  audioWorklet = { addModule }
  destination = {}
  sampleRate = 48000
  state = FakeAudioContext.suspended ? 'suspended' : 'running'
  currentTime = 1
  createMediaStreamSource() { return { connect:vi.fn() } }
  createGain() { return { gain:{ value:1 }, connect:vi.fn() } }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return { numberOfChannels:channels, length, sampleRate, duration:length / sampleRate, copyToChannel:vi.fn() }
  }
  createBufferSource() { return new FakeBufferSource() as never }
  resume = vi.fn(async () => { this.state = 'running' })
  close = closeContext
  constructor() { FakeAudioContext.instances.push(this) }
}

class FakeBufferSource {
  static instances: FakeBufferSource[] = []
  buffer: { duration:number } | null = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
  constructor() { FakeBufferSource.instances.push(this) }
}

class FakeSourceBuffer extends EventTarget {
  static appendThrows = false
  updating = false
  appended: ArrayBuffer[] = []
  appendBuffer(value: ArrayBuffer) {
    if (FakeSourceBuffer.appendThrows) throw new DOMException('private details', 'QuotaExceededError')
    this.appended.push(value)
  }
  abort = vi.fn()
}

class FakeMediaSource extends EventTarget {
  static latest: FakeMediaSource | null = null
  static isTypeSupported = () => true
  static addThrows = false
  readyState = 'open'
  buffer = new FakeSourceBuffer()
  endOfStream = vi.fn()
  constructor() {
    super(); FakeMediaSource.latest = this
    window.setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0)
  }
  addSourceBuffer() {
    if (FakeMediaSource.addThrows) throw new DOMException('private details', 'NotSupportedError')
    return this.buffer
  }
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = []
  static rejectPlay = false
  src = ''
  error: { code:number } | null = null
  pause = vi.fn()
  play = vi.fn(() => FakeAudio.rejectPlay
    ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : Promise.resolve())
  constructor() { super(); FakeAudio.instances.push(this) }
}

afterEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); FakeWebSocket.instances = []; FakeWebSocket.autoEvent = 'open'; FakeWebSocket.autoReady = true; FakeAudio.instances = []; FakeAudio.rejectPlay = false; FakeWorkletNode.latest = null; FakeMediaSource.latest = null
  FakeAudioContext.suspended = false; FakeAudioContext.instances = []; FakeBufferSource.instances = []; FakeMediaSource.addThrows = false; FakeSourceBuffer.appendThrows = false
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
  playback_mode:'buffered_mp3' as const, selected_codec:'mp3' as const,
  provider_sample_rate:null, media_source_allowed:false,
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
  expect(apiJson).toHaveBeenCalledWith(expect.anything(), '/api/web/voice/sessions', {
    method:'POST', body:JSON.stringify({ browser_capabilities:{
      web_audio:true, media_source:true, media_source_mp3:true,
    } }),
  })
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
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null,
    channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:1,
  }) })))
  await waitFor(() => expect(result.current.phase).toBe('speaking'))
  const progressive = new Uint8Array([0, 0, 0, 1, 10, 20, 30]).buffer
  act(() => socket.dispatchEvent(new MessageEvent('message', { data:progressive })))
  expect(FakeMediaSource.latest).toBeNull()
  expect(FakeAudio.instances).toHaveLength(0)
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

it('maps a legacy Chat-credit Voice 402 to refresh guidance without a purchase bucket', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockRejectedValue(new ApiError(402, { error:{
    code:'insufficient_chat_credit', credit_bucket:'chat',
    message:'Add Chat credits to start the selected Swico mode.',
  } }))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(result.current.errorCode).toBe('voice_server_update_required'))
  expect(result.current.error).toMatch(/older version.*refresh/i)
  expect(result.current.creditRequired).toBeNull()
  expect(FakeWebSocket.instances).toHaveLength(0)
})

it('maps legacy close code 4450 to refresh guidance without a Chat purchase bucket', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('legacy-close'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  act(() => FakeWebSocket.instances[0].dispatchEvent(new CloseEvent('close', {
    code:4450, reason:'insufficient_chat_credit',
  })))
  expect(result.current.errorCode).toBe('voice_server_update_required')
  expect(result.current.error).toMatch(/older version.*refresh/i)
  expect(result.current.creditRequired).toBeNull()
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

it('buffers ordered MP3 until audio.end, then waits for the audio ended event', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('drain'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3',
    sample_rate:null, channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:1,
  }) })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0, 0, 0, 1, 1, 2, 3]).buffer })))
  expect(FakeAudio.instances).toHaveLength(0)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
  expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled()
  expect(FakeMediaSource.latest).toBeNull()
  expect(FakeAudio.instances[0].src).toBe('blob:test-voice')
  expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1)
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
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null,
    channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:1,
  }) })))
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

it('orders buffered MP3, ignores duplicates, detects a temporary gap, and keeps server Listening visually Speaking', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('ordered'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  const message = (value: object) => act(() => ws.dispatchEvent(new MessageEvent('message', {
    data:JSON.stringify({ protocol_version:1, ...value }),
  })))
  message({ type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null,
    channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:1 })
  const packet = (sequence: number, ...bytes: number[]) => {
    const value = new Uint8Array(4 + bytes.length); new DataView(value.buffer).setUint32(0, sequence); value.set(bytes, 4)
    act(() => ws.dispatchEvent(new MessageEvent('message', { data:value.buffer })))
  }
  packet(1, 1, 2); packet(1, 9, 9); packet(3, 5, 6); packet(2, 3, 4)
  message({ type:'state.changed', state:'listening' })
  expect(result.current.phase).toBe('speaking')
  message({ type:'audio.end', turn_number:1, codec:'mp3', chunks_sent:3, bytes_sent:6, characters:4, interrupted:false })
  await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
  expect(result.current.playbackDiagnostics.duplicate_chunks).toBe(1)
  expect(result.current.playbackDiagnostics.missing_sequence_detected).toBe(true)
  expect(result.current.playbackDiagnostics.audio_chunks_received).toBe(3)
  expect(result.current.playbackDiagnostics.audio_bytes_received).toBe(6)
  expect(result.current.phase).toBe('speaking')
  act(() => FakeAudio.instances[0].dispatchEvent(new Event('ended')))
  expect(result.current.phase).toBe('listening')
})

it.each([
  ['source_buffer_create', () => { FakeMediaSource.addThrows = true }],
  ['source_buffer_append', () => { FakeSourceBuffer.appendThrows = true }],
] as const)('falls back to retained MP3 when MediaSource fails at %s', async (stage, arrange) => {
  stubBrowser(); arrange()
  vi.mocked(apiJson).mockResolvedValue({
    ...ticket(`media-${stage}`), playback_mode:'auto', media_source_allowed:true,
  })
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3',
    sample_rate:null, channels:1, sample_format:null, playback_mode:'auto', turn_number:1,
  }) })))
  await waitFor(() => expect(FakeMediaSource.latest).not.toBeNull())
  if (stage === 'source_buffer_create') {
    await waitFor(() => expect(result.current.playbackDiagnostics.fallback_used).toBe(true))
  } else {
    await waitFor(() => expect(result.current.playbackDiagnostics.source_buffer_created).toBe(true))
  }
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,2]).buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  await waitFor(() => expect(result.current.playbackDiagnostics.fallback_used).toBe(true))
  await waitFor(() => expect(FakeAudio.instances.some(item => item.src === 'blob:test-voice')).toBe(true))
  expect(result.current.playbackDiagnostics.failure_stage).toBe(stage)
  expect(result.current.playbackDiagnostics.dom_exception_name).toMatch(/NotSupportedError|QuotaExceededError/)
  expect(JSON.stringify(result.current.playbackDiagnostics)).not.toContain('private details')
})

it('retains all MP3 after an audible MediaSource failure and replays without another ticket or TTS request', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue({ ...ticket('media-audible'), playback_mode:'auto', media_source_allowed:true })
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null,
    channels:1, sample_format:null, playback_mode:'auto', turn_number:1,
  }) })))
  await waitFor(() => expect(result.current.playbackDiagnostics.source_buffer_created).toBe(true))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,2]).buffer })))
  act(() => FakeMediaSource.latest?.buffer.dispatchEvent(new Event('updateend')))
  await waitFor(() => expect(FakeAudio.instances[0].play).toHaveBeenCalled())
  act(() => FakeAudio.instances[0].dispatchEvent(new Event('playing')))
  act(() => FakeMediaSource.latest?.buffer.dispatchEvent(new Event('error')))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,2,3,4]).buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  expect(result.current.playbackState).toBe('playback_error')
  expect(result.current.canReplay).toBe(true)
  expect(result.current.playbackWarning).toMatch(/Replay the full spoken answer/i)
  const ticketCalls = vi.mocked(apiJson).mock.calls.length
  await act(async () => { await result.current.manualPlay() })
  expect(FakeAudio.instances).toHaveLength(2)
  expect(FakeAudio.instances[1].src).toBe('blob:test-voice')
  expect(apiJson).toHaveBeenCalledTimes(ticketCalls)
})

it('uses retained Blob after a SourceBuffer error before playback begins', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue({ ...ticket('buffer-error'), playback_mode:'auto', media_source_allowed:true })
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null,
    channels:1, sample_format:null, playback_mode:'auto', turn_number:1,
  }) })))
  await waitFor(() => expect(result.current.playbackDiagnostics.source_buffer_created).toBe(true))
  act(() => FakeMediaSource.latest?.buffer.dispatchEvent(new Event('error')))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,2]).buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  await waitFor(() => expect(FakeAudio.instances.some(item => item.src === 'blob:test-voice')).toBe(true))
  expect(result.current.playbackDiagnostics.failure_stage).toBe('source_buffer_error')
  expect(result.current.playbackDiagnostics.fallback_used).toBe(true)
})

it.each([
  [1, 'aborted'], [2, 'network'], [3, 'decode'], [4, 'source_not_supported'],
] as const)('maps MediaError %s to safe category %s while preserving text and replay', async (code, category) => {
  stubBrowser({ mediaSource:false })
  vi.mocked(apiJson).mockResolvedValue(ticket(`media-error-${code}`))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'assistant.delta', delta:'Still visible' }) })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null,
    channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:1,
  }) })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,2]).buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
  FakeAudio.instances[0].error = { code }
  act(() => FakeAudio.instances[0].dispatchEvent(new Event('error')))
  expect(result.current.playbackDiagnostics.audio_element_media_error_code).toBe(code)
  expect(result.current.playbackDiagnostics.media_error_category).toBe(category)
  expect(result.current.assistant).toBe('Still visible')
  expect(result.current.error).toBe('')
  expect(result.current.canReplay).toBe(true)
})

it('streams LINEAR16 at the provider rate, waits for final scheduled source, and stops all sources on barge-in', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue({
    ...ticket('pcm'), playback_mode:'pcm_stream', selected_codec:'linear16', provider_sample_rate:24000,
  })
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/L16', codec:'linear16',
    sample_rate:24000, channels:1, sample_format:'pcm_s16le', playback_mode:'pcm_stream', turn_number:1,
  }) })))
  const samples = new Int16Array([0, 32767, -32768, 16384])
  const packet = new Uint8Array(4 + samples.byteLength); new DataView(packet.buffer).setUint32(0, 1)
  packet.set(new Uint8Array(samples.buffer), 4)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:packet.buffer })))
  const nextPacket = new Uint8Array(packet); new DataView(nextPacket.buffer).setUint32(0, 2)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:nextPacket.buffer })))
  expect(FakeBufferSource.instances).toHaveLength(2)
  expect(FakeBufferSource.instances[0].start).toHaveBeenCalledWith(1.16)
  expect(FakeBufferSource.instances[1].start).toHaveBeenCalledWith(1.16 + 4 / 24000)
  expect(result.current.playbackDiagnostics.scheduled_pcm_seconds).toBeCloseTo(8 / 24000)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'audio.end' }) })))
  expect(result.current.phase).toBe('speaking')
  act(() => FakeBufferSource.instances[0].onended?.())
  expect(result.current.phase).toBe('speaking')
  act(() => FakeBufferSource.instances[1].onended?.())
  expect(result.current.phase).toBe('listening')

  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/L16', codec:'linear16', sample_rate:24000,
    channels:1, sample_format:'pcm_s16le', playback_mode:'pcm_stream', turn_number:2,
  }) })))
  const second = new Uint8Array(packet); new DataView(second.buffer).setUint32(0, 1)
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:second.buffer })))
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, type:'warning', code:'assistant_interrupted' }) })))
  expect(FakeBufferSource.instances.at(-1)?.stop).toHaveBeenCalled()
  expect(result.current.phase).toBe('interrupted')
})

it('preserves suspended PCM until a manual user action resumes the dedicated AudioContext', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue({
    ...ticket('pcm-blocked'), playback_mode:'pcm_stream', selected_codec:'linear16', provider_sample_rate:16000,
  })
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null, collectDiagnostics:true }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  FakeAudioContext.instances[0].state = 'suspended'
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'audio.start', content_type:'audio/L16', codec:'linear16', sample_rate:16000,
    channels:1, sample_format:'pcm_s16le', playback_mode:'pcm_stream', turn_number:1,
  }) })))
  const value = new Uint8Array([0,0,0,1,1,0,2,0])
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:value.buffer })))
  await waitFor(() => expect(result.current.playbackState).toBe('autoplay_blocked'))
  expect(FakeBufferSource.instances).toHaveLength(0)
  await act(async () => { await result.current.manualPlay() })
  expect(FakeBufferSource.instances).toHaveLength(1)
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

it('keeps partial captions through endpoint pending and returns smoothly on speech resumption', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('adaptive-pause'))
  const { result } = renderHook(() => useRealtimeVoice({ user:testUser, threadId:null }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  const emit = (value: object) => act(() => ws.dispatchEvent(new MessageEvent('message', {
    data:JSON.stringify({ protocol_version:1, ...value }),
  })))
  emit({ type:'stt.partial', transcript:'I paused because' })
  emit({ type:'state.changed', state:'endpoint_pending' })
  expect(result.current.phase).toBe('endpoint_pending')
  expect(result.current.partial).toBe('I paused because')
  expect(result.current.phase).not.toBe('thinking')
  emit({ type:'speech_start' })
  emit({ type:'state.changed', state:'listening' })
  expect(result.current.phase).toBe('listening')
  expect(result.current.partial).toBe('I paused because')
})

it('collects only safe scalar adaptive endpoint metadata', async () => {
  stubBrowser()
  vi.mocked(apiJson).mockResolvedValue(ticket('endpoint-diagnostics'))
  const { result } = renderHook(() => useRealtimeVoice({
    user:testUser, threadId:null, collectDiagnostics:true,
  }))
  await waitFor(() => expect(result.current.phase).toBe('listening'))
  const ws = FakeWebSocket.instances[0]
  act(() => ws.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({
    protocol_version:1, type:'endpoint.metadata', transcript_classification:'unfinished',
    terminal_cadence_detected:false, trailing_off_detected:true, voiced_duration_ms:448,
    endpoint_delay_ms:2600, endpoint_reason:'trailing_off', endpoint_deadline_generation:7,
    endpoint_cancel_count:2, raw_pcm:'must-not-appear', pitch_history:[180, 160], transcript:'private',
  }) })))
  expect(result.current.endpointDiagnostics).toEqual({
    transcript_classification:'unfinished', terminal_cadence_detected:false,
    trailing_off_detected:true, voiced_duration_ms:448, endpoint_delay_ms:2600,
    endpoint_reason:'trailing_off', endpoint_deadline_generation:7,
    endpoint_cancel_count:2,
  })
  const serialized = JSON.stringify(result.current.endpointDiagnostics)
  expect(serialized).not.toMatch(/raw_pcm|pitch_history|private/)
})
