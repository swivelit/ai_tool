import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import {
  AuthCredential,
  EmailAuthProvider,
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  deleteUser,
  linkWithCredential,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";

import { auth } from "@/lib/firebase";
import {
  clearProfile,
  createProfileOnBackend,
  deleteAccountOnBackend,
  getProfileForFirebaseUid,
} from "@/lib/account";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

const googleWebClientId =
  extra.googleWebClientId || process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

type PendingGoogleLink = {
  email?: string;
  credential: AuthCredential;
};

let pendingGoogleLink: PendingGoogleLink | null = null;

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

    case "auth/account-exists-with-different-credential":
      return "This email is already linked to a different sign-in method. Please use the original login method for this account.";

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
      return "For security, please sign out, log in again, and then try this action once more.";

    default:
      return message || "Authentication failed. Please try again.";
  }
}

function mapGoogleError(error: any) {
  if (isErrorWithCode(error)) {
    switch (error.code) {
      case statusCodes.IN_PROGRESS:
        return "Google sign-in is already in progress.";

      case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
        return "Google Play Services is missing or outdated on this device.";
    }
  }

  const message = typeof error?.message === "string" ? error.message : "";

  if (/developer_error/i.test(message)) {
    return "Google configuration mismatch. Check the package name, SHA-1 fingerprint, Web client ID, and google-services.json.";
  }

  if (/cancelled/i.test(message) || /canceled/i.test(message)) {
    return "Google sign-in was cancelled.";
  }

  return message || "Google sign-in failed. Please try again.";
}

function detectProvider(user: User): "password" | "google" {
  if (hasProvider(user, "google.com")) {
    return "google";
  }

  return "password";
}

function buildFallbackName(user: User) {
  const displayName = user.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const email = user.email?.trim();
  if (email && email.includes("@")) {
    const localPart = email.split("@")[0]?.trim();
    if (localPart) {
      return localPart;
    }
  }

  return "User";
}

