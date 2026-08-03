const SAFE_PREFIX = /^(?:`{3,8}|~{3,8})(?:html|xml|css|javascript|js|typescript|ts|json|python|py|bash|sh|shell|sql|text|code)?\n$/
const STARTS_WITH_FENCE = /^[ \t]{0,3}(?:`{3,}|~{3,})/

export function continuationMarkdown(content: string, prefix?: string | null): string {
  const value = String(content ?? '')
  const candidate = String(prefix ?? '')
  if (!candidate || !SAFE_PREFIX.test(candidate) || STARTS_WITH_FENCE.test(value)) return value
  return candidate + value
}

export function stitchContinuationMarkdown(segments: readonly {
  content: string
  continuation_rewind_characters?: number
}[]): string {
  if (!segments.length) return ''
  let combined = String(segments[0].content ?? '')
  for (const segment of segments.slice(1)) {
    const requestedRewind = Number(segment.continuation_rewind_characters ?? 0)
    const rewind = Number.isInteger(requestedRewind)
      ? Math.max(0, Math.min(combined.length, requestedRewind)) : 0
    if (rewind > 0) combined = combined.slice(0, -rewind)
    const next = String(segment.content ?? '')
    if (rewind === 0 && combined && next && !combined.endsWith('\n') && !next.startsWith('\n')) {
      combined += '\n'
    }
    combined += next
  }
  return combined
}
