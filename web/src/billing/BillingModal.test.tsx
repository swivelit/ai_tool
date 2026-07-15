import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { BillingModal } from './BillingModal'

vi.mock('../api/client', () => ({ apiJson: vi.fn().mockRejectedValue(new Error('order failed')) }))

it('shows gross payment, credited value, and does not load checkout when order creation fails', async () => {
  const append = vi.spyOn(document.head, 'appendChild')
  render(<BillingModal user={{} as never} config={{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test', min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500 }] }} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByText('You pay')).toBeInTheDocument()
  expect(screen.getAllByText('₹5').length).toBeGreaterThan(0)
  await userEvent.click(screen.getByRole('button', { name: 'Pay ₹10 securely' }))
  expect(await screen.findByText('order failed')).toBeInTheDocument()
  expect(append).not.toHaveBeenCalled()
})
