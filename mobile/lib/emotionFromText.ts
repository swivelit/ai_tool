import type { Emotion } from "./assistantCharacter";

export type { Emotion } from "./assistantCharacter";

/**
 * Maps an assistant reply to a facial Emotion using a small keyword/sentiment
 * scorer. Pure + deterministic so it can be unit-tested and reused by the chat
 * screen to drive `<AssistantCharacter emotion=... />`.
 *
 * Categories are scored independently and the highest wins; ties break toward
 * the more "careful" emotion (concerned > excited > thinking > happy) so an
 * apology never reads as celebration. A reply with no signal stays neutral.
 */

const EXCITED = [
  "amazing",
  "awesome",
  "fantastic",
  "wonderful",
  "incredible",
  "congratulations",
  "congrats",
  "hooray",
  "yay",
  "let's go",
  "lets go",
  "so happy",
  "well done",
  "great job",
  "brilliant",
];

const HAPPY = [
  "glad",
  "happy",
  "great",
  "good",
  "nice",
  "sure",
  "of course",
  "thanks",
  "thank you",
  "welcome",
  "love",
  "perfect",
  "enjoy",
  "delighted",
  "wonderful",
  "absolutely",
  "cheers",
];

const CONCERNED = [
  "sorry",
  "unfortunately",
  "apolog",
  "error",
  "failed",
  "failure",
  "cannot",
  "can't",
  "couldn't",
  "could not",
  "unable",
  "problem",
  "issue",
  "trouble",
  "warning",
  "careful",
  "danger",
  "sad",
  "worried",
  "afraid",
  "won't work",
  "not working",
];

const SAD = [
  "sad",
  "disappointed",
  "disappointing",
  "upset",
  "hurt",
  "loss",
  "lost",
  "miss you",
  "heavy day",
  "rough day",
  "that sounds hard",
  "tough",
  "grief",
  "lonely",
];

const SURPRISED = [
  "wow",
  "whoa",
  "woah",
  "oh!",
  "unexpected",
  "surprising",
  "surprise",
  "i didn't expect",
  "did not expect",
  "that's new",
  "that is new",
  "remarkable",
  "no way",
];

const THINKING = [
  "hmm",
  "let me",
  "let me think",
  "let's see",
  "lets see",
  "i think",
  "maybe",
  "perhaps",
  "consider",
  "wondering",
  "not sure",
  "it depends",
  "possibly",
  "calculating",
  "looking into",
];

const POSITIVE_EMOJI = /[\u{1F600}-\u{1F60F}\u{1F642}\u{1F60A}\u{2728}\u{1F389}\u{1F38A}\u{1F525}\u{1F973}\u{2764}\u{1F44D}]/u;
const SAD_EMOJI = /[\u{1F61E}\u{1F614}\u{1F622}\u{1F625}\u{1F62D}]/u;
const CONCERN_EMOJI = /[\u{1F61F}\u{1F628}\u{1F630}\u{26A0}]/u;
const SURPRISED_EMOJI = /[\u{1F62E}\u{1F632}\u{1F633}\u{1F631}\u{1F92F}]/u;

function countMatches(haystack: string, needles: string[]): number {
  let total = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) total += 1;
  }
  return total;
}

export function emotionFromText(reply: string): Emotion {
  const text = String(reply ?? "").toLowerCase().trim();
  if (!text) return "neutral";

  const exclamations = (text.match(/!/g) || []).length;
  const hasQuestion = text.includes("?");

  let excited = countMatches(text, EXCITED) * 2;
  let happy = countMatches(text, HAPPY);
  let concerned = countMatches(text, CONCERNED) * 2;
  let sad = countMatches(text, SAD) * 2;
  let surprised = countMatches(text, SURPRISED) * 2;
  let thinking = countMatches(text, THINKING);

  if (POSITIVE_EMOJI.test(reply)) {
    happy += 1;
    excited += 1;
  }
  if (SAD_EMOJI.test(reply)) {
    sad += 2;
  }
  if (CONCERN_EMOJI.test(reply)) {
    concerned += 2;
  }
  if (SURPRISED_EMOJI.test(reply)) {
    surprised += 2;
  }
  if (exclamations >= 2) excited += 2;
  else if (exclamations === 1) happy += 1;
  if (text.includes("?!") || text.includes("!?")) surprised += 2;
  if (hasQuestion) thinking += 1;

  const scores: { emotion: Emotion; score: number }[] = [
    // Order encodes the tie-break priority (first wins on equal score).
    { emotion: "concerned", score: concerned },
    { emotion: "sad", score: sad },
    { emotion: "surprised", score: surprised },
    { emotion: "excited", score: excited },
    { emotion: "thinking", score: thinking },
    { emotion: "happy", score: happy },
  ];

  let best: { emotion: Emotion; score: number } = {
    emotion: "neutral",
    score: 0,
  };
  for (const candidate of scores) {
    if (candidate.score > best.score) best = candidate;
  }

  return best.score > 0 ? best.emotion : "neutral";
}
