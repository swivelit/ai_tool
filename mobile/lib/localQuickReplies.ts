export type QuickLocalRoute =
  | "fast_greeting"
  | "identity"
  | "small_talk"
  | "wellbeing_support"
  | "capabilities"
  | "thanks"
  | "goodbye";

export type QuickLocalReplyResult = {
  route: QuickLocalRoute;
  assistantText: string;
  englishText: string;
  intent: "assistant";
  title: string;
  confidence: number;
  source: "local_rules";
};

type QuickLocalReplyInput = {
  message: string;
  replyLanguage?: "en" | "ta" | string | null;
  assistantName?: string | null;
  userName?: string | null;
};

const QUICK_PHRASES: Record<QuickLocalRoute, string[]> = {
  fast_greeting: [
    "hi",
    "hello",
    "hey",
    "namaste",
    "vanakkam",
    "good morning",
    "good evening",
    "good night",
    "thanks",
  ],
  identity: [
    "who are you",
    "what are you",
    "what is your name",
    "whats your name",
    "what's your name",
  ],
  small_talk: [
    "what are you up to",
    "what are you doing",
    "what's up",
    "whats up",
    "how are you",
    "how is it going",
    "are you there",
    "can you hear me",
    "are you awake",
  ],
  wellbeing_support: [
    "i am sad",
    "im sad",
    "i'm sad",
    "i feel sad",
    "i am anxious",
    "im anxious",
    "i'm anxious",
    "i feel anxious",
    "i am stressed",
    "im stressed",
    "i'm stressed",
    "i feel stressed",
    "overwhelmed",
    "tired",
    "so tired",
    "exhausted",
    "sleepy",
    "drained",
    "stressed",
    "not feeling good",
    "feeling low",
  ],
  capabilities: [
    "what can you do",
    "what can you help with",
    "can you help me",
    "help",
    "help me",
    "how can you help",
    "what are your features",
  ],
  thanks: ["thanks", "thank you", "okay thanks"],
  goodbye: ["bye", "good bye", "see you"],
};

const ROUTE_TITLES: Record<QuickLocalRoute, string> = {
  fast_greeting: "Greeting",
  identity: "Identity",
  small_talk: "Chat",
  wellbeing_support: "Wellbeing",
  capabilities: "What I Can Do",
  thanks: "Thanks",
  goodbye: "Goodbye",
};

const TASK_CONTEXT_WORDS = [
  "reminder",
  "reminders",
  "task",
  "tasks",
  "schedule",
  "scheduled",
  "calendar",
  "remind",
  "tomorrow",
  "today",
  "tonight",
  "later",
  "plan",
  "plans",
  "design",
  "create",
  "make",
  "set",
  "add",
  "delete",
  "update",
  "change",
  "find",
  "search",
  "weather",
  "explain",
  "explanation",
  "summarize",
  "summary",
  "write",
  "writing",
  "code",
  "coding",
  "program",
  "payment",
  "payments",
  "pay",
  "upi",
  "bank",
  "file",
  "files",
  "document",
  "documents",
  "doc",
  "docs",
  "app",
  "open",
  "close",
  "send",
  "email",
  "call",
  "message",
];

function normalizeQuickText(value?: string | null) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u2032`´]/g, "'")
    .replace(/(\p{L})'(\p{L})/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensFor(value: string) {
  return normalizeQuickText(value).split(/\s+/).filter(Boolean);
}

function containsToken(tokens: string[], token: string) {
  return tokens.some((candidate) => candidate === token);
}

function containsPhraseTokens(tokens: string[], phraseTokens: string[]) {
  if (!phraseTokens.length || phraseTokens.length > tokens.length) {
    return false;
  }

  for (let index = 0; index <= tokens.length - phraseTokens.length; index += 1) {
    const matched = phraseTokens.every(
      (token, offset) => tokens[index + offset] === token,
    );
    if (matched) {
      return true;
    }
  }

  return false;
}

function hasTaskContext(tokens: string[]) {
  return TASK_CONTEXT_WORDS.some((word) => containsToken(tokens, word));
}

function isShortPhraseMatch(tokens: string[], phrase: string, options?: {
  allowContainingPhrase?: boolean;
  blockTaskContext?: boolean;
  extraTokensAllowed?: number;
}) {
  const phraseTokens = tokensFor(phrase);
  if (!phraseTokens.length) {
    return false;
  }

  if (tokens.length === phraseTokens.length && containsPhraseTokens(tokens, phraseTokens)) {
    return true;
  }

  if (!options?.allowContainingPhrase) {
    return false;
  }

  if (options.blockTaskContext && hasTaskContext(tokens)) {
    return false;
  }

  const extraTokensAllowed = options.extraTokensAllowed ?? 2;
  if (tokens.length > phraseTokens.length + extraTokensAllowed) {
    return false;
  }

  return containsPhraseTokens(tokens, phraseTokens);
}

function routeMatches(route: QuickLocalRoute, tokens: string[]) {
  const phrases = QUICK_PHRASES[route];

  if (route === "wellbeing_support") {
    return phrases.some((phrase) => {
      const phraseTokens = tokensFor(phrase);
      return containsPhraseTokens(tokens, phraseTokens) && !hasTaskContext(tokens);
    });
  }

  if (route === "identity") {
    return phrases.some((phrase) =>
      isShortPhraseMatch(tokens, phrase),
    );
  }

  if (route === "small_talk") {
    return phrases.some((phrase) =>
      isShortPhraseMatch(tokens, phrase, {
        allowContainingPhrase: true,
        blockTaskContext: true,
        extraTokensAllowed: 2,
      }),
    );
  }

  if (route === "capabilities") {
    return phrases.some((phrase) =>
      isShortPhraseMatch(tokens, phrase, {
        allowContainingPhrase: true,
        blockTaskContext: true,
        extraTokensAllowed:
          phrase === "help" || phrase === "help me" ? 0 : 3,
      }),
    );
  }

  return phrases.some((phrase) => isShortPhraseMatch(tokens, phrase));
}

function displayName(value?: string | null) {
  const clean = String(value || "").trim();
  return clean || null;
}

function englishReplyFor(route: QuickLocalRoute, input: QuickLocalReplyInput) {
  const userName = displayName(input.userName);
  const assistantName = displayName(input.assistantName);

  switch (route) {
    case "fast_greeting":
      return userName
        ? `Hi ${userName}. I'm here and ready to help.`
        : "Hi. I'm here and ready to help.";
    case "identity":
      return assistantName
        ? `I'm ${assistantName}, your local-first AI assistant on this phone.`
        : "I'm your local-first AI assistant on this phone.";
    case "small_talk":
      return "I'm right here with you. I can help you plan, remember things, answer from local memory, or just chat. What would you like to do?";
    case "wellbeing_support":
      return "That sounds exhausting. Take a short rest, drink some water, and don't push yourself too hard. If this feels unusual, severe, or keeps happening, please consider checking with a medical professional.";
    case "capabilities":
      return "I can chat with you, help plan your day, create reminders, remember useful details locally, and answer from local knowledge. What should we start with?";
    case "thanks":
      return "You're welcome. I'm here when you need me.";
    case "goodbye":
      return assistantName
        ? `Bye for now. ${assistantName} will be here when you come back.`
        : "Bye for now. I'll be here when you come back.";
    default:
      return "I’m here with you. What would you like to do?";
  }
}

