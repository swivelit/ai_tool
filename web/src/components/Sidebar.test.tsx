import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Sidebar } from './Sidebar'

const props = {
  threads: [{ id:'t1', title:'Tamil ideas', archived_at:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }],
  activeId: 't1', wallet: { balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1, token_estimate:{ tier:'lite' as const, tier_label:'Swico Lite', pricing_as_of:'2026-07-17T00:00:00Z', estimated_blended_tokens:60_000, blended_assumption:'70/30', range_min_tokens:25_000, range_max_tokens:180_000, explanation:'Estimated for Swico Lite. Actual usage depends on message size, response length, and task complexity.' } },
  userName:'Hari', open:false, collapsed:false, archived:false, hasMore:false, query:'', setQuery:vi.fn(), select:vi.fn(), newChat:vi.fn(), addCredit:vi.fn(), openSettings:vi.fn(), mutate:vi.fn(), signOut:vi.fn(), close:vi.fn(), toggleCollapsed:vi.fn(), toggleArchived:vi.fn(), loadMore:vi.fn(), toggleTheme:vi.fn(),
}

it('supports collapse, grouped history, menus, and search shortcut', () => {
  render(<Sidebar {...props} />)
  expect(screen.getByText('Today')).toBeInTheDocument(); expect(screen.getByText('Tamil ideas')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' })); expect(props.toggleCollapsed).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Tamil ideas' })); expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.keyDown(window, { key:'k', metaKey:true }); expect(screen.getByRole('textbox', { name:'Search chats' })).toHaveFocus()
  expect(screen.getByText('Token credits')).toBeInTheDocument()
  expect(screen.getByText('≈ 60K tokens')).toBeInTheDocument()
  expect(screen.queryByText(/5\.00/)).not.toBeInTheDocument()
  expect(screen.queryByText('₹5.00')).not.toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
})

it('shows loading, zero, and unavailable estimate states', () => {
  const { rerender } = render(<Sidebar {...props} wallet={null} />)
  expect(screen.getByText('Calculating…')).toBeInTheDocument()
  rerender(<Sidebar {...props} wallet={{ ...props.wallet, token_estimate:{ ...props.wallet.token_estimate, estimated_blended_tokens:0 } }} />)
  expect(screen.getByText('0 tokens')).toBeInTheDocument()
  rerender(<Sidebar {...props} wallet={{ ...props.wallet, token_estimate:{ ...props.wallet.token_estimate, estimated_blended_tokens:null } }} />)
  expect(screen.getByText('Estimate unavailable')).toBeInTheDocument()
})

it('focuses and closes the mobile drawer accessibly', () => {
  const close = vi.fn(); render(<Sidebar {...props} open close={close} />)
  expect(screen.getAllByRole('button', { name:'Close sidebar' })[0]).toHaveFocus()
  fireEvent.keyDown(window, { key:'Escape' }); expect(close).toHaveBeenCalled()
})
