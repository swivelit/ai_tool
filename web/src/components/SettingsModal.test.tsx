import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { apiJson } from '../api/client'
import type { UsageSummary } from '../types'
import { SettingsModal } from './SettingsModal'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson: vi.fn() }
})

const profile = { name:'Hari', place:'Chennai', timezone:'Asia/Kolkata', assistant_name:'Elli', reply_language:'en' as const, email:'h@example.com', email_editable:false as const }
const preferences = { period:'monthly' as const, tier:'lite' as const, tier_label:'Swico Lite', hard_limit_micros:null, hard_limit_ai_credits:null, hard_limit_token_estimate:null, remaining_token_estimate:null, warning_threshold_percent:80, notify_at_threshold:true, current_usage_micros:250_000, current_usage_ai_credits:'0.250000', remaining_micros:null, warning_reached:false, next_reset_at:'2026-08-31T18:30:00Z', timezone:'Asia/Kolkata', updated_at:null }
const emptyTier = (label: string) => ({ label, request_count:0, input_tokens:0, cached_input_tokens:0, output_tokens:0, total_tokens:0, debited_micros:0, debited_ai_credits:'0.000000', debited_token_credits:'0.000000', period_debit_percentage:0, monthly_limit_percentage:0 })
const usage = { period:'current_month' as const, tier:'lite' as const, tier_label:'Swico Lite', timezone:'Asia/Kolkata', period_start:'2026-07-31T18:30:00Z', period_end:'2026-08-31T18:30:00Z', next_reset_at:'2026-08-31T18:30:00Z', request_count:2, input_tokens:1200, cached_input_tokens:300, output_tokens:400, total_tokens:1600, actual_usage_count:1, estimated_usage_count:1, debited_micros:250_000, debited_ai_credits:'0.250000', available_micros:5_000_000, available_ai_credits:'5.000000', daily:[], monthly_hard_limit_micros:null, by_tier:{ lite:{ ...emptyTier('Swico Lite'), request_count:2, input_tokens:1200, cached_input_tokens:300, output_tokens:400, total_tokens:1600, debited_micros:250_000, debited_token_credits:'0.250000', period_debit_percentage:100 }, standard:emptyTier('Swico'), pro:emptyTier('Swico Pro') }, voice:{ label:'Voice' as const, stt_request_count:0, tts_request_count:0, total_audio_seconds:0, total_tts_characters:0, request_count:0, debited_micros:0, debited_voice_credits:'0.000000', period_debit_percentage:0, monthly_limit_percentage:0 }, estimated_tokens_remaining:{ tier:'lite' as const, tier_label:'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimated for Swico Lite. Actual usage depends on message size, response length, and task complexity.' } }
const assistant = { tier:'lite' as const, tier_label:'Swico Lite', tier_description:'Fast and efficient for everyday questions.', tier_selection_enabled:true, tiers:[
  { id:'lite' as const, label:'Swico Lite', description:'Fast and efficient for everyday questions.', available:true, selected:true },
  { id:'standard' as const, label:'Swico', description:'Balanced quality and speed for most tasks.', available:true, selected:false },
  { id:'pro' as const, label:'Swico Pro', description:'Best for complex reasoning, planning, and coding.', available:false, selected:false },
] }

function mockSettingsApi(payments: unknown[] = [], usageValue: UsageSummary = usage) {
  vi.mocked(apiJson).mockImplementation(async (_user, path, init) => {
    if (path === '/api/web/settings/profile' && init?.method === 'PATCH') return { ...profile, ...(JSON.parse(String(init.body)) as object) } as never
    if (path === '/api/web/settings/profile') return profile as never
    if (path === '/api/web/settings/usage' && init?.method === 'PATCH') return { ...preferences, ...(JSON.parse(String(init.body)) as object) } as never
    if (path === '/api/web/settings/usage') return preferences as never
    if (path.includes('/usage/summary')) return usageValue as never
    if (path === '/api/web/billing/payments') return { items:payments } as never
    throw new Error(`Unhandled ${path}`)
  })
}

