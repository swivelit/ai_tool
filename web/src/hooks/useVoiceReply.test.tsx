import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError, synthesizeAudio } from '../api/client'
import { useVoiceReply } from './useVoiceReply'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, synthesizeAudio: vi.fn() }
})

const user = { getIdToken: vi.fn() } as never
const wallet = { balance_micros:100, reserved_micros:0, available_micros:100, version:2 }
const response = {
  audio_base64: window.btoa(`RIFF${'\0'.repeat(16)}`), mime_type:'audio/wav',
  speaker:'anushka', target_language_code:'en-IN' as const, model:'bulbul:v2',
  character_count:12, charged_micros:10, voice_credits:'0.000010', wallet,
}

let audios: HTMLAudioElement[]
let originalCreate: typeof document.createElement
let playImpl: ReturnType<typeof vi.fn>
let pauseImpl: ReturnType<typeof vi.fn>

beforeEach(() => {
  audios = []
  originalCreate = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = originalCreate(tag, options)
    if (tag === 'audio') audios.push(element as HTMLAudioElement)
    return element
  }) as typeof document.createElement)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice-reply')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  playImpl = vi.fn(function (this: HTMLAudioElement) {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  pauseImpl = vi.fn(function (this: HTMLAudioElement) {
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(playImpl)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseImpl)
  vi.mocked(synthesizeAudio).mockReset().mockResolvedValue(response)
})

afterEach(() => { vi.restoreAllMocks() })

it('generates once, autoplays, and reuses the in-memory blob for play pause and replay', async () => {
  const { result, unmount } = renderHook(() => useVoiceReply({ user, scopeKey:'thread-1', enabled:true }))
  await act(async () => { await result.current.generate('message-1', 'turn-1') })
  expect(synthesizeAudio).toHaveBeenCalledOnce()
  expect(result.current.states['message-1'].status).toBe('playing')
  act(() => result.current.pause('message-1'))
  expect(result.current.states['message-1'].status).toBe('paused')
  act(() => audios[0].dispatchEvent(new Event('ended')))
  expect(result.current.states['message-1'].status).toBe('ended')
  await act(async () => { await result.current.play('message-1') })
  expect(synthesizeAudio).toHaveBeenCalledOnce()
  expect(playImpl).toHaveBeenCalledTimes(2)
  unmount()
})

it('catches autoplay rejection and leaves the reply ready for manual Play', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
  const { result, unmount } = renderHook(() => useVoiceReply({ user, scopeKey:'thread-1', enabled:true }))
  await act(async () => { await result.current.generate('message-1', 'turn-1') })
  expect(result.current.states['message-1'].status).toBe('ready')
  expect(synthesizeAudio).toHaveBeenCalledOnce()
  unmount()
})

it('keeps a 402 as a local voice error and does not remove text state', async () => {
  vi.mocked(synthesizeAudio).mockRejectedValueOnce(new ApiError(402, {}))
  const { result } = renderHook(() => useVoiceReply({ user, scopeKey:'thread-1', enabled:true }))
  await act(async () => { await result.current.generate('message-1', 'turn-1') })
  expect(result.current.states['message-1']).toMatchObject({
    status:'error', insufficientCredits:true, error:'Not enough Voice credits to play this reply',
  })
})

it('aborts stale synthesis and revokes object URLs on thread change and unmount', async () => {
  let resolveRequest!: (value: typeof response) => void
  vi.mocked(synthesizeAudio).mockImplementationOnce(() => new Promise(resolve => { resolveRequest = resolve }))
  const { result, rerender, unmount } = renderHook(
    ({ scopeKey }) => useVoiceReply({ user, scopeKey, enabled:true }),
    { initialProps:{ scopeKey:'thread-1' } },
  )
  act(() => { void result.current.generate('message-1', 'turn-1') })
  rerender({ scopeKey:'thread-2' })
  await act(async () => { resolveRequest(response); await Promise.resolve() })
  expect(URL.createObjectURL).not.toHaveBeenCalled()

  await act(async () => { await result.current.generate('message-2', 'turn-2') })
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
  unmount()
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-reply'))
})
