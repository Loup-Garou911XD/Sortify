import type { Tag } from "../db.ts";

interface Rule {
  value: string;
  /** Matched against version hints: bracket contents and trailing " - ..." segments. */
  hint: RegExp;
  /** Matched against the whole title; only for words that rarely appear in real song names. */
  anywhere?: RegExp;
}

const RULES: Rule[] = [
  {
    value: "Live",
    hint: /\blive\b|\bin concert\b|\bunplugged\b/,
    anywhere: /\blive (?:at|from|in|on|session|performance|version)\b/i,
  },
  {
    value: "Remix",
    // "Tiësto Remix", "Club Mix", "Skrillex Edit" — but not "Original Mix" or "Radio Edit".
    hint: /\bremix\b|\bbootleg\b|\brework\b|\bvip\b|\bflip\b|(?<!\b(?:original|extended|radio|album))\s(?:mix|edit)\b/,
    anywhere: /\bremix\b/i,
  },
  { value: "Cover", hint: /\bcover\b/, anywhere: /\bcover(?:ed)? by\b|\s-\s.*\bcover\s*$/i },
  { value: "Acoustic", hint: /\bacoustic\b|\bunplugged\b/, anywhere: /\bacoustic\b/i },
  {
    value: "Instrumental",
    hint: /\binstrumental\b|\bkaraoke\b|\bbacking track\b/,
    anywhere: /\binstrumental\b|\bkaraoke\b/i,
  },
  {
    value: "Sped Up",
    hint: /\bsped[\s-]?up\b|\bnightcore\b/,
    anywhere: /\bsped[\s-]?up\b|\bnightcore\b/i,
  },
  { value: "Slowed", hint: /\bslowed\b/, anywhere: /\bslowed\b/i },
];

/** Rule-based song-type tags ("Live", "Remix", ...) from a video title and its parsed hints. */
export function detectSongTypes(rawTitle: string, hints: string[]): Tag[] {
  const tags: Tag[] = [];
  for (const rule of RULES) {
    const hint = hints.find((h) => rule.hint.test(h));
    const matched = hint ?? (rule.anywhere?.test(rawTitle) ? rawTitle : undefined);
    if (matched !== undefined) {
      tags.push({
        dimension: "type",
        value: rule.value,
        rawTag: matched,
        source: "rule",
        weight: 1,
      });
    }
  }
  return tags;
}
