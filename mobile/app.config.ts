import "dotenv/config";

const APP_SCHEME = "com.harishajahan.tamilai";

export default {
  expo: {
    name: "J AI",
    slug: "tamil-ai",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: APP_SCHEME,
    userInterfaceStyle: "automatic",
    newArchEnabled: true,

    extra: {
      APP_SCHEME,
      API_BASE:
        process.env.EXPO_PUBLIC_API_BASE ||
        process.env.EXPO_PUBLIC_API_URL ||
        "https://ai-tool-rrau.onrender.com",
      apiUrl:
        process.env.EXPO_PUBLIC_API_URL ||
        process.env.EXPO_PUBLIC_API_BASE ||
        "https://ai-tool-rrau.onrender.com",

      // phone-local runtime
      LOCAL_MODEL_BASE_URL:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_BASE_URL || "http://127.0.0.1:10000/v1",
      LOCAL_MODEL_API_KEY:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_API_KEY || "local-phone",
      LOCAL_MODEL_TIMEOUT_MS: Number(
        process.env.EXPO_PUBLIC_LOCAL_MODEL_TIMEOUT_MS || 45000
      ),

      // local speech-to-text model
      // set this to the exact model name exposed by your local runtime
      LOCAL_STT_MODEL:
        process.env.EXPO_PUBLIC_LOCAL_STT_MODEL || "whisper",

      // requested local LLM / embedding models
      LOCAL_MODEL_GEMMA_4B:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_GEMMA_4B || "google/gemma-3-4b-it",
      LOCAL_MODEL_QWEN_8B:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_QWEN_8B || "Qwen/Qwen3-8B",
      LOCAL_MODEL_QWEN_14B:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_QWEN_14B || "Qwen/Qwen3-14B",
      LOCAL_MODEL_QWEN_EMBED:
        process.env.EXPO_PUBLIC_LOCAL_MODEL_QWEN_EMBED ||
        "Qwen/Qwen3-Embedding-0.6B",

      firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
      firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
      firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
      firebaseMessagingSenderId:
        process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
      googleAndroidClientId:
        process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
      googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      router: {},
      eas: {
        projectId: "43fd64c5-dbf3-4e80-8057-ecbb15689e27",
      },
    },

    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.harishajahan.tamilai",
    },

    android: {
      package: "com.harishajahan.tamilai",
      googleServicesFile: "./google-services.json",
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      adaptiveIcon: {
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
        backgroundColor: "#E6F4FE",
      },
    },

    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },

    plugins: [
      "expo-router",
      "@react-native-google-signin/google-signin",
      [
        "expo-speech-recognition",
        {
          microphonePermission: "Allow $(PRODUCT_NAME) to use the microphone for hands-free voice mode.",
          speechRecognitionPermission:
            "Allow $(PRODUCT_NAME) to recognize speech for hands-free voice mode.",
          androidSpeechServicePackages: [
            "com.google.android.googlequicksearchbox",
            "com.google.android.tts",
            "com.google.android.as",
          ],
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
    ],

    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
  },
};