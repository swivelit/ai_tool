import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(__dirname, "..", "app", "(chat)", "index.tsx"),
  "utf8",
);

function sliceAround(marker: string, radius = 900) {
  const index = source.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return source.slice(Math.max(0, index - radius), index + radius);
}

describe("chat voice press-and-hold source", () => {
  it("uses press-in and press-out for the composer mic without tap toggle", () => {
    const block = sliceAround('testID="chat-mic-button"');

    expect(block).toContain("onPressIn");
    expect(block).toContain("handleQuickMicPressIn");
    expect(block).toContain("onPressOut");
    expect(block).toContain("handleQuickMicPressOut");
    expect(block).not.toMatch(/\bonPress=\{/);
  });

  it("uses press-in and press-out for the live orb without tap toggle", () => {
    const block = source.match(/<Orb[\s\S]*?\/>/)?.[0] || "";

    expect(block).toBeTruthy();
    expect(block).toContain("onPressIn");
    expect(block).toContain("handleLiveOrbPressIn");
    expect(block).toContain("onPressOut");
    expect(block).toContain("handleLiveOrbPressOut");
    expect(block).not.toContain("onPress=");
  });

  it("queues quick release during microphone startup and sends Tamil voice defaults", () => {
    expect(source).toContain('recordingPhaseRef.current === "starting"');
    expect(source).toContain("stopWhenReadyRef.current = true");
    expect(source).toContain("client_voice_release_queued");
    expect(source).toContain("assertMinimumVoiceRecordingDuration");
    expect(source).toContain("client_voice_recording_too_short");
    expect(source).toContain("voiceSurface: requestVoiceSurface");
    expect(source).toContain("voiceOnlyMode");
    expect(source).toContain("client_voice_reply_tts_started");
    expect(source).toContain("client_voice_reply_tts_completed");
    expect(source).toContain("client_voice_reply_tts_failed");
    expect(source).toContain("FileSystem.writeAsStringAsync");
    expect(source).toContain("FileSystem.EncodingType.Base64");
    expect(source).toContain("voice-last-reply");
    expect(source).toContain("voice-reply-status");
    expect(source).toContain("TTS speaker is misconfigured");
    expect(source).not.toContain('speaker: "shubh"');
    expect(source).not.toContain("speaker: 'shubh'");
    expect(source).toContain("recordingPhaseRef.current === \"stopping\"");
    expect(source).toContain("reply_language=ta&speech_language=ta-IN");
  });

  it("supports voice-only mode by hiding the typed send path", () => {
    expect(source).toContain("voiceOnlyMode");
    expect(source).toContain("voice-only-composer-placeholder");
    expect(source).toContain("!voiceOnlyMode ? (");
  });
});
