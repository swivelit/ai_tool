import { useMemo, useState } from 'react'
import type { Thread, Wallet } from '../types'

export function Sidebar({ threads, activeId, wallet, userName, open, select, newChat, addCredit, mutate, signOut, close }: {
  threads: Thread[]; activeId: string | null; wallet: Wallet | null; userName: string; open: boolean;
  select: (id: string) => void; newChat: () => void; addCredit: () => void;
  mutate: (thread: Thread, action: 'rename' | 'archive' | 'delete') => void;
  signOut: () => void; close: () => void;
}) {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => threads.filter(item => item.title.toLowerCase().includes(query.toLowerCase())), [threads, query])
  return <><aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Chat history">
    <div className="brand"><span className="brand-mark">S</span><span>Swico</span><button className="mobile-close" aria-label="Close menu" onClick={close}>×</button></div>
    <button className="new-chat" onClick={newChat}><span>＋</span> New chat <kbd>⌘ K</kbd></button>
    <label className="search"><span>⌕</span><input aria-label="Search chats" placeholder="Search conversations" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="thread-label">Recent</div>
    <nav className="threads">{visible.map(thread => <div className={`thread-row ${thread.id === activeId ? 'active' : ''}`} key={thread.id}>
      <button className="thread-select" onClick={() => select(thread.id)}><span>{thread.title}</span></button>
      <details><summary aria-label={`Actions for ${thread.title}`}>•••</summary><div className="thread-menu">
        <button onClick={() => mutate(thread, 'rename')}>Rename</button><button onClick={() => mutate(thread, 'archive')}>Archive</button><button className="danger" onClick={() => mutate(thread, 'delete')}>Delete</button>
      </div></details>
    </div>)}</nav>
    <div className="sidebar-bottom">
      <button className="credit-card" onClick={addCredit}><span><small>AI credits</small><strong>₹{((wallet?.available_micros ?? 0) / 1_000_000).toFixed(2)}</strong></span><b>＋ Add</b></button>
      <details className="user-menu"><summary><span className="avatar">{userName.slice(0, 1).toUpperCase()}</span><span>{userName}</span><b>⌄</b></summary><div><button onClick={signOut}>Sign out</button></div></details>
      <div className="legal"><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/refunds">Refunds</a><a href="/legal/ai">AI limits</a><a href="/legal/contact">Support</a></div>
    </div>
  </aside>{open && <button className="drawer-scrim" aria-label="Close menu" onClick={close} />}</>
}
