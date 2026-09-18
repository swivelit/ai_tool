import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/useAuth'
import { ChatPage } from './pages/ChatPage'
import { GuestChatPage } from './pages/GuestChatPage'
import { LoginPage } from './pages/LoginPage'
import { CliAuthorizePage } from './pages/CliAuthorizePage'
import { CliSessionsPage } from './pages/CliSessionsPage'
import { CliGuidePage } from './pages/CliGuidePage'
import { CloudTasksPage } from './pages/CloudTasksPage'
import {applyColorStyle,applyCustomColors,applyTheme,resolveColorStyle,resolveCustomColors,resolveTheme,type ColorStyle,type CustomColors,type Theme,} from './theme'

const LegalPage = lazy(() => import('./pages/LegalPage').then(module => ({ default: module.LegalPage })))

export function App() {
  const { user, loading } = useAuth()
  const [theme, setTheme] = useState<Theme>(resolveTheme)
  const [colorStyle, setColorStyle] = useState<ColorStyle>(resolveColorStyle)
  const [customColors, setCustomColors] = useState<CustomColors>(resolveCustomColors)
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    applyColorStyle(colorStyle)
  }, [colorStyle])

  useEffect(() => {
    applyCustomColors(customColors)
  }, [customColors])

  const location = useLocation()
  if (loading) return <div className="app-loading"><div className="orb">S</div></div>
  const returnTo = new URLSearchParams(location.search).get('returnTo')
  const safeReturnTo = (() => {
    if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.startsWith('/\\') || returnTo.includes('\\')) return '/'
    try {
      const parsed = new URL(returnTo, window.location.origin)
      return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/'
    } catch { return '/' }
  })()
  return <Routes>
    <Route path="/cli/authorize" element={<CliAuthorizePage />} />
    <Route path="/settings/cli-sessions" element={user ? <CliSessionsPage /> : <Navigate to={`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />} />
    <Route path="/tasks" element={user ? <CloudTasksPage /> : <Navigate to={`/login?returnTo=%2Ftasks`} replace />} />
    <Route path="/legal/:page" element={<Suspense fallback={<div className="app-loading">Loading…</div>}><LegalPage /></Suspense>} />
    <Route path="/terms" element={<Navigate to="/legal/terms" replace />} />
    <Route path="/privacy" element={<Navigate to="/legal/privacy" replace />} />
    <Route path="/refunds" element={<Navigate to="/legal/refunds" replace />} />
    <Route path="/pricing" element={<Navigate to="/legal/pricing" replace />} />
    <Route path="/swico-cli" element={<CliGuidePage isAuthenticated={Boolean(user)} />} />
    <Route path="/login" element={user ? <Navigate to={safeReturnTo} replace /> : <LoginPage initialMode="login" />} />
    <Route path="/signup" element={user ? <Navigate to={safeReturnTo} replace /> : <LoginPage initialMode="signup" />} />
    <Route
      path="/"
      element={
        user
          ? <ChatPage theme={theme} setTheme={setTheme} colorStyle={colorStyle} setColorStyle={setColorStyle} customColors={customColors} setCustomColors={setCustomColors}/>
          : <GuestChatPage />
      }
    />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
}
