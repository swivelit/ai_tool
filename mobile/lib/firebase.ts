import Constants from "expo-constants";
import { Platform } from "react-native";
import { initializeApp, getApp, getApps } from "firebase/app";
import { getAuth, initializeAuth } from "firebase/auth";
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

if (missingKeys.length) {
  throw new Error(
    `Missing Firebase config: ${missingKeys.join(", ")}. Add the EXPO_PUBLIC_FIREBASE_* values to your .env file.`
  );
}

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

type NativeInitializeAuthOptions = NonNullable<Parameters<typeof initializeAuth>[1]>;
type NativePersistenceValue = NonNullable<NativeInitializeAuthOptions["persistence"]>;

export function createNativePersistence(
  getPersistenceFactory?: (storage: typeof AsyncStorage) => NativePersistenceValue
) {
  if (getPersistenceFactory) {
    return getPersistenceFactory(AsyncStorage);
  }

  const { getReactNativePersistence } =
    require("firebase/auth/react-native") as {
      getReactNativePersistence: (storage: typeof AsyncStorage) => NativePersistenceValue;
    };

  return getReactNativePersistence(AsyncStorage);
}

export function getInitializeAuthOptions(
  platformOS: string,
  getPersistenceFactory?: (storage: typeof AsyncStorage) => NativePersistenceValue
): NativeInitializeAuthOptions | undefined {
  if (platformOS === "web") {
    return undefined;
  }

  return {
    persistence: createNativePersistence(getPersistenceFactory),
  };
}

function buildAuth() {
  const options = getInitializeAuthOptions(Platform.OS);

  if (!options) {
    return getAuth(firebaseApp);
  }

  try {
    return initializeAuth(firebaseApp, options);
  } catch {
    return getAuth(firebaseApp);
  }
}

export const auth = buildAuth();
