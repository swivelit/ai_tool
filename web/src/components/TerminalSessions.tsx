import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { ApiError, ApiNetworkError, listCliSessions, revokeCliSession, type CliSessionSummary } from '../api/client'

function sessionError(error: unknown): string {
  if (error instanceof ApiNetworkError) return 'We could not reach the server. Reconnect and try again.'
  if (error instanceof ApiError && error.status === 404) return 'This terminal belongs to another account or is no longer available.'
  return error instanceof Error ? error.message : 'Terminal sessions could not be loaded.'
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString()
}

export function TerminalSessions({ user }: { user: User }) {
  const [items, setItems] = useState<CliSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const generation = useRef(0)
  const revokedIds = useRef(new Set<string>())

  const load = useCallback(async (requestGeneration = generation.current, clearNotice = true) => {
    setLoading(true); setError('')
    try {
      const result = await listCliSessions(user)
      if (generation.current === requestGeneration) {
        setItems(result.items.filter(item => !revokedIds.current.has(item.id)))
        if (clearNotice) setNotice('')
      }
    } catch (value) {
      if (generation.current === requestGeneration) setError(sessionError(value))
    } finally {
      if (generation.current === requestGeneration) setLoading(false)
    }
  }, [user])

  useEffect(() => {
    revokedIds.current.clear()
    const requestGeneration = ++generation.current
    void load(requestGeneration)
    return () => { if (generation.current === requestGeneration) generation.current += 1 }
  }, [load])

  const revoke = async (item: CliSessionSummary) => {
    if (pending[item.id]) return
    const requestGeneration = generation.current
    setPending(value => ({ ...value, [item.id]: true })); setError(''); setNotice('')
    try {
      await revokeCliSession(user, item.id)
      if (generation.current !== requestGeneration) return
      revokedIds.current.add(item.id)
      setItems(value => value.filter(current => current.id !== item.id))
      setConfirming(null)
      setNotice(`${item.device_description || 'Terminal session'} was revoked.`)
      await load(requestGeneration, false)
    } catch (value) {
      if (generation.current === requestGeneration) {
        setError(sessionError(value)); setConfirming(null)
      }
    } finally {
      if (generation.current === requestGeneration) {
        setPending(value => ({ ...value, [item.id]: false }))
      }
    }
  }

  return <section aria-labelledby="terminal-sessions-title">
    <h1 id="terminal-sessions-title">Terminal sessions</h1>
    <p>Manage terminals authorized to use paid Swico Chat. Revoking a terminal does not alter existing billing records.</p>
    {loading && <p role="status">Loading terminal sessions…</p>}
    {error && <div role="alert" className="auth-status error"><p>{error}</p><button type="button" onClick={() => void load()}>Retry</button></div>}
    {!loading && !error && !items.length && <p role="status">No active terminal sessions.</p>}
    {notice && <p role="status" className="auth-status">{notice}</p>}
    <div aria-live="polite">
      {items.map(item => <article key={item.id} className="terminal-session-card">
        <h2>{item.device_description || 'Swico terminal'}</h2>
        <dl>
          <div><dt>Session ID</dt><dd>{item.id}</dd></div>
          <div><dt>Created</dt><dd>{dateLabel(item.created_at)}</dd></div>
          <div><dt>Last seen</dt><dd>{dateLabel(item.last_seen_at)}</dd></div>
        </dl>
        {confirming === item.id ? <div role="group" aria-label={`Confirm revocation for ${item.device_description || 'terminal session'}`}>
          <p>Revoke this terminal? It will be rejected on its next request.</p>
          <button type="button" className="danger-button" disabled={Boolean(pending[item.id])} onClick={() => void revoke(item)}>{pending[item.id] ? 'Revoking…' : 'Confirm revoke'}</button>
          <button type="button" disabled={Boolean(pending[item.id])} onClick={() => setConfirming(null)}>Cancel</button>
        </div> : <button type="button" disabled={Boolean(pending[item.id])} onClick={() => setConfirming(item.id)}>Revoke</button>}
      </article>)}
    </div>
  </section>
}
