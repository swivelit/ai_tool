import type { PaymentHistory } from '../types'

export type PaymentPresentation = {
  heading: string
  detail: string | null
  amountLabel: 'Selected checkout amount' | 'Gross amount paid' | null
  showTokensAdded: boolean
  showRefundAmount: boolean
  showReversalEstimate: boolean
  timestamp: string
  timestampLabel: 'Payment completed' | 'Checkout created'
}

export function paymentPresentation(payment: PaymentHistory): PaymentPresentation {
  const status = payment.status.toLowerCase()
  const creditApplied = payment.credit_applied === true
  const completedTimestamp = payment.paid_at || null
  const base = {
    detail: null,
    amountLabel: null,
    showTokensAdded: false,
    showRefundAmount: false,
    showReversalEstimate: false,
    timestamp: completedTimestamp ?? payment.created_at,
    timestampLabel: completedTimestamp ? 'Payment completed' as const : 'Checkout created' as const,
  }

  if (status === 'creating') {
    return { ...base, heading: 'Preparing checkout', amountLabel: 'Selected checkout amount' }
  }
  if (status === 'created') {
    return {
      ...base,
      heading: 'Checkout not completed',
      detail: 'Payment not confirmed',
      amountLabel: 'Selected checkout amount',
    }
  }
  if (status === 'attempted') {
    return {
      ...base,
      heading: 'Payment attempted — confirmation pending',
      amountLabel: 'Selected checkout amount',
    }
  }
  if (status === 'failed') {
    return { ...base, heading: 'Checkout failed', amountLabel: 'Selected checkout amount' }
  }

  const creditedPresentation = {
    amountLabel: 'Gross amount paid' as const,
    showTokensAdded: creditApplied,
  }
  if (status === 'partially_refunded') {
    return {
      ...base,
      ...creditedPresentation,
      heading: 'Partially refunded',
      showRefundAmount: payment.refunded_amount_paise > 0,
      showReversalEstimate: payment.credit_reversal_micros > 0,
    }
  }
  if (status === 'refunded') {
    return {
      ...base,
      ...creditedPresentation,
      heading: 'Refunded',
      showRefundAmount: true,
      showReversalEstimate: true,
    }
  }
  if ((status === 'credited' || status === 'captured') && creditApplied) {
    return { ...base, ...creditedPresentation, heading: 'Payment completed' }
  }
  if (status === 'captured' || status === 'credited' || payment.payment_received === true) {
    return {
      ...base,
      heading: 'Payment received — token confirmation pending',
      amountLabel: 'Gross amount paid',
    }
  }
  return { ...base, heading: 'Payment status unavailable' }
}
