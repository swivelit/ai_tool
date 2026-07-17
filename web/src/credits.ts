export function formatRupeesFromPaise(paise: number): string {
  const safe = Number.isSafeInteger(paise) ? paise : 0
  const absolute = Math.abs(safe)
  return `${safe < 0 ? '-' : ''}₹${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

export function compactTokens(tokens: number): string {
  const safe = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0
  if (safe >= 1_000_000) return `${Math.floor(safe / 100_000) / 10}M`
  if (safe >= 1_000) return `${Math.floor(safe / 100) / 10}K`
  return String(safe)
}

export function estimatedTokenLabel(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return 'Estimate unavailable'
  return tokens <= 0 ? '0 tokens' : `≈ ${compactTokens(tokens)} tokens`
}

export function tokenRangeLabel(minimum: number, maximum: number): string {
  return `${compactTokens(minimum)}–${compactTokens(maximum)} tokens`
}

export function fullTokenRangeLabel(minimum: number, maximum: number): string {
  return `${Math.max(0, minimum).toLocaleString()}–${Math.max(0, maximum).toLocaleString()} tokens`
}
