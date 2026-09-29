import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { Discogs } from "./enrich/discogs.ts";
import { LastFm } from "./enrich/lastfm.ts";
import { Budget, type LookupDeps } from "./enrich/lookup.ts";
import { MusicBrainz } from "./enrich/musicbrainz.ts";
import type { Enrichers } from "./enrich/pipeline.ts";
import { loadTagMap, TagMapper } from "./tagging/mapper.ts";
import { loadAuthClient } from "./youtube/auth.ts";
import { YouTubeClient } from "./youtube/client.ts";

/** YouTube client for the signed-in user (throws if `sortify auth` has not been run). */
export function youtubeFor(config: Config): YouTubeClient {
  const auth = loadAuthClient(config);
  return new YouTubeClient({ getAccessToken: () => auth.getAccessToken() });
}

export type PlaylistReader = Pick<
  YouTubeClient,
  "quotaUsed" | "getPlaylistTitle" | "playlistEntries" | "videoDurations"
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
  const missing = store.videoIdsMissingDuration(playlistId);
  if (missing.length > 0) store.setDurations(await yt.videoDurations(missing));
  return {
    playlistId,
    title,
    tracks: entries.length,
    newTracks: missing.length,
    quotaUsed: yt.quotaUsed - quotaAtStart,
  };
}

/** The enrichment sources the current configuration allows, sharing one API budget. */
export function createEnrichers(
  config: Config,
  store: Store,
  options: { maxApiCalls?: number; musicbrainz?: boolean } = {},
): { enrichers: Enrichers; budget: Budget } {
  const budget = new Budget(options.maxApiCalls);
  const deps: LookupDeps = { store, budget, userAgent: config.userAgent };
  return {
    budget,
    enrichers: {
      mapper: new TagMapper(loadTagMap(config.tagMapPath)),
      musicbrainz: options.musicbrainz === false ? undefined : new MusicBrainz(deps),
      discogs: config.discogsToken ? new Discogs(deps, config.discogsToken) : undefined,
      lastfm: config.lastfmApiKey ? new LastFm(deps, config.lastfmApiKey) : undefined,
    },
  };
}
