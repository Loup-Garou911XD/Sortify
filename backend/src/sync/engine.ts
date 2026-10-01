/**
 * Keeping one dataset in step across devices.
 *
 * The loop is pull, merge, push. Merging is what makes it safe: a push always sends the result
 * of folding the remote into the local copy, never the local copy alone, so a device cannot
 * overwrite work another device did while it was away.
 *
 * The guard is Drive's `modifiedTime`. If the file changed since the copy this device merged,
 * the push is abandoned and the whole cycle runs again against the newer remote.
 *
 * Drive has no compare-and-swap on file content, so the guard is a check before the write and
 * not an atomic one: a write that lands in the instant between them is overwritten. That costs
 * nothing permanent, because every device keeps its own full copy and every push sends the
 * merge of local and remote — so the overwritten device restores its data on its next sync.
 * It is why a device must keep syncing rather than push once and forget.
 */
import { DriveAuthError, type DriveSnapshots, type RemoteFile } from "./drive.ts";
import type { MergeNotes, Snapshot, Syncable } from "./snapshot.ts";

export type SyncState = "idle" | "syncing" | "offline" | "needs-auth";

export interface SyncResult {
  state: SyncState;
  /** What the last merge changed, when it changed anything. */
  notes?: MergeNotes;
  /** Why syncing is not working, for showing the user. */
  message?: string;
  at: string;
}

/** Pushes are collapsed: a burst of edits costs one upload, not one per edit. */
const DEBOUNCE_MS = 5000;
/** A push that loses the race re-runs the cycle; give up after this many attempts. */
const MAX_ATTEMPTS = 3;

export class SyncEngine {
  private known: RemoteFile | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<SyncResult> | undefined;
  private last: SyncResult = { state: "idle", at: new Date(0).toISOString() };

  private readonly store: Syncable;
  private readonly drive: DriveSnapshots;
  private readonly onChange: ((result: SyncResult) => void) | undefined;

  constructor(store: Syncable, drive: DriveSnapshots, onChange?: (result: SyncResult) => void) {
    this.store = store;
    this.drive = drive;
    this.onChange = onChange;
  }

  status(): SyncResult {
    return this.last;
  }

  /** Runs a full cycle now. Concurrent calls share the one in flight. */
  sync(): Promise<SyncResult> {
    this.running ??= this.cycle().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Asks for a push once the edits stop. Safe to call on every write. */
  schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync();
    }, DEBOUNCE_MS);
  }

  /** Pushes immediately if one is pending, for shutdown and page-hide. */
  async flush(): Promise<void> {
    if (this.timer === undefined && this.last.state !== "syncing") return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.sync();
  }

  private settle(result: Omit<SyncResult, "at">): SyncResult {
    this.last = { ...result, at: new Date().toISOString() };
    this.onChange?.(this.last);
    return this.last;
  }

  private async cycle(): Promise<SyncResult> {
    this.settle({ state: "syncing" });
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const remote = await this.drive.find();
        let notes: MergeNotes | undefined;

        if (remote) {
          // Only merge a copy we have not already folded in; otherwise just push ours.
          if (remote.modifiedTime !== this.known?.modifiedTime) {
            notes = this.store.absorb(await this.drive.download(remote));
          }
          const written = await this.push(remote);
          if (!written) continue; // Someone else wrote first; start again from their copy.
          this.known = written;
        } else {
          this.known = await this.drive.create(this.store.snapshot());
        }
        return this.settle({ state: "idle", ...(notes ? { notes } : {}) });
      }
      return this.settle({
        state: "idle",
        message: "Another device kept changing the data; will try again later.",
      });
    } catch (err) {
      if (err instanceof DriveAuthError) {
        return this.settle({ state: "needs-auth", message: err.message });
      }
      return this.settle({
        state: "offline",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Writes the merged snapshot, unless the remote moved between the merge and now. */
  private async push(seen: RemoteFile): Promise<RemoteFile | undefined> {
    const current = await this.drive.find();
    if (current && current.modifiedTime !== seen.modifiedTime) return undefined;
    return await this.drive.update(seen, this.store.snapshot());
  }
}

/** The snapshot a device sends when it has never synced, kept out of the engine for testing. */
export const firstSnapshot = (store: Syncable): Snapshot => store.snapshot();
