import { useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import {
  onIdTokenChanged, signInWithEmailAndPassword, signOut as firebaseSignOut, type User,
} from 'firebase/auth'
import { API_BASE } from '../api/client'
import { auth } from './firebase'
import { AuthContext } from './context'

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => onIdTokenChanged(auth, current => { setUser(current); setLoading(false) }), [])
  const value = useMemo(() => ({
    user, loading,
    signIn: async (email: string, password: string) => { await signInWithEmailAndPassword(auth, email, password) },
    signUp: async (name: string, email: string, password: string, otp?: string) => {
      const path = otp ? '/auth/email-otp/signup/complete' : '/auth/email-otp/signup/request'
      const body = otp ? { name, email, password, otp } : { name, email }
      const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(String(((await response.json().catch(() => ({}))) as { detail?: string }).detail || 'Signup failed.'))
      if (!otp) return 'otp_sent' as const
      await signInWithEmailAndPassword(auth, email, password)
      return 'complete' as const
    },
    resetPassword: async (email: string, newPassword?: string, otp?: string) => {
      const complete = Boolean(newPassword && otp)
      const path = complete ? '/auth/email-otp/password-reset/confirm' : '/auth/email-otp/password-reset/request'
      const body = complete ? { email, new_password: newPassword, otp } : { email }
      const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(String(((await response.json().catch(() => ({}))) as { detail?: string }).detail || 'Password reset failed.'))
      return complete ? 'complete' as const : 'otp_sent' as const
    },
    signOut: async () => { await firebaseSignOut(auth) },
  }), [user, loading])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
