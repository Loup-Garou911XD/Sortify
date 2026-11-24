import type { SyncView } from "../api/types.ts";
import type { SyncResult } from "./engine.ts";
import { isQuiet } from "./snapshot.ts";

const NOTHING_BROUGHT: SyncView["brought"] = {
  playlists: 0,
  tracks: 0,
  tags: 0,
  cache: 0,
  runs: 0,
  keys: 0,
};
const NOTHING_REMOVED: SyncView["removed"] = { playlists: 0, tracks: 0, runs: 0 };

/** Flattens the engine's result into the shape the UI polls for. */
export function syncView(result: SyncResult): SyncView {
  return {
    state: result.state,
    message: result.message ?? null,
    at: result.at,
    changed: result.notes !== undefined && !isQuiet(result.notes),
    renamedRuns: result.notes?.renumbered ?? [],
    conflictedRuns: result.notes?.conflicted ?? [],
    brought: { ...NOTHING_BROUGHT, ...result.notes?.added },
    removed: { ...NOTHING_REMOVED, ...result.notes?.removed },
    usage: result.usage ?? null,
  };
}
