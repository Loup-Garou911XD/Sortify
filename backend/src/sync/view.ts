import type { SyncView } from "../api/types.ts";
import type { SyncResult } from "./engine.ts";
import { isQuiet } from "./snapshot.ts";

/** Flattens the engine's result into the shape the UI polls for. */
export function syncView(result: SyncResult): SyncView {
  return {
    state: result.state,
    message: result.message ?? null,
    at: result.at,
    changed: result.notes !== undefined && !isQuiet(result.notes),
    renamedRuns: result.notes?.renumbered ?? [],
    conflictedRuns: result.notes?.conflicted ?? [],
  };
}
