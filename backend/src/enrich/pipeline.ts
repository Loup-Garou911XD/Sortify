import type { Cache, Tag, Track } from "../db.ts";
import type { RawTag, TagMapper } from "../tagging/mapper.ts";
import { artistAgreementTags } from "./agreement.ts";
import { detectLanguages } from "./language.ts";
import { BudgetExhaustedError, LookupFailedError } from "./lookup.ts";
import type { ProviderClient, TrackQuery } from "./provider.ts";
import { detectSongTypes } from "./songType.ts";
import { parseTitle } from "./titleParser.ts";

export interface Enrichers {
  mapper: TagMapper;
  /** Provider clients in PROVIDERS order (see providers.ts). */
  clients: ProviderClient[];
  /**
   * Every raw tag the providers gave for a track, before the tag map had its say. The tag report
   * uses it to find the tags the map is dropping; tagging itself does not.
   */
  onRawTags?: (videoId: string, raw: RawTag[]) => void;
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
/** Earlier than any recording a provider could sensibly report; below it, the year is junk. */
const FIRST_YEAR = 1900;

/**
 * Tags one track: song-type and language rules from the title, then the providers in four steps.
 * The first resolver that recognises the track fixes its spelling, all providers' track tags are
 * fetched in parallel, fallback providers are asked only if no subgenre was found, and
 * artist-level tags fill in only when nothing gave a genre at all.
 *
 * A title that yields no artist and song name still gets the providers that read per-video data,
 * since those cost nothing and need no match: that is all a messy upload has.
 */
export async function enrichTrack(track: Track, enrichers: Enrichers): Promise<EnrichedTrack> {
  const parsed = parseTitle(track.title, track.channel);
  const tags: Tag[] = [
    ...detectSongTypes(track.title, parsed.hints),
    ...detectLanguages(track.title),
  ];
  const externalIds: Record<string, string> = {};
  const failed = new Set<string>();
  /** Release years the providers reported, for one `decade` tag. */
  const years: { year: number; source: string }[] = [];

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

  /** Maps what the providers gave, adds the derived tags and hands back the saved shape. */
  const finish = (
    raw: RawTag[],
    extra: Tag[],
    meta: { artist: string | null; songTitle: string | null },
  ): EnrichedTrack => {
    enrichers.onRawTags?.(track.videoId, raw);
    const earliest = years.sort((a, b) => a.year - b.year)[0];
    tags.push(...extra, ...enrichers.mapper.languageTags(raw));
    if (earliest) tags.push(decadeTag(earliest));
    return { meta: { ...meta, externalIds, failedProviders: [...failed] }, tags };
  };

  if (!parsed.artist || !parsed.songTitle) {
    const query: TrackQuery = {
      videoId: track.videoId,
      artist: parsed.artist ?? "",
      title: parsed.songTitle ?? "",
      externalIds,
    };
    const raw: RawTag[] = [];
    for (const client of enrichers.clients.filter((c) => c.videoOnly)) {
      const found = await ask(client, () => client.trackTags?.(query));
      if (found) raw.push(...found.genres);
    }
    return finish(raw, enrichers.mapper.genres(raw), parsed);
  }

  const clients = enrichers.clients.filter((c) => !c.skip?.(parsed));
  let query: TrackQuery = {
    videoId: track.videoId,
    artist: parsed.artist,
    title: parsed.songTitle,
  };
  const genreRaw: RawTag[] = [];
  const moodRaw: RawTag[] = [];
  // Language is read off every raw tag any provider gave, artist-level ones included.
  const languageRaw: RawTag[] = [];

  const noteYear = (source: string, year: number | undefined): void => {
    if (year !== undefined && year >= FIRST_YEAR && year <= new Date().getFullYear() + 1) {
      years.push({ year, source });
    }
  };

  let resolved = false;
  for (const client of clients) {
    const match = await ask(client, () => client.resolve?.(query));
    if (!match) continue;
    query = { ...query, artist: match.artist, title: match.title };
    if (match.externalId) externalIds[client.id] = match.externalId;
    genreRaw.push(...(match.genres ?? []));
    noteYear(client.id, match.year);
    resolved = true;
    break;
  }

  const collect = async (asked: ProviderClient[]): Promise<void> => {
    // The ids gathered so far travel with the query, so a provider can ask a second question
    // about the track its own resolve already identified.
    const withIds: TrackQuery = { ...query, externalIds: { ...externalIds } };
    const results = await Promise.all(
      asked.map(async (client) => ({
        client,
        found: await ask(client, () => client.trackTags?.(withIds)),
      })),
    );
    for (const { client, found } of results) {
      if (!found) continue;
      if (found.externalId) externalIds[client.id] = found.externalId;
      genreRaw.push(...found.genres);
      moodRaw.push(...(found.moods ?? []));
      noteYear(client.id, found.year);
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
      const raw = (await ask(client, () => artistTags(query.artist))) ?? [];
      languageRaw.push(...raw);
      genres = enrichers.mapper.genres(raw);
      if (genres.length > 0) break;
    }
  }

  return finish(
    [...genreRaw, ...moodRaw, ...languageRaw],
    [...genres, ...enrichers.mapper.moodTags(moodRaw)],
    // A resolver may have corrected the spelling; that is what the track is saved under.
    { artist: query.artist, songTitle: query.title },
  );
}

/** Earliest year of the ones reported, as "1970s"; the exact year stays as the raw tag. */
function decadeTag({ year, source }: { year: number; source: string }): Tag {
  return {
    dimension: "decade",
    value: `${Math.floor(year / 10) * 10}s`,
    rawTag: String(year),
    source,
    weight: 1,
  };
}

export interface EnrichSummary {
  enriched: number;
  remaining: number;
  /** Tracks saved without some provider's data because it was unreachable; retried next run. */
  retryLater: number;
  /** Tracks that took a subgenre from the same artist's other tracks (see agreement.ts). */
  propagated: number;
  stoppedByBudget: boolean;
  cancelled: boolean;
}

/**
 * Enriches every track in a fetched playlist that is not tagged yet, or whose last tagging missed
 * a provider that could not be reached (or all of them with `force`), several at a time. Each track is saved as soon as it is done, so an interrupted run
 * loses nothing.
 */
export async function enrichPlaylist(
  store: Cache,
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

  // What the services could not say about a track, the artist's other tracks here often can.
  const inferred = artistAgreementTags(
    store.playlistTracks(playlistId),
    store.playlistAllTags(playlistId),
  );
  for (const [videoId, tags] of inferred) store.addTags(videoId, tags);

  const remaining = todo.length - enriched;
  return {
    enriched,
    remaining,
    retryLater,
    propagated: inferred.size,
    stoppedByBudget,
    cancelled: remaining > 0 && !stoppedByBudget && Boolean(options.signal?.aborted),
  };
}
