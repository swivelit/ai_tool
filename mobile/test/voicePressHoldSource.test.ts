import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(__dirname, "..", "app", "(chat)", "index.tsx"),
  "utf8",
);
const transcriptSource = fs.readFileSync(
  path.join(__dirname, "..", "components", "VoiceSessionTranscript.tsx"),
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
    expect(source).toContain("resolveVoiceLanguageParams");
    expect(source).toContain("requested_reply_language");
    expect(source).toContain("requested_speech_language");
    expect(source).toContain("tts_language_code");
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
    expect(source).not.toContain("reply_language=ta&speech_language=ta-IN");
    expect(source).toContain("voiceLanguage.ttsLanguageCode");
  });

  it("keeps live orb voice turns inside the voice-session transcript", () => {
    expect(source).toContain("activeVoiceSessionId");
    expect(source).toContain("voiceSessionTurns");
    expect(source).toContain("voiceSessionMode");
    expect(source).toContain("VoiceSessionTranscript");
    expect(transcriptSource).toContain("voice-session-transcript");
    expect(transcriptSource).toContain("voice-session-user-turn");
    expect(transcriptSource).toContain("voice-session-assistant-turn");
    expect(transcriptSource).toContain("voice-session-scroll");
    expect(source).toContain("isLiveVoiceSession");
    expect(source).toContain("updateVoiceSessionTurn");
  });

  it("does not only append live orb voice to the main chat while the sheet is active", () => {
    const liveBlock = sliceAround("isLiveVoiceSession", 5200);

    expect(liveBlock).toContain("voiceSessionItemsPendingHistoryRef");
    expect(liveBlock).toContain("updateVoiceSessionTurn");
    expect(liveBlock).toContain("refreshHistoryAndSessions([nextItem])");
    expect(liveBlock).toContain("attachItemToCurrentChat(nextItem, mergedHistory)");
  });

  it("quick mic still uses the normal chat flow", () => {
    const quickBlock = sliceAround("handleQuickMicPressIn", 2400);

    expect(quickBlock).toContain('await startRecording("quick")');
    expect(source).toContain("setPendingChatTurn({");
    expect(source).toContain("await attachItemToCurrentChat(nextItem, mergedHistory)");
  });

  it("voice source logs TTS language and voice session identifiers", () => {
    expect(source).toContain("tts_language_code");
    expect(source).toContain("voice_session_id");
    expect(source).toContain("tts_speaker");
    expect(source).toContain("tts_locale_style");
  });

  it("supports voice-only mode by hiding the typed send path", () => {
    expect(source).toContain("voiceOnlyMode");
    expect(source).toContain("voice-only-composer-placeholder");
    expect(source).toContain("!voiceOnlyMode ? (");
  });
});
