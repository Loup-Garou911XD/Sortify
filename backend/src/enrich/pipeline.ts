import type { Store, Tag, Track } from "../db.ts";
import type { RawTag, TagMapper } from "../tagging/mapper.ts";
import { BudgetExhaustedError } from "./lookup.ts";
import type { ProviderClient, TrackQuery } from "./provider.ts";
import { detectSongTypes } from "./songType.ts";
import { parseTitle } from "./titleParser.ts";

export interface Enrichers {
  mapper: TagMapper;
  /** Provider clients in PROVIDERS order (see providers.ts). */
  clients: ProviderClient[];
}

export interface EnrichedTrack {
  meta: {
    artist: string | null;
    songTitle: string | null;
    /** Provider id → that provider's id for the track (MusicBrainz MBID, Discogs release…). */
    externalIds: Record<string, string>;
  };
  tags: Tag[];
}

/**
 * Tracks tagged at once. Each service keeps its own rate limit, so this only lets one service
 * work on one track while another service works on the next.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Tags one track: song-type rules from the title, then the providers in three steps — the first
 * resolver that recognises the track fixes its spelling, all providers' track tags are fetched in
 * parallel, and artist-level tags fill in only when nothing else gave a genre.
 */
export async function enrichTrack(track: Track, enrichers: Enrichers): Promise<EnrichedTrack> {
  const parsed = parseTitle(track.title, track.channel);
  const tags: Tag[] = detectSongTypes(track.title, parsed.hints);
  const externalIds: Record<string, string> = {};
  if (!parsed.artist || !parsed.songTitle) {
    return { meta: { artist: parsed.artist, songTitle: parsed.songTitle, externalIds }, tags };
  }

  const clients = enrichers.clients.filter((c) => !c.skip?.(parsed));
  let query: TrackQuery = { artist: parsed.artist, title: parsed.songTitle };
  const genreRaw: RawTag[] = [];
  const moodRaw: RawTag[] = [];

  let resolved = false;
  for (const client of clients) {
    const match = await client.resolve?.(query);
    if (!match) continue;
    query = { artist: match.artist, title: match.title };
    if (match.externalId) externalIds[client.id] = match.externalId;
    genreRaw.push(...(match.genres ?? []));
    resolved = true;
    break;
  }

  const results = await Promise.all(
    clients.map(async (client) => ({ client, tags: await client.trackTags?.(query) })),
  );
  for (const { client, tags: found } of results) {
    if (!found) continue;
    if (found.externalId) externalIds[client.id] = found.externalId;
    genreRaw.push(...found.genres);
    moodRaw.push(...(found.moods ?? []));
  }

  let genres = enrichers.mapper.genres(genreRaw);
  // A guessed artist (e.g. from a label upload's credits) could pull in someone else's genres.
  if (genres.length === 0 && (parsed.confident || resolved)) {
    for (const client of clients) {
      if (!client.artistTags) continue;
      genres = enrichers.mapper.genres(await client.artistTags(query.artist));
      if (genres.length > 0) break;
    }
  }

  tags.push(...genres, ...enrichers.mapper.moodTags(moodRaw));
  return { meta: { artist: query.artist, songTitle: query.title, externalIds }, tags };
}

export interface EnrichSummary {
  enriched: number;
  remaining: number;
  stoppedByBudget: boolean;
  cancelled: boolean;
}

/**
 * Enriches every track in a fetched playlist that has not been enriched yet (or all of them with
 * `force`), several at a time. Each track is saved as soon as it is done, so an interrupted run
 * loses nothing.
 */
export async function enrichPlaylist(
  store: Store,
  playlistId: string,
  enrichers: Enrichers,
  options: {
    force?: boolean;
    onProgress?: (done: number, total: number, track: Track) => void;
    /** Checked before each track; already enriched tracks stay saved. */
    signal?: AbortSignal;
    concurrency?: number;
  } = {},
): Promise<EnrichSummary> {
  const todo = store
    .playlistTracks(playlistId)
    .filter((t) => options.force || t.enrichedAt === null);
  const queue = [...todo];
  let enriched = 0;
  let stoppedByBudget = false;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (!stoppedByBudget && !failure && !options.signal?.aborted) {
      const track = queue.shift();
      if (!track) return;
      try {
        const result = await enrichTrack(track, enrichers);
        store.saveEnrichment(track.videoId, result.meta, result.tags);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) stoppedByBudget = true;
        else failure ??= { error };
        return;
      }
      enriched++;
      options.onProgress?.(enriched, todo.length, track);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, todo.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure.error;

  const remaining = todo.length - enriched;
  return {
    enriched,
    remaining,
    stoppedByBudget,
    cancelled: remaining > 0 && !stoppedByBudget && Boolean(options.signal?.aborted),
  };
}
