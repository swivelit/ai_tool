import React from "react";

import { AssistantCharacter } from "@/components/AssistantCharacter";
import { type CharacterState, type Emotion } from "@/lib/assistantCharacter";

type OrbProps = {
  listening: boolean;
  state?: CharacterState;
  emotion?: Emotion;
  mouthOpenness?: number;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  size?: number;
};

/**
 * Compatibility wrapper for the legacy voice control API.
 *
 * The app still routes through `Orb` from the existing chat screen, but the
 * visual control is now the animated assistant character. Recording remains a
 * strict press-and-hold interaction via onPressIn/onPressOut.
 */
export function Orb({
  listening,
  state,
  emotion,
  mouthOpenness,
  onPress,
  onPressIn,
  onPressOut,
  size = 168,
}: OrbProps) {
  return (
    <AssistantCharacter
      state={state ?? (listening ? "listening" : "idle")}
      emotion={emotion ?? (listening ? "thinking" : "neutral")}
      mouthOpenness={mouthOpenness}
      listening={listening}
      mode="hero"
      size={size}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      testID="voice-assistant-character"
      accessibilityLabel="Hold the assistant to talk"
    />
  );
}
