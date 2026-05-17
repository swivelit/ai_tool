export const documentDirectory = "file:///mock/";

export const EncodingType = {
  UTF8: "utf8",
  Base64: "base64",
};

export async function getInfoAsync(_uri: string) {
  return {
    exists: false,
    size: 0,
  };
}

export async function makeDirectoryAsync(_uri: string) {
  return undefined;
}

export async function deleteAsync(_uri: string) {
  return undefined;
}

export async function moveAsync(_options: unknown) {
  return undefined;
}

export async function readAsStringAsync(_uri: string) {
  return "";
}

export function createDownloadResumable() {
  return {
    downloadAsync: async () => null,
    pauseAsync: async () => ({ resumeData: "mock-resume-data" }),
    resumeAsync: async () => null,
    savable: () => ({
      url: "",
      fileUri: "",
      options: {},
      resumeData: "mock-resume-data",
    }),
  };
}

export async function getFreeDiskStorageAsync() {
  return Number.MAX_SAFE_INTEGER;
}
