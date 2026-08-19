import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAudioRecorder } from './useAudioRecorder'

class MockMediaRecorder {
  static isTypeSupported = vi.fn((value: string) => value === 'audio/webm;codecs=opus')
  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) { this.mimeType = options?.mimeType ?? 'audio/webm' }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data:new Blob(['voice'], { type:this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

function Harness({
  transcribe = vi.fn().mockResolvedValue({ transcript:'dictated text', detected_language:'en', duration_seconds:1, duration_milliseconds:1000, voice_turn_id:'voice-turn', stt_charge:{ charged_micros:1, voice_credits:'0.000001' }, wallet:{} }),
  onTranscript = vi.fn(),
  resetKey = 'thread-a',
}: {
  transcribe?: (user: never, blob: Blob, operationId: string, voiceTurnId: string) => Promise<unknown>;
  onTranscript?: (text: string, voiceTurnId: string, wallet: unknown) => void;
  resetKey?: string;
}) {
  const recorder = useAudioRecorder({
    user:{ getIdToken:vi.fn() } as never, enabled:true, onTranscript,
    transcribe:transcribe as never, resetKey,
  })
  return <div>
    <span data-testid="status">{recorder.state.status}</span>
    <span>{recorder.state.error}</span>
    <button onClick={() => void recorder.start()}>start</button>
    <button onClick={recorder.stop}>stop</button>
    <button onClick={recorder.cancel}>cancel</button>
  </div>
}

function installMedia(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{ getUserMedia } })
  vi.stubGlobal('MediaRecorder', MockMediaRecorder)
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('reports microphone permission denied', async () => {
  installMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
  render(<Harness />)
  fireEvent.click(screen.getByText('start'))
  expect(await screen.findByText(/permission was denied/i)).toBeInTheDocument()
})

it('reports no microphone found', async () => {
  installMedia(() => Promise.reject(new DOMException('missing', 'NotFoundError')))
  render(<Harness />)
  fireEvent.click(screen.getByText('start'))
  expect(await screen.findByText(/No microphone was found/i)).toBeInTheDocument()
})

it('reports unsupported MediaRecorder without requesting permission', async () => {
  const getUserMedia = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{ getUserMedia } })
  vi.stubGlobal('MediaRecorder', undefined)
  render(<Harness />)
  fireEvent.click(screen.getByText('start'))
  expect(await screen.findByText(/not supported by this browser/i)).toBeInTheDocument()
  expect(getUserMedia).not.toHaveBeenCalled()
})

it('prevents two simultaneous microphone requests', () => {
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => undefined))
  installMedia(getUserMedia)
  render(<Harness />)
  const start = screen.getByText('start')
  fireEvent.click(start)
  fireEvent.click(start)
  expect(getUserMedia).toHaveBeenCalledOnce()
})

it('stops tracks, transcribes, and returns editable text without sending', async () => {
  const stopTrack = vi.fn()
  installMedia(() => Promise.resolve({ getTracks:() => [{ stop:stopTrack }] } as unknown as MediaStream))
  const transcribe = vi.fn().mockResolvedValue({ transcript:'editable words', detected_language:'en', duration_seconds:1, duration_milliseconds:1000, voice_turn_id:'voice-turn', stt_charge:{ charged_micros:1, voice_credits:'0.000001' }, wallet:{} })
  const onTranscript = vi.fn(); const send = vi.fn()
  render(<Harness transcribe={transcribe} onTranscript={onTranscript} />)
  fireEvent.click(screen.getByText('start'))
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('recording'))
  fireEvent.click(screen.getByText('stop'))
  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('editable words', 'voice-turn', expect.any(Object)))
  expect(transcribe).toHaveBeenCalledOnce()
  expect(transcribe.mock.calls[0][2]).not.toBe(transcribe.mock.calls[0][3])
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
})

it('cancels without transcription and cleans tracks', async () => {
  const stopTrack = vi.fn()
  installMedia(() => Promise.resolve({ getTracks:() => [{ stop:stopTrack }] } as unknown as MediaStream))
  const transcribe = vi.fn()
  render(<Harness transcribe={transcribe as never} />)
  fireEvent.click(screen.getByText('start'))
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('recording'))
  fireEvent.click(screen.getByText('cancel'))
  expect(screen.getByTestId('status')).toHaveTextContent('idle')
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(transcribe).not.toHaveBeenCalled()
})

it('ignores a pending transcription after its thread scope changes', async () => {
  installMedia(() => Promise.resolve({ getTracks:() => [{ stop:vi.fn() }] } as unknown as MediaStream))
  let resolveTranscription!: (value: unknown) => void
  const transcribe = vi.fn(() => new Promise(resolve => { resolveTranscription = resolve }))
  const onTranscript = vi.fn()
  const view = render(<Harness transcribe={transcribe} onTranscript={onTranscript} resetKey="thread-a" />)
  fireEvent.click(screen.getByText('start'))
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('recording'))
  fireEvent.click(screen.getByText('stop'))
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
  view.rerender(<Harness transcribe={transcribe} onTranscript={onTranscript} resetKey="thread-b" />)
  await act(async () => {
    resolveTranscription({ transcript:'stale', voice_turn_id:'voice-turn', wallet:{} })
    await Promise.resolve()
  })
  expect(onTranscript).not.toHaveBeenCalled()
  expect(screen.getByTestId('status')).toHaveTextContent('idle')
})

it('automatically stops at 30 seconds', async () => {
  vi.useFakeTimers()
  const stopTrack = vi.fn()
  installMedia(() => Promise.resolve({ getTracks:() => [{ stop:stopTrack }] } as unknown as MediaStream))
  const transcribe = vi.fn().mockResolvedValue({ transcript:'max', detected_language:'en', duration_seconds:30, duration_milliseconds:30000, voice_turn_id:'voice-turn', stt_charge:{ charged_micros:1, voice_credits:'0.000001' }, wallet:{} })
  render(<Harness transcribe={transcribe} />)
  await act(async () => { fireEvent.click(screen.getByText('start')); await Promise.resolve() })
  expect(screen.getByTestId('status')).toHaveTextContent('recording')
  await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); await Promise.resolve() })
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(transcribe).toHaveBeenCalledOnce()
})

it('cleans microphone tracks on unmount', async () => {
  const stopTrack = vi.fn()
  installMedia(() => Promise.resolve({ getTracks:() => [{ stop:stopTrack }] } as unknown as MediaStream))
  const view = render(<Harness />)
  fireEvent.click(screen.getByText('start'))
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('recording'))
  view.unmount()
  expect(stopTrack).toHaveBeenCalledOnce()
})
