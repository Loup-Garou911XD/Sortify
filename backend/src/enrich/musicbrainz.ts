import type { RawTag } from "../tagging/mapper.ts";
import { type LookupDeps, ServiceClient } from "./lookup.ts";
import type { ProviderClient, Resolution, TagProvider, TrackQuery, TrackTags } from "./provider.ts";
import { similarity, yearOf } from "./text.ts";
import type { ParsedTitle } from "./titleParser.ts";

/** The cached form of a search result (kept stable so existing caches stay valid). */
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
/** MusicBrainz tags carry vote counts rather than weights; trust them a little below Discogs. */
const TAG_WEIGHT = 0.8;
/** Genres are the curated subset of those tags, so they are worth a little more. */
const GENRE_WEIGHT = 0.9;

const quote = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** The cached form of the recording lookup that follows a match. */
export interface RecordingGenres {
  genres: string[];
  year?: number;
}

interface LookupResponse {
  genres?: { name: string; count?: number }[];
  "first-release-date"?: string;
}

/** Recording search; corrects artist/title spelling before the other providers look up tags. */
export class MusicBrainz implements ProviderClient {
  readonly id = "musicbrainz";
  /**
   * The genre lookup is a second request about a track this provider already matched, so it is
   * only worth making for the tracks nothing else could place.
   */
  readonly fallback = true;
  private readonly http: ServiceClient;

  constructor(deps: LookupDeps) {
    // MusicBrainz allows one request per second per client.
    this.http = new ServiceClient(deps, { name: "MusicBrainz", source: this.id, intervalMs: 1100 });
  }

  /** Topic tracks already carry the label's own spelling; the lookup is for messy uploads. */
  skip(parsed: ParsedTitle): boolean {
    return parsed.official;
  }

  async resolve({ artist, title }: TrackQuery): Promise<Resolution | undefined> {
    const url = `https://musicbrainz.org/ws/2/recording?${new URLSearchParams({
      query: `recording:${quote(title)} AND artist:${quote(artist)}`,
      fmt: "json",
      limit: "5",
    })}`;
    const match = await this.http.get({
      key: [artist, title],
      url,
      parse: (body) => pickRecording(body as SearchResponse, artist, title),
    });
    if (!match) return undefined;
    return {
      artist: match.artist,
      title: match.title,
      externalId: match.mbid,
      genres: match.tags.map((t): RawTag => ({ tag: t.name, source: this.id, weight: TAG_WEIGHT })),
    };
  }

  /**
   * The matched recording's curated genres, which the search does not return. Asked only about a
   * recording this provider's own `resolve` identified, so it costs nothing for the rest.
   */
  async trackTags({ externalIds }: TrackQuery): Promise<TrackTags> {
    const mbid = externalIds?.[this.id];
    if (!mbid) return { genres: [] };
    const found = await this.http.get({
      kind: "recording",
      key: [mbid],
      url: `https://musicbrainz.org/ws/2/recording/${mbid}?inc=genres&fmt=json`,
      parse: (body) => parseGenres(body as LookupResponse),
    });
    return {
      genres: (found?.genres ?? []).map((tag) => ({ tag, source: this.id, weight: GENRE_WEIGHT })),
      year: found?.year,
    };
  }
}

/** Null when the recording carried neither a genre nor a date, so the cache can expire it. */
export function parseGenres(body: LookupResponse | null): RecordingGenres | null {
  const genres = (body?.genres ?? []).map((g) => g.name);
  const year = yearOf(body?.["first-release-date"]);
  return genres.length === 0 && year === undefined ? null : { genres, year };
}

export const musicbrainz: TagProvider = {
  id: "musicbrainz",
  label: "MusicBrainz",
  help: "Corrects artist and title spelling, and adds curated genres for tracks nothing else placed. Needs no key.",
  envVars: [],
  create: (deps) => new MusicBrainz(deps),
};

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
