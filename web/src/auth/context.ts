import { createContext } from 'react'
import type { User } from 'firebase/auth'

export type AuthContextValue = {
  user: User | null; loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string, otp?: string) => Promise<'otp_sent' | 'complete'>;
  resetPassword: (email: string, newPassword?: string, otp?: string) => Promise<'otp_sent' | 'complete'>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null)
