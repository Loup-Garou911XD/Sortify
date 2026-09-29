import type { Store, Tag, Track } from "../db.ts";
import type { RawTag, TagMapper } from "../tagging/mapper.ts";
import { BudgetExhaustedError, LookupFailedError } from "./lookup.ts";
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
    /** Providers that could not be reached; the track is tagged again on the next run. */
    failedProviders: string[];
  };
  tags: Tag[];
}

/**
 * Tracks tagged at once. Each service keeps its own rate limit, so this only lets one service
 * work on one track while another service works on the next.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Tags one track: song-type rules from the title, then the providers in four steps — the first
 * resolver that recognises the track fixes its spelling, all providers' track tags are fetched in
 * parallel, fallback providers are asked only if no subgenre was found, and artist-level tags
 * fill in only when nothing gave a genre at all.
 */
export async function enrichTrack(track: Track, enrichers: Enrichers): Promise<EnrichedTrack> {
  const parsed = parseTitle(track.title, track.channel);
  const tags: Tag[] = detectSongTypes(track.title, parsed.hints);
  const externalIds: Record<string, string> = {};
  const failed = new Set<string>();
  if (!parsed.artist || !parsed.songTitle) {
    const meta = { artist: parsed.artist, songTitle: parsed.songTitle, externalIds };
    return { meta: { ...meta, failedProviders: [] }, tags };
  }

  /** Runs one provider call; a provider that keeps failing is noted and skipped for now. */
  const ask = async <T>(client: ProviderClient, call: () => Promise<T> | undefined) => {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof LookupFailedError)) throw error;
      failed.add(client.id);
      return undefined;
    }
  };

  const clients = enrichers.clients.filter((c) => !c.skip?.(parsed));
  let query: TrackQuery = {
    videoId: track.videoId,
    artist: parsed.artist,
    title: parsed.songTitle,
  };
  const genreRaw: RawTag[] = [];
  const moodRaw: RawTag[] = [];

  let resolved = false;
  for (const client of clients) {
    const match = await ask(client, () => client.resolve?.(query));
    if (!match) continue;
    query = { ...query, artist: match.artist, title: match.title };
    if (match.externalId) externalIds[client.id] = match.externalId;
    genreRaw.push(...(match.genres ?? []));
    resolved = true;
    break;
  }

  const collect = async (asked: ProviderClient[]): Promise<void> => {
    const results = await Promise.all(
      asked.map(async (client) => ({
        client,
        found: await ask(client, () => client.trackTags?.(query)),
      })),
    );
    for (const { client, found } of results) {
      if (!found) continue;
      if (found.externalId) externalIds[client.id] = found.externalId;
      genreRaw.push(...found.genres);
      moodRaw.push(...(found.moods ?? []));
    }
  };
  await collect(clients.filter((c) => !c.fallback));
  if (!enrichers.mapper.hasSubgenre(genreRaw)) await collect(clients.filter((c) => c.fallback));

  let genres = enrichers.mapper.genres(genreRaw);
  // A guessed artist (e.g. from a label upload's credits) could pull in someone else's genres.
  if (genres.length === 0 && (parsed.confident || resolved)) {
    for (const client of clients) {
      const artistTags = client.artistTags?.bind(client);
      if (!artistTags) continue;
      genres = enrichers.mapper.genres((await ask(client, () => artistTags(query.artist))) ?? []);
      if (genres.length > 0) break;
    }
  }

  tags.push(...genres, ...enrichers.mapper.moodTags(moodRaw));
  return {
    meta: {
      artist: query.artist,
      songTitle: query.title,
      externalIds,
      failedProviders: [...failed],
    },
    tags,
  };
}

export interface EnrichSummary {
  enriched: number;
  remaining: number;
  /** Tracks saved without some provider's data because it was unreachable; retried next run. */
  retryLater: number;
  stoppedByBudget: boolean;
  cancelled: boolean;
}

/**
 * Enriches every track in a fetched playlist that is not tagged yet, or whose last tagging missed
 * a provider that could not be reached (or all of them with `force`), several at a time. Each track is saved as soon as it is done, so an interrupted run
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
    .filter((t) => options.force || t.enrichedAt === null || t.failedProviders.length > 0);
  const queue = [...todo];
  let enriched = 0;
  let retryLater = 0;
  let stoppedByBudget = false;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (!stoppedByBudget && !failure && !options.signal?.aborted) {
      const track = queue.shift();
      if (!track) return;
      try {
        const result = await enrichTrack(track, enrichers);
        store.saveEnrichment(track.videoId, result.meta, result.tags);
        if (result.meta.failedProviders.length > 0) retryLater++;
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
    retryLater,
    stoppedByBudget,
    cancelled: remaining > 0 && !stoppedByBudget && Boolean(options.signal?.aborted),
  };
}
