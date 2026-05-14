const CURRENT_OR_LIVE_TERMS = new Set([
  "latest",
  "today",
  "current",
  "live",
  "score",
  "scores",
  "news",
  "breaking",
  "now",
  "new",
  "recent",
  "update",
  "updates",
  "election",
  "elections",
  "vote",
  "voting",
  "poll",
  "polls",
  "result",
  "results",
  "winner",
  "candidate",
  "candidates",
  "government",
  "president",
  "prime",
  "minister",
  "pm",
  "cm",
  "mla",
  "mp",
  "weather",
  "forecast",
  "tomorrow",
  "yesterday",
  "price",
  "prices",
  "rate",
  "rates",
  "stock",
  "stocks",
  "crypto",
  "nearby",
  "best",
  "cheapest",
  "deal",
  "deals",
  "offer",
  "offers",
  "discount",
  "discounts",
]);

const CURRENT_OR_LIVE_PHRASES = [
  "near me",
  "prime minister",
];

function normalizeCurrentDataText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u2032`´]/g, "'")
    .replace(/(\p{L})'(\p{L})/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseRegex(phrase: string) {
  return new RegExp(
    `\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );
}

export function isCurrentOrLiveDataQuestion(message: unknown) {
  const normalized = normalizeCurrentDataText(message);
  if (!normalized) return false;

  if (CURRENT_OR_LIVE_PHRASES.some((phrase) => phraseRegex(phrase).test(normalized))) {
    return true;
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => CURRENT_OR_LIVE_TERMS.has(token));
}
