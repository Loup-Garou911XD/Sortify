/**
 * How much of the sync file each kind of data takes, for showing the user what is in their
 * Drive folder. Measured from the snapshot as uploaded, in UTF-8 bytes, which is what Drive
 * stores. Free of `node:` imports: `TextEncoder` exists in both Node and browsers.
 */
import type { DriveUsage } from "../api/types.ts";
import type { Snapshot } from "./snapshot.ts";

const encoder = new TextEncoder();
const size = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * `bytes` is Drive's own figure when it gave one, else the sum of the parts (each part is
 * measured once; the whole file is never serialized again just to be counted).
 */
export function snapshotUsage(snapshot: Snapshot, driveBytes?: number): DriveUsage {
  const { playlists, tracks, tags, cache, runs, keys, deleted, deletedRuns, ...rest } = snapshot;
  const parts: DriveUsage["parts"] = [
    { part: "playlists", count: playlists.length, bytes: size(playlists) },
    { part: "tracks", count: tracks.length, bytes: size(tracks) },
    { part: "tags", count: tags.length, bytes: size(tags) },
    { part: "cache", count: cache.length, bytes: size(cache) },
    { part: "plans", count: runs.length, bytes: size(runs) },
    { part: "keys", count: keys.length, bytes: size(keys) },
    {
      part: "other",
      count: deleted.length + deletedRuns.length,
      bytes: size({ deleted, deletedRuns, ...rest }),
    },
  ];
  return {
    bytes: driveBytes ?? parts.reduce((sum, p) => sum + p.bytes, 0),
    // "[]" is two bytes: an empty part is left out.
    parts: parts.filter((p) => p.bytes > 2).sort((a, b) => b.bytes - a.bytes),
  };
}
