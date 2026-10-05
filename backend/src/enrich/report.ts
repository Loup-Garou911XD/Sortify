// DIMENSIONS comes from api/types.ts rather than db.ts, which would pull in node:sqlite.
import { DIMENSIONS } from "../api/types.ts";
import type { Cache, Dimension } from "../db.ts";
import { normalizeTag, type RawTag } from "../tagging/mapper.ts";
import { type Enrichers, enrichTrack } from "./pipeline.ts";

export interface DimensionCoverage {
  dimension: Dimension;
  /** Tracks with at least one tag in this dimension. */
  tracks: number;
  /** Distinct values, i.e. how many playlists a plan could make. */
  values: number;
}

export interface SourceCoverage {
  source: string;
  /** Tracks this source gave at least one tag for. */
  tracks: number;
  tags: number;
}

export interface UnmappedTag {
  /** The tag as the service wrote it, in the most common spelling seen. */
  tag: string;
  sources: string[];
  /** Tracks it was offered for. */
  tracks: number;
}

export interface TagReport {
  total: number;
  /** Tracks whose title gave no artist and song name, so the services could not be asked. */
  unparsed: number;
  /**
   * Tracks no service had an answer cached for: either they have not been asked yet, or they were
   * asked and nothing matched. Both mean the tag map cannot help them.
   */
  unanswered: number;
  dimensions: DimensionCoverage[];
  sources: SourceCoverage[];
  /** The raw tags the tag map drops, most offered first. */
  unmapped: UnmappedTag[];
}

/** How many unmapped tags are worth listing; the tail is one-offs. */
const TOP_UNMAPPED = 40;

/**
 * Re-tags a playlist from the lookup cache alone and reports what came of it: how far each
 * dimension reaches, which source carries it, and the raw tags the tag map is throwing away.
 *
 * Nothing is written and no request is made (the providers must be built with `offline`), so it
 * is safe to run at any time. That also means it only knows what the services have already been
 * asked: a track nothing is cached for counts under `unanswered`.
 */
export async function tagReport(
  store: Cache,
  playlistId: string,
  enrichers: Enrichers,
): Promise<TagReport> {
  const tracks = store.playlistTracks(playlistId);
  const raw = new Map<string, RawTag[]>();
  const report: TagReport = {
    total: tracks.length,
    unparsed: 0,
    unanswered: 0,
    dimensions: [],
    sources: [],
    unmapped: [],
  };

  const dimensionTracks = new Map<Dimension, Set<string>>();
  const dimensionValues = new Map<Dimension, Set<string>>();
  const sourceTracks = new Map<string, Set<string>>();
  const sourceTags = new Map<string, number>();

  for (const track of tracks) {
    const { meta, tags } = await enrichTrack(track, {
      ...enrichers,
      onRawTags: (videoId, tags) => raw.set(videoId, tags),
    });
    if (!meta.artist || !meta.songTitle) report.unparsed++;
    for (const tag of tags) {
      add(dimensionTracks, tag.dimension, track.videoId);
      add(dimensionValues, tag.dimension, tag.value);
      add(sourceTracks, tag.source, track.videoId);
      sourceTags.set(tag.source, (sourceTags.get(tag.source) ?? 0) + 1);
    }
  }

  report.dimensions = DIMENSIONS.map((dimension) => ({
    dimension,
    tracks: dimensionTracks.get(dimension)?.size ?? 0,
    values: dimensionValues.get(dimension)?.size ?? 0,
  }));
  report.sources = [...sourceTags]
    .map(([source, tags]) => ({ source, tracks: sourceTracks.get(source)?.size ?? 0, tags }))
    .sort((a, b) => b.tracks - a.tracks || a.source.localeCompare(b.source));
  // Tags that cost no request (YouTube's topic labels) say nothing about the cache.
  const free = new Set(enrichers.clients.filter((c) => c.videoOnly).map((c) => c.id));
  report.unanswered = tracks.filter(
    (t) => !(raw.get(t.videoId) ?? []).some((r) => !free.has(r.source)),
  ).length;
  report.unmapped = unmappedTags(raw, enrichers);
  return report;
}

/**
 * The raw tags the map has no label for, grouped by their normalized form (so "Hip-Hop" and
 * "hip hop" count as one) and ranked by how many tracks they were offered for.
 */
function unmappedTags(raw: Map<string, RawTag[]>, enrichers: Enrichers): UnmappedTag[] {
  const groups = new Map<
    string,
    { spellings: Map<string, number>; sources: Set<string>; tracks: Set<string> }
  >();
  for (const [videoId, tags] of raw) {
    for (const tag of tags) {
      if (enrichers.mapper.maps(tag.tag)) continue;
      const normalized = normalizeTag(tag.tag);
      if (!normalized) continue;
      const group = groups.get(normalized) ?? {
        spellings: new Map<string, number>(),
        sources: new Set<string>(),
        tracks: new Set<string>(),
      };
      group.spellings.set(tag.tag, (group.spellings.get(tag.tag) ?? 0) + 1);
      group.sources.add(tag.source);
      group.tracks.add(videoId);
      groups.set(normalized, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      tag: [...group.spellings].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
      sources: [...group.sources].sort(),
      tracks: group.tracks.size,
    }))
    .sort((a, b) => b.tracks - a.tracks || a.tag.localeCompare(b.tag))
    .slice(0, TOP_UNMAPPED);
}

function add<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  const set = index.get(key) ?? new Set<V>();
  set.add(value);
  index.set(key, set);
}
