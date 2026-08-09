import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const screenSource = fs.readFileSync(
  path.join(__dirname, "..", "components", "swico", "SwicoChatScreen.tsx"),
  "utf8",
);
const apiSource = fs.readFileSync(path.join(__dirname, "..", "lib", "swicoApi.ts"), "utf8");
const routeSource = fs.readFileSync(path.join(__dirname, "..", "app", "(chat)", "index.tsx"), "utf8");

describe("production mobile voice and chat source contract", () => {
  it("keeps the normal composer text-first and backend controlled", () => {
    expect(screenSource).toContain('testID="chat-input"');
    expect(screenSource).toContain('testID="chat-send-button"');
    expect(screenSource).toContain("streamChat");
    expect(screenSource).toContain("cancelChatRequest");
    expect(screenSource).not.toContain('testID="chat-mic-button"');
    expect(screenSource).not.toContain("/api/chat");
    expect(screenSource).not.toContain("runLocalAssistantTurn");
  });

  it("uses the website audio endpoints for dictation and reply playback", () => {
    expect(screenSource).toContain("Audio.requestPermissionsAsync");
    expect(screenSource).toContain("transcribeAudioUri");
    expect(screenSource).toContain("synthesizeAudio");
    expect(apiSource).toContain("/api/web/audio/transcribe");
    expect(apiSource).toContain("/api/web/audio/synthesize");
    expect(apiSource).toContain("/api/web/voice/sessions");
    expect(screenSource).not.toContain("/api/transcribe-and-analyze");
    expect(screenSource).not.toContain("/api/tts");
  });

  it("does not expose the legacy assistant/orb production route", () => {
    expect(routeSource).toContain("SwicoChatScreen");
    expect(screenSource).not.toContain("<Orb");
    expect(screenSource).not.toContain("startHandsFreeSession");
    expect(screenSource).not.toContain("nativeOnDeviceModelBridge");
  });
});
