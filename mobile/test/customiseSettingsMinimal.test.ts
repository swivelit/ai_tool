import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");
const customiseSource = fs.readFileSync(path.join(root, "app", "customise.tsx"), "utf8");
const modalSource = fs.readFileSync(path.join(root, "app", "modal.tsx"), "utf8");
const setupSource = fs.readFileSync(path.join(root, "app", "setup.tsx"), "utf8");

const forbidden = [
  "Dedicated training screen",
  "Android speech diagnostics",
  "Android recognizer status",
  "Live transcript",
  "Your captured phrase will appear here",
  "Install on-device speech model",
  "Download on-device speech model",
  "Best way to record it",
  "Last captured audio file",
  "Microphone audio was captured",
  "Requested language is supported",
  "Custom phrase recordings are uploaded",
  "Hands-free only becomes active",
  "Suggested negative sentences",
  "Active sign-in methods",
  "This account already supports email/password login.",
  "Wake engine",
  "OpenWakeWord technical copy",
];

describe("minimal settings wake phrase UI", () => {
  it("keeps customise clean and routes training away from Android STT", () => {
    expect(customiseSource).toContain("Settings");
    expect(customiseSource).toContain("Assistant name");
    expect(customiseSource).toContain("Professional");
    expect(customiseSource).toContain("Friendly");
    expect(customiseSource).toContain("Tamil");
    expect(customiseSource).toContain("English");
    expect(customiseSource).toContain("customise-hands-free-switch");
    expect(customiseSource).toContain("customise-wake-phrase-input");
    expect(customiseSource).toContain("customise-wake-trainer-button");
    expect(customiseSource).toContain("Train wake phrase");
    expect(customiseSource).toContain("customise-save-button");
    expect(customiseSource).toContain("life-context-card");
    expect(customiseSource).toContain("life-context-enable-toggle");
    expect(customiseSource).toContain("life-context-activity-permission-button");
    expect(customiseSource).toContain("life-context-usage-settings-button");
    expect(customiseSource).toContain("life-context-share-backend-toggle");
    expect(customiseSource).toContain("life-context-share-app-names-toggle");
    expect(customiseSource).toContain("life-context-daily-summary");
    expect(customiseSource).toContain("gaze tracking");
    expect(customiseSource).toContain("hidden monitoring");
    expect(customiseSource).not.toContain("handsFreeRecognizer.start");
    expect(customiseSource).not.toContain("useHandsFreeRecognitionEvent");
    expect(customiseSource.match(/name="radio-outline"/g) || []).toHaveLength(0);
    forbidden.forEach((copy) => expect(customiseSource).not.toContain(copy));
  });

  it("removes the hidden modal wake trainer Android speech path", () => {
    expect(modalSource).not.toContain("handsFreeRecognizer.start");
    expect(modalSource).not.toContain("useHandsFreeRecognitionEvent");
    forbidden.forEach((copy) => expect(modalSource).not.toContain(copy));
  });

  it("keeps setup copy short and product-facing", () => {
    expect(setupSource).toContain("Train wake phrase");
    expect(setupSource).toContain("Positive sample");
    expect(setupSource).toContain("Negative sample");
    expect(setupSource).toContain("Needs model");
    forbidden.forEach((copy) => expect(setupSource).not.toContain(copy));
  });
});
