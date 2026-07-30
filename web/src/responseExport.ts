function twoDigits(value: number): string {
  return value.toString().padStart(2, '0')
}

export function responseMarkdownFilename(now = new Date()): string {
  return [
    'swico-response-',
    now.getFullYear(),
    '-',
    twoDigits(now.getMonth() + 1),
    '-',
    twoDigits(now.getDate()),
    '-',
    twoDigits(now.getHours()),
    twoDigits(now.getMinutes()),
    '.md',
  ].join('')
}

export function downloadMarkdown(content: string, now = new Date()): void {
  const blob = new Blob([content], {
    type: 'text/markdown;charset=utf-8',
  })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = responseMarkdownFilename(now)
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(objectUrl)
  }
}
