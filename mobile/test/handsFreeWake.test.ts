import { describe, expect, it } from "vitest";

import {
  cleanHandsFreeCommand,
  isHandsFreeStopCommand,
  normalizeHandsFreeText,
  uniqueHandsFreePhrases,
} from "../lib/handsFreeWake";

describe("hands-free command helpers", () => {
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
});
