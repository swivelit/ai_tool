import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Sidebar } from './Sidebar'

const props = {
  threads: [{ id:'t1', title:'Tamil ideas', archived_at:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString() }],
  activeId: 't1', wallet: { balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1 },
  userName:'Hari', open:false, collapsed:false, archived:false, hasMore:false, query:'', setQuery:vi.fn(), select:vi.fn(), newChat:vi.fn(), addCredit:vi.fn(), mutate:vi.fn(), signOut:vi.fn(), close:vi.fn(), toggleCollapsed:vi.fn(), toggleArchived:vi.fn(), loadMore:vi.fn(), toggleTheme:vi.fn(),
}

it('supports collapse, grouped history, menus, and search shortcut', () => {
  render(<Sidebar {...props} />)
  expect(screen.getByText('Today')).toBeInTheDocument(); expect(screen.getByText('Tamil ideas')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' })); expect(props.toggleCollapsed).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Tamil ideas' })); expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.keyDown(window, { key:'k', metaKey:true }); expect(screen.getByRole('textbox', { name:'Search chats' })).toHaveFocus()
})

it('focuses and closes the mobile drawer accessibly', () => {
  const close = vi.fn(); render(<Sidebar {...props} open close={close} />)
  expect(screen.getAllByRole('button', { name:'Close sidebar' })[0]).toHaveFocus()
  fireEvent.keyDown(window, { key:'Escape' }); expect(close).toHaveBeenCalled()
})
