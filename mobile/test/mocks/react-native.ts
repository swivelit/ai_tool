export const Platform = {
  OS: "ios",
  select<T>(values: Record<string, T> & { default?: T }) {
    return values.ios ?? values.default;
  },
};

export const AppState = {
  currentState: "active",
  addEventListener: (_event: string, _listener: (state: string) => void) => ({
    remove: () => undefined,
  }),
};

export const InteractionManager = {
  runAfterInteractions: (task: () => void) => {
    task();
    return { cancel: () => undefined };
  },
};

export const StyleSheet = {
  absoluteFillObject: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  create<T extends Record<string, any>>(styles: T) {
    return styles;
  },
};

export function useWindowDimensions() {
  return { width: 390, height: 844, scale: 3, fontScale: 1 };
}

export const View = "View";
export const Text = "Text";
export const Pressable = "Pressable";
export const ScrollView = "ScrollView";
export const ActivityIndicator = "ActivityIndicator";
export const NativeModules = {};

export default {
  Platform,
  AppState,
  InteractionManager,
  StyleSheet,
  useWindowDimensions,
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  NativeModules,
};
