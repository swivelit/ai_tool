export function formatAiCredits(micros: number, decimals = 2): string {
  const safe = Number.isSafeInteger(micros) ? micros : 0
  const negative = safe < 0
  const absolute = Math.abs(safe)
  const scale = 10 ** decimals
  const divisor = 1_000_000 / scale
  const rounded = Math.floor((absolute + Math.floor(divisor / 2)) / divisor)
  const whole = Math.floor(rounded / scale)
  const fraction = String(rounded % scale).padStart(decimals, '0')
  return `${negative ? '-' : ''}${whole}${decimals ? `.${fraction}` : ''}`
}

export function formatRupeesFromPaise(paise: number): string {
  const safe = Number.isSafeInteger(paise) ? paise : 0
  const absolute = Math.abs(safe)
  return `${safe < 0 ? '-' : ''}₹${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

export function parseAiCreditsToMicros(value: string): number | null {
  const cleaned = value.trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(cleaned)) return null
  const [whole, fraction = ''] = cleaned.split('.')
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null
}

export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 100_000) / 10}m`
  if (tokens >= 1_000) return `${Math.floor(tokens / 100) / 10}k`
  return String(tokens)
}
