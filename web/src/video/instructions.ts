export type SupportedInstructions = { swap: 'both' | 'male' | 'female'; enhance: 'off' | 'natural'; caption: string }

export const DEFAULT_INSTRUCTIONS = 'swap: both\nenhance: off\ncaption:'

/** Client-side UX validation only; the backend parser remains authoritative. */
export function parseSupportedInstructions(text: string): SupportedInstructions | null {
  const result: SupportedInstructions = { swap: 'both', enhance: 'off', caption: '' }
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    if (separator < 0) return null
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!(key in result) || seen.has(key)) return null
    seen.add(key)
    if (key === 'swap' && (value === 'both' || value === 'male' || value === 'female')) result.swap = value
    else if (key === 'enhance' && (value === 'off' || value === 'natural')) result.enhance = value
    else if (key === 'caption' && value.length <= 100 && ![...value].some(character => {
      const code = character.charCodeAt(0)
      return code < 32 || code > 126
    })) result.caption = value
    else return null
  }
  return result
}

export function formatSupportedInstructions(value: SupportedInstructions): string {
  return `swap: ${value.swap}\nenhance: ${value.enhance}\ncaption: ${value.caption}`
}
