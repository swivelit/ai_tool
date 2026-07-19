import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { apiJson } from '../api/client'
import type { TopupEstimateResponse } from '../types'
import { BillingModal } from './BillingModal'

vi.mock('../api/client', () => ({ apiJson: vi.fn() }))

const estimate = { tier:'lite' as const, tier_label:'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimated for Swico Lite. Actual usage depends on message size, response length, and task complexity.' }
const estimate299 = { ...estimate, estimated_blended_tokens:860_000, range_min_tokens:358_000, range_max_tokens:2_100_000 }
const customEstimate = { tier:'lite' as const, tier_label:'Swico Lite', estimated_blended_tokens:450_000, range_min_tokens:187_000, range_max_tokens:1_350_000 }
const newerCustomEstimate = { ...customEstimate, estimated_blended_tokens:460_000, range_min_tokens:190_000, range_max_tokens:1_360_000 }
const historyItem = (status: string, changes = {}) => ({ id:`order-${status}`, gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0, status, created_at:'2026-07-17T00:00:00Z', updated_at:'2026-07-17T00:00:00Z', paid_at:null, refunded_at:null, payment_received:false, credit_applied:false, token_estimate:estimate, reversal_token_estimate:estimate, ...changes })
const config = {
  currency:'INR' as const, credit_percent:'50', razorpay_key_id:'rzp_test_example',
  razorpay_mode:'test' as const, checkout_enabled:true, custom_topup_enabled:true,
  min_topup_paise:1000, max_topup_paise:50000,
  packages:[
    { gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, token_estimate:estimate },
    { gross_amount_paise:29900, credited_amount_micros:149_500_000, platform_share_paise:14950, token_estimate:estimate299 },
  ],
}
const voiceEstimate = { pricing_version:'test-v1', estimated_stt_seconds:600, estimated_stt_minutes:'10.00', estimated_tts_characters:5000, assumption:'STT-only or TTS-only; not guaranteed.' }
const voiceConfig = { ...config, packages:config.packages.map(item => ({ ...item, voice_estimate:voiceEstimate })) }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('renders exactly ₹10, ₹299, and Custom amount with ₹10 initially selected', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await act(async () => { await Promise.resolve() })
  const dialog = screen.getByRole('dialog', { name:'Add credits' })
  expect(dialog).not.toHaveAttribute('aria-describedby')
  expect(screen.getByText('Test Mode')).toBeInTheDocument()
  const cards = dialog.querySelectorAll('.packages button')
  expect(cards).toHaveLength(3)
  expect(screen.getByRole('button', { name:'Pay ₹10, estimated 25K to 180K tokens' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name:'Pay ₹299, estimated 358K to 2.1M tokens' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('button', { name:'Enter a custom payment amount' })).toHaveAttribute('aria-pressed', 'false')
  expect(within(dialog).getByText('Custom amount')).toBeInTheDocument()
  expect(dialog).not.toHaveTextContent(/Pay ₹50|Pay ₹100|Pay ₹500/)
  expect(document.querySelector('.package-summary')).toHaveTextContent('Pay ₹10 for Chat creditsEstimated token range 25K–180K tokens')
  expect(screen.getByRole('button', { name:'Pay ₹10 for Chat credits' })).toBeEnabled()
  expect(dialog).not.toHaveTextContent(/converted to token credits|service(?: and platform)? allocation|Pricing timestamp|Estimated for Swico|%/i)
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
})

it('uses stable preset selection and sends ₹299 exactly', async () => {
  vi.mocked(apiJson).mockReset().mockImplementation((_user, path) => {
    if (path === '/api/web/billing/payments') return Promise.resolve({ items:[] })
    if (path === '/api/web/billing/orders') return Promise.reject(new Error('order stopped for test'))
    throw new Error(`unexpected ${path}`)
  })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name:'Pay ₹299, estimated 358K to 2.1M tokens' }))
  expect(document.querySelector('.package-summary')).toHaveTextContent('Pay ₹299 for Chat creditsEstimated token range 358K–2.1M tokens')
  await userEvent.click(screen.getByRole('button', { name:'Pay ₹299 for Chat credits' }))
  await screen.findByText('order stopped for test')
  const orderCall = vi.mocked(apiJson).mock.calls.find(call => call[1] === '/api/web/billing/orders')
  expect(JSON.parse(String(orderCall?.[2]?.body))).toMatchObject({ gross_amount_paise:29900 })
})

it('selects Voice credits and sends the authoritative bucket with speech estimates', async () => {
  vi.mocked(apiJson).mockReset().mockImplementation((_user, path) => {
    if (path === '/api/web/billing/payments') return Promise.resolve({ items:[] })
    if (path === '/api/web/billing/orders') return Promise.reject(new Error('order stopped for test'))
    throw new Error(`unexpected ${path}`)
  })
  render(<BillingModal user={{} as never} config={voiceConfig} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name:'Voice credits' }))
  expect(document.querySelector('.package-summary')).toHaveTextContent('STT-only estimate 10.00 minutes')
  expect(document.querySelector('.package-summary')).toHaveTextContent('TTS-only estimate 5,000 characters')
  await userEvent.click(screen.getByRole('button', { name:'Pay ₹10 for Voice credits' }))
  await screen.findByText('order stopped for test')
  const call = vi.mocked(apiJson).mock.calls.find(item => item[1] === '/api/web/billing/orders')
  expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ gross_amount_paise:1000, credit_bucket:'voice' })
})

