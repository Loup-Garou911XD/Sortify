import { type LookupDeps, ServiceClient } from "./lookup.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";
import { similarity } from "./text.ts";

/** The cached form of a search result (kept stable so existing caches stay valid). */
export interface DiscogsMatch {
  /** "master/123" or "release/456". */
  id: string;
  genres: string[];
  styles: string[];
}

interface SearchResponse {
  results?: {
    id: number;
    type: string;
    title: string;
    genre?: string[];
    style?: string[];
    format?: string[];
  }[];
}

const MIN_SIMILARITY = 0.6;

/**
 * Discogs database search for subgenres ("styles"). Styles belong to releases, not tracks, so
 * masters (the original release) are preferred and compilations are skipped. One search covers
 * masters and releases together; searching each type separately cost a second call per track
 * and found little extra.
 */
export class Discogs implements ProviderClient {
  readonly id = "discogs";
  private readonly http: ServiceClient;

  constructor(deps: LookupDeps, token: string) {
    // Authenticated clients get 60 requests per minute.
    this.http = new ServiceClient(deps, {
      name: "Discogs",
      source: this.id,
      intervalMs: 1100,
      headers: { authorization: `Discogs token=${token}` },
      authenticated: true,
    });
  }

  async trackTags({ artist, title }: TrackQuery): Promise<TrackTags> {
    const url = `https://api.discogs.com/database/search?${new URLSearchParams({
      artist,
      track: title,
      per_page: "25",
    })}`;
    const match = await this.http.get({
      key: [artist, title],
      url,
      parse: (body) => pickResult(body as SearchResponse, artist),
    });
    if (!match) return { genres: [] };
    return {
      externalId: match.id,
      genres: [...match.styles, ...match.genres].map((tag) => ({
        tag,
        source: this.id,
        weight: 1,
      })),
    };
  }
}

export const discogs: TagProvider = {
  id: "discogs",
  label: "Discogs",
  help: "The main subgenre source (release styles such as Synthwave or Deep House).",
  envVars: ["DISCOGS_TOKEN"],
  create: (deps, env) => new Discogs(deps, env.DISCOGS_TOKEN ?? ""),
};

export function pickResult(body: SearchResponse | null, artist: string): DiscogsMatch | null {
  const results = (body?.results ?? []).filter((r) => r.type === "master" || r.type === "release");
  // Stable sort: masters first, otherwise keep Discogs' relevance order.
  results.sort((a, b) => Number(b.type === "master") - Number(a.type === "master"));
  for (const r of results) {
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
