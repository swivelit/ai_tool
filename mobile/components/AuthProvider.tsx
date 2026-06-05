import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  EmailAuthProvider,
  User,
  deleteUser,
  linkWithCredential,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";

import { auth, firebaseConfigStatus } from "@/lib/firebase";
import {
  completeSignupWithOtp as completeSignupWithOtpRequest,
  confirmPasswordResetOtp as confirmPasswordResetOtpRequest,
  requestPasswordResetOtp as requestPasswordResetOtpRequest,
  requestSignupOtp as requestSignupOtpRequest,
} from "@/lib/authOtp";
import {
  clearProfile,
  getProfile,
  deleteAccountOnBackend,
  getProfileForFirebaseUid,
} from "@/lib/account";
import { getApiErrorDetails } from "@/lib/api";
import {
  assertE2eModeAllowed,
  getE2eMockFirebaseUser,
  isE2eMockAuthEnabled,
} from "@/lib/e2eMode";
import {
  syncProfileForAuthenticatedUser as syncBackendProfileForAuthenticatedUser,
  type ProfileSyncResult,
} from "@/lib/profileSync";
import { clearAssistantStorage } from "@/lib/storage";
import { clearLocalAgentDataForUser } from "@/lib/localAgents";

function normalizeEmail(email?: string | null) {
  const value = (email || "").trim().toLowerCase();
  return value || undefined;
}

function hasProvider(user: User | null | undefined, providerId: string) {
  return Boolean(user?.providerData?.some((item) => item.providerId === providerId));
}

function mapFirebaseError(error: any) {
  const code = error?.code || "";
  const message = typeof error?.message === "string" ? error.message : "";

  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "Invalid email or password.";

    case "auth/email-already-in-use":
      return "This email is already registered. Please log in instead.";

    case "auth/provider-already-linked":
      return "This sign-in method is already linked to your account.";

    case "auth/credential-already-in-use":
      return "These credentials are already linked to another account.";

    case "auth/weak-password":
      return "Password should be at least 6 characters.";

    case "auth/operation-not-allowed":
      return "This sign-in method is not enabled in Firebase Authentication yet.";

    case "auth/network-request-failed":
      return "Network error. Please check your internet connection.";

    case "auth/requires-recent-login":
      return "For security, please log in again and then try deleting the account.";

    default:
      return message || "Authentication failed. Please try again.";
  }
}

function requireConfiguredAuth() {
  if (auth) {
    return auth;
  }

  throw new Error(
    firebaseConfigStatus.message ||
      "Firebase Auth is not configured. Add EXPO_PUBLIC_FIREBASE_* values before building."
  );
}

type ProfileSyncIssue = {
  kind: "auth_error" | "backend_error" | "offline";
  message: string;
  debugMessage: string;
  canContinueSetup: boolean;
  status?: number;
  method?: string;
  path?: string;
  endpoint?: string;
  apiBase?: string;
};

