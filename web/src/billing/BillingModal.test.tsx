import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { apiJson } from '../api/client'
import { BillingModal } from './BillingModal'

vi.mock('../api/client', () => ({ apiJson: vi.fn() }))

const estimate = { tier:'lite' as const, tier_label:'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimated for Swico Lite. Actual usage depends on message size, response length, and task complexity.' }
const historyItem = (status: string, changes = {}) => ({ id:`order-${status}`, gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0, status, created_at:'2026-07-17T00:00:00Z', updated_at:'2026-07-17T00:00:00Z', paid_at:null, refunded_at:null, payment_received:false, credit_applied:false, token_estimate:estimate, reversal_token_estimate:estimate, ...changes })
const config = { currency:'INR' as const, credit_percent:'50', razorpay_key_id:'rzp_test_example', razorpay_mode:'test' as const, checkout_enabled:true, min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, token_estimate:estimate }] }

it('shows package amounts and token ranges without allocation copy and does not load checkout when order creation fails', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] }).mockRejectedValueOnce(new Error('order failed'))
  const append = vi.spyOn(document.head, 'appendChild')
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByRole('dialog', { name:'Add token credits' })).not.toHaveAttribute('aria-describedby')
  expect(screen.getByText('Test Mode')).toBeInTheDocument()
  const packageButton = screen.getByRole('button', { name:'Pay ₹10, estimated 25K to 180K tokens' })
  expect(packageButton).toHaveAttribute('aria-pressed', 'true')
  expect(packageButton).toHaveTextContent('Pay ₹10')
  expect(packageButton).toHaveTextContent('25K–180K tokens')
  expect(packageButton).not.toHaveTextContent(/%/)
  expect(screen.getAllByText('Pay ₹10').length).toBeGreaterThan(0)
  expect(screen.getAllByText('25K–180K tokens').length).toBeGreaterThan(0)
  const summary = document.querySelector('.package-summary')
  expect(summary).toHaveTextContent('Pay ₹10')
  expect(summary).toHaveTextContent('Estimated token range 25K–180K tokens')
  expect(summary).not.toHaveTextContent(/%/)
  expect(summary?.children).toHaveLength(2)
  expect(screen.queryByText(/converted to token credits/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/service(?: and platform)? allocation/i)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Pay ₹10 securely' })).toBeInTheDocument()
  expect(screen.queryByText(/5\.00/)).not.toBeInTheDocument()
  expect(screen.queryByText('Secure prepaid usage for Swico')).not.toBeInTheDocument()
  expect(screen.queryByText('Token estimates are approximate for your selected Swico mode and do not guarantee a fixed amount.')).not.toBeInTheDocument()
  expect(screen.queryByText(/Estimated for Swico Lite/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Pricing as of|Pricing timestamp/i)).not.toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
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
  expect(screen.getByText('Estimated tokens added')).toBeInTheDocument()
  expect(screen.getByText('Estimated tokens reversed')).toBeInTheDocument()
  expect(screen.getAllByText('25K–180K tokens')).toHaveLength(2)
  expect(screen.queryByText(/service allocation/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/50%/)).not.toBeInTheDocument()
})

it('keeps completed payment details visible without service allocation', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[historyItem('credited', { payment_received:true, credit_applied:true, paid_at:'2026-07-17T00:05:00Z' })] })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  expect(await screen.findAllByText('Payment completed')).toHaveLength(2)
  expect(screen.getByText('Gross amount paid')).toBeInTheDocument()
  expect(screen.getByText('₹10.00')).toBeInTheDocument()
  expect(screen.getByText('Estimated tokens added')).toBeInTheDocument()
  expect(screen.getByText('25K–180K tokens')).toBeInTheDocument()
  expect(screen.queryByText(/service allocation/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/50%/)).not.toBeInTheDocument()
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
