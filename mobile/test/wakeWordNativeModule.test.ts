import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("JaiWakeWord native module", () => {
  it("defines a local Expo module with Android audio capture and native ONNX inference", () => {
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
    expect(gradle).toContain("onnxruntime-android:1.25.1");
    expect(manifest).toContain("android.permission.RECORD_AUDIO");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE_MICROPHONE");
    expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");
    expect(manifest).toContain("HandsFreeForegroundService");
    expect(manifest).toContain('android:foregroundServiceType="microphone"');
    expect(module).toContain('Name("JaiWakeWord")');
    expect(module).toContain("onCommandAudio");
    expect(module).toContain("startSession");
    expect(module).toContain("stopSession");
    expect(module).toContain("notifyTtsStarted");
    expect(module).toContain("notifyTtsCompleted");
    expect(module).toContain("engine.isAvailable()");
    expect(module).toContain("Handler(Looper.getMainLooper())");
    expect(module).toContain("sendEventOnMain");
    expect(module).toContain("validateFixturePipeline");
    expect(module).toContain("validateModelBundle");
    expect(engine).not.toContain("fun isAvailable(): Boolean = false");
    expect(engine).toContain("OrtEnvironment");
    expect(engine).toContain("OrtSession");
    expect(engine).toContain("OnnxTensor.createTensor");
    expect(engine).toContain("OnnxWakeWordPipeline");
    expect(engine).toContain("processFrame");
    expect(engine).toContain("WakeInferenceWorker");
    expect(engine).toContain("AudioFrameQueue");
    expect(engine).toContain("parsed.minWakeIntervalMs");
    expect(engine).toContain("DeterministicWakeWordPipeline");
    expect(engine).toContain('"deterministicTestSeam" to true');
    expect(engine).toContain('"realOpenWakeWordModelCompatibility" to false');
    expect(engine).toContain("fun validateModelBundle");
    expect(engine).toContain("manifestRoles");
    expect(engine).toContain("JAI_WAKE_MANIFEST_ROLES_REQUIRED");
    expect(engine).toContain('"realOpenWakeWordModelCompatibility" to true');
    expect(engine).toContain('"modelShapesAccepted" to true');
    expect(engine).toContain('"modelFilesLoaded"');
    expect(engine).toContain('"shapesAccepted"');
    expect(engine).toContain('"processFrameRan"');
    expect(engine).toContain('"wakeEmitted"');
    expect(engine).not.toContain("Native OpenWakeWord inference is not enabled");
    expect(engine).not.toContain("return false");
    expect(audio).toContain("AudioRecord");
    expect(audio).toContain("AudioFrameQueue");
    expect(audio).toContain("frameQueue.offer");
    expect(audio).toContain("MediaRecorder.AudioSource.VOICE_RECOGNITION");
    const controller = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/HandsFreeController.kt",
    );
    const service = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/HandsFreeForegroundService.kt",
    );
    expect(controller).toContain("PreRollBuffer");
    expect(controller).toContain("EnergyVoiceActivityDetector");
    expect(controller).toContain("writeCommandWav");
    expect(controller).toContain("onCommandAudio");
    expect(controller).toContain("COMMAND_LISTENING");
    expect(service).toContain("FOREGROUND_SERVICE_TYPE_MICROPHONE");
    expect(service).toContain("startForeground");
    const inferenceWorker = read(
      "modules/wake-word/android/src/main/java/com/harishajahan/jai/wakeword/WakeInferenceWorker.kt",
    );
    expect(inferenceWorker).toContain("pipeline.processFrame");
    expect(inferenceWorker).toContain("score >= threshold");
  });

  it("keeps iOS structurally wired and clearly unsupported until ONNX Runtime is linked", () => {
    const podspec = read("modules/wake-word/ios/JaiWakeWord.podspec");
    const module = read("modules/wake-word/ios/WakeWordModule.swift");
    const engine = read("modules/wake-word/ios/OpenWakeWordEngine.swift");

    expect(podspec).toContain("ExpoModulesCore");
    expect(module).toContain('Name("JaiWakeWord")');
    expect(module).toContain("validateModelBundle");
    expect(engine).toContain("JAI_WAKE_MODEL_UNSUPPORTED");
    expect(engine).toContain('"status": "unsupported"');
    expect(engine).toContain("ONNX Runtime wake pipeline is not linked");
  });

  it("keeps real bundle validation separate from the deterministic fixture seam", () => {
    const script = path.join(root, "scripts", "validate-wake-model-bundle.mjs");
    const scriptSource = fs.readFileSync(script, "utf8");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        JAI_WAKE_MODEL_BUNDLE_DIR: "",
        JAI_HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR: "",
        HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR: "",
        OPENWAKEWORD_HEY_ELLI_BUNDLE_DIR: "",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP wake model bundle validation");
    expect(scriptSource).toContain("safeFlatOnnxFileName");
    expect(scriptSource).toContain("SHA-256 mismatch");
    expect(scriptSource).toContain("byte length mismatch");
    expect(scriptSource).toContain("unsafe file path");
  });
});
