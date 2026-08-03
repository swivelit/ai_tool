export const SENTENCE_VALIDATOR_VERSION = '2026-08-03.1'

const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\./giu
const BOUNDARY = /[.!?।॥]+(?:\s+|$)|\n+/gu

export function sharedSentenceCount(value: string): number {
  const text = String(value ?? '').trim()
  if (!text) return 0
  const protectedText = text.replace(ABBREVIATION, match => match.replaceAll('.', '․'))
  return protectedText.split(BOUNDARY).filter(part => part.trim()).length
}
