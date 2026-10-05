/**
 * What the lookup cache counts as a "no match", and how long one stands. Imported by both stores
 * as well as `lookup.ts`, so it stays free of `node:` imports and of any import of its own.
 */

/**
 * How long a cached "no match" stands. A match is kept forever (the services' ids do not change,
 * and re-asking would spend calls for nothing), but a miss can become a match as MusicBrainz,
 * Discogs and the stores fill in, so misses expire and the next run asks again.
 */
export const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a cached body is a "no match". Every provider's `parse` answers an empty body with
 * `null` or an empty list, so that is exactly what a miss looks like in the cache.
 */
export function isCachedMiss(body: unknown): boolean {
  return body === null || (Array.isArray(body) && body.length === 0);
}
