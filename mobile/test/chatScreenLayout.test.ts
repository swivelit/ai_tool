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

  it("bases ScrollView bottom padding on measured composer height without double-counting bottom padding", () => {
    const layout = computeChatScreenLayout({
      platform: "ios",
      screenWidth: 390,
      screenHeight: 844,
      safeAreaBottom: 34,
      composerHeight: 82,
    });

    expect(layout.scrollBottomPadding).toBe(94);
    expect(layout.scrollBottomPadding).not.toBe(210);
    expect(layout.scrollBottomPadding).toBeLessThan(
      82 + layout.composerBottomPadding + 12,
    );
  });

  it("clamps inflated Android bottom safe area values", () => {
    const layout74 = computeChatScreenLayout({
      platform: "android",
      screenWidth: 390,
      screenHeight: 844,
      safeAreaBottom: 74,
      composerHeight: 82,
    });
    const layout100 = computeChatScreenLayout({
      platform: "android",
      screenWidth: 390,
      screenHeight: 844,
      safeAreaBottom: 100,
      composerHeight: 82,
    });

    expect(layout74.composerBottomPadding).toBeLessThanOrEqual(24);
    expect(layout100.composerBottomPadding).toBeLessThanOrEqual(24);
    expect(layout100.scrollBottomPadding).toBe(94);
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
