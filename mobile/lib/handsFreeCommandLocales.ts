export function buildCommandRecognitionLocalePlan(preferredLocale: string) {
  const preferred = String(preferredLocale || "").trim();
  return Array.from(new Set([preferred, "en-IN", "en-US"].filter(Boolean)));
}

export function isLanguageNotSupportedRecognitionError(event: unknown) {
  const code = String((event as any)?.error || (event as any)?.code || "")
    .trim()
    .toLowerCase();
  const message = String((event as any)?.message || "")
    .trim()
    .toLowerCase();
  return code === "language-not-supported" || message.includes("language-not-supported");
}
