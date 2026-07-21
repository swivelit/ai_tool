import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, vi } from 'vitest'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice'
import { VoiceMode } from './VoiceMode'

vi.mock('../hooks/useRealtimeVoice', () => ({ useRealtimeVoice:vi.fn() }))

const base = {
  phase:'listening' as const, partial:'hello', assistant:'', muted:false, error:'',
  ticketInfo:{ tier_label:'Swico Pro', language:'ta' as const }, creditRequired:null,
  microphoneLevel:.25, cannotHear:false,
  playbackWarning:'', playbackState:'playback_finished', canReplay:false,
  toggleMute:vi.fn(), retry:vi.fn(), end:vi.fn().mockResolvedValue(undefined),
  manualPlay:vi.fn(), skipPlayback:vi.fn(),
}

const props = {
  user:{} as never, threadId:'thread-1', close:vi.fn(), addCredits:vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useRealtimeVoice).mockReturnValue(base as never)
})

it('has exactly one normal-state button and removes all secondary session controls and diagnostics', () => {
  render(<VoiceMode {...props} />)
  const dialog = screen.getByRole('dialog', { name:'Voice' })
  const buttons = within(dialog).getAllByRole('button')

  expect(buttons).toHaveLength(1)
  expect(buttons[0]).toHaveAccessibleName('Close Voice Mode')
  expect(buttons[0]).toHaveFocus()
  expect(screen.getByRole('heading', { name:'Listening' })).toBeInTheDocument()
  expect(screen.getByText('Swico Pro · Tamil')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Mute microphone' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Unmute microphone' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Hide captions' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Show captions' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'End conversation' })).not.toBeInTheDocument()
  expect(screen.queryByText('Voice diagnostics')).not.toBeInTheDocument()
  expect(document.querySelector('.voice-controls')).not.toBeInTheDocument()
})

it('shows partial and assistant captions automatically with their labels', () => {
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, partial:'spoken question', assistant:'spoken answer' } as never)
  render(<VoiceMode {...props} />)

  const captions = screen.getByLabelText('Voice captions')
  expect(captions).toHaveTextContent('You')
  expect(captions).toHaveTextContent('spoken question')
  expect(captions).toHaveTextContent('Swico')
  expect(captions).toHaveTextContent('spoken answer')
})

it('does not render an empty captions region', () => {
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, partial:'   ', assistant:'\n' } as never)
  render(<VoiceMode {...props} />)
  expect(screen.queryByLabelText('Voice captions')).not.toBeInTheDocument()
})

it('ends Voice Mode once before closing it', async () => {
  const order: string[] = []
  const end = vi.fn(async () => { order.push('end') })
  const close = vi.fn(() => { order.push('close') })
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, end } as never)
  render(<VoiceMode {...props} close={close} />)

  await userEvent.click(screen.getByRole('button', { name:'Close Voice Mode' }))
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(end).toHaveBeenCalledTimes(1)
  expect(order).toEqual(['end', 'close'])
})

it('guards rapid repeated click and Escape close actions', async () => {
  let resolveEnd!: () => void
  const end = vi.fn(() => new Promise<void>(resolve => { resolveEnd = resolve }))
  const close = vi.fn()
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, end } as never)
  render(<VoiceMode {...props} close={close} />)
  const closeButton = screen.getByRole('button', { name:'Close Voice Mode' })

  fireEvent.click(closeButton)
  fireEvent.click(closeButton)
  fireEvent.keyDown(window, { key:'Escape' })
  expect(end).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
  expect(closeButton).toBeDisabled()

  await act(async () => { resolveEnd() })
  expect(close).toHaveBeenCalledTimes(1)
})

it('ends and closes Voice Mode with Escape', async () => {
  const close = vi.fn()
  render(<VoiceMode {...props} close={close} />)
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(base.end).toHaveBeenCalledTimes(1)
})

it('still closes safely if ending rejects unexpectedly', async () => {
  const close = vi.fn()
  const end = vi.fn().mockRejectedValue(new Error('unexpected cleanup failure'))
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, end } as never)
  render(<VoiceMode {...props} close={close} />)
  await userEvent.click(screen.getByRole('button', { name:'Close Voice Mode' }))
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(end).toHaveBeenCalledTimes(1)
})

it('keeps error retry recovery available without closing the dialog', async () => {
  const retry = vi.fn()
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase:'error', error:'Connection closed.', retry } as never)
  render(<VoiceMode {...props} />)
  await userEvent.click(screen.getByRole('button', { name:'Try again' }))
  expect(retry).toHaveBeenCalledTimes(1)
  expect(props.close).not.toHaveBeenCalled()
})

it('offers only Voice-credit recovery inside Voice Mode', async () => {
  const addCredits = vi.fn()
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase:'error', error:'Credits required.', creditRequired:'voice' } as never)
  render(<VoiceMode {...props} addCredits={addCredits} />)
  expect(screen.queryByRole('button', { name:'Add Chat credits' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Add Voice credits' }))
  expect(addCredits).toHaveBeenCalledWith('voice')
})

it('does not expose a Chat purchase for a legacy Chat-credit Voice error', () => {
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase:'error', error:'Refresh Swico.', creditRequired:'chat' } as never)
  render(<VoiceMode {...props} />)
  expect(screen.queryByRole('button', { name:'Add Chat credits' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Add Voice credits' })).not.toBeInTheDocument()
})

it.each([
  ['autoplay_blocked', false, 'Tap to play'],
  ['playback_error', true, 'Replay full spoken answer'],
] as const)('keeps %s playback recovery and skip actions available', async (playbackState, canReplay, playName) => {
  const manualPlay = vi.fn()
  const skipPlayback = vi.fn()
  vi.mocked(useRealtimeVoice).mockReturnValue({
    ...base, playbackWarning:'The spoken reply needs attention.', playbackState,
    canReplay, manualPlay, skipPlayback,
  } as never)
  render(<VoiceMode {...props} />)

  await userEvent.click(screen.getByRole('button', { name:playName }))
  await userEvent.click(screen.getByRole('button', { name:'Skip audio' }))
  expect(manualPlay).toHaveBeenCalledTimes(1)
  expect(skipPlayback).toHaveBeenCalledTimes(1)
})

it('shows endpoint-pending guidance and keeps upstream product identity text out of the component', () => {
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase:'endpoint_pending' } as never)
  render(<VoiceMode {...props} />)
  expect(screen.getByRole('heading', { name:'Still listening…' })).toBeInTheDocument()
  expect(screen.getByText('Take your time')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name:'Thinking' })).not.toBeInTheDocument()
  expect(document.querySelector('.voice-orb-core')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/chatgpt|openai/i)
})

it.each(['thinking', 'speaking'] as const)('never shows cannot-hear while %s', phase => {
  vi.mocked(useRealtimeVoice).mockReturnValue({ ...base, phase, cannotHear:true, muted:false } as never)
  render(<VoiceMode {...props} />)
  expect(screen.queryByText(/We cannot hear you/i)).not.toBeInTheDocument()
})
