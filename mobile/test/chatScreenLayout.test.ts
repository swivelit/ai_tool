import { describe, expect, it } from "vitest";

import { computeChatScreenLayout } from "../lib/chatScreenLayout";

describe("chat screen layout", () => {
  it("keeps the composer above the Android keyboard on small screens", () => {
    const layout = computeChatScreenLayout({
      platform: "android",
      screenWidth: 360,
      screenHeight: 640,
      safeAreaTop: 24,
      safeAreaBottom: 0,
      composerHeight: 76,
      keyboardVisible: true,
      keyboardHeight: 300,
    });

    expect(layout.composerClearsKeyboard).toBe(true);
    expect(layout.composerBottomY).toBeLessThanOrEqual(340);
  });

  it("bases ScrollView bottom padding on composer height and safe area", () => {
    const layout = computeChatScreenLayout({
      platform: "ios",
      screenWidth: 390,
      screenHeight: 844,
      safeAreaBottom: 34,
      composerHeight: 82,
    });

    expect(layout.scrollBottomPadding).toBe(128);
    expect(layout.scrollBottomPadding).not.toBe(210);
  });

  it("keeps hidden-keyboard composer inside the safe area", () => {
    const layout = computeChatScreenLayout({
      platform: "ios",
      screenWidth: 390,
      screenHeight: 844,
      safeAreaBottom: 34,
      composerHeight: 82,
      keyboardVisible: false,
    });

    expect(layout.composerBottomY).toBe(810);
    expect(layout.composerTopY).toBeGreaterThan(0);
  });

  it("caps chat width on large screens", () => {
    const layout = computeChatScreenLayout({
      platform: "android",
      screenWidth: 900,
      screenHeight: 1200,
      composerHeight: 80,
    });

    expect(layout.contentMaxWidth).toBe(560);
  });
});
