import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Composer } from './Composer'

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
