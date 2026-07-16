import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/useAuth'
import { ChatPage } from './pages/ChatPage'
import { LoginPage } from './pages/LoginPage'

const LegalPage = lazy(() => import('./pages/LegalPage').then(module => ({ default: module.LegalPage })))

export function App() {
  const { user, loading } = useAuth()
  if (loading) return <div className="app-loading"><div className="orb">S</div></div>
  return <Routes>
    <Route path="/legal/:page" element={<Suspense fallback={<div className="app-loading">Loading…</div>}><LegalPage /></Suspense>} />
    <Route path="/terms" element={<Navigate to="/legal/terms" replace />} />
    <Route path="/privacy" element={<Navigate to="/legal/privacy" replace />} />
    <Route path="/refunds" element={<Navigate to="/legal/refunds" replace />} />
    <Route path="/" element={user ? <ChatPage /> : <LoginPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
}
