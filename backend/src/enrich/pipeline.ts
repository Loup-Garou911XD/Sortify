import type { Store, Tag, Track } from "../db.ts";
import type { RawTag, TagMapper } from "../tagging/mapper.ts";
import type { Discogs } from "./discogs.ts";
import type { LastFm } from "./lastfm.ts";
import { BudgetExhaustedError } from "./lookup.ts";
import type { MusicBrainz } from "./musicbrainz.ts";
import { detectSongTypes } from "./songType.ts";
import { parseTitle } from "./titleParser.ts";

export interface Enrichers {
  mapper: TagMapper;
  musicbrainz?: MusicBrainz;
  discogs?: Discogs;
  lastfm?: LastFm;
}

export interface EnrichedTrack {
  meta: {
    artist: string | null;
    songTitle: string | null;
    mbid: string | null;
    discogsId: string | null;
  };
  tags: Tag[];
}

/** Last.fm tags below this relative weight (0–100) are mostly noise from a handful of users. */
const LASTFM_MIN_COUNT = 10;
/** MusicBrainz tags carry vote counts rather than weights; trust them a little below Discogs. */
const MUSICBRAINZ_WEIGHT = 0.8;
/** Artist-level tags describe the artist, not the track, so they only count as a weak fallback. */
const ARTIST_TAG_FACTOR = 0.5;

export async function enrichTrack(track: Track, enrichers: Enrichers): Promise<EnrichedTrack> {
  const parsed = parseTitle(track.title, track.channel);
  const tags: Tag[] = detectSongTypes(track.title, parsed.hints);
  const meta: EnrichedTrack["meta"] = {
    artist: parsed.artist,
    songTitle: parsed.songTitle,
    mbid: null,
    discogsId: null,
  };
  if (!parsed.artist || !parsed.songTitle) return { meta, tags };

  let artist = parsed.artist;
  let title = parsed.songTitle;
  const genreRaw: RawTag[] = [];

  const recording = await enrichers.musicbrainz?.findRecording(artist, title);
  if (recording) {
    // MusicBrainz spelling makes the Discogs and Last.fm searches more accurate.
    artist = recording.artist;
    title = recording.title;
    meta.mbid = recording.mbid;
    for (const t of recording.tags) {
      genreRaw.push({ tag: t.name, source: "musicbrainz", weight: MUSICBRAINZ_WEIGHT });
    }
  }
  meta.artist = artist;
  meta.songTitle = title;

  const discogs = await enrichers.discogs?.findStyles(artist, title);
  if (discogs) {
    meta.discogsId = discogs.id;
    for (const tag of [...discogs.styles, ...discogs.genres]) {
      genreRaw.push({ tag, source: "discogs", weight: 1 });
    }
  }

  const lastfmTags = ((await enrichers.lastfm?.trackTags(artist, title)) ?? [])
    .filter((t) => t.count >= LASTFM_MIN_COUNT)
    .map((t): RawTag => ({ tag: t.name, source: "lastfm", weight: t.count / 100 }));
  genreRaw.push(...lastfmTags);

  let genres = enrichers.mapper.genres(genreRaw);
  if (genres.length === 0 && enrichers.lastfm) {
    const artistTags = (await enrichers.lastfm.artistTags(artist))
      .filter((t) => t.count >= LASTFM_MIN_COUNT)
      .map(
        (t): RawTag => ({
          tag: t.name,
          source: "lastfm",
          weight: (t.count / 100) * ARTIST_TAG_FACTOR,
        }),
      );
    genres = enrichers.mapper.genres(artistTags);
  }

  tags.push(...genres, ...enrichers.mapper.moodTags(lastfmTags));
  return { meta, tags };
}

export interface EnrichSummary {
  enriched: number;
  remaining: number;
  stoppedByBudget: boolean;
  cancelled: boolean;
}

/**
 * Enriches every track in a fetched playlist that has not been enriched yet (or all of them with
 * `force`). Each track is saved as soon as it is done, so an interrupted run loses nothing.
 */
export async function enrichPlaylist(
  store: Store,
  playlistId: string,
  enrichers: Enrichers,
  options: {
    force?: boolean;
    onProgress?: (done: number, total: number, track: Track) => void;
    /** Checked between tracks; already enriched tracks stay saved. */
    signal?: AbortSignal;
  } = {},
): Promise<EnrichSummary> {
  const todo = store
    .playlistTracks(playlistId)
    .filter((t) => options.force || t.enrichedAt === null);
  let enriched = 0;
  for (const track of todo) {
    if (options.signal?.aborted) {
      return {
        enriched,
        remaining: todo.length - enriched,
        stoppedByBudget: false,
        cancelled: true,
      };
    }
    try {
      const result = await enrichTrack(track, enrichers);
      store.saveEnrichment(track.videoId, result.meta, result.tags);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return {
          enriched,
          remaining: todo.length - enriched,
          stoppedByBudget: true,
          cancelled: false,
        };
      }
      throw err;
    }
    enriched++;
    options.onProgress?.(enriched, todo.length, track);
  }
  return { enriched, remaining: 0, stoppedByBudget: false, cancelled: false };
}
