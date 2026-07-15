import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ApiError, apiJson, streamChat } from '../api/client'
import { ChatPage } from './ChatPage'

const user = { getIdToken: vi.fn().mockResolvedValue('token') }
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user, signOut:vi.fn() }) }))
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson:vi.fn(), streamChat:vi.fn() }
})

const bootstrap = { user:{ id:1, name:'Hari', email:'h@example.com', reply_language:'en' }, wallet:{ balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1 }, billing:{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test_key', min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500 }] }, features:{ web_chat:true, prepaid_billing:true, local_models:false } } as const

function mockApi() {
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    if (path.includes('/billing/ledger') || path === '/api/web/billing/payments') return { items:[] } as never
    return {} as never
  })
}

it('opens billing when the API reports insufficient credit', async () => {
  mockApi(); vi.mocked(streamChat).mockRejectedValueOnce(new ApiError(402, {}))
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'hello'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('dialog', { name:'Add AI credit' })).toBeInTheDocument()
})

it('shows stop generation and sends a cooperative cancellation request', async () => {
  mockApi(); vi.mocked(streamChat).mockImplementation(() => new Promise(() => undefined))
  render(<ChatPage />); const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'long answer'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await userEvent.click(await screen.findByRole('button', { name:'Stop generation' }))
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes('/cancel'))).toBe(true))
})