type AuthContextType = {
  user: User | null;
  loading: boolean;
  googleReady: boolean;
  googleConfigured: boolean;
  passwordLinked: boolean;
  googleLinked: boolean;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUpWithPassword: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  linkPasswordForCurrentUser: (password: string, displayName?: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  deleteCurrentAccount: (backendUserId?: number) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleReady, setGoogleReady] = useState(false);

  const googleConfigured = Platform.OS !== "web" && Boolean(googleWebClientId);

  useEffect(() => {
    if (Platform.OS === "web") {
      setGoogleReady(false);
      return;
    }

    if (!googleWebClientId) {
      setGoogleReady(false);
      return;
    }

    GoogleSignin.configure({
      webClientId: googleWebClientId,
      scopes: ["email", "profile"],
    });

    setGoogleReady(true);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  async function reloadUser(authUser: User) {
    try {
      await authUser.reload();
    } catch {
      // Ignore reload failures and continue with the current user object.
    }

    return auth.currentUser || authUser;
  }

  async function syncProfileForAuthenticatedUser(authUser: User) {
    try {
      const provider = detectProvider(authUser);
      const restoredProfile = await getProfileForFirebaseUid(authUser.uid, authUser.email);

      const upsertedProfile = await createProfileOnBackend({
        ...(restoredProfile || {}),
        userId: restoredProfile?.userId,
        firebaseUid: authUser.uid,
        firebaseEmailVerified: authUser.emailVerified,
        email: authUser.email || restoredProfile?.email || "",
        avatarUrl: authUser.photoURL || restoredProfile?.avatarUrl,
        authProvider: provider,
        name: restoredProfile?.name || buildFallbackName(authUser),
        place: restoredProfile?.place || "",
        assistantName: restoredProfile?.assistantName || "Elli",
        timezone: restoredProfile?.timezone || "Asia/Kolkata",
        questionnaireCompleted: restoredProfile?.questionnaireCompleted ?? false,
      });

      return upsertedProfile;
    } catch (error) {
      console.warn("[auth] Failed to sync backend profile after authentication:", error);
      return null;
    }
  }

  async function finalizeAuthenticatedUser(authUser: User) {
    const freshUser = await reloadUser(authUser);
    setUser(freshUser);
    await syncProfileForAuthenticatedUser(freshUser);
    return freshUser;
  }

  async function tryLinkPendingGoogleCredential(authUser: User) {
    const pending = pendingGoogleLink;
    if (!pending?.credential) {
      return authUser;
    }

    const currentEmail = normalizeEmail(authUser.email);
    if (pending.email && currentEmail && pending.email !== currentEmail) {
      return authUser;
    }

    try {
      await linkWithCredential(authUser, pending.credential);
    } catch (error: any) {
      const code = error?.code || "";

      if (
        code !== "auth/provider-already-linked" &&
        code !== "auth/credential-already-in-use" &&
        code !== "auth/email-already-in-use"
      ) {
        console.warn("[auth] Failed to auto-link pending Google credential:", error);
      }
    } finally {
      pendingGoogleLink = null;
    }

    return auth.currentUser || authUser;
  }

  async function signInWithPassword(email: string, password: string) {
    const normalizedEmail = email.trim();

    try {
      const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
      const maybeLinkedUser = await tryLinkPendingGoogleCredential(credential.user);
      await finalizeAuthenticatedUser(maybeLinkedUser);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function linkPasswordForCurrentUser(password: string, displayName?: string) {
    const currentUser = auth.currentUser;

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

      await finalizeAuthenticatedUser(auth.currentUser || currentUser);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function signUpWithPassword(name: string, email: string, password: string) {
    const normalizedEmail = email.trim();
    const currentUser = auth.currentUser;
    const currentUserEmail = normalizeEmail(currentUser?.email);

    try {
      if (currentUser && currentUserEmail && currentUserEmail === normalizeEmail(normalizedEmail)) {
        await linkPasswordForCurrentUser(password, name.trim());
        return;
      }

      const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);

      if (name.trim()) {
        await updateProfile(credential.user, { displayName: name.trim() });
      }

      const maybeLinkedUser = await tryLinkPendingGoogleCredential(
        auth.currentUser || credential.user
      );
      await finalizeAuthenticatedUser(maybeLinkedUser);
    } catch (error: any) {
      if (
        error?.code === "auth/email-already-in-use" &&
        pendingGoogleLink?.email &&
        pendingGoogleLink.email === normalizeEmail(normalizedEmail)
      ) {
        try {
          const existingCredential = await signInWithEmailAndPassword(
            auth,
            normalizedEmail,
            password
          );

          if (name.trim() && !existingCredential.user.displayName) {
            await updateProfile(existingCredential.user, { displayName: name.trim() });
          }

          const maybeLinkedUser = await tryLinkPendingGoogleCredential(existingCredential.user);
          await finalizeAuthenticatedUser(maybeLinkedUser);
          return;
        } catch (linkError) {
          throw new Error(mapFirebaseError(linkError));
        }
      }

      throw new Error(mapFirebaseError(error));
    }
  }

  async function signInWithGoogle() {
    if (Platform.OS === "web") {
      throw new Error("Google sign-in is currently enabled only for Android/iOS builds.");
    }

    if (!googleWebClientId) {
      throw new Error("Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in your .env file.");
    }

    if (!googleReady) {
      throw new Error("Google sign-in is still preparing. Please try again.");
    }

    let googleEmail: string | undefined;
    let googleCredential: AuthCredential | null = null;

    try {
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true,
      });

      const result = await GoogleSignin.signIn();

      if (!isSuccessResponse(result)) {
        return;
      }

      const idToken = result.data.idToken;
      googleEmail = normalizeEmail(result.data.user?.email);

      if (!idToken) {
        throw new Error(
          "Google sign-in did not return an ID token. Check your Web client ID and google-services.json setup."
        );
      }

      googleCredential = GoogleAuthProvider.credential(idToken);

      const currentUser = auth.currentUser;
      const currentEmail = normalizeEmail(currentUser?.email);

      if (currentUser && currentEmail && googleEmail && currentEmail === googleEmail) {
        try {
          await linkWithCredential(currentUser, googleCredential);
        } catch (error: any) {
          const code = error?.code || "";

          if (
            code !== "auth/provider-already-linked" &&
            code !== "auth/credential-already-in-use"
          ) {
            throw error;
          }
        }

        pendingGoogleLink = null;
        await finalizeAuthenticatedUser(auth.currentUser || currentUser);
        return;
      }

      const userCredential = await signInWithCredential(auth, googleCredential);
      pendingGoogleLink = null;
      await finalizeAuthenticatedUser(userCredential.user);
    } catch (error: any) {
      if (error?.code === "auth/account-exists-with-different-credential" && googleCredential) {
        pendingGoogleLink = {
          email: normalizeEmail(error?.customData?.email) || googleEmail,
          credential: googleCredential,
        };

        throw new Error(
          "This Google email is already registered with email/password. Log in once with email/password using the same email and Google will be linked automatically."
        );
      }

      const message = mapGoogleError(error);

      if (message === "Google sign-in was cancelled.") {
        return;
      }

      throw new Error(message);
    }
  }

  async function signOutUser() {
    pendingGoogleLink = null;

    if (Platform.OS !== "web") {
      try {
        await GoogleSignin.signOut();
      } catch {
        // Ignore Google SDK sign-out errors and continue signing out from Firebase.
      }
    }

    await signOut(auth);
    await clearProfile();
  }

  async function deleteCurrentAccount(backendUserId?: number) {
    const currentUser = auth.currentUser;

    if (!currentUser) {
      throw new Error("No logged-in user found.");
    }

    const restoredProfile = await getProfileForFirebaseUid(currentUser.uid, currentUser.email);
    const resolvedBackendUserId = backendUserId || restoredProfile?.userId;

    try {
      await deleteUser(currentUser);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }

    if (resolvedBackendUserId) {
      try {
        await deleteAccountOnBackend(resolvedBackendUserId);
      } catch (error: any) {
        throw new Error(
          error?.message ||
            "Your login account was deleted, but backend cleanup failed. Please remove the remaining profile data from the server."
        );
      }
    }

    pendingGoogleLink = null;

    if (Platform.OS !== "web") {
      try {
        await GoogleSignin.revokeAccess();
      } catch {
        // Ignore revoke errors.
      }

      try {
        await GoogleSignin.signOut();
      } catch {
        // Ignore Google SDK sign-out errors after deletion.
      }
    }

    await clearProfile();
  }

  const value = useMemo(
    () => ({
      user,
      loading,
      googleReady,
      googleConfigured,
      passwordLinked: hasProvider(user, "password"),
      googleLinked: hasProvider(user, "google.com"),
      signInWithPassword,
      signUpWithPassword,
      signInWithGoogle,
      linkPasswordForCurrentUser,
      signOutUser,
      deleteCurrentAccount,
    }),
    [googleConfigured, googleReady, loading, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}