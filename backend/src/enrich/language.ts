import type { Tag } from "../db.ts";

/**
 * Scripts that belong to one language closely enough to name it. Devanagari also writes Marathi
 * and Nepali, and Arabic script also writes Urdu and Persian, so those are the common reading
 * rather than a certainty; a provider tag saying otherwise adds its own language tag beside this
 * one, and the planner then puts the track in both groups.
 */
const SCRIPTS: { value: string; pattern: RegExp }[] = [
  // Kana before Han: Japanese titles mix the two, Chinese ones use Han alone.
  { value: "Japanese", pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu },
  { value: "Korean", pattern: /\p{Script=Hangul}/gu },
  { value: "Mandarin", pattern: /\p{Script=Han}/gu },
  { value: "Hindi", pattern: /\p{Script=Devanagari}/gu },
  { value: "Punjabi", pattern: /\p{Script=Gurmukhi}/gu },
  { value: "Bengali", pattern: /\p{Script=Bengali}/gu },
  { value: "Gujarati", pattern: /\p{Script=Gujarati}/gu },
  { value: "Tamil", pattern: /\p{Script=Tamil}/gu },
  { value: "Telugu", pattern: /\p{Script=Telugu}/gu },
  { value: "Kannada", pattern: /\p{Script=Kannada}/gu },
  { value: "Malayalam", pattern: /\p{Script=Malayalam}/gu },
  { value: "Urdu", pattern: /\p{Script=Arabic}/gu },
  { value: "Hebrew", pattern: /\p{Script=Hebrew}/gu },
  { value: "Greek", pattern: /\p{Script=Greek}/gu },
  { value: "Russian", pattern: /\p{Script=Cyrillic}/gu },
  { value: "Thai", pattern: /\p{Script=Thai}/gu },
];

/** A stray symbol or one borrowed character is not a title in that script. */
const MIN_LETTERS = 2;

/**
 * Language tags from the script a title is written in. Latin script says nothing about the
 * language, so romanized titles get their language from provider tags instead (see the tag map's
 * `languages` section). At most one script wins: the one with the most letters.
 */
export function detectLanguages(rawTitle: string): Tag[] {
  const counted = SCRIPTS.map((script) => ({
    value: script.value,
    letters: rawTitle.match(script.pattern)?.length ?? 0,
  })).filter((c) => c.letters >= MIN_LETTERS);
  // Kana settle a Japanese title even when its kanji outnumber them.
  const japanese = counted.some((c) => c.value === "Japanese");
  let best: { value: string; letters: number } | undefined;
  for (const candidate of counted) {
    if (japanese && candidate.value === "Mandarin") continue;
    if (!best || candidate.letters > best.letters) best = candidate;
  }
  if (!best) return [];
  return [
    { dimension: "language", value: best.value, rawTag: rawTitle, source: "rule", weight: 1 },
  ];
}
