import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Archive, ChevronLeft, ChevronRight, LogOut, Menu, MessageSquarePlus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Settings, SunMoon, Trash2, X } from 'lucide-react'
import type { SearchResult, Thread, Wallet } from '../types'
import { compactTokens, estimatedTokenLabel } from '../credits'

type Group = { label: string; threads: Thread[] }

function groupThreads(threads: Thread[]): Group[] {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const groups = new Map<string, Thread[]>()
  for (const thread of threads) {
    const date = new Date(thread.updated_at); const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    const days = Math.floor((today.getTime() - day.getTime()) / 86_400_000)
    const label = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days <= 7 ? 'Previous 7 days' : days <= 30 ? 'Previous 30 days' : 'Older'
    groups.set(label, [...(groups.get(label) ?? []), thread])
  }
  return ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'].flatMap(label => groups.has(label) ? [{ label, threads: groups.get(label)! }] : [])
}

export function Sidebar({ threads, activeId, wallet, userName, open, collapsed, archived, hasMore, query,
  setQuery, select, newChat, addCredit, openSettings, mutate, signOut, close, toggleCollapsed, toggleArchived, loadMore, toggleTheme, searchResults = [], selectSearch = () => undefined }: {
  threads: Thread[]; activeId: string | null; wallet: Wallet | null; userName: string; open: boolean; collapsed: boolean;
  archived: boolean; hasMore: boolean; query: string; setQuery: (value: string) => void;
  select: (id: string) => void; newChat: () => void; addCredit: () => void; openSettings: () => void;
  mutate: (thread: Thread, action: 'rename' | 'archive' | 'delete') => void;
  signOut: () => void; close: () => void; toggleCollapsed: () => void; toggleArchived: () => void;
  loadMore: () => void; toggleTheme: () => void;
  searchResults?: SearchResult[]; selectSearch?: (result: SearchResult) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null)
  const [account, setAccount] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const accountButtonRef = useRef<HTMLButtonElement>(null)
  const groups = useMemo(() => groupThreads(threads), [threads])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); searchRef.current?.focus()
      }
      if (event.key === 'Escape') { setMenu(null); setAccount(false); if (open) close() }
    }
    window.addEventListener('keydown', shortcuts); return () => window.removeEventListener('keydown', shortcuts)
  }, [close, open])
  useEffect(() => { if (open) closeRef.current?.focus() }, [open])
  const iconButton = (label: string, icon: ReactNode, action: () => void) => <button className="rail-action" aria-label={label} title={label} onClick={action}>{icon}<span>{label}</span></button>
  const estimatedTokens = wallet?.token_estimate?.estimated_blended_tokens
  const billingExempt = wallet?.billing_exempt === true
  const estimatedBalanceName = !wallet || estimatedTokens === null || estimatedTokens === undefined
    ? 'Estimated balance unavailable'
    : `Estimated balance ${compactTokens(estimatedTokens).replace(/K$/, ' thousand').replace(/M$/, ' million')} tokens`
  return <><aside className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`} aria-label="Chat history">
    <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true">S</span><strong>Swico</strong>
      <button ref={closeRef} className="mobile-close icon-button" aria-label="Close sidebar" title="Close sidebar" onClick={close}><X size={20} /></button>
      <button className="collapse-button icon-button" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button>
    </div>
    <div className="sidebar-primary">
      {iconButton('New chat', <MessageSquarePlus size={19} />, newChat)}
      <label className="search-action" title="Search chats"><Search size={19} /><input ref={searchRef} aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)} /><kbd>⌘K</kbd></label>
    </div>
    <button className="archive-toggle rail-action" onClick={toggleArchived}><Archive size={18} /><span>{archived ? 'Back to chats' : 'Archived chats'}</span>{archived ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
    <nav className="threads" aria-label={archived ? 'Archived conversations' : 'Conversations'}>
      {!!query.trim() && !!searchResults.length && <div className="content-search-results">
        {(['message', 'summary', 'memory'] as const).map(kind => {
          const items = searchResults.filter(item => item.source_kind === kind)
          if (!items.length) return null
          return <section key={kind}><h2>{kind === 'message' ? 'Messages' : kind === 'summary' ? 'Chat summaries' : 'Saved memory'}</h2>
            {items.map((item, index) => <button type="button" key={`${kind}-${item.message_id ?? item.thread_id}-${index}`} disabled={!item.thread_id} onClick={() => selectSearch(item)}>
              <span>{item.snippet}</span><small>{new Date(item.updated_at).toLocaleDateString()}</small>
            </button>)}
          </section>
        })}
      </div>}
      {groups.map(group => <section className="thread-group" key={group.label}><h2>{group.label}</h2>{group.threads.map(thread => <div className={`thread-row ${thread.id === activeId ? 'active' : ''}`} key={thread.id}>
        <button className="thread-select" onClick={() => select(thread.id)} title={thread.title}><span>{thread.title}</span></button>
        <button className="thread-more icon-button" aria-label={`Actions for ${thread.title}`} aria-expanded={menu === thread.id} onClick={() => setMenu(menu === thread.id ? null : thread.id)}><MoreHorizontal size={17} /></button>
        {menu === thread.id && <div className="thread-menu" role="menu">
          <button role="menuitem" onClick={() => { setMenu(null); mutate(thread, 'rename') }}><Pencil size={15} />Rename</button>
          <button role="menuitem" onClick={() => { setMenu(null); mutate(thread, 'archive') }}><Archive size={15} />{archived ? 'Unarchive' : 'Archive'}</button>
          <button role="menuitem" className="danger" onClick={() => { setMenu(null); mutate(thread, 'delete') }}><Trash2 size={15} />Delete</button>
        </div>}
      </div>)}</section>)}
      {!threads.length && <p className="sidebar-empty">{query ? 'No matching chats' : archived ? 'No archived chats' : 'Your chats will appear here'}</p>}
      {hasMore && <button className="load-more" onClick={loadMore}>Load more</button>}
    </nav>
    <div className="sidebar-bottom">
      <button className="credit-card" disabled={billingExempt} onClick={addCredit} aria-label={billingExempt ? 'Token credits. Unlimited.' : `Add token credits. ${estimatedBalanceName}.`}><span><small>Token credits</small><strong>{billingExempt ? 'Unlimited' : wallet ? estimatedTokenLabel(estimatedTokens) : 'Calculating…'}</strong></span>{!billingExempt && <b><Plus size={14} /> Add tokens</b>}</button>
      <div className="account-wrap"><button ref={accountButtonRef} className="account-button" aria-expanded={account} onClick={() => setAccount(!account)}><span className="avatar">{userName.slice(0, 1).toUpperCase()}</span><span>{userName}</span><MoreHorizontal size={17} /></button>
        {account && <div className="account-menu" role="menu">
          <button role="menuitem" onClick={() => { accountButtonRef.current?.focus(); openSettings(); setAccount(false) }}><Settings size={16} />Settings</button>
          <button role="menuitem" onClick={() => { toggleTheme(); setAccount(false) }}><SunMoon size={16} />Toggle theme</button>
          <button role="menuitem" onClick={signOut}><LogOut size={16} />Sign out</button>
        </div>}
      </div>
      <div className="legal"><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/refunds">Refunds</a><a href="/legal/ai">AI limits</a><a href="/legal/delivery">Digital delivery</a><a href="/legal/pricing">Pricing</a><a href="/legal/contact">Support</a></div>
    </div>
  </aside>{open && <button className="drawer-scrim" aria-label="Close sidebar" onClick={close} />}</>
}

export function SidebarTrigger({ open }: { open: () => void }) {
  return <button className="menu-button icon-button" aria-label="Open sidebar" title="Open sidebar" onClick={open}><Menu size={21} /></button>
}
