import { type LookupDeps, ServiceClient } from "./lookup.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";
import { bestMatch, similarity } from "./text.ts";

/** The cached form of a search result. */
export interface ItunesMatch {
  /** iTunes track id. */
  id: string;
  /** The song's primary genre, e.g. "Punjabi Pop", "Bollywood", "Alternative". */
  genre: string;
}

interface SearchResponse {
  results?: {
    trackId: number;
    artistName: string;
    trackName: string;
    primaryGenreName?: string;
  }[];
}

const MIN_SIMILARITY = 0.6;
/** Store genres are per song and often regional, but sometimes odd ("New Age" for a rap song). */
const GENRE_WEIGHT = 0.7;

/**
 * iTunes Search API: the store genre of each song. Strong on regional music ("Punjabi Pop",
 * "Bollywood", "Indian Pop") and needs no key, but Apple allows only about 20 requests a minute,
 * so it is a fallback provider: asked only about tracks no other provider gave a subgenre.
 */
export class ITunes implements ProviderClient {
  readonly id = "itunes";
  readonly fallback = true;
  private readonly http: ServiceClient;
  private readonly country: string;

  constructor(deps: LookupDeps, country = "US") {
    this.country = country;
    this.http = new ServiceClient(deps, { name: "iTunes", source: this.id, intervalMs: 3100 });
  }

  async trackTags({ artist, title }: TrackQuery): Promise<TrackTags> {
    const url = `https://itunes.apple.com/search?${new URLSearchParams({
      term: `${artist} ${title}`,
      entity: "song",
      limit: "10",
      country: this.country,
    })}`;
    const match = await this.http.get({
      key: [this.country, artist, title],
      url,
      parse: (body) => pickSong(body as SearchResponse, artist, title),
    });
    if (!match) return { genres: [] };
    return {
      externalId: match.id,
      genres: [{ tag: match.genre, source: this.id, weight: GENRE_WEIGHT }],
    };
  }
}

export function pickSong(
  body: SearchResponse | null,
  artist: string,
  title: string,
): ItunesMatch | null {
  const candidates = (body?.results ?? []).filter(
    (r) => r.primaryGenreName && similarity(r.artistName, artist) >= MIN_SIMILARITY,
  );
  const r = bestMatch(candidates, (c) => similarity(c.trackName, title), MIN_SIMILARITY);
  return r?.primaryGenreName ? { id: String(r.trackId), genre: r.primaryGenreName } : null;
}

export const itunes: TagProvider = {
  id: "itunes",
  label: "iTunes",
  help: "Store genres such as Punjabi Pop and Bollywood; asked only when others found no subgenre. Needs no key (ITUNES_COUNTRY picks the store, default US).",
  envVars: [],
  create: (deps, env) => new ITunes(deps, env.ITUNES_COUNTRY?.trim() || "US"),
};
