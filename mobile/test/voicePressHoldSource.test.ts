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
    expect(source).toContain("configureAudioForPlayback");
    expect(source).toContain("client_voice_reply_playback_started");
    expect(source).toContain("client_voice_reply_playback_finished");
    expect(source).toContain("client_voice_reply_playback_failed");
    expect(source).toContain("sound.playAsync");
    expect(source).toContain("FileSystem.writeAsStringAsync");
    expect(source).toContain("FileSystem.EncodingType.Base64");
    expect(source).not.toContain("voice-last-reply");
    expect(source).not.toContain("voice-reply-status");
    expect(source).not.toContain("voiceReplyPanel");
    expect(source).toContain("isTtsSpeakerMisconfiguredError");
    expect(source).toContain("speaker_misconfigured");
    expect(source).not.toContain('speaker: "shubh"');
    expect(source).not.toContain("speaker: 'shubh'");
    expect(source).toContain("recordingPhaseRef.current === \"stopping\"");
    expect(source).not.toContain("reply_language=ta&speech_language=ta-IN");
    expect(source).toContain("voiceLanguage.ttsLanguageCode");
  });

  it("uses swipe navigation instead of chat/voice transition buttons", () => {
    expect(source).toContain("PanResponder.create");
    expect(source).toContain("VOICE_NAV_SWIPE_MIN_DISTANCE");
    expect(source).toContain("VOICE_NAV_SWIPE_CAPTURE_DISTANCE");
    expect(source).toContain("isClearHorizontalDrag");
    expect(source).toContain("chatSwipePanResponder");
    expect(source).toContain("voiceSwipePanResponder");
    expect(source).toContain('testID="chat-swipe-surface"');
    expect(source).toContain('testID="voice-swipe-surface"');
    expect(source).toContain("openVoiceFromChatSwipe(gestureState.dx, gestureState.dy)");
    expect(source).toContain("closeVoiceFromSwipe(gestureState.dx, gestureState.dy)");
    expect(source).toContain("onTouchStart={handleChatSwipeTouchStart}");
    expect(source).toContain("onTouchEnd={handleChatSwipeTouchEnd}");
    expect(source).toContain("onTouchStart={handleVoiceSwipeTouchStart}");
    expect(source).toContain("onTouchEnd={handleVoiceSwipeTouchEnd}");
    expect(source).not.toContain('testID="chat-voice-button"');
    expect(source).not.toContain('accessibilityLabel="chat-voice-button"');
    expect(source).not.toContain('testID="open-voice-mode-button"');
    expect(source).not.toContain('accessibilityLabel="open-voice-mode-button"');
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
    expect(transcriptSource).toContain("LinearGradient");
    expect(transcriptSource).toContain("topFade");
    expect(transcriptSource).not.toContain("Hold the orb. Your speech and reply will appear here.");
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

  it("keeps voice history separate from active text chat sessions", () => {
    expect(source).toContain("getChatHistoryItemKind(item) !== \"chat\"");
    expect(source).toContain("normalizeItemForRequestSource");
    expect(source).toContain("source === \"handsfree\" || source === \"voice\"");
    expect(source).toContain("chatListKindBadge");
    expect(source).toContain("getChatSessionKindLabel");
  });

  it("voice source logs TTS language and voice session identifiers", () => {
    expect(source).toContain("tts_language_code");
    expect(source).toContain("voice_session_id");
    expect(source).toContain("tts_speaker");
    expect(source).toContain("tts_locale_style");
  });

  it("keeps explicit voice-only support without hiding the chat composer", () => {
    expect(source).toContain("voiceOnlyMode");
    expect(source).toContain('testID="chat-input"');
    expect(source).toContain('testID="chat-send-button"');
    expect(source).not.toContain("voiceOnlyInitialOpenRef");
    expect(source).not.toContain("voiceOnlyMode &&");
    expect(source).not.toContain("}, [voiceOnlyMode");
    expect(source).not.toContain('testID="open-voice-mode-button"');
    expect(source).not.toContain('accessibilityLabel="open-voice-mode-button"');
    expect(source).not.toContain("!voiceOnlyMode ? (");
    expect(source).not.toContain("Open voice mode");
    expect(source).not.toContain("Hold the mic to talk");
  });

  it("does not render a fake chat input inside voice mode", () => {
    expect(source).not.toContain("chatbubble-ellipses-outline");
    expect(source).not.toContain("voiceBottomDock");
    expect(source).not.toContain("voiceBottomRow");
    expect(source).not.toContain("voiceDockInput");
    expect(source).not.toContain("voiceDockPlaceholder");
    expect(source).not.toContain("voiceDockButton");
    expect(source).not.toContain("voiceDockButtonDanger");
    expect(source).not.toContain("voiceReplyPanel");
    expect(source).not.toContain("voiceReplyStatus");
    expect(source).not.toContain("voiceLastReply");
    expect(source).not.toContain("Hold the orb to talk");
  });

  it("uses native OpenWakeWord wake detection and single-owner command STT", () => {
    expect(source).toContain('from "@/lib/handsFreeWake"');
    expect(source).toContain('from "@/lib/wakeWordEngine"');
    expect(source).toContain('from "@/lib/handsFreeRecognizer"');
    expect(source).toContain('from "@/lib/handsFreeStateMachine"');
    expect(source).toContain("startWakeWordListening");
    expect(source).toContain("stopWakeWordListening");
    expect(source).toContain("ensureWakeModel");
    expect(source).toContain("isHandsFreeWakeEligible");
    expect(source).toContain("handsFreeStateReducer");
    expect(source).toContain("activateHandsFreeConversation");
    expect(source).toContain("deactivateHandsFreeConversation");
    expect(source).toContain("restartWakeAfterTurn");
    expect(source).toContain("scheduleWakeStart");
    expect(source).toContain("handleNativeWakeWordDetected");
    expect(source).toContain("handleHandsFreeFinalTranscript");
    expect(source).toContain("isHandsFreeStopCommand");
    expect(source).not.toContain("matchWakePhrase");
    expect(source).not.toContain("buildWakePhraseCandidates");
    expect(source).not.toContain("ExpoSpeechRecognitionModule");
    expect(source).not.toContain("useSpeechRecognitionEvent");
    expect(source).not.toContain("handsFreeDesiredModeRef");
    expect(source).not.toContain("handsFreeStartingRef");
    expect(source).not.toContain("handsFreeRestartTimerRef");
    expect(source).not.toContain("handsFreeBlockedRef");
    expect(source).not.toContain("handsFreeConversationActiveRef");
    expect(source).not.toContain("queueHandsFreeRestart");
    expect(source).not.toContain("resumeHandsFreeAfterAssistantTurn");
    expect(source).not.toContain('queueHandsFreeRestart("conversation"');
    expect(source).not.toContain('setHandsFreeRecognizerMode("conversation")');
    expect(source).toContain("source === \"handsfree\"");
    expect(source).toContain("shouldAutoSpeakReply");
    expect(source).toContain("replySoundRef.current");
    expect(source).toContain("abortHandsFreeRecognizer(false)");
    expect(source).toContain('handsFreeRecognizer.start("handsfree-command"');
    expect(source).toContain("contextualStrings");
    expect(source).toContain("addsPunctuation: false");
    expect(source).toContain("interimResults: true");
    expect(source).toContain("maxAlternatives: 1");
    expect(source).toContain("continuous: false");
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
    expect(customiseSource).toContain("Train wake phrase");
    expect(customiseSource).toContain("Needs model");
    expect(customiseSource).not.toContain("Works while the app is open");
    expect(customiseSource).not.toContain("recognizer pauses while replies are spoken");
    expect(customiseSource).not.toContain('from "@/lib/handsFreeRecognizer"');
    expect(customiseSource).not.toContain('handsFreeRecognizer.start("customise"');
    expect(customiseSource).not.toContain("Dedicated training screen");
    expect(customiseSource).not.toContain("Live transcript");
    expect(customiseSource).not.toContain("Android speech diagnostics");
    expect(customiseSource).not.toContain("ExpoSpeechRecognitionModule");
    expect(modalSource).not.toContain('from "@/lib/handsFreeRecognizer"');
    expect(modalSource).not.toContain('handsFreeRecognizer.start("modal"');
    expect(modalSource).not.toContain("ExpoSpeechRecognitionModule");
    expect(modalSource).not.toContain("Dedicated training screen");
    expect(modalSource).not.toContain("Live transcript");
    expect(modalSource).not.toContain("Android recognizer status");
    expect(modalSource).toContain("Customise");
    expect(setupSource).toContain("Positive sample");
    expect(setupSource).toContain("Negative sample");
    expect(setupSource).not.toContain("Wake engine: native OpenWakeWord");
    expect(setupSource).not.toContain("Manifest:");
    expect(setupSource).not.toContain("Base phrase match");
    expect(setupSource).not.toContain("Custom phrase recordings are uploaded");
    expect(setupSource).not.toContain("Hands-free only becomes active");
    expect(setupSource).not.toContain("Suggested negative sentences");
    expect(setupSource).toContain("apiPostForm");
    expect(setupSource).toContain("/api/openwakeword/enrollment/sample");
    expect(setupSource).toContain("/api/openwakeword/enrollment/finalize");
    expect(setupSource).toContain("/api/openwakeword/enrollment/model/status");
    expect(setupSource).toContain("downloadAndSaveWakeModelBundle");
    expect(setupSource).toContain("if (modelStatus.ready)");
    expect(setupSource).toContain("status: \"pending\"");
    expect(setupSource).not.toContain("powers wake detection");
  });
});