function tamilReplyFor(route: QuickLocalRoute, input: QuickLocalReplyInput) {
  const userName = displayName(input.userName);
  const assistantName = displayName(input.assistantName);

  switch (route) {
    case "fast_greeting":
      return userName
        ? `வணக்கம் ${userName}. நான் உதவ தயாராக இருக்கிறேன்.`
        : "வணக்கம். நான் உதவ தயாராக இருக்கிறேன்.";
    case "identity":
      return assistantName
        ? `நான் ${assistantName}, இந்த phone-லேயே local-first ஆக இயங்கும் உங்கள் AI assistant.`
        : "நான் இந்த phone-லேயே local-first ஆக இயங்கும் உங்கள் AI assistant.";
    case "small_talk":
      return "நான் இங்கேதான் இருக்கிறேன். திட்டமிட, நினைவூட்டல்கள் உருவாக்க, local memory-லிருந்து பதில் சொல்ல, அல்லது சும்மா chat செய்ய உதவலாம். என்ன செய்யலாம்?";
    case "wellbeing_support":
      return "அது ரொம்ப சோர்வாக இருக்கலாம். கொஞ்சம் ஓய்வு எடுத்துக்கோங்க, தண்ணீர் குடிங்க, உங்களை அதிகம் அழுத்த வேண்டாம். இது வழக்கத்துக்கு மாறாக, கடுமையாக, அல்லது தொடர்ந்து இருந்தால் மருத்துவரிடம் பேசுங்கள்.";
    case "capabilities":
      return "நான் உங்களுடன் chat செய்ய, நாள் திட்டமிட, reminders உருவாக்க, பயனுள்ள விஷயங்களை local-ஆக நினைவில் வைத்துக்கொள்ள, local knowledge-லிருந்து பதில் சொல்ல உதவலாம். எதிலிருந்து தொடங்கலாம்?";
    case "thanks":
      return "பரவாயில்லை. தேவைப்பட்டால் நான் இங்கே இருக்கிறேன்.";
    case "goodbye":
      return "சரி, பிறகு பார்க்கலாம். நீங்கள் திரும்ப வந்தால் நான் இங்கே இருப்பேன்.";
    default:
      return englishReplyFor(route, input);
  }
}

function confidenceFor(route: QuickLocalRoute) {
  if (route === "wellbeing_support") return 0.97;
  if (route === "small_talk") return 0.98;
  return 0.99;
}

export function tryBuildQuickLocalReply(
  input: QuickLocalReplyInput,
): QuickLocalReplyResult | null {
  const normalized = normalizeQuickText(input.message);
  if (!normalized) {
    return null;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const routeOrder: QuickLocalRoute[] = [
    "wellbeing_support",
    "identity",
    "capabilities",
    "fast_greeting",
    "thanks",
    "goodbye",
    "small_talk",
  ];
  const route = routeOrder.find((candidate) => routeMatches(candidate, tokens));

  if (!route) {
    return null;
  }

  const englishText = englishReplyFor(route, input);
  const replyLanguage = normalizeQuickText(input.replyLanguage);
  const assistantText = replyLanguage === "ta"
    ? tamilReplyFor(route, input)
    : englishText;

  return {
    route,
    assistantText,
    englishText,
    intent: "assistant",
    title: ROUTE_TITLES[route],
    confidence: confidenceFor(route),
    source: "local_rules",
  };
}
