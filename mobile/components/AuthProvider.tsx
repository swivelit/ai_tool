import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
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
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";

import { auth } from "@/lib/firebase";
import { clearProfile } from "@/lib/account";

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

    case "auth/weak-password":
      return "Password should be at least 6 characters.";

    case "auth/network-request-failed":
      return "Network error. Please check your internet connection.";

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
      await signInWithCredential(auth, credential);
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