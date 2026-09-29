import type { RawTag } from "../tagging/mapper.ts";
import { type LookupDeps, ServiceClient } from "./lookup.ts";
import type { ProviderClient, Resolution, TagProvider, TrackQuery } from "./provider.ts";
import { similarity } from "./text.ts";
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

const quote = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** Recording search; corrects artist/title spelling before the other providers look up tags. */
export class MusicBrainz implements ProviderClient {
  readonly id = "musicbrainz";
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
}

export const musicbrainz: TagProvider = {
  id: "musicbrainz",
  label: "MusicBrainz",
  help: "Corrects artist and title spelling. Needs no key.",
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
