import { describe, expect, it } from 'vitest'
import { DEFAULT_INSTRUCTIONS, formatSupportedInstructions, parseSupportedInstructions } from './instructions'

describe('supported video instructions', () => {
  it('round-trips the visible supported controls', () => {
    const value = { swap: 'female' as const, enhance: 'natural' as const, caption: 'hello' }
    expect(parseSupportedInstructions(formatSupportedInstructions(value))).toEqual(value)
    expect(parseSupportedInstructions(DEFAULT_INSTRUCTIONS)).toEqual({ swap: 'both', enhance: 'off', caption: '' })
  })

  it.each(['make them dance', 'swap: both\nscene: beach', 'swap: male\nswap: female', 'caption: 🙂', `caption: ${'x'.repeat(101)}`])('rejects unsupported input: %s', value => {
    expect(parseSupportedInstructions(value)).toBeNull()
  })
})
