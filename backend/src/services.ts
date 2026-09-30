import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { Budget, type LookupDeps } from "./enrich/lookup.ts";
import type { Enrichers } from "./enrich/pipeline.ts";
import { createProviderClients } from "./enrich/providers.ts";
import { TagMapper } from "./tagging/mapper.ts";
import { loadTagMap } from "./tagging/tagMapFile.ts";
import { loadAuthClient } from "./youtube/auth.ts";
import { YouTubeClient } from "./youtube/client.ts";

/** YouTube client for the signed-in user (throws if `sortify auth` has not been run). */
export function youtubeFor(config: Config): YouTubeClient {
  const auth = loadAuthClient(config);
  return new YouTubeClient({ getAccessToken: () => auth.getAccessToken() });
}

export type PlaylistReader = Pick<
  YouTubeClient,
  "quotaUsed" | "getPlaylistTitle" | "playlistEntries" | "videoDetails"
>;

export interface FetchResult {
  playlistId: string;
  title: string;
  tracks: number;
  newTracks: number;
  quotaUsed: number;
}

/** Reads a playlist from YouTube into the cache. Durations are only looked up for new videos. */
export async function fetchPlaylist(
  store: Store,
  yt: PlaylistReader,
  playlistId: string,
): Promise<FetchResult> {
  const quotaAtStart = yt.quotaUsed;
  const title = await yt.getPlaylistTitle(playlistId);
  const entries = await yt.playlistEntries(playlistId);
  store.savePlaylist(playlistId, title, entries);
  const missing = store.videoIdsMissingDetails(playlistId);
  if (missing.length > 0) store.setVideoDetails(await yt.videoDetails(missing));
  return {
    playlistId,
    title,
    tracks: entries.length,
    newTracks: missing.length,
    quotaUsed: yt.quotaUsed - quotaAtStart,
  };
}

/** Clients for every configured tagging provider (minus `skip`), sharing one API budget. */
export function createEnrichers(
  config: Config,
  store: Store,
  options: { maxApiCalls?: number; skip?: readonly string[] } = {},
): { enrichers: Enrichers; budget: Budget } {
  const budget = new Budget(options.maxApiCalls);
  const deps: LookupDeps = { store, budget, userAgent: config.userAgent };
  return {
    budget,
    enrichers: {
      mapper: new TagMapper(loadTagMap(config.tagMapPath)),
      clients: createProviderClients(deps, config.env, options.skip),
    },
  };
}
