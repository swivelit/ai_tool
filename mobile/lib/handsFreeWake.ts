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

export function isHandsFreeStopCommand(input: string) {
  return STOP_COMMANDS.has(normalizeHandsFreeText(input));
}
