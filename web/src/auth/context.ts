import { createContext } from 'react'
import type { User } from 'firebase/auth'

export type OtpFlowResult =
  | { status: 'otp_sent'; cooldownSeconds: number }
  | { status: 'complete' }

export type AuthContextValue = {
  user: User | null; loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string, otp?: string) => Promise<OtpFlowResult>;
  resetPassword: (email: string, newPassword?: string, otp?: string) => Promise<OtpFlowResult>;
  resendSignUp: (name: string, email: string) => Promise<number>;
  resendPasswordReset: (email: string) => Promise<number>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null)
