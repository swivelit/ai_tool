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
const customiseSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "customise.tsx"),
  "utf8",
);
const setupSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "setup.tsx"),
  "utf8",
);
const modalSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "modal.tsx"),
  "utf8",
);

function sliceAround(marker: string, radius = 900) {
  const index = source.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return source.slice(Math.max(0, index - radius), index + radius);
}

describe("chat voice press-and-hold source", () => {
  it("keeps the normal chat composer text-only", () => {
    [
      'testID="chat-mic-button"',
      'accessibilityLabel="chat-mic-button"',
      "handleQuickMicPressIn",
      "handleQuickMicPressOut",
      'startRecording("quick")',
      'activeSurface === "quick"',
      "Recording voice message",
      "Sending voice message",
      "Hold the mic to talk",
    ].forEach((forbidden) => {
      expect(source).not.toContain(forbidden);
    });

    expect(source).toContain('testID="chat-input"');
    expect(source).toContain('testID="chat-send-button"');
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

  it("keeps voice recording and reply playback on the live orb route", () => {
    expect(source).toContain('testID="chat-voice-button"');
    expect(source).toContain("openVoiceSession");
    expect(source).toContain("<Orb");
    expect(source).toContain("handleLiveOrbPressIn");
    expect(source).toContain("handleLiveOrbPressOut");
    expect(source).toContain('startRecording("live")');
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
    expect(source).toContain('const voiceSessionId = ensureVoiceSession("live")');
    expect(source).toContain("updateVoiceSessionTurn");
  });

  it("keeps live orb voice out of the normal chat thread while the sheet is active", () => {
    const liveBlock = sliceAround("async function stopAndAnalyze", 8200);

    expect(liveBlock).toContain("voiceSessionItemsPendingHistoryRef");
    expect(liveBlock).toContain("updateVoiceSessionTurn");
    expect(liveBlock).not.toContain("attachItemToCurrentChat(nextItem, mergedHistory)");
    expect(source).toContain("await refreshHistoryAndSessions(pendingItems)");
  });

  it("voice source logs TTS language and voice session identifiers", () => {
    expect(source).toContain("tts_language_code");
    expect(source).toContain("voice_session_id");
    expect(source).toContain("tts_speaker");
    expect(source).toContain("tts_locale_style");
  });

  it("supports voice-only mode with a non-recording voice-mode CTA", () => {
    expect(source).toContain("voiceOnlyMode");
    expect(source).toContain('testID="open-voice-mode-button"');
    expect(source).toContain('accessibilityLabel="open-voice-mode-button"');
    expect(source).toContain("!voiceOnlyMode ? (");
    expect(source).toContain("Open voice mode");
    expect(source).not.toContain("Hold the mic to talk");
  });

  it("uses the shared hands-free wake helper and continuous conversation mode", () => {
    expect(source).toContain('from "@/lib/handsFreeWake"');
    expect(source).toContain("type HandsFreeRecognizerMode = \"off\" | \"wake\" | \"command\" | \"conversation\"");
    expect(source).toContain("activateHandsFreeConversation");
    expect(source).toContain("deactivateHandsFreeConversation");
    expect(source).toContain("resumeHandsFreeAfterAssistantTurn");
    expect(source).toContain("handleHandsFreeFinalTranscript");
    expect(source).toContain("isHandsFreeStopCommand");
    expect(source).toContain("matchWakePhrase");
    expect(source).toContain('queueHandsFreeRestart("conversation"');
    expect(source).toContain('setHandsFreeRecognizerMode("conversation")');
    expect(source).toContain("source === \"handsfree\"");
    expect(source).toContain("shouldAutoSpeakReply");
    expect(source).toContain("replySoundRef.current");
    expect(source).toContain("abortHandsFreeRecognizer(false)");
    expect(source).toContain("contextualStrings");
    expect(source).toContain("addsPunctuation: false");
    expect(source).toContain("interimResults: true");
    expect(source).toContain("maxAlternatives: 1");
    expect(source).toContain("androidIntentOptions");
    expect(source).toContain("EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS");
  });

  it("keeps hands-free E2E hooks debug-only and separate from the composer mic", () => {
    expect(source).toContain("isE2eMockHandsFreeEnabled");
    expect(source).toContain("getE2eHandsFreeWakePhrase");
    expect(source).toContain("getE2eHandsFreeCommand");
    expect(source).toContain("simulateE2eHandsFreeWakeCommand");
    expect(source).toContain("simulateE2eHandsFreeStop");
    expect(source).toContain('testID="e2e-hands-free-trigger-button"');
    expect(source).toContain('testID="e2e-hands-free-stop-button"');
    expect(source).not.toContain('testID="chat-mic-button"');
  });

  it("exposes configurable hands-free settings without overclaiming wake-word enrollment", () => {
    expect(customiseSource).toContain("customise-hands-free-switch");
    expect(customiseSource).toContain("customise-wake-phrase-input");
    expect(customiseSource).toContain("customise-wake-trainer-button");
    expect(customiseSource).toContain("customise-save-button");
    expect(customiseSource).toContain("Works while the app is open");
    expect(customiseSource).toContain("recognizer pauses while replies are spoken");
    expect(modalSource).toContain("hands-free, and wake phrase");
    expect(setupSource).toContain("foreground hands-free recognition");
    expect(setupSource).toContain("Runtime hands-free uses the saved phrase while the app is open");
    expect(setupSource).not.toContain("powers wake detection");
  });
});
