import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { apiJson } from '../api/client'
import { BillingModal } from './BillingModal'

vi.mock('../api/client', () => ({ apiJson: vi.fn() }))

const estimate = { reference_provider:'openai', reference_model:'gpt-5-nano', pricing_as_of:'2026-07-17T00:00:00Z', pricing_snapshot:{}, estimated_input_only_tokens:180_000, estimated_output_only_tokens:25_000, estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimated using openai/gpt-5-nano pricing. Actual token usage varies by model, provider, cached input and input/output mix.' }
const historyItem = (status: string, changes = {}) => ({ id:`order-${status}`, gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0, status, created_at:'2026-07-17T00:00:00Z', updated_at:'2026-07-17T00:00:00Z', paid_at:null, refunded_at:null, payment_received:false, credit_applied:false, token_estimate:estimate, reversal_token_estimate:estimate, ...changes })
const config = { currency:'INR' as const, credit_percent:'50', razorpay_key_id:'rzp_test_example', razorpay_mode:'test' as const, checkout_enabled:true, min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, token_estimate:estimate }] }

it('shows gross payment, credited value, and does not load checkout when order creation fails', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] }).mockRejectedValueOnce(new Error('order failed'))
  const append = vi.spyOn(document.head, 'appendChild')
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByText('Test Mode')).toBeInTheDocument()
  expect(screen.getAllByText('Pay ₹10').length).toBeGreaterThan(0)
  expect(screen.getAllByText('50% converted to token credits').length).toBeGreaterThan(0)
  expect(screen.getAllByText('25K–180K tokens').length).toBeGreaterThan(0)
  expect(screen.queryByText(/5\.00/)).not.toBeInTheDocument()
  expect(screen.getByText(/Estimated using openai\/gpt-5-nano pricing/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Pay ₹10 securely' }))
  expect(await screen.findByText('order failed')).toBeInTheDocument()
  expect(append).not.toHaveBeenCalled()
})

it('does not describe a created checkout as paid or credited', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[historyItem('created')] })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  expect(await screen.findByText('Checkout not completed')).toBeInTheDocument()
  expect(screen.getByText('Payment not confirmed')).toBeInTheDocument()
  expect(screen.getByText('Selected checkout amount')).toBeInTheDocument()
  expect(screen.queryByText(/₹10(?:\.00)? paid/i)).not.toBeInTheDocument()
  expect(screen.queryByText('Gross amount paid')).not.toBeInTheDocument()
  expect(screen.queryByText('Estimated tokens added')).not.toBeInTheDocument()
  expect(screen.queryByText('Service allocation')).not.toBeInTheDocument()
})

it('keeps genuine payment and refund amounts visible in rupees', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[historyItem('partially_refunded', { refunded_amount_paise:500, credit_reversal_micros:2_500_000, payment_received:true, credit_applied:true, paid_at:'2026-07-17T00:05:00Z' })] })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  expect(await screen.findByText('Partially refunded')).toBeInTheDocument()
  expect(screen.getByText('₹10.00')).toBeInTheDocument()
  expect(screen.getByText('₹5.00')).toBeInTheDocument()
})

it('uses explicit live mode and checkout status instead of inferring from the key', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] })
  render(<BillingModal user={{} as never} config={{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test_misleading', razorpay_mode:'live', checkout_enabled:false, min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, token_estimate:estimate }] }} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByRole('button', { name:'Close add token credits' })).toHaveFocus()
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  expect(await screen.findByText('No payments or refunds yet.')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name:'Add tokens' }))
  expect(screen.queryByText('Test Mode')).not.toBeInTheDocument()
  expect(screen.getByText(/Checkout is currently disabled/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Pay ₹10 securely' })).toBeDisabled()
})