type AuthContextType = {
  user: User | null;
  loading: boolean;
  passwordLinked: boolean;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  requestSignupOtp: (email: string, name?: string) => Promise<{ cooldown_seconds?: number; message?: string }>;
  completeSignupWithOtp: (
    name: string,
    email: string,
    password: string,
    otp: string
  ) => Promise<void>;
  requestPasswordResetOtp: (email: string) => Promise<{ cooldown_seconds?: number; message?: string }>;
  confirmPasswordResetOtp: (email: string, otp: string, newPassword: string) => Promise<void>;
  linkPasswordForCurrentUser: (password: string, displayName?: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  deleteCurrentAccount: (backendUserId?: number) => Promise<void>;
  profileSyncIssue: ProfileSyncIssue | null;
  retryProfileSync: () => Promise<void>;
  clearProfileSyncIssue: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  assertE2eModeAllowed();
  const e2eMockAuth = isE2eMockAuthEnabled();
  const e2eUser = e2eMockAuth ? (getE2eMockFirebaseUser() as User) : null;

  const [firebaseUser, setFirebaseUser] = useState<User | null>(e2eUser);
  const [loading, setLoading] = useState(!e2eMockAuth);
  const [locallySignedOut, setLocallySignedOut] = useState(false);
  const [profileSyncIssue, setProfileSyncIssue] = useState<ProfileSyncIssue | null>(null);
  const blockAuthRestoreRef = useRef(false);
  const lastAuthUserRef = useRef<User | null>(null);

  const user = locallySignedOut ? null : firebaseUser;

  useEffect(() => {
    if (e2eMockAuth) {
      setFirebaseUser(e2eUser);
      lastAuthUserRef.current = e2eUser;
      setLoading(false);
      setLocallySignedOut(false);
      setProfileSyncIssue(null);
      return;
    }

    if (!auth) {
      setFirebaseUser(null);
      lastAuthUserRef.current = null;
      setLoading(false);
      setLocallySignedOut(false);
      setProfileSyncIssue(null);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setFirebaseUser(nextUser);
      lastAuthUserRef.current = nextUser;
      setLoading(false);

      if (!nextUser) {
        blockAuthRestoreRef.current = false;
        setLocallySignedOut(false);
        setProfileSyncIssue(null);
        return;
      }

      if (!blockAuthRestoreRef.current) {
        setLocallySignedOut(false);
      }
    });

    return unsubscribe;
  }, [e2eMockAuth]);

  async function reloadUser(authUser: User) {
    const configuredAuth = requireConfiguredAuth();

    try {
      await authUser.reload();
    } catch {
      // Ignore reload failures and continue with the current user object.
    }

    return configuredAuth.currentUser || authUser;
  }

  function issueFromProfileSyncResult(result: ProfileSyncResult): ProfileSyncIssue | null {
    const cachedProfile = "cachedProfile" in result ? result.cachedProfile : undefined;

    if (result.status === "ok" || result.status === "not_found" || cachedProfile) {
      return null;
    }

    return {
      kind: result.status,
      message: result.error.userMessage,
      debugMessage: result.error.debugMessage,
      canContinueSetup: result.status === "offline" || result.status === "backend_error",
      status: result.error.status,
      method: result.error.method,
      path: result.error.path,
      endpoint: result.error.endpoint,
      apiBase: result.error.apiBase,
    };
  }

  async function syncProfileForAuthenticatedUser(authUser: User) {
    try {
      const result = await syncBackendProfileForAuthenticatedUser(authUser);
      const nextIssue = issueFromProfileSyncResult(result);

      if (result.status !== "ok" && result.status !== "not_found") {
        console.warn(
          "[auth] Failed to sync backend profile after authentication.",
          result.error
        );
      }

      setProfileSyncIssue(nextIssue);

      if (result.status === "ok") {
        return result.profile;
      }

      return "cachedProfile" in result ? result.cachedProfile || null : null;
    } catch (error) {
      const details = getApiErrorDetails(error);
      console.warn(
        "[auth] Failed to sync backend profile after authentication.",
        details
      );
      setProfileSyncIssue({
        kind: "backend_error",
        message: "The backend could not restore your profile right now. Please try again.",
        debugMessage: details.path
          ? `Backend profile sync failed: ${details.method || "REQUEST"} ${details.path} returned ${
              details.status ?? "unknown error"
            }.`
          : `Backend profile sync failed: ${details.message}`,
        canContinueSetup: true,
        status: details.status,
        method: details.method,
        path: details.path,
        endpoint: details.endpoint,
        apiBase: details.apiBase,
      });
      return null;
    }
  }

  async function finalizeAuthenticatedUser(authUser: User) {
    const freshUser = await reloadUser(authUser);
    lastAuthUserRef.current = freshUser;
    blockAuthRestoreRef.current = false;
    setLocallySignedOut(false);
    setLoading(true);
    setFirebaseUser(freshUser);
    await syncProfileForAuthenticatedUser(freshUser);
    setLoading(false);
    return freshUser;
  }

  async function retryProfileSync() {
    const configuredAuth = requireConfiguredAuth();
    const candidate = configuredAuth.currentUser || lastAuthUserRef.current || firebaseUser;

    if (!candidate) {
      setProfileSyncIssue(null);
      return;
    }

    const freshUser = await reloadUser(candidate);
    lastAuthUserRef.current = freshUser;
    setFirebaseUser(freshUser);
    await syncProfileForAuthenticatedUser(freshUser);
  }

  function clearProfileSyncIssue() {
    setProfileSyncIssue(null);
  }

  async function signInWithPassword(email: string, password: string) {
    if (e2eMockAuth) {
      setFirebaseUser(e2eUser);
      setLocallySignedOut(false);
      setLoading(false);
      return;
    }

    const normalizedEmail = email.trim();

    try {
      const configuredAuth = requireConfiguredAuth();
      const credential = await signInWithEmailAndPassword(
        configuredAuth,
        normalizedEmail,
        password
      );
      await finalizeAuthenticatedUser(credential.user);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function linkPasswordForCurrentUser(password: string, displayName?: string) {
    if (e2eMockAuth) {
      setFirebaseUser(e2eUser);
      setLocallySignedOut(false);
      setLoading(false);
      return;
    }

    const configuredAuth = requireConfiguredAuth();
    const currentUser = configuredAuth.currentUser;

    if (!currentUser) {
      throw new Error("No logged-in user found.");
    }

    const currentEmail = normalizeEmail(currentUser.email);

    if (!currentEmail) {
      throw new Error("This account does not have an email address to link with a password.");
    }

    if ((password || "").trim().length < 6) {
      throw new Error("Password should be at least 6 characters.");
    }

    if (hasProvider(currentUser, "password")) {
      if (displayName?.trim() && currentUser.displayName !== displayName.trim()) {
        await updateProfile(currentUser, { displayName: displayName.trim() });
      }

      await finalizeAuthenticatedUser(currentUser);
      return;
    }

    const emailCredential = EmailAuthProvider.credential(currentEmail, password);

    try {
      await linkWithCredential(currentUser, emailCredential);

      if (displayName?.trim() && currentUser.displayName !== displayName.trim()) {
        await updateProfile(currentUser, { displayName: displayName.trim() });
      }

      await finalizeAuthenticatedUser(configuredAuth.currentUser || currentUser);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function requestSignupOtp(email: string, name?: string) {
    if (e2eMockAuth) {
      return { cooldown_seconds: 60, message: "OTP sent. Check your email." };
    }

    return requestSignupOtpRequest(email, name);
  }

  async function completeSignupWithOtp(
    name: string,
    email: string,
    password: string,
    otp: string
  ) {
    if (e2eMockAuth) {
      setFirebaseUser(e2eUser);
      setLocallySignedOut(false);
      setLoading(false);
      return;
    }

    try {
      await completeSignupWithOtpRequest(name, email, password, otp);
      const configuredAuth = requireConfiguredAuth();
      const credential = await signInWithEmailAndPassword(
        configuredAuth,
        email.trim(),
        password
      );
      if (name.trim() && !credential.user.displayName) {
        await updateProfile(credential.user, { displayName: name.trim() });
      }
      await finalizeAuthenticatedUser(configuredAuth.currentUser || credential.user);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Account creation failed.");
    }
  }

  async function requestPasswordResetOtp(email: string) {
    if (e2eMockAuth) {
      return {
        cooldown_seconds: 60,
        message: "If an account exists for this email, we sent a reset code.",
      };
    }
    return requestPasswordResetOtpRequest(email);
  }

  async function confirmPasswordResetOtp(
    email: string,
    otp: string,
    newPassword: string
  ) {
    if (e2eMockAuth) {
      return;
    }
    await confirmPasswordResetOtpRequest(email, otp, newPassword);
  }

  async function clearCachedSensitiveData(backendUserId?: number) {
    const cachedProfile = await getProfile().catch(() => null);
    const localUserId = backendUserId || cachedProfile?.userId;

    if (localUserId) {
      await clearLocalAgentDataForUser(localUserId).catch(() => undefined);
    }
  }

  async function primeLocalSignedOutState(backendUserId?: number) {
    await clearCachedSensitiveData(backendUserId);
    blockAuthRestoreRef.current = true;
    setLocallySignedOut(true);
    setProfileSyncIssue(null);
    setLoading(false);
    await Promise.all([clearProfile(), clearAssistantStorage()]);
  }

  async function clearLocalSession() {
    if (e2eMockAuth) {
      await primeLocalSignedOutState();
      setFirebaseUser(null);
      lastAuthUserRef.current = null;
      return;
    }

    const configuredAuth = requireConfiguredAuth();

    await primeLocalSignedOutState();

    try {
      await signOut(configuredAuth);
    } catch {
      // Ignore Firebase sign-out errors during forced local cleanup.
    }

  }

  async function signOutUser() {
    await clearLocalSession();
  }

  async function deleteCurrentAccount(backendUserId?: number) {
    if (e2eMockAuth) {
      await primeLocalSignedOutState(backendUserId);
      setFirebaseUser(null);
      lastAuthUserRef.current = null;
      return;
    }

    const configuredAuth = requireConfiguredAuth();
    const currentUser = configuredAuth.currentUser;

    if (!currentUser) {
      throw new Error("No logged-in user found.");
    }

    const restoredProfile = await getProfileForFirebaseUid(
      currentUser.uid,
      currentUser.email
    );
    const resolvedBackendUserId = backendUserId || restoredProfile?.userId;

    try {
      if (resolvedBackendUserId) {
        await deleteAccountOnBackend(resolvedBackendUserId);
      }
    } catch (error: any) {
      throw new Error(
        error?.message ||
          "Backend cleanup failed. Please try again before deleting the login account."
      );
    }

    try {
      await currentUser.reload();
    } catch {
      // Ignore reload failures and continue with the current auth user.
    }

    const liveUser = configuredAuth.currentUser || currentUser;

    try {
      await deleteUser(liveUser);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }

    await primeLocalSignedOutState(resolvedBackendUserId);

    try {
      await signOut(configuredAuth);
    } catch {
      // Ignore sign-out errors after account deletion attempts.
    }

  }

  const value: AuthContextType = {
    user,
    loading,
    passwordLinked: hasProvider(user, "password"),
    signInWithPassword,
    requestSignupOtp,
    completeSignupWithOtp,
    requestPasswordResetOtp,
    confirmPasswordResetOtp,
    linkPasswordForCurrentUser,
    signOutUser,
    deleteCurrentAccount,
    profileSyncIssue,
    retryProfileSync,
    clearProfileSyncIssue,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
