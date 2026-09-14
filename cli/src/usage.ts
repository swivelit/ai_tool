type UsageObject = Record<string, unknown>

function object(value: unknown): UsageObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UsageObject : undefined
}

function integerLabel(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value.toLocaleString('en-US')
  if (typeof value === 'string' && /^\d+$/.test(value)) return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return undefined
}

/** Render the public /usage envelope without inventing precision or quotas. */
export function formatUsage(value: unknown): string {
  const body = object(value) ?? {}
  const wallet = object(body.wallet) ?? object(body.chat_wallet) ?? body
  const tier = typeof body.tier_label === 'string' ? body.tier_label : typeof body.tier === 'string' ? body.tier : 'paid Chat'
  const available = integerLabel(wallet.available_micros ?? wallet.balance_micros)
  const reserved = integerLabel(wallet.reserved_micros)
  const estimate = object(wallet.token_estimate) ?? object(body.token_estimate)
  const blended = integerLabel(estimate?.estimated_blended_tokens)
  const minimum = integerLabel(estimate?.range_min_tokens)
  const maximum = integerLabel(estimate?.range_max_tokens)
  const lines = [`Swico Chat usage (${tier})`]
  lines.push(`Available Chat credit: ${available === undefined ? 'unavailable' : `${available} micros`}`)
  lines.push(`Reserved Chat credit: ${reserved === undefined ? 'unavailable' : `${reserved} micros`}`)
  if (wallet.billing_exempt === true) lines.push('Allowance/eligibility: exempt account (as reported by the usage endpoint)')
  else lines.push('Allowance/eligibility: not shown by the usage endpoint')
  if (blended || minimum || maximum) {
    const range = minimum && maximum ? `${minimum}–${maximum}` : blended ?? 'unavailable'
    lines.push(`Estimated token range: ${range} tokens (estimate, not exact provider-token balance)`)
  } else if (estimate?.availability === 'unavailable') {
    lines.push('Token estimate: unavailable (pricing estimate)')
  } else {
    lines.push('Token estimate: not shown by the usage endpoint')
  }
  return lines.join('\n')
}
