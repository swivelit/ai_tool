import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Composer } from './Composer'
import type { ComposerAttachment, ComposerRepository, ReadyAttachment } from '../types'

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

it('measures composer height, updates the shared CSS variable, and cleans up in StrictMode', () => {
  const callbacks: Array<() => void> = []
  const disconnect = vi.fn()
  const observe = vi.fn()
  const OriginalResizeObserver = globalThis.ResizeObserver
  class TestResizeObserver {
    constructor(callback: () => void) { callbacks.push(callback) }
    observe = observe
    disconnect = disconnect
    unobserve = vi.fn()
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
  const { container, unmount } = render(<StrictMode><div className="chat-main">
    <div className="conversation" />
    <Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false} />
  </div></StrictMode>)
  const wrap = container.querySelector('.composer-wrap') as HTMLElement
  const conversation = container.querySelector('.conversation') as HTMLElement
  Object.defineProperties(conversation, {
    offsetWidth:{ configurable:true, value:730 },
    clientWidth:{ configurable:true, value:700 },
  })
  vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue({
    width:700, height:237.4, top:0, right:700, bottom:237.4, left:0,
    x:0, y:0, toJSON:() => ({}),
  })
  callbacks.at(-1)?.()
  const main = container.querySelector('.chat-main') as HTMLElement
  expect(main.style.getPropertyValue('--composer-reserved-height')).toBe('237px')
  expect(main.style.getPropertyValue('--chat-scrollbar-inline-reserve')).toBe('15px')
  unmount()
  expect(disconnect).toHaveBeenCalled()
  expect(main.style.getPropertyValue('--composer-reserved-height')).toBe('')
  expect(main.style.getPropertyValue('--chat-scrollbar-inline-reserve')).toBe('')
  globalThis.ResizeObserver = OriginalResizeObserver
})

it('selects documents through the attachment control', async () => {
  const addFiles = vi.fn()
  const { container } = render(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false}
    attachmentsEnabled supportedExtensions={['.txt']} addFiles={addFiles} />)
  const file = new File(['hello'], 'notes.txt', { type:'text/plain' })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(input, file)
  expect(addFiles).toHaveBeenCalledWith([file])
  expect(addFiles).toHaveBeenCalledTimes(1)
})

it('accepts configured image extensions and renders an image thumbnail chip', () => {
  const image = ready({
    name:'preview.png', media_type:'image/png',
    preview_url:'blob:synthetic-preview',
  })
  const { container } = render(<Composer
    value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()}
    streaming={false} attachmentsEnabled supportedExtensions={['.png', '.txt']}
    attachments={[image]}
  />)
  expect((container.querySelector('input[aria-label="Upload files"]') as HTMLInputElement).accept).toBe('.png,.txt')
  expect(container.querySelector('img.attachment-thumbnail')).toHaveAttribute(
    'src', 'blob:synthetic-preview',
  )
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

it('shows repository upload only when enabled and accepts one ZIP', async () => {
  const addRepository = vi.fn()
  const { container, rerender } = render(<Composer
    value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()}
    streaming={false} attachmentsEnabled supportedExtensions={['.txt']}
    repositoryUploadEnabled={false} addRepository={addRepository}
  />)
  await userEvent.click(screen.getByRole('button', { name:'Add to prompt' }))
  expect(screen.queryByRole('menuitem', {
    name:/Upload code repository/,
  })).not.toBeInTheDocument()
  fireEvent.keyDown(window, { key:'Escape' })
  rerender(<Composer
    value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()}
    streaming={false} attachmentsEnabled supportedExtensions={['.txt']}
    repositoryUploadEnabled addRepository={addRepository}
  />)
  await userEvent.click(screen.getByRole('button', { name:'Add to prompt' }))
  await userEvent.click(screen.getByRole('menuitem', {
    name:/Upload code repository/,
  }))
  const input = container.querySelector(
    'input[aria-label="Upload code repository"]',
  ) as HTMLInputElement
  expect(input.accept).toBe('.zip')
  const archive = new File(['archive'], 'swico.zip', {
    type:'application/zip',
  })
  await userEvent.upload(input, archive)
  expect(addRepository).toHaveBeenCalledWith(archive)
})

