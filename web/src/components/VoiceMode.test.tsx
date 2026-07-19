import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, vi } from 'vitest'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice'
import { VoiceMode } from './VoiceMode'

vi.mock('../hooks/useRealtimeVoice', () => ({ useRealtimeVoice:vi.fn() }))

const base = {
  phase:'listening' as const, partial:'hello', assistant:'', muted:false, error:'',
  ticketInfo:{ tier_label:'Swico Pro', language:'ta' as const }, creditRequired:null,
  toggleMute:vi.fn(), retry:vi.fn(), end:vi.fn().mockResolvedValue(undefined),
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
  expect(screen.getByRole('heading', { name:'Listening' })).toBeInTheDocument()
  expect(screen.getByText('streamed answer')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Try again' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Add Voice credits' }))
  expect(addCredits).toHaveBeenCalledWith('voice')
})

it('shows endpoint pending, toggles captions, and retries without closing the dialog', async () => {
  const retry = vi.fn()
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase:'endpoint_pending', retry } as never)
  render(<VoiceMode user={{} as never} threadId={null} close={vi.fn()} addCredits={vi.fn()} />)
  expect(screen.getByRole('heading', { name:'Still listening…' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Hide captions' }))
  expect(screen.queryByText('hello')).not.toBeInTheDocument()
  expect(document.querySelector('.voice-orb-core')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/chatgpt|openai/i)
})
