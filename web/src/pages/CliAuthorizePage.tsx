import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { approveCliDevice, getCliDeviceInfo, type CliDeviceInfo } from '../api/client'
import { useAuth } from '../auth/useAuth'

export function CliAuthorizePage() {
  const auth = useAuth(); const [params] = useSearchParams()
  const code = (params.get('user_code') ?? '').trim().toUpperCase()
  const [device, setDevice] = useState<CliDeviceInfo | null>(null)
  const [status, setStatus] = useState('Loading device request…'); const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!code) { setStatus('This terminal request is missing its code.'); return }
    void getCliDeviceInfo(code).then(value => { setDevice(value); setStatus(value.status === 'pending' ? '' : `This request is ${value.status}.`) }).catch(() => setStatus('This terminal request is expired or unavailable.'))
  }, [code])
  const decide = async (approved: boolean) => {
    if (!auth.user || !device || busy) return
    setBusy(true); setStatus('Saving your decision…')
    try { const result = await approveCliDevice(auth.user, code, approved); setStatus(result.status === 'approved' ? 'Terminal access approved. You may return to Swico CLI.' : 'Terminal access denied.') ; setDevice(value => value ? { ...value, status: result.status } : value) }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Could not save the decision.') }
    finally { setBusy(false) }
  }
  if (!auth.user) return <main className="login-page"><section className="auth-card"><h1>Authorize Swico CLI</h1><p>Sign in to approve a terminal for your own Swico account.</p>{code && <p><strong>Code:</strong> {code}</p>}<Link className="primary wide" to={`/login?returnTo=${encodeURIComponent(`/cli/authorize?user_code=${encodeURIComponent(code)}`)}`}>Sign in</Link></section></main>
  return <main className="login-page"><section className="auth-card" aria-labelledby="cli-authorize-title"><div className="auth-brand"><span className="brand-mark" aria-hidden="true">S</span><span>Swico</span></div><h1 id="cli-authorize-title">Authorize Swico CLI</h1>{device && <><p><strong>{device.device_description}</strong> is requesting access to your Swico account.</p><p>Code: <strong>{device.user_code}</strong></p><p>Requested access: {device.scopes.join(', ') || 'chat'}. Selected CLI tier: <strong>{device.tier ?? 'your existing paid tier'}</strong>. Swico CLI does not use Swico Free; Chat eligibility and billing are checked when requests start.</p>{device.status === 'pending' && <div className="auth-links"><button className="primary" disabled={busy} onClick={() => void decide(true)}>Approve terminal</button><button disabled={busy} onClick={() => void decide(false)}>Deny</button></div>}</>}{status && <p role="status" className="auth-status">{status}</p>}</section></main>
}