it('renders bounded repository lifecycle and static-only wording', () => {
  const repository: ComposerRepository = {
    id:'repo-1', display_name:'swico.zip', status:'uploading', progress:125,
    languages:[], file_count:0, symbol_count:0,
  }
  const props = {
    value:'fix it', setValue:vi.fn(), send:vi.fn(), stop:vi.fn(),
    streaming:false, repositoryUploadEnabled:true,
  }
  const { rerender } = render(<Composer {...props} repository={repository} />)
  expect(screen.getByText('Uploading repository… 100%')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Send message' })).toBeDisabled()
  rerender(<Composer {...props} repository={{
    ...repository, status:'ready', progress:100, languages:['Python'],
    file_count:12, symbol_count:20,
  }} repositoryChatEnabled repositoryValidationCapability="static_only" />)
  expect(screen.getByText('Repository ready')).toBeInTheDocument()
  expect(screen.getByText('Python · 12 files')).toBeInTheDocument()
  expect(screen.getByText('Static checks only')).toBeInTheDocument()
  rerender(<Composer {...props} repository={{
    ...repository, status:'expired', progress:100,
  }} />)
  expect(screen.getByText('Repository expired')).toBeInTheDocument()
})

it('shows waveform only when empty and replaces it with Send for content', () => {
  const props = { setValue:vi.fn(), send:vi.fn(), stop:vi.fn(), streaming:false, realtimeVoiceEnabled:true }
  const { rerender } = render(<Composer {...props} value="" />)
  expect(screen.getByTestId('composer')).toBeVisible()
  expect(screen.getByRole('textbox', { name:'Message Swico' })).toBeEnabled()
  expect(screen.getByRole('button', { name:'Start real-time Voice Mode' })).toBeEnabled()
  expect(screen.queryByRole('button', { name:'Send message' })).not.toBeInTheDocument()
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
    attachments={[ready({ warnings:['This PDF appears scanned. OCR was not performed.'] })]} removeAttachment={remove} />)
  expect(screen.getByText(/remaining/)).toBeInTheDocument()
  expect(screen.getByText(/OCR was not performed/)).toHaveAttribute('role', 'status')
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

it('keeps the character count visible from zero through over-limit states', () => {
  const props = { setValue:vi.fn(), send:vi.fn(), stop:vi.fn(), streaming:false, maxCharacters:100, inlineThreshold:90 }
  const { container, rerender } = render(<Composer {...props} value="" />)
  const count = () => container.querySelector<HTMLElement>('#composer-character-count')!
  expect(count()).toHaveTextContent('0 / 100 characters')
  expect(count()).toHaveClass('character-count')
  expect(count()).not.toHaveClass('sr-only')
  expect(screen.getByRole('textbox')).toHaveAttribute('aria-describedby', 'composer-character-count')

  rerender(<Composer {...props} value="short" />)
  expect(count()).toHaveClass('character-count')
  expect(count()).not.toHaveClass('near-limit')
  rerender(<Composer {...props} value={'x'.repeat(80)} />)
  expect(count()).toHaveClass('character-count', 'near-limit')
  expect(count()).not.toHaveClass('sr-only')
  expect(container.querySelector('.composer-shell')).toHaveClass('has-character-count')

  rerender(<Composer {...props} inlineThreshold={30} value={'x'.repeat(30)} />)
  expect(count()).toHaveClass('character-count')
  rerender(<Composer {...props} value={'x'.repeat(100)} />)
  expect(count()).toHaveTextContent('100 / 100 characters')
  expect(count()).not.toHaveClass('over-limit')
  rerender(<Composer {...props} value={'x'.repeat(101)} />)
  expect(count()).toHaveClass('character-count', 'over-limit')
  expect(screen.getByRole('alert')).toHaveTextContent('exceeds the 100-character limit')
  expect(count()).not.toHaveAttribute('aria-live')
})

it('keeps keyboard focus inside the single outer composer shell', () => {
  const { container } = render(<Composer value="" setValue={vi.fn()} send={vi.fn()} stop={vi.fn()} streaming={false} />)
  const shell = container.querySelector('.composer-shell')!
  const inner = container.querySelector('.composer')!
  fireEvent.focus(screen.getByRole('textbox'))
  expect(shell).toContainElement(document.activeElement as HTMLElement)
  expect(inner).not.toHaveAttribute('tabindex')
  expect(inner.className).toBe('composer')
})
