import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

export type HandsFreeRecognizerOwner = "handsfree-command" | "customise" | "modal";

let activeOwner: HandsFreeRecognizerOwner | null = null;

function stopPreviousOwner(nextOwner: HandsFreeRecognizerOwner) {
  if (activeOwner && activeOwner !== nextOwner) {
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // Ignore ownership cleanup errors; the next owner will surface real start failures.
    }
  }
}

export const handsFreeRecognizer = {
  start(owner: HandsFreeRecognizerOwner, options: Record<string, any>) {
    stopPreviousOwner(owner);
    activeOwner = owner;
    return ExpoSpeechRecognitionModule.start(options as any);
  },

  stop(owner: HandsFreeRecognizerOwner) {
    if (activeOwner && activeOwner !== owner) return;
    activeOwner = null;
    return ExpoSpeechRecognitionModule.stop();
  },

  abort(owner: HandsFreeRecognizerOwner) {
    if (activeOwner && activeOwner !== owner) return;
    activeOwner = null;
    return ExpoSpeechRecognitionModule.abort();
  },

  getOwner() {
    return activeOwner;
  },

  isRecognitionAvailable() {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  },

  requestPermissionsAsync() {
    return ExpoSpeechRecognitionModule.requestPermissionsAsync();
  },

  supportsRecording() {
    return ExpoSpeechRecognitionModule.supportsRecording?.();
  },

  supportsOnDeviceRecognition() {
    return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition?.();
  },

  getDefaultRecognitionService() {
    return ExpoSpeechRecognitionModule.getDefaultRecognitionService?.();
  },

  getSpeechRecognitionServices() {
    return ExpoSpeechRecognitionModule.getSpeechRecognitionServices?.();
  },

  getSupportedLocales(options?: Record<string, any>) {
    return ExpoSpeechRecognitionModule.getSupportedLocales?.(options as any);
  },

  androidTriggerOfflineModelDownload(options?: Record<string, any>) {
    return ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload?.(options as any);
  },

  subscribe() {
    return {
      unsubscribe: () => undefined,
    };
  },
};

export const useHandsFreeRecognitionEvent = useSpeechRecognitionEvent;
