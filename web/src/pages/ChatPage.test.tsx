import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ApiError, apiJson, streamChat } from '../api/client'
import { chatErrorMessage } from '../chatErrors'
import { ChatPage } from './ChatPage'

const user = { getIdToken: vi.fn().mockResolvedValue('token') }
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user, signOut:vi.fn() }) }))
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson:vi.fn(), streamChat:vi.fn() }
})

const assistant = { tier:'lite' as const, tier_label:'Swico Lite', tier_description:'Fast and efficient for everyday questions.', tier_selection_enabled:true, tiers:[
  { id:'lite' as const, label:'Swico Lite', description:'Fast and efficient for everyday questions.', available:true, selected:true },
  { id:'standard' as const, label:'Swico', description:'Balanced quality and speed for most tasks.', available:true, selected:false },
  { id:'pro' as const, label:'Swico Pro', description:'Best for complex reasoning, planning, and coding.', available:false, selected:false },
] }
const bootstrap = { user:{ id:1, name:'Hari', email:'h@example.com', reply_language:'en' }, wallet:{ balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1 }, billing:{ currency:'INR', credit_percent:'50', razorpay_key_id:'rzp_test_key', razorpay_mode:'test', checkout_enabled:true, custom_topup_enabled:true, min_topup_paise:1000, max_topup_paise:50000, packages:[{ gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500 }, { gross_amount_paise:29900, credited_amount_micros:149_500_000, platform_share_paise:14950 }] }, assistant, features:{ web_chat:true, prepaid_billing:true } } as const

it.each([
  [401, 'session expired'],
  [402, 'more AI credit'],
  [409, 'already being processed'],
  [422, 'Review your message'],
  [429, 'too quickly'],
  [500, 'temporarily unavailable'],
])('maps HTTP %i to a distinct actionable message', (status, expected) => {
  expect(chatErrorMessage(new ApiError(status, {}), false)).toContain(expected)
})

it('prioritises the offline state over an HTTP error', () => {
  expect(chatErrorMessage(new ApiError(500, {}), true)).toContain('offline')
})

function mockApi() {
  vi.mocked(apiJson).mockReset()
  vi.mocked(apiJson).mockImplementation(async (_user, path) => {
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    if (path.includes('/billing/ledger') || path === '/api/web/billing/payments') return { items:[] } as never
    return {} as never
  })
}

it('opens an accessible header mode selector with all public names and closes on Escape', async () => {
  mockApi(); render(<ChatPage />)
  const trigger = await screen.findByRole('button', { name:'Swico Lite' })
  await userEvent.click(trigger)
  expect(screen.getByRole('listbox', { name:'Swico modes' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name:/Fast and efficient/ })).toBeInTheDocument()
  const standardOption = screen.getByRole('option', { name:/Balanced quality and speed/ })
  expect(standardOption).toBeInTheDocument()
  expect(screen.getByRole('option', { name:/Best for complex reasoning/ })).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|chatgpt|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
  fireEvent.keyDown(screen.getByRole('listbox'), { key:'ArrowDown' })
  expect(standardOption).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('listbox'), { key:'Escape' })
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
  await userEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
})

it('saves a selected mode and refreshes the tier-sensitive token estimate', async () => {
  let selected = false
  const standard = { ...assistant, tier:'standard' as const, tier_label:'Swico', tier_description:'Balanced quality and speed for most tasks.', tiers:assistant.tiers.map(item => ({ ...item, selected:item.id === 'standard' })) }
  vi.mocked(apiJson).mockReset().mockImplementation(async (_user, path, init) => {
    if (path === '/api/web/settings/assistant' && init?.method === 'PATCH') { selected = true; return standard as never }
    if (path === '/api/web/bootstrap') return { ...bootstrap, assistant:selected ? standard : assistant, wallet:{ ...bootstrap.wallet, token_estimate:{ tier:selected ? 'standard' : 'lite', tier_label:selected ? 'Swico' : 'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:selected ? 12_000 : 60_000, range_min_tokens:5_000, range_max_tokens:20_000, explanation:'Estimate for the selected Swico mode.' } } } as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Swico Lite' }))
  await userEvent.click(screen.getByRole('option', { name:/Balanced quality and speed/ }))
  await waitFor(() => expect(screen.getByRole('button', { name:'Swico' })).toBeInTheDocument())
  expect(vi.mocked(apiJson)).toHaveBeenCalledWith(expect.anything(), '/api/web/settings/assistant', expect.objectContaining({ body:'{"tier":"standard"}' }))
  expect(await screen.findByText('≈ 12K tokens')).toBeInTheDocument()
})

it('restores the previous mode and reports a safe error when saving fails', async () => {
  mockApi()
  vi.mocked(apiJson).mockImplementation(async (_user, path, init) => {
    if (path === '/api/web/settings/assistant' && init?.method === 'PATCH') throw new Error('private routing failure')
    if (path === '/api/web/bootstrap') return bootstrap as never
    if (path.startsWith('/api/web/threads')) return { items:[], has_more:false } as never
    return {} as never
  })
  render(<ChatPage />)
  await userEvent.click(await screen.findByRole('button', { name:'Swico Lite' }))
  await userEvent.click(screen.getByRole('option', { name:/Balanced quality and speed/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('previous mode is still active')
  expect(screen.getByRole('button', { name:'Swico Lite' })).toBeInTheDocument()
  expect(screen.queryByText('private routing failure')).not.toBeInTheDocument()
})

it('opens billing when the API reports insufficient credit', async () => {
  mockApi(); vi.mocked(streamChat).mockRejectedValueOnce(new ApiError(402, {}))
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'hello'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('dialog', { name:'Add token credits' })).toBeInTheDocument()
})

it('shows stop generation and sends a cooperative cancellation request', async () => {
  mockApi(); vi.mocked(streamChat).mockImplementation(() => new Promise(() => undefined))
  render(<ChatPage />); const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'long answer'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(screen.getByRole('button', { name:'Swico Lite' })).toBeDisabled()
  await userEvent.click(await screen.findByRole('button', { name:'Stop generation' }))
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => String(call[1]).includes('/cancel'))).toBe(true))
})

it('shows usage-limit reset metadata without opening add-credit checkout', async () => {
  mockApi(); vi.mocked(streamChat).mockRejectedValueOnce(new ApiError(402, { error:{ code:'usage_limit_reached', reset_at:'2026-08-01T00:00:00Z' } }))
  render(<ChatPage />)
  const composer = await screen.findByRole('textbox', { name:'Message Swico' })
  await userEvent.type(composer, 'hello'); await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/monthly AI usage limit has been reached.*resets/i)
  expect(screen.queryByRole('dialog', { name:'Add AI credits' })).not.toBeInTheDocument()
})

it('refreshes the wallet estimate when the tab regains focus without polling', async () => {
  mockApi()
  render(<ChatPage />)
  await screen.findByRole('textbox', { name:'Message Swico' })
  window.dispatchEvent(new Event('focus'))
  await waitFor(() => expect(vi.mocked(apiJson).mock.calls.some(call => call[1] === '/api/web/billing/wallet')).toBe(true))
})
