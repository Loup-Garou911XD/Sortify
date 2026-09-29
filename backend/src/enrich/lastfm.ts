import type { RawTag } from "../tagging/mapper.ts";
import { type LookupDeps, ServiceClient } from "./lookup.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";

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
/** Tags below this relative weight (0–100) are mostly noise from a handful of users. */
const MIN_COUNT = 10;
/** Artist-level tags describe the artist, not the track, so they only count half. */
const ARTIST_TAG_FACTOR = 0.5;

function parseTags(body: TopTagsResponse | null): LastFmTag[] {
  const tags = body?.toptags?.tag;
  if (!tags) return [];
  // Last.fm returns a bare object instead of an array when there is exactly one tag.
  const list = Array.isArray(tags) ? tags : [tags];
  return list.map((t) => ({ name: t.name, count: Number(t.count) || 0 }));
}

/** Last.fm user tags: the only free source that mixes genre with mood ("chill", "sad"). */
export class LastFm implements ProviderClient {
  readonly id = "lastfm";
  private readonly http: ServiceClient;
  private readonly apiKey: string;

  constructor(deps: LookupDeps, apiKey: string) {
    this.apiKey = apiKey;
    this.http = new ServiceClient(deps, { name: "Last.fm", source: this.id, intervalMs: 250 });
  }

  private toRaw(tags: LastFmTag[], factor = 1): RawTag[] {
    return tags
      .filter((t) => t.count >= MIN_COUNT)
      .map((t) => ({ tag: t.name, source: this.id, weight: (t.count / 100) * factor }));
  }

  private async topTags(kind: "track" | "artist", params: Record<string, string>) {
    const url = `${API}?${new URLSearchParams({
      method: `${kind}.gettoptags`,
      ...params,
      autocorrect: "1",
      api_key: this.apiKey,
      format: "json",
    })}`;
    const tags = await this.http.get({
      kind,
      key: Object.values(params),
      url,
      parse: (body) => parseTags(body as TopTagsResponse),
    });
    return tags ?? [];
  }

  async trackTags({ artist, title }: TrackQuery): Promise<TrackTags> {
    const tags = this.toRaw(await this.topTags("track", { artist, track: title }));
    // The same user tags carry both genres ("synthwave") and moods ("chill").
    return { genres: tags, moods: tags };
  }

  async artistTags(artist: string): Promise<RawTag[]> {
    return this.toRaw(await this.topTags("artist", { artist }), ARTIST_TAG_FACTOR);
  }
}

export const lastfm: TagProvider = {
  id: "lastfm",
  label: "Last.fm",
  help: "The only mood source, plus subgenres when Discogs has none.",
  envVars: ["LASTFM_API_KEY"],
  create: (deps, env) => new LastFm(deps, env.LASTFM_API_KEY ?? ""),
};
