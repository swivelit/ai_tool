export type ChatScreenPlatform = "ios" | "android" | "web" | string;

export type ChatScreenLayoutInput = {
  screenWidth: number;
  screenHeight: number;
  safeAreaTop?: number;
  safeAreaBottom?: number;
  composerHeight?: number;
  keyboardHeight?: number;
  keyboardVisible?: boolean;
  platform?: ChatScreenPlatform;
  maxChatWidth?: number;
};

export type ChatScreenLayout = {
  isSmallPhone: boolean;
  horizontalPadding: number;
  topPadding: number;
  composerBottomPadding: number;
  composerBottomOffset: number;
  contentMaxWidth: number;
  scrollBottomPadding: number;
  keyboardHeight: number;
  composerTopY: number;
  composerBottomY: number;
  composerClearsKeyboard: boolean;
};

function finiteNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function computeChatScreenLayout(
  input: ChatScreenLayoutInput,
): ChatScreenLayout {
  const screenWidth = Math.max(0, finiteNumber(input.screenWidth, 0));
  const screenHeight = Math.max(0, finiteNumber(input.screenHeight, 0));
  const safeAreaTop = Math.max(0, finiteNumber(input.safeAreaTop, 0));
  const rawSafeAreaBottom = Math.max(0, finiteNumber(input.safeAreaBottom, 0));
  const composerHeight = Math.max(0, finiteNumber(input.composerHeight, 0));
  const keyboardHeight =
    input.keyboardVisible === true
      ? clamp(finiteNumber(input.keyboardHeight, 0), 0, screenHeight)
      : 0;
  const platform = String(input.platform || "").toLowerCase();
  const maxChatWidth = Math.max(320, finiteNumber(input.maxChatWidth, 560));
  const safeAreaBottom =
    platform === "android" ? clamp(rawSafeAreaBottom, 0, 12) : rawSafeAreaBottom;
  const isSmallPhone = screenWidth < 370 || screenHeight < 760;
  const horizontalPadding = isSmallPhone ? 14 : 18;
  const topPadding = safeAreaTop + (isSmallPhone ? 10 : 16);
  const composerBottomPadding =
    platform === "ios"
      ? Math.max(safeAreaBottom, 8)
      : clamp(safeAreaBottom || 8, 6, 12);
  const composerBottomOffset = keyboardHeight;
  const contentMaxWidth = Math.min(
    Math.max(0, screenWidth - horizontalPadding * 2),
    maxChatWidth,
  );
  const scrollBottomPadding = Math.max(
    24,
    Math.ceil(composerHeight + composerBottomPadding + 10),
  );
  const keyboardTopY = Math.max(0, screenHeight - keyboardHeight);
  const composerBottomY = Math.max(
    0,
    screenHeight - composerBottomOffset - composerBottomPadding,
  );
  const composerTopY = Math.max(
    topPadding,
    composerBottomY - composerHeight,
  );

  return {
    isSmallPhone,
    horizontalPadding,
    topPadding,
    composerBottomPadding,
    composerBottomOffset,
    contentMaxWidth,
    scrollBottomPadding,
    keyboardHeight,
    composerTopY,
    composerBottomY,
    composerClearsKeyboard: !keyboardHeight || composerBottomY <= keyboardTopY,
  };
}
