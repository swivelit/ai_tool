import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("JaiWakeWord native module scaffold", () => {
  it("defines a local Expo module with Android audio capture and fails closed without a 16 KB-safe runtime", () => {
    const config = read("modules/wake-word/expo-module.config.json");
    const gradle = read("modules/wake-word/android/build.gradle");
    const manifest = read("modules/wake-word/android/src/main/AndroidManifest.xml");
    const module = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/WakeWordModule.kt",
    );
    const engine = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/OpenWakeWordEngine.kt",
    );
    const audio = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/PcmAudioSource.kt",
    );

    expect(config).toContain("WakeWordModule");
    expect(gradle).not.toContain("onnxruntime-android");
    expect(manifest).toContain("android.permission.RECORD_AUDIO");
    expect(module).toContain('Name("JaiWakeWord")');
    expect(module).toContain('Events("onWake", "onWakeScore", "onWakeError")');
    expect(module).toContain("engine.isAvailable()");
    expect(engine).toContain("JAI_WAKE_MODEL_UNSUPPORTED");
    expect(engine).toContain("isAvailable(): Boolean = false");
    expect(engine).not.toContain("OrtEnvironment");
    expect(engine).not.toContain("OrtSession");
    expect(audio).toContain("AudioRecord");
    expect(audio).toContain("MediaRecorder.AudioSource.VOICE_RECOGNITION");
  });

  it("keeps iOS structurally wired and clearly unsupported until ONNX Runtime is linked", () => {
    const podspec = read("modules/wake-word/ios/JaiWakeWord.podspec");
    const module = read("modules/wake-word/ios/WakeWordModule.swift");
    const engine = read("modules/wake-word/ios/OpenWakeWordEngine.swift");

    expect(podspec).toContain("ExpoModulesCore");
    expect(module).toContain('Name("JaiWakeWord")');
    expect(engine).toContain("JAI_WAKE_MODEL_UNSUPPORTED");
    expect(engine).toContain("ONNX Runtime wake pipeline is not linked");
  });
});
