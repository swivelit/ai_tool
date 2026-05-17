import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "@react-native-async-storage/async-storage": path.resolve(
        __dirname,
        "test/mocks/async-storage.ts",
      ),
      "expo-constants": path.resolve(__dirname, "test/mocks/expo-constants.ts"),
      "expo-file-system/legacy": path.resolve(
        __dirname,
        "test/mocks/expo-file-system-legacy.ts",
      ),
      "expo-modules-core": path.resolve(
        __dirname,
        "test/mocks/expo-modules-core.ts",
      ),
      "react-native": path.resolve(__dirname, "test/mocks/react-native.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
