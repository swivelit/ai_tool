import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import type { PaymentStatus } from '../types'

export async function pollPaymentStatus(user: User, id: string, intervalMs = 2000, timeoutMs = 30000, signal?: AbortSignal): Promise<PaymentStatus | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !signal?.aborted) {
    const state = await apiJson<PaymentStatus>(user, `/api/web/billing/payments/${id}`)
    if (['credited', 'failed', 'refunded', 'partially_refunded'].includes(state.status)) return state
    await new Promise<void>(resolve => {
      const timer = window.setTimeout(resolve, intervalMs)
      signal?.addEventListener('abort', () => { window.clearTimeout(timer); resolve() }, { once: true })
    })
  }
  return null
}
