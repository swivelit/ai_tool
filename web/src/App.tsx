import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/useAuth'
import { ChatPage } from './pages/ChatPage'
import { LegalPage } from './pages/LegalPage'
import { LoginPage } from './pages/LoginPage'

export function App() {
  const { user, loading } = useAuth()
  if (loading) return <div className="app-loading"><div className="orb">S</div></div>
  return <Routes>
    <Route path="/legal/:page" element={<LegalPage />} />
    <Route path="/" element={user ? <ChatPage /> : <LoginPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
}
