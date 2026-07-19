import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, vi } from 'vitest'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice'
import { VoiceMode } from './VoiceMode'

vi.mock('../hooks/useRealtimeVoice', () => ({ useRealtimeVoice:vi.fn() }))

const base = {
  phase:'listening' as const, partial:'hello', assistant:'', muted:false, error:'',
  ticketInfo:{ tier_label:'Swico Pro', language:'ta' as const }, creditRequired:null,
  toggleMute:vi.fn(), end:vi.fn(),
}

beforeEach(() => vi.mocked(useRealtimeVoice).mockReturnValue(base as never))

it('shows language, tier, live transcript and accessible mute/end controls', async () => {
  const close = vi.fn()
  render(<VoiceMode user={{} as never} threadId="thread-1" close={close} addCredits={vi.fn()} />)
  expect(screen.getByRole('heading', { name:'Listening' })).toBeInTheDocument()
  expect(screen.getByText('Swico Pro · Tamil')).toBeInTheDocument()
  expect(screen.getByText('hello')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Mute microphone' }))
  expect(base.toggleMute).toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name:'End conversation' }))
  expect(base.end).toHaveBeenCalled(); expect(close).toHaveBeenCalled()
})

it('renders streamed text, interruption, errors and targeted credit actions', async () => {
  const addCredits = vi.fn()
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase:'interrupted', partial:'', assistant:'streamed answer', error:'Connection closed.', creditRequired:'voice' } as never)
  render(<VoiceMode user={{} as never} threadId={null} close={vi.fn()} addCredits={addCredits} />)
  expect(screen.getByRole('heading', { name:'Interrupted' })).toBeInTheDocument()
  expect(screen.getByText('streamed answer')).toBeInTheDocument()
  expect(screen.getByText(/does not reconnect automatically/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Add Voice credits' }))
  expect(addCredits).toHaveBeenCalledWith('voice')
})
