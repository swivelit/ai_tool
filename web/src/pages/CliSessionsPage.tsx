import { useAuth } from '../auth/useAuth'
import { Navigate } from 'react-router-dom'
import { TerminalSessions } from '../components/TerminalSessions'

export function CliSessionsPage() {
  const { user } = useAuth()
  if (!user) return <Navigate to={`/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`} replace />
  return <main className="login-page"><section className="auth-card"><TerminalSessions user={user} /></section></main>
}
