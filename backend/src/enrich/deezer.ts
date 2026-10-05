import { type LookupDeps, ServiceClient } from "./lookup.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";
import { bestMatch, similarity, yearOf } from "./text.ts";

/** The cached form of a track search result. */
export interface DeezerMatch {
  /** Deezer track id. */
  id: string;
  /** The album the genres and release date are read from. */
  albumId: string;
}

/** The cached form of an album lookup; one album covers all of its tracks. */
export interface DeezerAlbum {
  genres: string[];
  year?: number;
}

interface SearchResponse {
  data?: { id: number; title: string; artist?: { name: string }; album?: { id: number } }[];
}

interface AlbumResponse {
  genres?: { data?: { name: string }[] };
  release_date?: string;
}

const API = "https://api.deezer.com";
const MIN_SIMILARITY = 0.6;
/** Genres belong to the album and are broad ("Indian Music"), so they rank near iTunes'. */
const GENRE_WEIGHT = 0.6;

/**
 * Deezer's public API: album genres and the release date, with no key and a generous rate limit
 * (50 requests per 5 seconds). Its catalogue is strong where Discogs is thin, so like iTunes it
 * is a fallback, asked only about tracks no other provider gave a subgenre. Two lookups per
 * track, but the album one is shared by every track from the same album.
 */
export class Deezer implements ProviderClient {
  readonly id = "deezer";
  readonly fallback = true;
  private readonly http: ServiceClient;

  constructor(deps: LookupDeps) {
    this.http = new ServiceClient(deps, { name: "Deezer", source: this.id, intervalMs: 120 });
  }

  async trackTags({ artist, title }: TrackQuery): Promise<TrackTags> {
    const match = await this.http.get({
      kind: "track",
      key: [artist, title],
      url: `${API}/search?${new URLSearchParams({ q: `artist:"${artist}" track:"${title}"` })}`,
      parse: (body) => pickTrack(body as SearchResponse, artist, title),
    });
    if (!match) return { genres: [] };
    const album = await this.http.get({
      kind: "album",
      key: [match.albumId],
      url: `${API}/album/${match.albumId}`,
      parse: (body) => parseAlbum(body as AlbumResponse),
    });
    return {
      externalId: match.id,
      genres: (album?.genres ?? []).map((tag) => ({ tag, source: this.id, weight: GENRE_WEIGHT })),
      year: album?.year,
    };
  }
}

export function pickTrack(
  body: SearchResponse | null,
  artist: string,
  title: string,
): DeezerMatch | null {
  const credited = (body?.data ?? []).filter(
    (t) => t.album?.id && similarity(t.artist?.name ?? "", artist) >= MIN_SIMILARITY,
  );
  const best = bestMatch(credited, (t) => similarity(t.title, title), MIN_SIMILARITY);
  return best?.album ? { id: String(best.id), albumId: String(best.album.id) } : null;
}

/** Null when the album carried neither a genre nor a date, so the cache can expire it. */
export function parseAlbum(body: AlbumResponse | null): DeezerAlbum | null {
  const genres = (body?.genres?.data ?? []).map((g) => g.name);
  const year = yearOf(body?.release_date);
  return genres.length === 0 && year === undefined ? null : { genres, year };
}

export const deezer: TagProvider = {
  id: "deezer",
  label: "Deezer",
  help: "Album genres and release years, asked only when others found no subgenre. Needs no key.",
  envVars: [],
  // Deezer sends the other CORS headers but no access-control-allow-origin, so the static
  // build cannot reach it; asking anyway would only mark every track for a retry.
  serverOnly: true,
  create: (deps) => new Deezer(deps),
};
