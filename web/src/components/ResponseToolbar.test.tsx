import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { downloadMarkdown } from '../responseExport'
import { ResponseToolbar } from './ResponseToolbar'

vi.mock('../responseExport', () => ({
  downloadMarkdown: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(downloadMarkdown).mockReset()
})

function toolbar(overrides: {
  content?: string
  original?: string
  hasLocalEdit?: boolean
  onApply?: (content: string) => void
  onReset?: () => void
} = {}) {
  return <ResponseToolbar
    content={overrides.content ?? '# Complete answer'}
    original={overrides.original ?? '# Complete answer'}
    hasLocalEdit={overrides.hasLocalEdit ?? false}
    onApply={overrides.onApply ?? vi.fn()}
    onReset={overrides.onReset ?? vi.fn()}
  />
}

it('copies and downloads the complete displayed Markdown safely', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  render(toolbar({ content: '# Edited answer' }))

  await userEvent.click(screen.getByRole('button', { name: 'Copy response' }))
  expect(writeText).toHaveBeenCalledWith('# Edited answer')
  expect(screen.getByRole('button', { name: 'Response copied' })).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Download response' }))
  expect(downloadMarkdown).toHaveBeenCalledWith('# Edited answer')
})

it('handles clipboard rejection without crashing', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  })
  render(toolbar())

  await userEvent.click(screen.getByRole('button', { name: 'Copy response' }))

  expect(
    await screen.findByRole('button', { name: 'Copy failed' }),
  ).toBeInTheDocument()
})

it('opens accessible preview and edit modes, applies locally, and restores focus', async () => {
  const onApply = vi.fn()
  const { rerender } = render(toolbar({ onApply }))
  const opener = screen.getByRole('button', { name: 'Open response editor' })
  fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'Response editor' })
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(document.body.style.overflow).toBe('hidden')
  expect(screen.getByText('Complete answer')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const source = screen.getByLabelText('Response Markdown source')
  fireEvent.change(source, { target: { value: '# Local working copy' } })
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(downloadMarkdown).toHaveBeenCalledWith('# Local working copy')
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
  expect(onApply).toHaveBeenCalledWith('# Local working copy')

  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await waitFor(() => expect(opener).toHaveFocus())

  const onReset = vi.fn()
  rerender(toolbar({
    content: '# Local working copy',
    original: '# Complete answer',
    hasLocalEdit: true,
    onReset,
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit response' }))
  expect(screen.getByLabelText('Response Markdown source')).toHaveValue(
    '# Local working copy',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reset to original' }))
  expect(onReset).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Response Markdown source')).toHaveValue(
    '# Complete answer',
  )
})
