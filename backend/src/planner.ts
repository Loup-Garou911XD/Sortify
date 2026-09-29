import type { Dimension, PlannedGroup, Track, TrackTag } from "./db.ts";
import { QUOTA_COST } from "./youtube/client.ts";

export const UNSORTED = "Unsorted";
export const OTHER = "Other";

export interface PlanOptions {
  dimension: Dimension;
  /** Groups smaller than this are dropped; their tracks fall back to "Other". */
  minSize: number;
  /** Keep only a track's strongest N groups, to save write quota. */
  maxGroupsPerTrack?: number;
  /** Add "Other" and "Unsorted" playlists for tracks left without a group. */
  includeLeftovers: boolean;
}

export interface Plan {
  groups: PlannedGroup[];
  dropped: { name: string; size: number }[];
  /** Tracks with at least one tag for this dimension. */
  tagged: number;
  total: number;
}

/**
 * Puts each track into every group it has a tag for (strongest first, optionally capped), keeping
 * playlist order inside each group. Tracks with no tag go to "Unsorted"; tracks whose only
 * groups were too small go to "Other".
 */
export function planGroups(tracks: Track[], tags: TrackTag[], options: PlanOptions): Plan {
  const weights = new Map<string, Map<string, number>>();
  for (const tag of tags) {
    if (tag.dimension !== options.dimension) continue;
    const byValue = weights.get(tag.videoId) ?? new Map<string, number>();
    // Sources agreeing on a label strengthen it.
    byValue.set(tag.value, (byValue.get(tag.value) ?? 0) + tag.weight);
    weights.set(tag.videoId, byValue);
  }

  const chosen = new Map<string, string[]>();
  for (const track of tracks) {
    const ranked = [...(weights.get(track.videoId) ?? new Map<string, number>())]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value]) => value);
    chosen.set(track.videoId, ranked.slice(0, options.maxGroupsPerTrack ?? ranked.length));
  }

  const members = new Map<string, string[]>();
  for (const track of tracks) {
    for (const value of chosen.get(track.videoId) ?? []) {
      const list = members.get(value) ?? [];
      list.push(track.videoId);
      members.set(value, list);
    }
  }

  const dropped: Plan["dropped"] = [];
  const kept = new Set<string>();
  for (const [name, ids] of members) {
    if (ids.length >= options.minSize) kept.add(name);
    else dropped.push({ name, size: ids.length });
  }

  const other: string[] = [];
  const unsorted: string[] = [];
  for (const track of tracks) {
    const values = chosen.get(track.videoId) ?? [];
    if (values.length === 0) unsorted.push(track.videoId);
    else if (!values.some((v) => kept.has(v))) other.push(track.videoId);
  }

  const groups: PlannedGroup[] = [...kept]
    .map((name) => ({ name, videoIds: members.get(name) ?? [] }))
    .sort((a, b) => b.videoIds.length - a.videoIds.length || a.name.localeCompare(b.name));
  if (options.includeLeftovers) {
    if (other.length > 0) groups.push({ name: OTHER, videoIds: other });
    if (unsorted.length > 0) groups.push({ name: UNSORTED, videoIds: unsorted });
  }

  dropped.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return { groups, dropped, tagged: tracks.length - unsorted.length, total: tracks.length };
}

export interface QuotaEstimate {
  playlists: number;
  additions: number;
  units: number;
  days: number;
}

/** Write cost of applying a plan: one insert per playlist plus one per track added. */
export function estimateQuota(groups: PlannedGroup[], dailyQuota: number): QuotaEstimate {
  const playlists = groups.length;
  const additions = groups.reduce((sum, g) => sum + g.videoIds.length, 0);
  const units = (playlists + additions) * QUOTA_COST.insert;
  return { playlists, additions, units, days: Math.ceil(units / dailyQuota) };
}
