import { useEffect, useState } from 'react'
import { listCliSessions, revokeCliSession, type CliSessionSummary } from '../api/client'
import { useAuth } from '../auth/useAuth'

export function CliSessionsPage() {
  const { user } = useAuth(); const [items, setItems] = useState<CliSessionSummary[]>([]); const [error, setError] = useState('')
  const load = () => { if (user) void listCliSessions(user).then(value => { setItems(value.items); setError('') }).catch(errorValue => setError(errorValue instanceof Error ? errorValue.message : 'Could not load terminal sessions.')) }
  useEffect(load, [user])
  if (!user) return <main className="login-page"><section className="auth-card"><h1>Terminal sessions</h1><p>Sign in to manage terminal access.</p></section></main>
  return <main className="login-page"><section className="auth-card"><h1>Terminal sessions</h1><p>Revoke a terminal immediately. Revoking does not alter existing billing records.</p>{items.map(item => <article key={item.id}><strong>{item.device_description}</strong><p>Last seen {new Date(item.last_seen_at).toLocaleString()}</p><button disabled={item.current} onClick={() => void revokeCliSession(user, item.id).then(load).catch(errorValue => setError(errorValue instanceof Error ? errorValue.message : 'Could not revoke session.'))}>{item.current ? 'Current session' : 'Revoke'}</button></article>)}{error && <p role="alert" className="auth-status error">{error}</p>}</section></main>
}
