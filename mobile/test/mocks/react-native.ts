export const Platform = {
  OS: "ios",
  select<T>(values: Record<string, T> & { default?: T }) {
    return values.ios ?? values.default;
  },
};

export const NativeModules = {};

export default {
  Platform,
  NativeModules,
};
