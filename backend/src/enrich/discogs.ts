import { cachedGet, type LookupDeps, RateLimiter } from "./lookup.ts";
import { similarity } from "./text.ts";

export interface DiscogsMatch {
  /** "master/123" or "release/456". */
  id: string;
  genres: string[];
  styles: string[];
}

interface SearchResponse {
  results?: {
    id: number;
    type: "master" | "release";
    title: string;
    genre?: string[];
    style?: string[];
    format?: string[];
  }[];
}

const MIN_SIMILARITY = 0.6;

/**
 * Discogs database search for subgenres ("styles"). Styles belong to releases, not tracks, so
 * masters (the original release) are preferred and compilations are skipped.
 */
export class Discogs {
  private readonly deps: LookupDeps;
  private readonly token: string;
  // Authenticated clients get 60 requests per minute.
  private readonly limiter: RateLimiter;

  constructor(deps: LookupDeps, token: string) {
    this.deps = deps;
    this.token = token;
    this.limiter = new RateLimiter(1100, deps.sleep);
  }

  async findStyles(artist: string, title: string): Promise<DiscogsMatch | null> {
    for (const type of ["master", "release"] as const) {
      const url = `https://api.discogs.com/database/search?${new URLSearchParams({
        type,
        artist,
        track: title,
        per_page: "10",
      })}`;
      const match = await cachedGet(this.deps, this.limiter, {
        source: `discogs-${type}`,
        cacheKey: `${artist}\u0000${title}`.toLowerCase(),
        url,
        headers: { authorization: `Discogs token=${this.token}` },
        parse: (body) => pickResult(body as SearchResponse, artist),
      });
      if (match) return match;
    }
    return null;
  }
}

export function pickResult(body: SearchResponse | null, artist: string): DiscogsMatch | null {
  for (const r of body?.results ?? []) {
    if (r.format?.some((f) => /compilation/i.test(f))) continue;
    // Titles are "Artist - Release Title"; a missing separator means an odd entry, skip it.
    const sep = r.title.indexOf(" - ");
    if (sep < 0) continue;
    const resultArtist = r.title.slice(0, sep).replace(/\s*\(\d+\)$/, "");
    if (similarity(resultArtist, artist) < MIN_SIMILARITY) continue;
    if (!r.style?.length && !r.genre?.length) continue;
    return { id: `${r.type}/${r.id}`, genres: r.genre ?? [], styles: r.style ?? [] };
  }
  return null;
}
