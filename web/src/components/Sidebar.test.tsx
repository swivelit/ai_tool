import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { ComponentProps } from 'react'

const props = {
  threads: [{ id:'t1', title:'Tamil ideas', archived_at:null,pinned: false, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }],
  activeId: 't1', wallet: { balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1, token_estimate:{ tier:'lite' as const, tier_label:'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimated for Swico Lite. Actual usage depends on message size, response length, and task complexity.' } },
  userName:'Hari', open:false, collapsed:false, archived:false, hasMore:false, query:'', setQuery:vi.fn(), select:vi.fn(), newChat:vi.fn(), addCredit:vi.fn(), openSettings:vi.fn(), mutate:vi.fn(), signOut:vi.fn(), close:vi.fn(), toggleCollapsed:vi.fn(), toggleArchived:vi.fn(), loadMore:vi.fn(), toggleTheme:vi.fn(),
}

type SidebarProps = ComponentProps<typeof Sidebar>

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  return render(<MemoryRouter><Sidebar {...props} {...overrides} /></MemoryRouter>)
}

it('supports collapse, grouped history, menus, and search shortcut', () => {
  renderSidebar()
  expect(screen.getByText('Today')).toBeInTheDocument(); expect(screen.getByText('Tamil ideas')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' })); expect(props.toggleCollapsed).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Tamil ideas' })); expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.keyDown(window, { key:'k', metaKey:true }); expect(screen.getByRole('textbox', { name:'Search chats' })).toHaveFocus()
  expect(screen.getByText('Token credits')).toBeInTheDocument()
  expect(screen.getByText('≈ 60K tokens')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Add token credits. Estimated balance 60 thousand tokens.' })).toBeInTheDocument()
  expect(screen.queryByText(props.wallet.token_estimate.explanation)).not.toBeInTheDocument()
  expect(screen.queryByText(/5\.00/)).not.toBeInTheDocument()
  expect(screen.queryByText('₹5.00')).not.toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
})

it('keeps the primary New chat action unique when a thread has the same title', () => {
  const newChat = vi.fn()
  renderSidebar({ newChat, threads:[{
    ...props.threads[0], title:'New chat',
  }] })
  expect(screen.getAllByRole('button', { name:'New chat' })).toHaveLength(2)
  expect(screen.getByTestId('new-chat-button')).toHaveClass('rail-action', 'new-chat')
  fireEvent.click(screen.getByTestId('new-chat-button'))
  expect(newChat).toHaveBeenCalledTimes(1)
  expect(props.select).not.toHaveBeenCalled()
})

it.each([
  ['lite', 'Swico Lite'],
  ['standard', 'Swico'],
  ['pro', 'Swico Pro'],
] as const)('does not render the %s estimate explanation', (tier, tierLabel) => {
  const explanation = `Estimated for ${tierLabel}. Actual usage depends on message size, response length, and task complexity.`
  renderSidebar({ wallet:{ ...props.wallet, token_estimate:{ ...props.wallet.token_estimate, tier, tier_label:tierLabel, explanation } } })
  expect(screen.queryByText(explanation)).not.toBeInTheDocument()
  expect(screen.getByText('≈ 60K tokens')).toBeInTheDocument()
  expect(screen.getByRole('button', { name:'Add token credits. Estimated balance 60 thousand tokens.' })).toBeInTheDocument()
})

it('shows loading, zero, and unavailable estimate states', () => {
  const { rerender } = renderSidebar({ wallet:null })
  expect(screen.getByText('Calculating…')).toBeInTheDocument()
  rerender(<MemoryRouter><Sidebar {...props} wallet={{ ...props.wallet, token_estimate:{ ...props.wallet.token_estimate, estimated_blended_tokens:0 } }} /></MemoryRouter>)
  expect(screen.getByText('0 tokens')).toBeInTheDocument()
  rerender(<MemoryRouter><Sidebar {...props} wallet={{ ...props.wallet, token_estimate:{ ...props.wallet.token_estimate, estimated_blended_tokens:null } }} /></MemoryRouter>)
  expect(screen.getByText('Estimate temporarily unavailable')).toBeInTheDocument()
})

it('shows Unlimited and disables top-up for a billing-exempt account', () => {
  const addCredit = vi.fn()
  renderSidebar({ addCredit, wallet:{
    ...props.wallet, billing_exempt:true, balance_display:'Unlimited', token_estimate:null,
  } })
  const credits = screen.getByRole('button', { name:'Token credits. Unlimited.' })
  expect(credits).toBeDisabled()
  expect(screen.getByText('Unlimited')).toBeInTheDocument()
  expect(screen.queryByText('Add tokens')).not.toBeInTheDocument()
  fireEvent.click(credits)
  expect(addCredit).not.toHaveBeenCalled()
})

it('focuses and closes the mobile drawer accessibly', () => {
  const close = vi.fn(); renderSidebar({ open:true, close })
  expect(screen.getAllByRole('button', { name:'Close sidebar' })[0]).toHaveFocus()
  fireEvent.keyDown(window, { key:'Escape' }); expect(close).toHaveBeenCalled()
})

it('places the public Swico CLI link before New chat and exposes collapsed accessibility', () => {
  renderSidebar({ collapsed:true })
  const cliLink = screen.getByRole('link', { name:'Swico CLI' })
  const newChat = screen.getByTestId('new-chat-button')
  expect(cliLink).toHaveAttribute('title', 'Swico CLI')
  expect(cliLink.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
