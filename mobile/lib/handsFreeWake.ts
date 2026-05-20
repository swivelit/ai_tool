export type WakePhraseMatch = {
  matched: boolean;
  command: string;
  phrase?: string;
};

const STOP_COMMANDS = new Set([
  "stop",
  "cancel",
  "go to sleep",
  "stop hands free",
  "stop handsfree",
]);

export function normalizeHandsFreeText(value?: string | null) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9஀-௿\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanHandsFreeCommand(input: string) {
  return normalizeHandsFreeText(input);
}

export function uniqueHandsFreePhrases(values: string[]) {
  return Array.from(
    new Set(values.map((value) => normalizeHandsFreeText(value)).filter(Boolean))
  );
}

export function buildWakePhraseCandidates(
  assistantName: string,
  wakePhrase?: string | null,
  trainedPhrases: string[] = [],
) {
  const cleanName = normalizeHandsFreeText(assistantName);
  const explicitWakePhrase = normalizeHandsFreeText(wakePhrase);

  return uniqueHandsFreePhrases([
    explicitWakePhrase,
    ...trainedPhrases,
    cleanName ? `hey ${cleanName}` : "",
    cleanName ? `hi ${cleanName}` : "",
    cleanName ? `hello ${cleanName}` : "",
  ]);
}

export function matchWakePhrase(input: string, phrases: string[]): WakePhraseMatch {
  const normalizedInput = normalizeHandsFreeText(input);
  const candidates = uniqueHandsFreePhrases(phrases).sort(
    (left, right) => right.length - left.length
  );

  for (const phrase of candidates) {
    if (normalizedInput === phrase) {
      return { matched: true, command: "", phrase };
    }

    if (normalizedInput.startsWith(`${phrase} `)) {
      return {
        matched: true,
        command: cleanHandsFreeCommand(normalizedInput.slice(phrase.length)),
        phrase,
      };
    }
  }

  return { matched: false, command: "" };
}

export function isHandsFreeStopCommand(input: string) {
  return STOP_COMMANDS.has(normalizeHandsFreeText(input));
}
