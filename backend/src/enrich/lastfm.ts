import { cachedGet, type LookupDeps, RateLimiter } from "./lookup.ts";

export interface LastFmTag {
  name: string;
  /** Relative weight 0–100 (100 = the track's most-applied tag). */
  count: number;
}

interface TopTagsResponse {
  toptags?: { tag?: LastFmTag[] | LastFmTag };
  error?: number;
}

const API = "https://ws.audioscrobbler.com/2.0/";

function parseTags(body: TopTagsResponse | null): LastFmTag[] {
  const tags = body?.toptags?.tag;
  if (!tags) return [];
  // Last.fm returns a bare object instead of an array when there is exactly one tag.
  const list = Array.isArray(tags) ? tags : [tags];
  return list.map((t) => ({ name: t.name, count: Number(t.count) || 0 }));
}

/** Last.fm user tags: the only free source that mixes genre with mood ("chill", "sad"). */
export class LastFm {
  private readonly deps: LookupDeps;
  private readonly apiKey: string;
  private readonly limiter: RateLimiter;

  constructor(deps: LookupDeps, apiKey: string) {
    this.deps = deps;
    this.apiKey = apiKey;
    this.limiter = new RateLimiter(250, deps.sleep);
  }

  async trackTags(artist: string, title: string): Promise<LastFmTag[]> {
    const url = `${API}?${new URLSearchParams({
      method: "track.gettoptags",
      artist,
      track: title,
      autocorrect: "1",
      api_key: this.apiKey,
      format: "json",
    })}`;
    const tags = await cachedGet(this.deps, this.limiter, {
      source: "lastfm-track",
      cacheKey: `${artist}\u0000${title}`.toLowerCase(),
      url,
      parse: (body) => parseTags(body as TopTagsResponse),
    });
    return tags ?? [];
  }

  async artistTags(artist: string): Promise<LastFmTag[]> {
    const url = `${API}?${new URLSearchParams({
      method: "artist.gettoptags",
      artist,
      autocorrect: "1",
      api_key: this.apiKey,
      format: "json",
    })}`;
    const tags = await cachedGet(this.deps, this.limiter, {
      source: "lastfm-artist",
      cacheKey: artist.toLowerCase(),
      url,
      parse: (body) => parseTags(body as TopTagsResponse),
    });
    return tags ?? [];
  }
}
