import { afterEach, expect, it, vi } from 'vitest'
import { downloadMarkdown, responseMarkdownFilename } from './responseExport'

afterEach(() => vi.restoreAllMocks())

it('creates a deterministic safe Markdown filename', () => {
  expect(
    responseMarkdownFilename(new Date(2026, 6, 30, 9, 5)),
  ).toBe('swico-response-2026-07-30-0905.md')
})

it('downloads exact UTF-8 Markdown and revokes the object URL', async () => {
  const source = '# Safe Markdown\n\n<script>alert("text only")</script>'
  let capturedBlob: Blob | undefined
  const createObjectURL = vi.fn((blob: Blob) => {
    capturedBlob = blob
    return 'blob:swico-response'
  })
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURL,
  })
  const clicked = vi.spyOn(
    HTMLAnchorElement.prototype,
    'click',
  ).mockImplementation(function click(this: HTMLAnchorElement) {
    expect(this.download).toMatch(
      /^swico-response-\d{4}-\d{2}-\d{2}-\d{4}\.md$/,
    )
    expect(this.href).toBe('blob:swico-response')
  })

  downloadMarkdown(source)

  expect(clicked).toHaveBeenCalledTimes(1)
  expect(capturedBlob?.type).toBe('text/markdown;charset=utf-8')
  const downloadedText = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(capturedBlob as Blob)
  })
  expect(downloadedText).toBe(source)
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:swico-response')
  expect(document.querySelector('a[download]')).not.toBeInTheDocument()
})
