const STATIC_CACHE_UNSAFE_TERMS = new Set([
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

const STATIC_CACHE_UNSAFE_PHRASES = [
  "near me",
  "prime minister",
  "exchange rate",
];

const IMMEDIATE_BACKEND_TERMS = new Set([
  "latest",
  "current",
  "live",
  "news",
  "breaking",
]);

const WEATHER_TERMS = new Set(["weather", "forecast"]);

const MARKET_TERMS = new Set([
  "price",
  "prices",
  "rate",
  "rates",
  "stock",
  "stocks",
  "crypto",
]);

const RESULT_TERMS = new Set(["score", "scores", "result", "results", "winner"]);

const SPORTS_CONTEXT_TERMS = new Set([
  "ipl",
  "cricket",
  "match",
  "matches",
  "game",
  "games",
  "team",
  "teams",
  "sports",
  "football",
  "soccer",
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "league",
  "tournament",
  "fixture",
  "fixtures",
  "final",
  "finals",
]);

const POLITICAL_CONTEXT_TERMS = new Set([
  "election",
  "elections",
  "vote",
  "voting",
  "poll",
  "polls",
  "candidate",
  "candidates",
  "government",
  "president",
  "pm",
  "cm",
  "mla",
  "mp",
]);

const POLITICAL_ROLE_TERMS = new Set(["president", "pm", "cm", "mla", "mp"]);

const POLITICAL_CURRENT_MODIFIERS = new Set([
  "latest",
  "current",
  "live",
  "news",
  "breaking",
  "today",
  "now",
  "new",
  "recent",
  "update",
  "updates",
  "result",
  "results",
  "winner",
  "details",
]);

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

function tokenize(value: string) {
  return value.split(/\s+/).filter(Boolean);
}

function hasAny(tokens: string[], terms: Set<string>) {
  return tokens.some((token) => terms.has(token));
}

function hasPhrase(normalized: string, phrases: string[]) {
  return phrases.some((phrase) => phraseRegex(phrase).test(normalized));
}

export function isUnsafeForStaticCache(message: unknown) {
  const normalized = normalizeCurrentDataText(message);
  if (!normalized) return false;

  if (hasPhrase(normalized, STATIC_CACHE_UNSAFE_PHRASES)) {
    return true;
  }

  return hasAny(tokenize(normalized), STATIC_CACHE_UNSAFE_TERMS);
}

export function requiresImmediateBackendCurrentData(message: unknown) {
  const normalized = normalizeCurrentDataText(message);
  if (!normalized) return false;

  const tokens = tokenize(normalized);

  if (hasAny(tokens, IMMEDIATE_BACKEND_TERMS)) {
    return true;
  }

  if (hasPhrase(normalized, ["near me"]) || tokens.includes("nearby")) {
    return true;
  }

  if (hasAny(tokens, WEATHER_TERMS)) {
    return true;
  }

  if (hasPhrase(normalized, ["exchange rate"]) || hasAny(tokens, MARKET_TERMS)) {
    return true;
  }

  const hasSportsContext =
    hasAny(tokens, SPORTS_CONTEXT_TERMS) || hasPhrase(normalized, ["world cup"]);
  const hasPoliticalContext =
    hasAny(tokens, POLITICAL_CONTEXT_TERMS) ||
    hasPhrase(normalized, ["prime minister"]);
  const hasResultTerm = hasAny(tokens, RESULT_TERMS);

  if (hasResultTerm && (hasSportsContext || hasPoliticalContext)) {
    return true;
  }

  if (!hasPoliticalContext) {
    return false;
  }

  const hasPoliticalRole =
    hasAny(tokens, POLITICAL_ROLE_TERMS) ||
    hasPhrase(normalized, ["prime minister"]);
  const asksForCurrentRole =
    hasPoliticalRole && /\b(who is|whos|name of|current)\b/.test(normalized);

  return (
    hasAny(tokens, POLITICAL_CURRENT_MODIFIERS) ||
    asksForCurrentRole ||
    /\b(election details|election result|election results)\b/.test(normalized)
  );
}

export function isCurrentOrLiveDataQuestion(message: unknown) {
  return isUnsafeForStaticCache(message);
}
