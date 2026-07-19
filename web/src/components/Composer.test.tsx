import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Composer } from './Composer'
import type { ComposerAttachment, ReadyAttachment } from '../types'

const assistant = { tier:'lite' as const, tier_label:'Swico Lite', tier_description:'', tier_selection_enabled:true, tiers:[
  { id:'lite' as const, label:'Swico Lite', description:'Fast', available:true, selected:true },
  { id:'standard' as const, label:'Swico', description:'Balanced', available:true, selected:false },
] }

const ready = (overrides: Partial<ReadyAttachment> = {}): ReadyAttachment => ({
  id:'upload-1', name:'notes.txt', media_type:'text/plain', size_bytes:1024,
  created_at:new Date().toISOString(), expires_at:new Date(Date.now() + 600_000).toISOString(),
  status:'ready', warnings:[], ...overrides,
})

it('sends on Enter, preserves Shift+Enter, and exposes stop state', async () => {
  const send = vi.fn(); const stop = vi.fn(); const setValue = vi.fn()
  const { rerender } = render(<Composer value="hello" setValue={setValue} send={send} stop={stop} streaming={false} />)
  const textarea = screen.getByRole('textbox')
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(textarea, { key: 'Enter' }); expect(send).toHaveBeenCalledOnce()
  rerender(<Composer value="hello" setValue={setValue} send={send} stop={stop} streaming disabled={false} />)
  await userEvent.click(screen.getByRole('button', { name: 'Stop generation' })); expect(stop).toHaveBeenCalledOnce()
})

it('auto-resizes for multiline and resets after clearing', () => {
  const { rerender } = render(<Composer value={'one\ntwo\nthree'} setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false} />)
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 120 })
  rerender(<Composer value={'one\ntwo\nthree\nfour'} setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false} />)
  expect(textarea.style.height).toBe('120px')
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 28 })
  rerender(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false} />)
  expect(textarea.style.height).toBe('28px')
})

it('selects and drops documents through the attachment control', async () => {
  const addFiles = vi.fn()
  const { container } = render(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    attachmentsEnabled supportedExtensions={['.txt']} addFiles={addFiles} />)
  const file = new File(['hello'], 'notes.txt', { type:'text/plain' })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(input, file)
  expect(addFiles).toHaveBeenCalledWith([file])
  fireEvent.drop(screen.getByTestId('composer').parentElement!, { dataTransfer:{ files:[file] } })
  expect(addFiles).toHaveBeenCalledTimes(2)
})

it('opens the Plus menu accessibly, uploads, restores focus, and hosts the tier selector', async () => {
  const addFiles = vi.fn(); const onTierSelect = vi.fn()
  const { container } = render(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    attachmentsEnabled supportedExtensions={['.txt']} addFiles={addFiles}
    assistant={assistant} onTierSelect={onTierSelect} />)
  const plus = screen.getByRole('button', { name:'Add to prompt' })
  await userEvent.click(plus)
  expect(plus).toHaveAttribute('aria-expanded', 'true')
  const upload = await screen.findByRole('menuitem', { name:/Upload files/ })
  expect(upload).toHaveFocus()
  fireEvent.keyDown(window, { key:'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(plus).toHaveFocus()
  await userEvent.click(plus)
  await userEvent.click(screen.getByRole('menuitem', { name:/Upload files/ }))
  const file = new File(['hello'], 'notes.txt', { type:'text/plain' })
  await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file)
  expect(addFiles).toHaveBeenCalledWith([file])
  await userEvent.click(screen.getByRole('button', { name:/Swico Lite/ }))
  await userEvent.click(screen.getByRole('option', { name:/Balanced/ }))
  expect(onTierSelect).toHaveBeenCalledWith('standard')
})

it('shows waveform only when empty and replaces it with Send for content', () => {
  const props = { setValue:vi.fn(), send:vi.fn(), stop:vi.fn(), streaming:false, realtimeVoiceEnabled:true }
  const { rerender } = render(<Composer {...props} value="" />)
  expect(screen.getByRole('button', { name:'Start real-time Voice Mode' })).toBeEnabled()
  rerender(<Composer {...props} value="draft" />)
  expect(screen.queryByRole('button', { name:'Start real-time Voice Mode' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Send message' })).toBeEnabled()
})

it('explains authenticated Voice disablement and issues no start action', async () => {
  const start = vi.fn()
  render(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    realtimeVoiceEnabled={false} realtimeVoiceUnavailableReason="Voice Mode is disabled on the server."
    onRealtimeVoice={start} />)
  const button = screen.getByRole('button', { name:'Start real-time Voice Mode' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('title', 'Voice Mode is disabled on the server.')
  await userEvent.click(button)
  expect(start).not.toHaveBeenCalled()
})

it('shows upload state, countdown, expiry, and removes attachments', async () => {
  const remove = vi.fn()
  const uploading: ComposerAttachment = {
    local_id:'local', file:new File(['x'], 'draft.csv', { type:'text/csv' }), name:'draft.csv',
    media_type:'text/csv', size_bytes:1, status:'uploading', progress:42,
  }
  const { rerender } = render(<Composer value="hello" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    attachments={[uploading]} removeAttachment={remove} />)
  expect(screen.getByText('Uploading… 42%')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Send message' })).toBeDisabled()
  rerender(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    attachments={[ready()]} removeAttachment={remove} />)
  expect(screen.getByText(/remaining/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Send message' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name:'Remove notes.txt' }))
  expect(remove).toHaveBeenCalled()
  rerender(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    attachments={[ready({ status:'expired' } as never)]} removeAttachment={remove} />)
  expect(screen.getByText('Expired')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Start real-time Voice Mode' })).toBeDisabled()
})

it('sends an attachment-only message on Enter', () => {
  const send = vi.fn()
  render(<Composer value="" setValue={vi.fn()} send={send} stop={vi.fn()} streaming={false} attachments={[ready()]} />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key:'Enter' })
  expect(send).toHaveBeenCalledOnce()
})
