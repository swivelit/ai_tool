import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { apiJson } from '../api/client'
import { SettingsModal } from './SettingsModal'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, apiJson: vi.fn() }
})

const profile = { name:'Hari', place:'Chennai', timezone:'Asia/Kolkata', assistant_name:'Elli', reply_language:'en' as const, email:'h@example.com', email_editable:false as const }
const preferences = { period:'monthly' as const, hard_limit_micros:null, hard_limit_ai_credits:null, warning_threshold_percent:80, notify_at_threshold:true, current_usage_micros:250_000, current_usage_ai_credits:'0.250000', remaining_micros:null, warning_reached:false, next_reset_at:'2026-08-31T18:30:00Z', timezone:'Asia/Kolkata', updated_at:null }
const usage = { period:'current_month' as const, timezone:'Asia/Kolkata', period_start:'2026-07-31T18:30:00Z', period_end:'2026-08-31T18:30:00Z', next_reset_at:'2026-08-31T18:30:00Z', request_count:2, input_tokens:1200, cached_input_tokens:300, output_tokens:400, total_tokens:1600, actual_usage_count:1, estimated_usage_count:1, debited_micros:250_000, debited_ai_credits:'0.250000', available_micros:5_000_000, available_ai_credits:'5.000000', daily:[], provider_breakdown:[], model_breakdown:[], estimated_tokens_remaining:{ reference_provider:'openai', reference_model:'gpt-5-nano', pricing_as_of:'2026-07-17T00:00:00Z', pricing_snapshot:{}, estimated_input_only_tokens:180_000, estimated_output_only_tokens:25_000, estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimate only. Actual tokens vary by model and input/output mix.' } }

function mockSettingsApi() {
  vi.mocked(apiJson).mockImplementation(async (_user, path, init) => {
    if (path === '/api/web/settings/profile' && init?.method === 'PATCH') return { ...profile, ...(JSON.parse(String(init.body)) as object) } as never
    if (path === '/api/web/settings/profile') return profile as never
    if (path === '/api/web/settings/usage' && init?.method === 'PATCH') return { ...preferences, ...(JSON.parse(String(init.body)) as object) } as never
    if (path === '/api/web/settings/usage') return preferences as never
    if (path.includes('/usage/summary')) return usage as never
    if (path === '/api/web/billing/payments') return { items:[] } as never
    throw new Error(`Unhandled ${path}`)
  })
}

it('shows labelled model-dependent estimates and separate actual token categories', async () => {
  mockSettingsApi()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Usage & billing' }))
  expect(screen.getByText('25k–180k tokens')).toBeInTheDocument()
  expect(screen.getByText(/On gpt-5-nano; model-dependent estimate, not a guaranteed quota/)).toBeInTheDocument()
  expect(screen.getByText('Input tokens')).toBeInTheDocument()
  expect(screen.getByText('Cached input tokens')).toBeInTheDocument()
  expect(screen.getByText('Output tokens')).toBeInTheDocument()
  expect(screen.getByText('5.00 AI credits')).toBeInTheDocument()
  expect(screen.queryByText('₹5.00 AI credits')).not.toBeInTheDocument()
})

it('edits profile, validates required fields, and saves owner fields only', async () => {
  mockSettingsApi(); const savedProfile = vi.fn()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={savedProfile} />)
  await userEvent.click(await screen.findByRole('button', { name:'Profile' }))
  const name = screen.getByLabelText('Name')
  await userEvent.clear(name); await userEvent.click(screen.getByRole('button', { name:'Save profile' }))
  expect(screen.getByRole('status')).toHaveTextContent(/Name, timezone, and assistant name are required/)
  await userEvent.type(name, 'New Name'); await userEvent.selectOptions(screen.getByLabelText('Reply language'), 'ta')
  await userEvent.click(screen.getByRole('button', { name:'Save profile' }))
  await waitFor(() => expect(savedProfile).toHaveBeenCalledWith(expect.objectContaining({ name:'New Name', reply_language:'ta' })))
  expect(screen.getByDisplayValue('h@example.com')).toHaveAttribute('readonly')
})

it('configures an exact integer-micro monthly cap and warning threshold', async () => {
  mockSettingsApi()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} close={vi.fn()} addCredits={vi.fn()} openArchived={vi.fn()} savedProfile={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name:'Usage & billing' }))
  await userEvent.click(screen.getByLabelText('No monthly cap beyond prepaid AI credits'))
  await userEvent.type(screen.getByLabelText(/Monthly cap \(AI credits\)/), '2.5')
  await userEvent.clear(screen.getByLabelText('Warning threshold (%)')); await userEvent.type(screen.getByLabelText('Warning threshold (%)'), '75')
  await userEvent.click(screen.getByRole('button', { name:'Save usage limit' }))
  await waitFor(() => expect(vi.mocked(apiJson)).toHaveBeenCalledWith(expect.anything(), '/api/web/settings/usage', expect.objectContaining({ body: expect.stringContaining('2500000') })))
})

it('traps focus, closes on escape, and exposes archived/legal controls', async () => {
  mockSettingsApi(); const close = vi.fn(); const archived = vi.fn()
  render(<SettingsModal user={{} as never} theme="light" setTheme={vi.fn()} close={close} addCredits={vi.fn()} openArchived={archived} savedProfile={vi.fn()} />)
  expect(screen.getByRole('button', { name:'Close settings' })).toHaveFocus()
  await userEvent.click(await screen.findByRole('button', { name:'Data controls' }))
  await userEvent.click(screen.getByRole('button', { name:/Archived chats/ })); expect(archived).toHaveBeenCalled()
  expect(screen.getByRole('link', { name:'Terms' })).toHaveAttribute('href', '/legal/terms')
  fireEvent.keyDown(window, { key:'Escape' }); expect(close).toHaveBeenCalled()
})
