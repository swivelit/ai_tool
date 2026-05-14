const storage = new Map<string, string>();

export function __resetAsyncStorageMock() {
  storage.clear();
}

export default {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: async (key: string) => {
    storage.delete(key);
  },
  clear: async () => {
    storage.clear();
  },
};
