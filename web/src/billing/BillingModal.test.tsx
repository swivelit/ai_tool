import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { apiJson } from '../api/client'
import { BillingModal } from './BillingModal'

vi.mock('../api/client', () => ({ apiJson: vi.fn() }))

it('shows gross payment, credited value, and does not load checkout when order creation fails', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] }).mockRejectedValueOnce(new Error('order failed'))
  const append = vi.spyOn(document.head, 'appendChild')
  render(<BillingModal user={{} as never} config={{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test_example', razorpay_mode:'test', checkout_enabled:true, min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500 }] }} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByText('Test Mode')).toBeInTheDocument()
  expect(screen.getByText('Amount paid')).toBeInTheDocument()
  expect(screen.getAllByText(/5\.00 AI credits/).length).toBeGreaterThan(0)
  expect(screen.queryByText('₹5.00 AI credits')).not.toBeInTheDocument()
  expect(screen.getByText('Pay ₹10 → receive 5.00 AI credits')).toBeInTheDocument()
  expect(screen.getByText('Equivalent to ₹5 of consumable AI usage')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Pay ₹10 securely' }))
  expect(await screen.findByText('order failed')).toBeInTheDocument()
  expect(append).not.toHaveBeenCalled()
})

it('uses explicit live mode and checkout status instead of inferring from the key', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] })
  render(<BillingModal user={{} as never} config={{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test_misleading', razorpay_mode:'live', checkout_enabled:false, min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500 }] }} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByRole('button', { name:'Close add credit' })).toHaveFocus()
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  expect(await screen.findByText('No payments or refunds yet.')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name:'Add credits' }))
  expect(screen.queryByText('Test Mode')).not.toBeInTheDocument()
  expect(screen.getByText(/Checkout is currently disabled/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Pay ₹10 securely' })).toBeDisabled()
})
