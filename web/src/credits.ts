export function formatRupeesFromPaise(paise: number): string {
  const safe = Number.isSafeInteger(paise) ? paise : 0
  const absolute = Math.abs(safe)
  return `${safe < 0 ? '-' : ''}₹${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** Customer-facing INR formatting for whole-rupee prices and amounts. */
export function formatRupeesForDisplay(paise: number): string {
  const safe = Number.isSafeInteger(paise) ? paise : 0
  if (safe % 100 !== 0) return formatRupeesFromPaise(safe)
  return `₹${Math.floor(safe / 100).toLocaleString('en-IN')}`
}

export function compactTokens(tokens: number): string {
  const safe = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0
  if (safe >= 1_000_000) return `${Math.floor(safe / 100_000) / 10}M`
  if (safe >= 1_000) return `${Math.floor(safe / 100) / 10}K`
  return String(safe)
}

export function estimatedTokenLabel(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return 'Estimate temporarily unavailable'
  return tokens <= 0 ? '0 tokens' : `≈ ${compactTokens(tokens)} tokens`
}

export function tokenRangeLabel(minimum: number | null | undefined, maximum: number | null | undefined): string {
  if (minimum === null || minimum === undefined || maximum === null || maximum === undefined) return 'Estimate temporarily unavailable'
  return `${compactTokens(minimum)}–${compactTokens(maximum)} tokens`
}

type TokenEstimateShape = {
  estimated_blended_tokens: number | null
  range_min_tokens: number | null
  range_max_tokens: number | null
  estimate_available?: boolean
  availability?: 'available' | 'unavailable'
}

export function tokenEstimateAvailable(estimate: TokenEstimateShape | null | undefined): boolean {
  return Boolean(estimate && estimate.estimated_blended_tokens !== null && estimate.estimate_available !== false && estimate.availability !== 'unavailable' && estimate.range_min_tokens !== null && estimate.range_min_tokens !== undefined && estimate.range_max_tokens !== null && estimate.range_max_tokens !== undefined)
}

export function tokenEstimateLabel(estimate: TokenEstimateShape | null | undefined, unit: 'tokens' | 'token equivalent' = 'tokens'): string {
  if (!tokenEstimateAvailable(estimate)) return 'Estimate temporarily unavailable'
  if (estimate?.estimated_blended_tokens === 0) return unit === 'tokens' ? '0 tokens' : '0 token equivalent'
  const label = tokenRangeLabel(estimate?.range_min_tokens, estimate?.range_max_tokens)
  return unit === 'tokens' ? label : label.replace(/ tokens$/, ' token equivalent')
}

export function fullTokenRangeLabel(minimum: number | null | undefined, maximum: number | null | undefined): string {
  if (minimum === null || minimum === undefined || maximum === null || maximum === undefined) return 'Estimate temporarily unavailable'
  return `${Math.max(0, minimum).toLocaleString()}–${Math.max(0, maximum).toLocaleString()} tokens`
}
