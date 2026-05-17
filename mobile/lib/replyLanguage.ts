export type ReplyLanguage =
  | "english"
  | "tamil"
  | "tanglish"
  | "auto";

export const PRODUCT_DEFAULT_REPLY_LANGUAGE: ReplyLanguage = "auto";

const TAMIL_SCRIPT_RE = /[\u0B80-\u0BFF]/;
const LATIN_LETTER_RE = /[a-z]/i;
const NON_LATIN_LETTER_RE = /[^\W\d_a-z]/giu;

const ENGLISH_REQUEST_RE =
  /\b(?:reply|answer|respond|speak|tell|say|explain)\s+(?:in\s+)?english\b|\benglish\s+(?:la\s+)?(?:sollu|pesu|reply|answer|please)\b|\bin\s+english\b/i;

const TAMIL_REQUEST_RE =
  /\b(?:reply|answer|respond|speak|tell|say|explain)\s+(?:in\s+)?tamil\b|\btamil\s+(?:la\s+)?(?:sollu|pesu|reply|answer|please)\b|தமிழ(?:ில்|்ல|்)\s*(?:சொல்லு|சொல்லுங்கள்|பேசு|பேசுங்கள்)?/i;

const TANGLISH_RE =
  /\b(?:enna|ennaikku|epdi|eppadi|iruka|irukka|iruku|venum|vena|pannu|pannunga|sollu|sollunga|pesu|pesunga|theriyala|seri|sapadu|saapadu|nan|naan|unga|ungalukku|ennoda)\b/i;

export function normalizeReplyLanguage(value: unknown): ReplyLanguage | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (!normalized) return null;
  if (normalized === "en" || normalized === "english") {
    return "english";
  }

  if (
    normalized === "ta" ||
    normalized === "tamil" ||
    normalized === "தமிழ்"
  ) {
    return "tamil";
  }

  if (
    normalized === "tanglish" ||
    normalized === "mixed"
  ) {
    return "tanglish";
  }

  if (
    normalized === "auto" ||
    normalized === "detect"
  ) {
    return "auto";
  }
  return null;
  }

export function detectExplicitReplyLanguage(message: unknown): ReplyLanguage | null {
  const text = String(message || "").trim();
  if (!text) return null;

  if (ENGLISH_REQUEST_RE.test(text)) return "english";
if (TAMIL_REQUEST_RE.test(text)) return "tamil";
  return null;
}

export function detectMessageReplyLanguage(message: unknown): ReplyLanguage | null {
  const text = String(message || "").trim();
  if (!text) return null;

  const explicit = detectExplicitReplyLanguage(text);
  if (explicit) return explicit;

  if (TAMIL_SCRIPT_RE.test(text)) return "tamil";
  if (TANGLISH_RE.test(text)) return "tanglish";

  const latinLetters = (text.match(/[a-z]/gi) || []).length;
  const nonLatinLetters = (text.match(NON_LATIN_LETTER_RE) || []).filter(
    (char) => !TAMIL_SCRIPT_RE.test(char),
  ).length;

  if (latinLetters > 0 && latinLetters >= Math.max(3, nonLatinLetters * 2)) {
    return "english";
  }

  if (LATIN_LETTER_RE.test(text) && !nonLatinLetters) {
    return "english";
  }

  return "auto";
}

export function resolveReplyLanguage(opts: {
  explicit?: unknown;
  profile?: unknown;
  message?: unknown;
  productDefault?: ReplyLanguage;
}): ReplyLanguage {
  return (
    normalizeReplyLanguage(opts.explicit) ||
    detectExplicitReplyLanguage(opts.message) ||
    normalizeReplyLanguage(opts.profile) ||
    detectMessageReplyLanguage(opts.message) ||
    opts.productDefault ||
    PRODUCT_DEFAULT_REPLY_LANGUAGE
  );
}
