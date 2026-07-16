import { useState, type FormEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { friendlyAuthError } from '../auth/authError'
import { useAuth } from '../auth/useAuth'

export function LoginPage() {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login')
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [otp, setOtp] = useState(''); const [otpSent, setOtpSent] = useState(false)
  const [status, setStatus] = useState(''); const [isError, setIsError] = useState(false)
  const [busy, setBusy] = useState(false); const [showPassword, setShowPassword] = useState(false)
  const title = mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Welcome back'
  const changeMode = (next: 'login' | 'signup' | 'reset') => { setMode(next); setOtpSent(false); setOtp(''); setStatus(''); setIsError(false); setPassword('') }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    if (otpSent && otp.length !== 6) { setStatus('Enter the 6-digit verification code.'); setIsError(true); return }
    setBusy(true); setStatus(''); setIsError(false)
    try {
      if (mode === 'reset') {
        const result = await auth.resetPassword(email, otpSent ? password : undefined, otpSent ? otp : undefined)
        if (result === 'otp_sent') { setOtpSent(true); setStatus('We sent a 6-digit code to your email.') }
        else { changeMode('login'); setStatus('Password changed. Sign in with your new password.') }
      } else if (mode === 'signup') {
        const result = await auth.signUp(name, email, password, otpSent ? otp : undefined)
        if (result === 'otp_sent') { setOtpSent(true); setStatus('We sent a 6-digit code to your email.') }
      } else await auth.signIn(email, password)
    } catch (error) { setStatus(friendlyAuthError(error)); setIsError(true) }
    finally { setBusy(false) }
  }
  const needsPassword = mode !== 'reset' || otpSent
  return <main className="login-page"><section className="auth-card" aria-labelledby="auth-title">
    <div className="auth-brand"><span className="brand-mark" aria-hidden="true">S</span><span>Swico</span></div>
    <h1 id="auth-title">{title}</h1><p className="auth-intro">{otpSent ? `Enter the code sent to ${email}` : mode === 'login' ? 'Sign in to continue to Swico' : mode === 'reset' ? 'We’ll email you a verification code' : 'Use your email to get started'}</p>
    <form onSubmit={event => void submit(event)} noValidate>
      {mode === 'signup' && !otpSent && <label>Name<input autoComplete="name" required value={name} onChange={event => setName(event.target.value)} /></label>}
      <label>Email address<input type="email" autoComplete="email" required disabled={otpSent} value={email} onChange={event => setEmail(event.target.value)} /></label>
      {needsPassword && <div className="auth-field"><label htmlFor="auth-password">{mode === 'reset' ? 'New password' : 'Password'}</label><span className="password-field"><input id="auth-password" type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></div>}
      {otpSent && <label>Verification code<input className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>}
      <button className="primary wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? (otpSent ? 'Verify and create account' : 'Continue') : mode === 'reset' ? (otpSent ? 'Change password' : 'Send verification code') : 'Sign in'}</button>
      {status && <p role={isError ? 'alert' : 'status'} className={`auth-status ${isError ? 'error' : ''}`}>{status}</p>}
    </form>
    <div className="auth-links">{mode !== 'login' ? <button type="button" onClick={() => changeMode('login')}>Back to sign in</button> : <><span>New to Swico? <button type="button" onClick={() => changeMode('signup')}>Create account</button></span><button type="button" onClick={() => changeMode('reset')}>Forgot password?</button></>}</div>
  </section></main>
}
