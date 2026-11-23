import type { FetchLike, LookupDeps } from "./lookup.ts";
import { ServiceClient } from "./lookup.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";
import { bestMatch, lacksYear, similarity, yearOf } from "./text.ts";

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const MIN_SIMILARITY = 0.6;

/** The cached form of a track search result. */
export interface SpotifyMatch {
  /** Spotify track id. */
  id: string;
  /** The matched artist. No longer read (see `Spotify`); kept so older entries still parse. */
  artistId: string;
  /**
   * Release year of the album the track was found on; `null` when Spotify gives none. Absent in
   * entries cached before it was read; those are asked again (see `lacksYear`).
   */
  year?: number | null;
}

interface SearchResponse {
  tracks?: {
    items?: {
      id: string;
      name: string;
      artists: { id: string; name: string }[];
      album?: { release_date?: string };
    }[];
  };
}

/**
 * Spotify Web API with app credentials (no user sign-in): finds the track and reads the release
 * year of its album, for the `decade` tag. It gives no genres. Spotify used to list them on the
 * artist, but development-mode apps (every personal app) now get artist objects without
 * `genres`, `popularity` or `followers`, so asking for the artist cost a request per artist and
 * could never return anything.
 */
export class Spotify implements ProviderClient {
  readonly id = "spotify";
  private readonly http: ServiceClient;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: string;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(deps: LookupDeps, clientId: string, clientSecret: string) {
    // `fetch` is a method of the global object: capturing it unbound and calling it through a
    // variable throws "Illegal invocation" in browsers, though it works in Node.
    this.fetchImpl = deps.fetch ?? fetch.bind(globalThis);
    // btoa, not Buffer: this module also runs in the browser build, and both are ASCII.
    this.credentials = btoa(`${clientId}:${clientSecret}`);
    this.http = new ServiceClient(deps, {
      name: "Spotify",
      source: this.id,
      intervalMs: 250,
      headers: async () => ({ authorization: `Bearer ${await this.accessToken()}` }),
      authenticated: true,
    });
  }

  /** App access token, reused until a minute before it expires; one request at a time. */
  private accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return Promise.resolve(this.token.value);
    this.tokenRequest ??= this.requestToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${this.credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(
        `Spotify rejected the app credentials (HTTP ${res.status}); check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET`,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    return body.access_token;
  }

  async trackTags({ artist, title }: TrackQuery): Promise<TrackTags> {
    const match = await this.http.get({
      kind: "track",
      key: [artist, title],
      url: `${API}/search?${new URLSearchParams({
        q: `track:${title} artist:${artist}`,
        type: "track",
        limit: "10",
      })}`,
      parse: (body) => pickTrack(body as SearchResponse, artist, title),
      outdated: lacksYear,
    });
    if (!match) return { genres: [] };
    return { externalId: match.id, genres: [], year: match.year ?? undefined };
  }
}

export function pickTrack(
  body: SearchResponse | null,
  artist: string,
  title: string,
): SpotifyMatch | null {
  const credited = (body?.tracks?.items ?? []).flatMap((item) => {
    const a = item.artists.find((x) => similarity(x.name, artist) >= MIN_SIMILARITY);
    return a ? [{ item, artistId: a.id }] : [];
  });
  const best = bestMatch(credited, (c) => similarity(c.item.name, title), MIN_SIMILARITY);
  if (!best) return null;
  return {
    id: best.item.id,
    artistId: best.artistId,
    year: yearOf(best.item.album?.release_date) ?? null,
  };
}

export const spotify: TagProvider = {
  id: "spotify",
  label: "Spotify",
  help: "Release years, for sorting by decade. No genres: Spotify withholds them from personal apps. Needs an app's client ID and secret from developer.spotify.com.",
  envVars: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
  create: (deps, env) =>
    new Spotify(deps, env.SPOTIFY_CLIENT_ID ?? "", env.SPOTIFY_CLIENT_SECRET ?? ""),
};
