import { expect, it, vi } from 'vitest'
import { apiJson } from '../api/client'
import { pollPaymentStatus } from './paymentPolling'

vi.mock('../api/client', () => ({ apiJson: vi.fn() }))

it('polls pending payment until credited without creating another order', async () => {
  const payment = { internal_order_id:'o1', gross_amount_paise:1500, credited_amount_micros:7_500_000, platform_share_paise:750, refunded_amount_paise:0, provider_payment_id:'p1', created_at:'', paid_at:null, refunded_at:null, updated_at:'' }
  vi.mocked(apiJson).mockResolvedValueOnce({ ...payment, status:'attempted' }).mockResolvedValueOnce({ ...payment, status:'credited' })
  const result = await pollPaymentStatus({} as never, 'o1', 0, 1000)
  expect(result?.status).toBe('credited'); expect(apiJson).toHaveBeenCalledTimes(2)
  expect(vi.mocked(apiJson).mock.calls.every(call => call[1] === '/api/web/billing/payments/o1')).toBe(true)
})
