import 'dotenv/config';

export default {
  expo: {
    name: "Tamil AI",
    slug: "tamil-ai",
    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL,
    },
  },
};