it('validates custom whole rupees and never estimates or opens checkout for invalid input', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] })
  const append = vi.spyOn(document.head, 'appendChild')
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name:'Enter a custom payment amount' }))
  const input = screen.getByLabelText('Custom amount')
  const pay = screen.getByRole('button', { name:'Enter a valid amount' })
  expect(input).toHaveAttribute('inputmode', 'numeric')
  expect(input).toHaveAttribute('aria-describedby', 'custom-amount-help')
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(pay).toBeDisabled()
  await userEvent.type(input, '9')
  expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount from ₹10 to ₹500.')
  expect(input).toHaveAttribute('aria-describedby', 'custom-amount-help custom-amount-error')
  await userEvent.clear(input); await userEvent.type(input, '501')
  expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount from ₹10 to ₹500.')
  await userEvent.clear(input); await userEvent.type(input, '12.5')
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole-rupee amount using numbers only.')
  expect(vi.mocked(apiJson).mock.calls.filter(call => call[1].startsWith('/api/web/billing/estimate'))).toHaveLength(0)
  expect(vi.mocked(apiJson).mock.calls.filter(call => call[1] === '/api/web/billing/orders')).toHaveLength(0)
  expect(append).not.toHaveBeenCalled()
})

it('debounces a valid ₹75 estimate, updates summary, retains input across tabs, and sends 7500 paise', async () => {
  vi.mocked(apiJson).mockReset().mockImplementation((_user, path) => {
    if (path === '/api/web/billing/payments') return Promise.resolve({ items:[] })
    if (path === '/api/web/billing/estimate?gross_amount_paise=7500&credit_bucket=chat') {
      return Promise.resolve({ gross_amount_paise:7500, token_estimate:customEstimate })
    }
    if (path === '/api/web/billing/orders') return Promise.reject(new Error('order stopped for test'))
    throw new Error(`unexpected ${path}`)
  })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name:'Enter a custom payment amount' }))
  const input = screen.getByLabelText('Custom amount')
  await userEvent.type(input, '75')
  expect(screen.getByRole('button', { name:'Calculating estimate…' })).toBeDisabled()
  await waitFor(() => expect(apiJson).toHaveBeenCalledWith(
    expect.anything(), '/api/web/billing/estimate?gross_amount_paise=7500&credit_bucket=chat',
    expect.objectContaining({ signal:expect.any(AbortSignal) }),
  ))
  expect(await screen.findByRole('button', { name:'Pay ₹75 for Chat credits' })).toBeEnabled()
  expect(document.querySelector('.package-summary')).toHaveTextContent('Pay ₹75 for Chat creditsEstimated token range 187K–1.3M tokens')
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  await userEvent.click(screen.getByRole('tab', { name:'Add credits' }))
  expect(screen.getByLabelText('Custom amount')).toHaveValue('75')
  await userEvent.click(screen.getByRole('button', { name:'Pay ₹75 for Chat credits' }))
  await screen.findByText('order stopped for test')
  const orderCall = vi.mocked(apiJson).mock.calls.find(call => call[1] === '/api/web/billing/orders')
  expect(JSON.parse(String(orderCall?.[2]?.body))).toMatchObject({ gross_amount_paise:7500 })
})

it('ignores a stale custom estimate response after the amount changes', async () => {
  const first = deferred<TopupEstimateResponse>()
  const second = deferred<TopupEstimateResponse>()
  vi.mocked(apiJson).mockReset().mockImplementation((_user, path) => {
    if (path === '/api/web/billing/payments') return Promise.resolve({ items:[] })
    if (path.includes('gross_amount_paise=7500&')) return first.promise
    if (path.includes('gross_amount_paise=7600&')) return second.promise
    throw new Error(`unexpected ${path}`)
  })
  render(<BillingModal user={{} as never} config={config} close={vi.fn()} refreshed={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name:'Enter a custom payment amount' }))
  const input = screen.getByLabelText('Custom amount')
  await userEvent.type(input, '75')
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => call[1].includes('gross_amount_paise=7500&'))).toBe(true))
  await userEvent.clear(input); await userEvent.type(input, '76')
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => call[1].includes('gross_amount_paise=7600&'))).toBe(true))
  await act(async () => second.resolve({ gross_amount_paise:7600, token_estimate:newerCustomEstimate }))
  expect(await screen.findByRole('button', { name:'Pay ₹76 for Chat credits' })).toBeEnabled()
  expect(document.querySelector('.package-summary')).toHaveTextContent('190K–1.3M tokens')
  await act(async () => first.resolve({ gross_amount_paise:7500, token_estimate:customEstimate }))
  await waitFor(() => expect(document.querySelector('.package-summary')).toHaveTextContent('Pay ₹76'))
  expect(document.querySelector('.package-summary')).toHaveTextContent('190K–1.3M tokens')
  expect(document.querySelector('.package-summary')).not.toHaveTextContent('187K')
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
  expect(screen.queryByText(/service allocation|50%/i)).not.toBeInTheDocument()
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
  expect(screen.queryByText(/service allocation|50%/i)).not.toBeInTheDocument()
})

it('keeps checkout-disabled behavior and accessibility focus unchanged', async () => {
  vi.mocked(apiJson).mockReset().mockResolvedValueOnce({ items:[] })
  render(<BillingModal user={{} as never} config={{ ...config, razorpay_key_id:'rzp_test_misleading', razorpay_mode:'live', checkout_enabled:false }} close={vi.fn()} refreshed={vi.fn()} />)
  expect(screen.getByRole('button', { name:'Close add credits' })).toHaveFocus()
  await userEvent.click(screen.getByRole('tab', { name:'Payment history' }))
  expect(await screen.findByText('No payments or refunds yet.')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name:'Add credits' }))
  expect(screen.queryByText('Test Mode')).not.toBeInTheDocument()
  expect(screen.getByText(/Checkout is currently disabled/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Pay ₹10 for Chat credits' })).toBeDisabled()
})
