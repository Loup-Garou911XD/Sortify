/** Lowercase, strip accents and punctuation, drop a leading "the". Used for fuzzy comparisons. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  const compact = value.replace(/\s/g, "");
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/**
 * The candidate that best matches `target` by similarity, if any reaches `min`. Exact matches beat
 * "contains" matches, so "Softly" wins over "Softly (Tiësto Remix)"; ties keep the earlier one.
 */
export function bestMatch<T>(
  candidates: readonly T[],
  score: (candidate: T) => number,
  min: number,
): T | undefined {
  let best: T | undefined;
  let bestScore = min;
  for (const candidate of candidates) {
    const s = score(candidate);
    if (s > bestScore || (best === undefined && s >= min)) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Similarity in [0, 1] for artist/title matching: Sørensen–Dice over character bigrams, with a
 * floor of 0.9 when one normalized string contains the other ("Beyonce" vs "Beyoncé feat. X").
 */
export function similarity(a: string, b: string): number {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const count of gx.values()) total += count;
  for (const [gram, count] of gy) {
    total += count;
    overlap += Math.min(count, gx.get(gram) ?? 0);
  }
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * The year out of a release date, whatever precision the service gave ("2013", "2013-05",
 * "2013-05-17T07:00:00Z"). Undefined when there is nothing to read.
 */
export function yearOf(date: string | undefined): number | undefined {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
}