it('displays and saves the shared Swico mode in General settings', async () => {
  mockSettingsApi(); const saveTier = vi.fn().mockResolvedValue(undefined)
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={saveTier} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  expect(screen.getByRole('dialog', { name:'Settings' })).not.toHaveAttribute('aria-describedby')
  expect(screen.queryByText('Manage your profile, token usage, and Swico preferences.')).not.toBeInTheDocument()
  await screen.findByRole('heading', { name:'General' })
  await userEvent.click(screen.getByRole('button', { name:/Swico Lite/ }))
  expect(screen.getByRole('listbox', { name:'Swico modes' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('option', { name:/Balanced quality and speed/ }))
  await waitFor(() => expect(saveTier).toHaveBeenCalledWith('standard'))
})

it('uses the same conservative created-checkout presentation in settings', async () => {
  mockSettingsApi([{ id:'created-order', gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0, status:'created', created_at:'2026-07-17T00:00:00Z', updated_at:'2026-07-17T00:00:00Z', paid_at:null, refunded_at:null, payment_received:false, credit_applied:false }])
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Token credits' }))
  expect(screen.getByText('Checkout not completed')).toBeInTheDocument()
  expect(screen.getByText('Payment not confirmed')).toBeInTheDocument()
  expect(screen.queryByText(/₹10(?:\.00)? paid/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/Gross amount paid/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/tokens unavailable added/i)).not.toBeInTheDocument()
  expect(screen.queryByText('50% service allocation')).not.toBeInTheDocument()
})

it('shows completed and refunded payment details without allocation percentages', async () => {
  const tokenEstimate = usage.estimated_tokens_remaining
  mockSettingsApi([
    { id:'credited-order', gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0, status:'credited', created_at:'2026-07-17T00:00:00Z', updated_at:'2026-07-17T00:05:00Z', paid_at:'2026-07-17T00:05:00Z', refunded_at:null, payment_received:true, credit_applied:true, token_estimate:tokenEstimate, reversal_token_estimate:tokenEstimate },
    { id:'refund-order', gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:500, credit_reversal_micros:2_500_000, status:'partially_refunded', created_at:'2026-07-17T00:00:00Z', updated_at:'2026-07-18T00:05:00Z', paid_at:'2026-07-17T00:05:00Z', refunded_at:'2026-07-18T00:05:00Z', payment_received:true, credit_applied:true, token_estimate:tokenEstimate, reversal_token_estimate:tokenEstimate },
  ])
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Token credits' }))
  expect(screen.getAllByText('Payment completed')).toHaveLength(3)
  expect(screen.getByText('Partially refunded')).toBeInTheDocument()
  expect(screen.getAllByText('Gross amount paid: ₹10.00')).toHaveLength(2)
  expect(screen.getAllByText('Estimated 25K–180K tokens added')).toHaveLength(2)
  expect(screen.getByText('₹5.00 refunded')).toBeInTheDocument()
  expect(screen.getByText('Estimated 25K–180K tokens reversed')).toBeInTheDocument()
  expect(screen.queryByText(/service(?: and platform)? allocation/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/50%/)).not.toBeInTheDocument()
})

it('shows concise tier estimates and this-month token categories', async () => {
  mockSettingsApi()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Token credits' }))
  expect(screen.getByText('Chat credits available')).toBeInTheDocument()
  expect(screen.getByText('Voice credits available')).toBeInTheDocument()
  expect(screen.getByText('Swico Lite estimated token range')).toBeInTheDocument()
  expect(screen.getByText('25,000–180,000 tokens')).toBeInTheDocument()
  expect(screen.getByText('This month')).toBeInTheDocument()
  expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  expect(screen.getByRole('progressbar', { name:'Swico Lite credit utilization' })).toHaveAttribute('aria-valuenow', '100')
  expect(screen.getByRole('progressbar', { name:'Swico credit utilization' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByRole('progressbar', { name:'Swico Pro credit utilization' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByRole('progressbar', { name:'Voice credit utilization' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByText(/these are not LLM tokens/i)).toBeInTheDocument()
  expect(screen.getByText('Input tokens')).toBeInTheDocument()
  expect(screen.getByText('1,200')).toBeInTheDocument()
  expect(screen.getByText('Cached input tokens')).toBeInTheDocument()
  expect(screen.getByText('300')).toBeInTheDocument()
  expect(screen.getByText('Output tokens')).toBeInTheDocument()
  expect(screen.getByText('400')).toBeInTheDocument()
  expect(screen.getByText('25,000–180,000 tokens')).toBeInTheDocument()
  expect(screen.queryByText(/₹5/)).not.toBeInTheDocument()
  expect(screen.getByText('Total tokens')).toBeInTheDocument()
  expect(screen.getByText('1,600')).toBeInTheDocument()
  expect(screen.queryByText('70/30')).not.toBeInTheDocument()
  expect(screen.queryByText(/not a guaranteed quota/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/Estimated for Swico Lite/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/Pricing timestamp|Pricing as of/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/Measured requests|Estimated requests/i)).not.toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
})

it('shows Unlimited without a fictitious range or top-up controls', async () => {
  mockSettingsApi([], {
    ...usage, billing_exempt:true, balance_display:'Unlimited',
    estimated_tokens_remaining:null,
  })
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Token credits' }))
  expect(screen.getAllByText('Unlimited').length).toBeGreaterThanOrEqual(2)
  expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  expect(screen.queryByText(/estimated token range/i)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Add credits' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name:'Estimated monthly token limit' })).not.toBeInTheDocument()
})

it('edits profile, validates required fields, and saves owner fields only', async () => {
  mockSettingsApi(); const savedProfile = vi.fn()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={savedProfile} />)
  await userEvent.click(await screen.findByRole('button', { name:'Profile' }))
  const name = screen.getByLabelText('Name')
  await userEvent.clear(name); await userEvent.click(screen.getByRole('button', { name:'Save profile' }))
  expect(screen.getByRole('status')).toHaveTextContent(/Name, timezone, and assistant name are required/)
  await userEvent.type(name, 'New Name'); await userEvent.selectOptions(screen.getByLabelText('Reply language'), 'ta')
  await userEvent.click(screen.getByRole('button', { name:'Save profile' }))
  await waitFor(() => expect(savedProfile).toHaveBeenCalledWith(expect.objectContaining({ name:'New Name', reply_language:'ta' })))
  expect(screen.getByDisplayValue('h@example.com')).toHaveAttribute('readonly')
})

it('configures an estimated monthly token limit and warning threshold', async () => {
  mockSettingsApi()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Token credits' }))
  await userEvent.click(screen.getByLabelText('No monthly limit beyond prepaid token credits'))
  await userEvent.type(screen.getByRole('textbox', { name:/Estimated monthly tokens/ }), '250000')
  await userEvent.clear(screen.getByLabelText('Warning threshold (%)')); await userEvent.type(screen.getByLabelText('Warning threshold (%)'), '75')
  await userEvent.click(screen.getByRole('button', { name:'Save usage limit' }))
  await waitFor(() => expect(vi.mocked(apiJson)).toHaveBeenCalledWith(expect.anything(), '/api/web/settings/usage', expect.objectContaining({ body: expect.stringContaining('250000') })))
})

it('traps focus, closes on escape, and exposes archived/legal controls', async () => {
  mockSettingsApi(); const close = vi.fn(); const archived = vi.fn()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} assistant={assistant} tierSaving={false} saveTier={vi.fn()} close={close} addCredits={vi.fn()} openArchived={archived} savedProfile={vi.fn()} />)
  expect(screen.getByRole('button', { name:'Close settings' })).toHaveFocus()
  await userEvent.click(await screen.findByRole('button', { name:'Data controls' }))
  await userEvent.click(screen.getByRole('button', { name:/Archived chats/ })); expect(archived).toHaveBeenCalled()
  expect(screen.getByRole('link', { name:'Terms' })).toHaveAttribute('href', '/legal/terms')
  fireEvent.keyDown(window, { key:'Escape' }); expect(close).toHaveBeenCalled()
})
