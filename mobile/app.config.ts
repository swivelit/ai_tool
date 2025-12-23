import 'dotenv/config';

export default {
  expo: {
    name: "Tamil AI",
    slug: "tamil-ai",
    version: "1.0.0",

    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL,
    },

    ios: {
      bundleIdentifier: "com.harishajahan.tamilai",
    },

    android: {
      package: "com.harishajahan.tamilai",
    },
  },
};
