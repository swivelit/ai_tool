const SAFE_PREFIX = /^(?:`{3,8}|~{3,8})(?:html|xml|css|javascript|js|typescript|ts|json|python|py|bash|sh|shell|sql|text|code)?\n$/
const STARTS_WITH_FENCE = /^[ \t]{0,3}(?:`{3,}|~{3,})/

export function continuationMarkdown(content: string, prefix?: string | null): string {
  const value = String(content ?? '')
  const candidate = String(prefix ?? '')
  if (!candidate || !SAFE_PREFIX.test(candidate) || STARTS_WITH_FENCE.test(value)) return value
  return candidate + value
}
