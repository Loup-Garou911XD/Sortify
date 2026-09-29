import { cachedGet, type LookupDeps, RateLimiter } from "./lookup.ts";
import { similarity } from "./text.ts";

export interface RecordingMatch {
  mbid: string;
  artist: string;
  title: string;
  tags: { name: string; count: number }[];
}

interface SearchResponse {
  recordings?: {
    id: string;
    score: number;
    title: string;
    "artist-credit"?: { name: string; joinphrase?: string }[];
    tags?: { name: string; count: number }[];
  }[];
}

const MIN_SCORE = 80;
const MIN_SIMILARITY = 0.6;

const quote = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** MusicBrainz recording search; used to correct artist/title spelling before other lookups. */
export class MusicBrainz {
  private readonly deps: LookupDeps;
  // MusicBrainz allows one request per second per client.
  private readonly limiter: RateLimiter;

  constructor(deps: LookupDeps) {
    this.deps = deps;
    this.limiter = new RateLimiter(1100, deps.sleep);
  }

  async findRecording(artist: string, title: string): Promise<RecordingMatch | null> {
    const query = `recording:${quote(title)} AND artist:${quote(artist)}`;
    const url = `https://musicbrainz.org/ws/2/recording?${new URLSearchParams({
      query,
      fmt: "json",
      limit: "5",
    })}`;
    const result = await cachedGet(this.deps, this.limiter, {
      source: "musicbrainz",
      cacheKey: `${artist}\u0000${title}`.toLowerCase(),
      url,
      parse: (body) => pickRecording(body as SearchResponse, artist, title),
    });
    return result ?? null;
  }
}

export function pickRecording(
  body: SearchResponse | null,
  artist: string,
  title: string,
): RecordingMatch | null {
  for (const rec of body?.recordings ?? []) {
    const credit = (rec["artist-credit"] ?? []).map((c) => c.name + (c.joinphrase ?? "")).join("");
    if (
      rec.score >= MIN_SCORE &&
      similarity(credit, artist) >= MIN_SIMILARITY &&
      similarity(rec.title, title) >= MIN_SIMILARITY
    ) {
      return { mbid: rec.id, artist: credit, title: rec.title, tags: rec.tags ?? [] };
    }
  }
  return null;
}
