import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import {
  User,
  createUserWithEmailAndPassword,
  deleteUser,
  GoogleAuthProvider,
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
  saveProfile,
} from "@/lib/account";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

const googleWebClientId =
  extra.googleWebClientId || process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

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

    case "auth/weak-password":
      return "Password should be at least 6 characters.";

    case "auth/network-request-failed":
      return "Network error. Please check your internet connection.";

    case "auth/requires-recent-login":
      return "For security, please sign out, log in again, and then delete your account.";

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
  if (user.providerData?.some((item) => item.providerId === "google.com")) {
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
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUpWithPassword: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
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

  async function syncProfileForAuthenticatedUser(authUser: User) {
    try {
      const provider = detectProvider(authUser);
      const restoredProfile = await getProfileForFirebaseUid(authUser.uid, authUser.email);

      const mergedProfile = restoredProfile
        ? {
            ...restoredProfile,
            firebaseUid: authUser.uid,
            firebaseEmailVerified: authUser.emailVerified,
            email: authUser.email || restoredProfile.email || "",
            avatarUrl: authUser.photoURL || restoredProfile.avatarUrl,
            authProvider: provider,
          }
        : null;

      if (mergedProfile?.userId) {
        await saveProfile(mergedProfile);
        return;
      }

      const createdProfile = await createProfileOnBackend({
        ...(mergedProfile || {}),
        firebaseUid: authUser.uid,
        firebaseEmailVerified: authUser.emailVerified,
        email: authUser.email || mergedProfile?.email || "",
        avatarUrl: authUser.photoURL || mergedProfile?.avatarUrl,
        authProvider: provider,
        name: mergedProfile?.name || buildFallbackName(authUser),
        place: mergedProfile?.place || "",
        assistantName: mergedProfile?.assistantName || "Elli",
        timezone: mergedProfile?.timezone || "Asia/Kolkata",
        questionnaireCompleted: mergedProfile?.questionnaireCompleted ?? false,
        userId: mergedProfile?.userId,
      });

      await saveProfile(createdProfile);
    } catch (error) {
      console.warn("[auth] Failed to sync backend profile after authentication:", error);
    }
  }

  async function signInWithPassword(email: string, password: string) {
    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      await syncProfileForAuthenticatedUser(credential.user);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function signUpWithPassword(name: string, email: string, password: string) {
    try {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name.trim()) {
        await updateProfile(credential.user, { displayName: name.trim() });
      }

      await syncProfileForAuthenticatedUser(auth.currentUser || credential.user);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function signInWithGoogle() {
    if (Platform.OS === "web") {
      throw new Error("Google sign-in is currently enabled only for Android/iOS builds.");
    }

    if (!googleWebClientId) {
      throw new Error(
        "Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in your .env file."
      );
    }

    if (!googleReady) {
      throw new Error("Google sign-in is still preparing. Please try again.");
    }

    try {
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true,
      });

      const result = await GoogleSignin.signIn();

      if (!isSuccessResponse(result)) {
        return;
      }

      const idToken = result.data.idToken;

      if (!idToken) {
        throw new Error(
          "Google sign-in did not return an ID token. Check your Web client ID and google-services.json setup."
        );
      }

      const credential = GoogleAuthProvider.credential(idToken);
      const userCredential = await signInWithCredential(auth, credential);
      await syncProfileForAuthenticatedUser(userCredential.user);
    } catch (error) {
      const message = mapGoogleError(error);

      if (message === "Google sign-in was cancelled.") {
        return;
      }

      throw new Error(message);
    }
  }

  async function signOutUser() {
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
      signInWithPassword,
      signUpWithPassword,
      signInWithGoogle,
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