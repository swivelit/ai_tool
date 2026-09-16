import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import {
  onIdTokenChanged, signInWithEmailAndPassword, signOut as firebaseSignOut, type User,
} from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { publicApiJson } from '../api/client'
import { authApiErrorMessage } from './authError'
import { auth } from './firebase'
import { AuthContext, type OtpFlowResult } from './context'

const E2E_AUTH_ENABLED = import.meta.env.DEV && import.meta.env.VITE_E2E_MOCK_AUTH === 'true'
const E2E_EMAIL = 'e2e@example.test'
const E2E_PASSWORD = 'local-only-password'

function mockUser(email = E2E_EMAIL, name = 'E2E User'): User {
  return {
    uid: 'e2e-user', email, displayName: name, emailVerified: true, isAnonymous: false,
    providerData: [], metadata: {}, refreshToken: 'local-test-token', tenantId: null,
    phoneNumber: null, photoURL: null, providerId: 'firebase',
    getIdToken: async () => 'local-e2e-token', getIdTokenResult: async () => ({}) as never,
    reload: async () => undefined, delete: async () => undefined,
    toJSON: () => ({ uid: 'e2e-user', email }),
  } as unknown as User
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(() => E2E_AUTH_ENABLED && localStorage.getItem('swico-e2e-auth') === 'true' ? mockUser() : null)
  const [loading, setLoading] = useState(!E2E_AUTH_ENABLED)
  useEffect(() => {
    if (E2E_AUTH_ENABLED) { setLoading(false); return }
    return onIdTokenChanged(auth, current => { setUser(current); setLoading(false) })
  }, [])
  const completeE2eSignIn = useCallback((email: string, name = 'E2E User') => {
    localStorage.setItem('swico-e2e-auth', 'true')
    setUser(mockUser(email, name))
  }, [])
  const requestOtp = useCallback(async (path: string, body: Record<string, string>): Promise<number> => {
    const response = await publicApiJson<{ cooldown_seconds?: number }>(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const cooldown = Number(response.cooldown_seconds)
    return Number.isFinite(cooldown) && cooldown >= 0 ? Math.ceil(cooldown) : 0
  }, [])
  const value = useMemo(() => ({
    user, loading,
    signIn: async (email: string, password: string) => {
      if (E2E_AUTH_ENABLED) {
        if (email !== E2E_EMAIL || password !== E2E_PASSWORD) throw new FirebaseError('auth/invalid-credential', 'Invalid E2E credentials')
        completeE2eSignIn(email)
        return
      }
      await signInWithEmailAndPassword(auth, email, password)
    },
    signUp: async (name: string, email: string, password: string, otp?: string): Promise<OtpFlowResult> => {
      const path = otp ? '/auth/email-otp/signup/complete' : '/auth/email-otp/signup/request'
      const body = otp ? { name, email, password, otp } : { name, email }
      try {
        const response = await publicApiJson<{ cooldown_seconds?: number }>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!otp) {
          const cooldown = Number(response.cooldown_seconds)
          return { status: 'otp_sent', cooldownSeconds: Number.isFinite(cooldown) && cooldown >= 0 ? Math.ceil(cooldown) : 0 }
        }
      } catch (error) {
        throw new Error(authApiErrorMessage(error, !otp))
      }
      if (E2E_AUTH_ENABLED) completeE2eSignIn(email, name)
      else await signInWithEmailAndPassword(auth, email, password)
      return { status: 'complete' }
    },
    resetPassword: async (email: string, newPassword?: string, otp?: string): Promise<OtpFlowResult> => {
      const complete = Boolean(newPassword && otp)
      const path = complete ? '/auth/email-otp/password-reset/confirm' : '/auth/email-otp/password-reset/request'
      const body = complete ? { email, new_password: newPassword, otp } : { email }
      try {
        const response = await publicApiJson<{ cooldown_seconds?: number }>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!complete) {
          const cooldown = Number(response.cooldown_seconds)
          return { status: 'otp_sent', cooldownSeconds: Number.isFinite(cooldown) && cooldown >= 0 ? Math.ceil(cooldown) : 0 }
        }
      } catch (error) {
        throw new Error(authApiErrorMessage(error, !complete))
      }
      return { status: 'complete' }
    },
    resendSignUp: (name: string, email: string) => requestOtp('/auth/email-otp/signup/request', { name, email }).catch(error => { throw new Error(authApiErrorMessage(error, true)) }),
    resendPasswordReset: (email: string) => requestOtp('/auth/email-otp/password-reset/request', { email }).catch(error => { throw new Error(authApiErrorMessage(error, true)) }),
    signOut: async () => {
      if (E2E_AUTH_ENABLED) {
        localStorage.removeItem('swico-e2e-auth')
        setUser(null)
        return
      }
      await firebaseSignOut(auth)
    },
  }), [user, loading, completeE2eSignIn, requestOtp])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
