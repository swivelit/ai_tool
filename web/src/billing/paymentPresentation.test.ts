import { describe, expect, it } from 'vitest'
import type { PaymentHistory } from '../types'
import { paymentPresentation } from './paymentPresentation'

const createdAt = '2026-07-17T10:00:00Z'
const paidAt = '2026-07-17T10:05:00Z'

function payment(status: string, changes: Partial<PaymentHistory> = {}): PaymentHistory {
  return {
    id:`order-${status}`, gross_amount_paise:1000, credited_amount_micros:5_000_000,
    platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0,
    status, created_at:createdAt, updated_at:createdAt, paid_at:null, refunded_at:null,
    payment_received:false, credit_applied:false, ...changes,
  }
}

describe('paymentPresentation', () => {
  it('never presents a created checkout as paid or credited', () => {
    const view = paymentPresentation(payment('created'))
    expect(view.heading).toBe('Checkout not completed')
    expect(view.detail).toBe('Payment not confirmed')
    expect(view.amountLabel).toBe('Selected checkout amount')
    expect(view.showTokensAdded).toBe(false)
    expect(view.showServiceAllocation).toBe(false)
  })

  it('presents an attempted checkout as confirmation pending', () => {
    expect(paymentPresentation(payment('attempted')).heading).toBe('Payment attempted — confirmation pending')
  })

  it('presents captured but uncredited payment as token confirmation pending', () => {
    const view = paymentPresentation(payment('captured', { payment_received:true, paid_at:paidAt }))
    expect(view.heading).toBe('Payment received — token confirmation pending')
    expect(view.showTokensAdded).toBe(false)
    expect(view.showServiceAllocation).toBe(false)
  })

  it('presents a ledger-credited payment as completed', () => {
    const view = paymentPresentation(payment('credited', { payment_received:true, credit_applied:true, paid_at:paidAt }))
    expect(view.heading).toBe('Payment completed')
    expect(view.showTokensAdded).toBe(true)
    expect(view.showServiceAllocation).toBe(true)
    expect(view.timestamp).toBe(paidAt)
    expect(view.timestampLabel).toBe('Payment completed')
  })

  it('shows only positive partial-refund and reversal values', () => {
    const view = paymentPresentation(payment('partially_refunded', {
      payment_received:true, credit_applied:true, paid_at:paidAt,
      refunded_amount_paise:500, credit_reversal_micros:2_500_000,
    }))
    expect(view.heading).toBe('Partially refunded')
    expect(view.showRefundAmount).toBe(true)
    expect(view.showReversalEstimate).toBe(true)
  })

  it('shows full-refund information', () => {
    const view = paymentPresentation(payment('refunded', {
      payment_received:true, credit_applied:true, paid_at:paidAt,
      refunded_amount_paise:1000, credit_reversal_micros:5_000_000,
    }))
    expect(view.heading).toBe('Refunded')
    expect(view.showRefundAmount).toBe(true)
    expect(view.showReversalEstimate).toBe(true)
  })

  it('does not present a failed checkout as paid or credited', () => {
    const view = paymentPresentation(payment('failed'))
    expect(view.heading).toBe('Checkout failed')
    expect(view.amountLabel).toBe('Selected checkout amount')
    expect(view.showTokensAdded).toBe(false)
    expect(view.showServiceAllocation).toBe(false)
  })
})
