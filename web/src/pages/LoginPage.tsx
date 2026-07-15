import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'

export function LoginPage() {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setStatus('')
    try {
      if (mode === 'reset') {
        const result = await auth.resetPassword(email, otpSent ? password : undefined, otpSent ? otp : undefined)
        if (result === 'otp_sent') { setOtpSent(true); setStatus('Verification code sent. Enter it with your new password.') }
        else { setMode('login'); setOtpSent(false); setStatus('Password changed. Sign in with your new password.') }
      }
      else if (mode === 'signup') {
        const result = await auth.signUp(name, email, password, otpSent ? otp : undefined)
        if (result === 'otp_sent') { setOtpSent(true); setStatus('Verification code sent. Enter it to create your account.') }
      }
      else await auth.signIn(email, password)
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Authentication failed.') }
    finally { setBusy(false) }
  }
  return <main className="login-page"><section className="login-story"><div className="brand light"><span className="brand-mark">S</span><span>Swico</span></div><div><span className="eyebrow">A calmer way to think with AI</span><h1>Make room for<br /><em>better questions.</em></h1><p>A private workspace for writing, learning, planning and turning thought into forward motion.</p></div><small>Cloud AI, clear usage, your conversations.</small></section>
    <section className="login-panel"><form onSubmit={event => void submit(event)}><span className="eyebrow">Welcome to Swico</span><h2>{mode === 'signup' ? 'Create your space' : mode === 'reset' ? 'Reset your password' : 'Continue your work'}</h2>
      {mode === 'signup' && <label>Name<input autoComplete="name" required value={name} onChange={event => setName(event.target.value)} /></label>}
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      {(mode !== 'reset' || otpSent) && <label>{mode === 'reset' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /></label>}
      {otpSent && <label>Verification code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ''))} /></label>}
      <button className="primary wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? (otpSent ? 'Verify & create account' : 'Send verification code') : mode === 'reset' ? (otpSent ? 'Change password' : 'Send reset code') : 'Sign in'}</button>
      {status && <p role="status" className="auth-status">{status}</p>}
      <div className="auth-links">{mode !== 'login' && <button type="button" onClick={() => { setMode('login'); setOtpSent(false); setOtp('') }}>Back to sign in</button>}{mode === 'login' && <><button type="button" onClick={() => { setMode('signup'); setStatus('') }}>Create account</button><button type="button" onClick={() => { setMode('reset'); setStatus('') }}>Forgot password?</button></>}</div>
    </form></section></main>
}
