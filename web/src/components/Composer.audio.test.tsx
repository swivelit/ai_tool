import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Composer } from './Composer'

vi.mock('../hooks/useAudioRecorder', () => ({
  useAudioRecorder: () => ({
    state:{ status:'transcribing', elapsed_seconds:2, mime_type:'audio/webm', error:null },
    start:vi.fn(), stop:vi.fn(), cancel:vi.fn(), resetError:vi.fn(),
  }),
}))

it('prevents sending while transcription is pending', () => {
  const send = vi.fn()
  render(<Composer user={{} as never} value="ready text" setValue={vi.fn()} send={send} stop={vi.fn()} streaming={false} voiceEnabled />)
  expect(screen.getByText('Transcribing…')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Send message' })).toBeDisabled()
})
