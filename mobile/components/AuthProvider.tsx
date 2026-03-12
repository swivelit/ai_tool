import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import {
  User,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";

import { auth } from "@/lib/firebase";
import { clearProfile } from "@/lib/account";

WebBrowser.maybeCompleteAuthSession();

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

const googleAndroidClientId =
  extra.googleAndroidClientId || process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const googleIosClientId = extra.googleIosClientId || process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const googleWebClientId = extra.googleWebClientId || process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

function mapFirebaseError(error: any) {
  const code = error?.code || "";

  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "Invalid email or password.";
    case "auth/email-already-in-use":
      return "This email is already registered. Please log in instead.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/network-request-failed":
      return "Network error. Please check your internet connection.";
    default:
      return error?.message || "Authentication failed. Please try again.";
  }
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
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const platformClientId =
    Platform.OS === "android"
      ? googleAndroidClientId
      : Platform.OS === "ios"
        ? googleIosClientId
        : googleWebClientId;

  const [request, , promptAsync] = Google.useIdTokenAuthRequest({
    androidClientId: googleAndroidClientId,
    iosClientId: googleIosClientId,
    webClientId: googleWebClientId,
    scopes: ["openid", "profile", "email"],
    selectAccount: true,
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  async function signInWithPassword(email: string, password: string) {
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
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
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function signInWithGoogle() {
    if (!platformClientId) {
      throw new Error(
        `Missing Google OAuth client ID for ${Platform.OS}. Add the EXPO_PUBLIC_GOOGLE_${Platform.OS.toUpperCase()}_CLIENT_ID value to .env.`
      );
    }

    if (!request) {
      throw new Error("Google sign-in is still preparing. Please try again.");
    }

    try {
      const result = await promptAsync();

      if (result.type === "cancel" || result.type === "dismiss") {
        return;
      }

      if (result.type !== "success") {
        throw new Error("Google sign-in failed. Please try again.");
      }

      const idToken =
        (typeof result.params?.id_token === "string" ? result.params.id_token : undefined) ||
        result.authentication?.idToken;
      const accessToken =
        (typeof result.params?.access_token === "string"
          ? result.params.access_token
          : undefined) || result.authentication?.accessToken;

      if (!idToken && !accessToken) {
        throw new Error("Google sign-in finished without a usable token.");
      }

      const credential = GoogleAuthProvider.credential(idToken ?? null, accessToken ?? null);
      await signInWithCredential(auth, credential);
    } catch (error) {
      throw new Error(mapFirebaseError(error));
    }
  }

  async function signOutUser() {
    await signOut(auth);
    await clearProfile();
  }

  const value = useMemo(
    () => ({
      user,
      loading,
      googleReady: Boolean(request),
      googleConfigured: Boolean(platformClientId),
      signInWithPassword,
      signUpWithPassword,
      signInWithGoogle,
      signOutUser,
    }),
    [loading, platformClientId, request, user]
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