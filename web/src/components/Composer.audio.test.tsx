import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { vi } from 'vitest'
import { Composer } from './Composer'

const recorderMock = vi.hoisted(() => ({ status:'transcribing', options:null as null | Record<string, (...args: never[]) => void> }))

vi.mock('../hooks/useAudioRecorder', () => ({
  useAudioRecorder: (options: Record<string, (...args: never[]) => void>) => {
    recorderMock.options = options
    return {
    state:{ status:recorderMock.status, elapsed_seconds:2, mime_type:'audio/webm', error:null },
    start:vi.fn(), stop:vi.fn(), cancel:vi.fn(), resetError:vi.fn(),
  }},
}))

it('prevents sending while transcription is pending', () => {
  const send = vi.fn()
  render(<Composer user={{} as never} value="ready text" setValue={vi.fn()} send={send} stop={vi.fn()} streaming={false} voiceEnabled />)
  expect(screen.getByText('Transcribing…')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Send message' })).toBeDisabled()
})

it('inserts an editable voice draft without auto-send and clears origin on empty or cancel', async () => {
  recorderMock.status = 'idle'
  const send = vi.fn(); const voiceDraft = vi.fn(); const clear = vi.fn(); const cancel = vi.fn()
  function Harness() {
    const [value, setValue] = useState('')
    return <Composer user={{} as never} value={value} setValue={setValue} send={send} stop={vi.fn()}
      streaming={false} voiceEnabled onVoiceDraft={voiceDraft} onComposerClear={clear} onVoiceCancel={cancel} />
  }
  render(<Harness />)
  act(() => recorderMock.options?.onRecordingStarted('voice-turn' as never))
  act(() => recorderMock.options?.onTranscript('editable transcript' as never, 'voice-turn' as never, {} as never))
  const textbox = screen.getByRole('textbox', { name:'Message Swico' })
  expect(textbox).toHaveValue('editable transcript')
  expect(send).not.toHaveBeenCalled()
  await userEvent.type(textbox, ' changed')
  expect(textbox).toHaveValue('editable transcript changed')
  expect(clear).not.toHaveBeenCalled()
  await userEvent.clear(textbox)
  expect(clear).toHaveBeenCalled()
  act(() => recorderMock.options?.onCancel())
  expect(cancel).toHaveBeenCalled()
})
