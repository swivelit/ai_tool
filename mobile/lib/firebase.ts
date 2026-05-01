import Constants from "expo-constants";
import { Platform } from "react-native";
import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app";
import * as FirebaseAuth from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

const firebaseConfig = {
  apiKey: extra.firebaseApiKey || process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: extra.firebaseAuthDomain || process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: extra.firebaseProjectId || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: extra.firebaseStorageBucket || process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId:
    extra.firebaseMessagingSenderId || process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: extra.firebaseAppId || process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const missingKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

export const firebaseConfigStatus: {
  configured: boolean;
  missingKeys: string[];
  message?: string;
} = missingKeys.length
  ? {
      configured: false,
      missingKeys,
      message: `Missing Firebase config: ${missingKeys.join(
        ", "
      )}. Add EXPO_PUBLIC_FIREBASE_* values before building.`,
    }
  : {
      configured: true,
      missingKeys: [],
    };

export const firebaseApp: FirebaseApp | null = firebaseConfigStatus.configured
  ? getApps().length
    ? getApp()
    : initializeApp(firebaseConfig)
  : null;

type NativeInitializeAuthOptions = NonNullable<Parameters<typeof FirebaseAuth.initializeAuth>[1]>;
type NativePersistenceValue = NonNullable<NativeInitializeAuthOptions["persistence"]>;
type GetPersistenceFactory = (storage: typeof AsyncStorage) => NativePersistenceValue;

type FirebaseAuthModuleWithReactNativePersistence = typeof FirebaseAuth & {
  getReactNativePersistence?: GetPersistenceFactory;
};

const firebaseAuthModule = FirebaseAuth as FirebaseAuthModuleWithReactNativePersistence;

export function createNativePersistence(getPersistenceFactory?: GetPersistenceFactory) {
  if (getPersistenceFactory) {
    return getPersistenceFactory(AsyncStorage);
  }

  const getReactNativePersistence = firebaseAuthModule.getReactNativePersistence;

  if (typeof getReactNativePersistence === "function") {
    return getReactNativePersistence(AsyncStorage);
  }

  return undefined;
}

export function getInitializeAuthOptions(
  platformOS: string,
  getPersistenceFactory?: GetPersistenceFactory
): NativeInitializeAuthOptions | undefined {
  if (platformOS === "web") {
    return undefined;
  }

  const persistence = createNativePersistence(getPersistenceFactory);

  if (!persistence) {
    return undefined;
  }

  return {
    persistence,
  };
}

function buildAuth(app: FirebaseApp) {
  const options = getInitializeAuthOptions(Platform.OS);

  if (!options) {
    return FirebaseAuth.getAuth(app);
  }

  try {
    return FirebaseAuth.initializeAuth(app, options);
  } catch {
    return FirebaseAuth.getAuth(app);
  }
}

export const auth: FirebaseAuth.Auth | null = firebaseApp ? buildAuth(firebaseApp) : null;

export function requireFirebaseAuth(): FirebaseAuth.Auth {
  if (auth) {
    return auth;
  }

  throw new Error(
    firebaseConfigStatus.message ||
      "Firebase Auth is not configured. Add EXPO_PUBLIC_FIREBASE_* values before building."
  );
}
