import type { FetchLike, LookupDeps } from "./lookup.ts";
import { ServiceClient } from "./lookup.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";
import { bestMatch, similarity } from "./text.ts";

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const MIN_SIMILARITY = 0.6;
/** Genres describe the artist, not this track, but they are detailed ("desi hip hop"). */
const GENRE_WEIGHT = 0.6;

/** The cached form of a track search result. */
export interface SpotifyMatch {
  /** Spotify track id. */
  id: string;
  /** The matched artist, whose genres are looked up (and cached) separately. */
  artistId: string;
}

interface SearchResponse {
  tracks?: { items?: { id: string; name: string; artists: { id: string; name: string }[] }[] };
}

/**
 * Spotify Web API with app credentials (no user sign-in): finds the track, then its artist's
 * genres. Spotify marks artist genres as deprecated, so an empty list is treated as "no data".
 * Development-mode apps can no longer batch artist lookups, so each artist is fetched once and
 * cached.
 */
export class Spotify implements ProviderClient {
  readonly id = "spotify";
  private readonly http: ServiceClient;
  private readonly fetchImpl: FetchLike;
  private readonly credentials: string;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(deps: LookupDeps, clientId: string, clientSecret: string) {
    this.fetchImpl = deps.fetch ?? fetch;
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
    });
    if (!match) return { genres: [] };
    const genres = await this.http.get({
      kind: "artist",
      key: [match.artistId],
      url: `${API}/artists/${match.artistId}`,
      parse: (body) => (body as { genres?: string[] } | null)?.genres ?? [],
    });
    return {
      externalId: match.id,
      genres: genres.map((tag) => ({ tag, source: this.id, weight: GENRE_WEIGHT })),
    };
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
  return best ? { id: best.item.id, artistId: best.artistId } : null;
}

export const spotify: TagProvider = {
  id: "spotify",
  label: "Spotify",
  help: "Detailed artist genres (e.g. desi hip hop, punjabi pop). Needs an app's client ID and secret from developer.spotify.com.",
  envVars: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
  create: (deps, env) =>
    new Spotify(deps, env.SPOTIFY_CLIENT_ID ?? "", env.SPOTIFY_CLIENT_SECRET ?? ""),
};
