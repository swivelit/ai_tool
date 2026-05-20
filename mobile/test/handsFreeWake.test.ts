import { describe, expect, it } from "vitest";

import {
  buildWakePhraseCandidates,
  cleanHandsFreeCommand,
  isHandsFreeStopCommand,
  matchWakePhrase,
  normalizeHandsFreeText,
  uniqueHandsFreePhrases,
} from "../lib/handsFreeWake";

describe("hands-free wake phrase helpers", () => {
  it("matches a custom wake phrase", () => {
    const phrases = buildWakePhraseCandidates("Elli", "Computer");

    expect(matchWakePhrase("computer", phrases)).toMatchObject({
      matched: true,
      command: "",
      phrase: "computer",
    });
  });

  it("extracts an inline question after the wake phrase", () => {
    const phrases = buildWakePhraseCandidates("Elli", "Hey Jarvis");

    expect(matchWakePhrase("Hey Jarvis, what is the weather?", phrases)).toMatchObject({
      matched: true,
      command: "what is the weather",
      phrase: "hey jarvis",
    });
  });

  it("matches default assistant variants", () => {
    const phrases = buildWakePhraseCandidates("Elli");

    expect(matchWakePhrase("hey elli", phrases).matched).toBe(true);
    expect(matchWakePhrase("hi elli", phrases).matched).toBe(true);
    expect(matchWakePhrase("hello elli", phrases).matched).toBe(true);
  });

  it("removes duplicate and blank samples", () => {
    expect(uniqueHandsFreePhrases([" Hey Elli ", "", "hey elli", "Hi Elli"])).toEqual([
      "hey elli",
      "hi elli",
    ]);
  });

  it("normalizes punctuation and whitespace", () => {
    expect(normalizeHandsFreeText("  Hey,   Elli!!  ")).toBe("hey elli");
    expect(cleanHandsFreeCommand("  Tell   me... now ")).toBe("tell me now");
  });

  it("preserves Tamil letters", () => {
    expect(normalizeHandsFreeText("ஹே Elli, வானிலை?")).toBe("ஹே elli வானிலை");
  });

  it("detects hands-free stop commands", () => {
    ["stop", "cancel", "go to sleep", "stop hands free", "stop hands-free"].forEach(
      (command) => {
        expect(isHandsFreeStopCommand(command)).toBe(true);
      },
    );
    expect(isHandsFreeStopCommand("stop the timer")).toBe(false);
  });

  it("does not wake for random text", () => {
    const phrases = buildWakePhraseCandidates("Elli", "Hey Elli");

    expect(matchWakePhrase("tell me a joke", phrases)).toEqual({
      matched: false,
      command: "",
    });
  });
});
