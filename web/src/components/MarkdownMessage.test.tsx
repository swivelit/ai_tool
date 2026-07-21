import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import hljs from 'highlight.js/lib/core'
import { vi } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'

it('keeps streaming fenced code as React-owned plain text without DOM-mutating highlighting', () => {
  const highlightElement = vi.spyOn(hljs, 'highlightElement')
  const { container, rerender } = render(<MarkdownMessage streaming>{'```typescript\nconst value = "<script>alert(1)</script>";\n'}</MarkdownMessage>)
  const versions = [
    'const value = "<script>',
    'const value = "<script>alert(1)',
    'const value = "<script>alert(1)</script>";',
  ]
  for (const code of versions) {
    rerender(<MarkdownMessage streaming>{`\`\`\`typescript\n${code}\n`}</MarkdownMessage>)
    expect(container.querySelector('.code-block code')).toHaveTextContent(code)
    expect(container.querySelector('.code-block code')?.textContent).toBe(code)
  }
  expect(highlightElement).not.toHaveBeenCalled()
  expect(container.querySelector('.code-block code span')).not.toBeInTheDocument()
  expect(container.querySelector('script')).not.toBeInTheDocument()
  expect(container.innerHTML).toContain('&lt;script&gt;')
})

it('highlights known completed code once with the pure API while preserving text and copy content', async () => {
  const source = 'const answer: number = 42\nconsole.log(answer)'
  const highlight = vi.spyOn(hljs, 'highlight')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText } })
  const { container, rerender } = render(<MarkdownMessage streaming>{`\`\`\`typescript\n${source}\n\`\`\``}</MarkdownMessage>)
  expect(container.querySelector('.code-block code')).not.toHaveClass('hljs')
  expect(container.querySelector('.code-block code')?.textContent).toBe(source)
  expect(highlight).not.toHaveBeenCalled()

  rerender(<MarkdownMessage streaming={false}>{`\`\`\`typescript\n${source}\n\`\`\``}</MarkdownMessage>)
  const code = container.querySelector('.code-block code')
  expect(highlight).toHaveBeenCalledTimes(1)
  expect(code).toHaveClass('hljs')
  expect(code?.querySelector('span')).toBeInTheDocument()
  expect(code?.textContent).toBe(source)
  await userEvent.click(screen.getByRole('button', { name:'Copy code' }))
  expect(writeText).toHaveBeenCalledWith(source)
})

it('renders unknown languages and multiple code blocks without auto-detection or duplicated text', () => {
  const highlight = vi.spyOn(hljs, 'highlight')
  const markdown = [
    '```unknown-language',
    '<widget>one</widget>',
    '```',
    '',
    '```json',
    '{"safe":"<script>"}',
    '```',
  ].join('\n')
  const { container } = render(<MarkdownMessage>{markdown}</MarkdownMessage>)
  const blocks = [...container.querySelectorAll('.code-block code')]
  expect(blocks).toHaveLength(2)
  expect(blocks[0]?.textContent).toBe('<widget>one</widget>')
  expect(blocks[0]?.querySelector('span')).not.toBeInTheDocument()
  expect(blocks[1]?.textContent).toBe('{"safe":"<script>"}')
  expect(container.querySelector('script')).not.toBeInTheDocument()
  expect(highlight).toHaveBeenCalledTimes(1)
})
