/**
 * The cache, in the browser.
 *
 * `backend/src/db.ts` keeps this in SQLite. Here the whole model lives in memory and is flushed
 * to IndexedDB, because every method the pipeline calls is synchronous and IndexedDB is not.
 * A playlist of a few thousand tracks is a few MB, so holding it all is cheap; only the
 * collections a write touched are re-serialized, and the flush is debounced.
 */
import type {
  Dimension,
  PlannedGroup,
  PlaylistSummary,
  Run,
  RunGroup,
  RunGroupProgress,
  RunItem,
  RunStatus,
  Tag,
  Track,
  TrackTag,
} from "../../backend/src/db.ts";
import {
  type MergeNotes,
  mergeSnapshots,
  SNAPSHOT_VERSION,
  type Snapshot,
  type Syncable,
} from "../../backend/src/sync/snapshot.ts";

const DB_NAME = "sortify";
/** 2 split the single blob-per-collection store into one record per track, tag and lookup. */
const DB_VERSION = 2;
/** The v1 store: one record per collection. Read once on upgrade, then dropped. */
const LEGACY = "records";
const FLUSH_MS = 600;
/** How long to wait for another tab to release an older database before giving up on it. */
const BLOCKED_MS = 3000;
const SEP = "\x00";

/**
 * One IndexedDB object store per collection, each keyed by the record's own id, so a write
 * costs one small `put` instead of re-serialising the collection. `runs` is the exception: the
 * run list, its groups and the id counters are small and always change together, so they stay
 * one record under RUNS_KEY.
 */
const STORES = ["playlists", "tracks", "tags", "cache", "runs", "items"] as const;
type StoreName = (typeof STORES)[number];
const RUNS_KEY = "state";

const now = (): string => new Date().toISOString();

/** A track row; `topics` sits beside the track, as it does in the SQLite schema. */
interface TrackRow extends Track {
  topics: string[] | null;
}

interface PlaylistRow {
  title: string;
  fetchedAt: string;
  /** Video ids in playlist order. */
  items: string[];
}

/** The v1 blob, read once on upgrade. */
interface RunRecord {
  runs: Run[];
  groups: RunGroup[];
  items: [number, RunItem[]][];
  seq: { run: number; group: number };
}

/** Runs, their groups and the id counters: small, and always written together. */
interface RunHeader {
  runs: Run[];
  groups: RunGroup[];
  seq: { run: number; group: number };
}

/** A copy of the collections a transaction can touch, kept so `tx` can undo a failure. */
interface Rollback {
  playlists: Map<string, PlaylistRow>;
  tracks: Map<string, TrackRow>;
  tags: Map<string, Tag[]>;
  runs: Run[];
  groups: RunGroup[];
  items: Map<number, RunItem[]>;
  seq: { run: number; group: number };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Opens the database, or resolves `null` when it cannot be used.
 *
 * It never rejects and never hangs: a page that cannot reach storage still has to render. The
 * case that matters is `blocked` — another tab holding an older version open stops the upgrade,
 * and a promise that simply waits there would leave this page blank for ever.
 */
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (!tx || !db.objectStoreNames.contains(LEGACY)) return;
      // Carry a v1 database across rather than making the user fetch and re-tag everything.
      // The cursor walks the old collection-per-record store; the delete waits until it ends,
      // so it cannot cut the reads short.
      tx.objectStore(LEGACY).openCursor().onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor) {
          db.deleteObjectStore(LEGACY);
          return;
        }
        const name = String(cursor.key);
        if (name === "runs") {
          const legacy = cursor.value as RunRecord;
          tx.objectStore("runs").put(
            { runs: legacy.runs, groups: legacy.groups, seq: legacy.seq },
            RUNS_KEY,
          );
          for (const [id, items] of legacy.items ?? []) {
            tx.objectStore("items").put(items, String(id));
          }
        } else if ((STORES as readonly string[]).includes(name)) {
          for (const [key, value] of (cursor.value as [string, unknown][]) ?? []) {
            tx.objectStore(name).put(value, key);
          }
        }
        cursor.continue();
      };
    };
    req.onsuccess = () => {
      const db = req.result;
      // Yield to a tab that wants to upgrade, instead of blocking it the way we were blocked.
      db.onversionchange = () => db.close();
      finish(db);
    };
    req.onerror = () => finish(null);
    req.onblocked = () => {
      console.warn(
        "Sortify: another tab is holding an older version of the local database open. " +
          "Close it and reload to keep your cached playlists.",
      );
      setTimeout(() => finish(null), BLOCKED_MS);
    };
  });
}

export class BrowserStore implements Syncable {
  private readonly playlists = new Map<string, PlaylistRow>();
  private readonly tracks = new Map<string, TrackRow>();
  private readonly tags = new Map<string, Tag[]>();
  private readonly cache = new Map<string, unknown>();
  private runs: Run[] = [];
  private groups: RunGroup[] = [];
  private readonly items = new Map<number, RunItem[]>();
  private seq = { run: 0, group: 0 };

  /** Keys written since the last flush, per store; a key absent from the model is deleted. */
  /** Called after a write settles, so the owner can ask for a sync. */
  onWrite: (() => void) | undefined;
  private readonly dirty = new Map<StoreName, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inTx = false;

  private constructor(private readonly db: IDBDatabase | null) {}

  /**
   * Opens the database and loads the model. Anything that goes wrong with storage leaves a
   * working memory-only store rather than a page that never renders.
   */
  static async open(): Promise<BrowserStore> {
    let db: IDBDatabase | null = null;
    try {
      db = await idb();
      if (db) {
        const store = new BrowserStore(db);
        await store.load(db);
        store.watchForClose();
        return store;
      }
    } catch (err) {
      console.warn("Sortify: could not read the local database, continuing without it.", err);
      db?.close();
      db = null;
    }
    const store = new BrowserStore(db);
    store.watchForClose();
    return store;
  }

  /** A tab closing mid-debounce would otherwise lose the last few hundred milliseconds. */
  private watchForClose(): void {
    addEventListener("pagehide", () => this.flush());
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush();
    });
  }

  /** Reads every store in one transaction, so startup costs one round trip rather than six. */
  private async load(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(STORES, "readonly");
    const entries = async <V>(name: StoreName): Promise<[string, V][]> => {
      const os = tx.objectStore(name);
      const [keys, values] = await Promise.all([
        request(os.getAllKeys()),
        request(os.getAll() as IDBRequest<V[]>),
      ]);
      return keys.map((k, i) => [String(k), values[i] as V]);
    };
    const [playlists, tracks, tags, cache, runs, items] = await Promise.all([
      entries<PlaylistRow>("playlists"),
      entries<TrackRow>("tracks"),
      entries<Tag[]>("tags"),
      entries<unknown>("cache"),
      entries<RunHeader>("runs"),
      entries<RunItem[]>("items"),
    ]);
    for (const [k, v] of playlists) this.playlists.set(k, v);
    for (const [k, v] of tracks) this.tracks.set(k, v);
    for (const [k, v] of tags) this.tags.set(k, v);
    for (const [k, v] of cache) this.cache.set(k, v);
    for (const [k, v] of items) this.items.set(Number(k), v);
    const header = runs.find(([k]) => k === RUNS_KEY)?.[1];
    if (header) {
      this.runs = header.runs;
      this.groups = header.groups;
      this.seq = header.seq;
    }
  }

  /** Marks one record as needing a write and schedules the flush. */
  private touch(name: StoreName, key: string | number): void {
    let keys = this.dirty.get(name);
    if (!keys) {
      keys = new Set();
      this.dirty.set(name, keys);
    }
    keys.add(String(key));
    this.schedule();
  }

  /** Marks the run list, its groups and the id counters, which always change together. */
  private touchRuns(): void {
    this.touch("runs", RUNS_KEY);
  }

  private schedule(): void {
    if (this.inTx) return;
    this.onWrite?.();
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /**
   * Writes the records changed since the last flush, and only those. A key the model no longer
   * holds is deleted, which is how removed runs and groups leave the database.
   */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.db || this.dirty.size === 0) return;
    const tx = this.db.transaction([...this.dirty.keys()], "readwrite");
    for (const [name, keys] of this.dirty) {
      const os = tx.objectStore(name);
      for (const key of keys) {
        const value = this.record(name, key);
        if (value === undefined) os.delete(key);
        else os.put(value, key);
      }
    }
    this.dirty.clear();
  }

  private record(name: StoreName, key: string): unknown {
    switch (name) {
      case "playlists":
        return this.playlists.get(key);
      case "tracks":
        return this.tracks.get(key);
      case "tags":
        return this.tags.get(key);
      case "cache":
        return this.cache.get(key);
      case "items":
        return this.items.get(Number(key));
      default:
        return { runs: this.runs, groups: this.groups, seq: this.seq };
    }
  }

  /**
   * Runs `fn` as one unit. The collections it can touch are snapshotted first and restored if it
   * throws, so a failed stage cannot leave the model half-written — the guarantee SQLite gives
   * with BEGIN. Every write below replaces objects rather than mutating them, which is what
   * makes a shallow snapshot enough. The lookup cache is left out: `cachePut` is the only writer
   * and it never runs inside a transaction, so copying it per track would be pure waste.
   */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    const snapshot: Rollback = {
      playlists: new Map(this.playlists),
      tracks: new Map(this.tracks),
      tags: new Map(this.tags),
      runs: [...this.runs],
      groups: [...this.groups],
      items: new Map(this.items),
      seq: { ...this.seq },
    };
    this.inTx = true;
    try {
      const result = fn();
      this.inTx = false;
      this.schedule();
      return result;
    } catch (err) {
      this.inTx = false;
      this.restore(snapshot);
      throw err;
    }
  }

  private restore(s: Rollback): void {
    const reset = <K, V>(target: Map<K, V>, from: Map<K, V>): void => {
      target.clear();
      for (const [k, v] of from) target.set(k, v);
    };
    reset(this.playlists, s.playlists);
    reset(this.tracks, s.tracks);
    reset(this.tags, s.tags);
    reset(this.items, s.items);
    this.runs = s.runs;
    this.groups = s.groups;
    this.seq = s.seq;
  }

  // --- playlists and tracks ----------------------------------------------------

  savePlaylist(
    playlistId: string,
    title: string,
    items: { videoId: string; title: string; channel: string }[],
  ): void {
    this.tx(() => {
      this.playlists.set(playlistId, {
        title,
        fetchedAt: now(),
        items: items.map((i) => i.videoId),
      });
      for (const item of items) {
        const existing = this.tracks.get(item.videoId);
        // Title and channel are refreshed; anything already learned about the track is kept.
        this.tracks.set(item.videoId, {
          ...(existing ?? {
            videoId: item.videoId,
            durationS: null,
            artist: null,
            songTitle: null,
            externalIds: {},
            failedProviders: [],
            enrichedAt: null,
            topics: null,
          }),
          title: item.title,
          channel: item.channel,
        });
        this.touch("tracks", item.videoId);
      }
      this.touch("playlists", playlistId);
    });
  }

  getPlaylist(playlistId: string): { playlistId: string; title: string } | undefined {
    const row = this.playlists.get(playlistId);
    return row && { playlistId, title: row.title };
  }

  private trackOf(videoId: string): Track | undefined {
    const row = this.tracks.get(videoId);
    if (!row) return undefined;
    const { topics: _topics, ...track } = row;
    return track;
  }

  playlistTracks(playlistId: string): Track[] {
    const ids = this.playlists.get(playlistId)?.items ?? [];
    return ids.map((id) => this.trackOf(id)).filter((t): t is Track => t !== undefined);
  }

  videoIdsMissingDetails(playlistId: string): string[] {
    const ids = this.playlists.get(playlistId)?.items ?? [];
    return ids.filter((id) => {
      const row = this.tracks.get(id);
      return row !== undefined && (row.durationS === null || row.topics === null);
    });
  }

  trackTopics(videoId: string): string[] {
    return this.tracks.get(videoId)?.topics ?? [];
  }

  setVideoDetails(details: Map<string, { durationS: number | null; topics: string[] }>): void {
    this.tx(() => {
      for (const [videoId, d] of details) {
        const row = this.tracks.get(videoId);
        if (!row) continue;
        this.tracks.set(videoId, { ...row, durationS: d.durationS, topics: d.topics });
        this.touch("tracks", videoId);
      }
    });
  }

  // --- enrichment ---------------------------------------------------------------

  saveEnrichment(
    videoId: string,
    meta: {
      artist: string | null;
      songTitle: string | null;
      externalIds: Record<string, string>;
      failedProviders: string[];
    },
    tags: Tag[],
  ): void {
    this.tx(() => {
      const row = this.tracks.get(videoId);
      if (row) {
        this.tracks.set(videoId, {
          ...row,
          artist: meta.artist,
          songTitle: meta.songTitle,
          externalIds: meta.externalIds,
          failedProviders: meta.failedProviders,
          enrichedAt: now(),
        });
      }
      // One tag per (dimension, value, source), keeping the strongest weight.
      const best = new Map<string, Tag>();
      for (const t of tags) {
        const key = [t.dimension, t.value, t.source].join(SEP);
        const current = best.get(key);
        if (!current || t.weight > current.weight) best.set(key, t);
      }
      this.tags.set(videoId, [...best.values()]);
      this.touch("tracks", videoId);
      this.touch("tags", videoId);
    });
  }

  private tagsIn(playlistId: string): TrackTag[] {
    const ids = this.playlists.get(playlistId)?.items ?? [];
    const out: TrackTag[] = [];
    for (const videoId of ids) {
      for (const t of this.tags.get(videoId) ?? []) out.push({ ...t, videoId });
    }
    return out;
  }

  playlistTags(playlistId: string, dimension: Dimension): TrackTag[] {
    return this.tagsIn(playlistId).filter((t) => t.dimension === dimension);
  }

  playlistAllTags(playlistId: string): TrackTag[] {
    return this.tagsIn(playlistId).sort((a, b) => b.weight - a.weight);
  }

  // --- provider lookup cache ------------------------------------------------------

  cacheGet(source: string, key: string): unknown {
    return this.cache.get(source + SEP + key);
  }

  cachePut(source: string, key: string, body: unknown): void {
    const id = source + SEP + key;
    this.cache.set(id, body);
    this.touch("cache", id);
  }

  // --- runs -------------------------------------------------------------------------

  createRun(
    sourcePlaylistId: string,
    dimension: Dimension,
    minSize: number,
    groups: PlannedGroup[],
  ): number {
    return this.tx(() => {
      const runId = ++this.seq.run;
      this.runs.push({
        runId,
        sourcePlaylistId,
        dimension,
        minSize,
        createdAt: now(),
        status: "planned",
        quotaUsed: 0,
        writesDone: 0,
      });
      for (const group of groups) {
        const groupId = ++this.seq.group;
        this.groups.push({ groupId, runId, name: group.name, targetPlaylistId: null });
        this.items.set(
          groupId,
          group.videoIds.map((videoId, position) => ({
            groupId,
            videoId,
            position,
            written: false,
          })),
        );
        this.touch("items", groupId);
      }
      this.touchRuns();
      return runId;
    });
  }

  getRun(runId: number): Run | undefined {
    return this.runs.find((r) => r.runId === runId);
  }

  listRuns(): Run[] {
    return [...this.runs].sort((a, b) => b.runId - a.runId);
  }

  updateRun(
    runId: number,
    patch: { status?: RunStatus; quotaDelta?: number; writesDelta?: number },
  ): void {
    this.runs = this.runs.map((r) =>
      r.runId === runId
        ? {
            ...r,
            status: patch.status ?? r.status,
            quotaUsed: r.quotaUsed + (patch.quotaDelta ?? 0),
            writesDone: r.writesDone + (patch.writesDelta ?? 0),
          }
        : r,
    );
    this.touchRuns();
  }

  deleteRun(runId: number): void {
    this.tx(() => {
      for (const g of this.groups) {
        if (g.runId !== runId) continue;
        this.items.delete(g.groupId);
        // The key is gone from the model, so the flush deletes its record.
        this.touch("items", g.groupId);
      }
      this.groups = this.groups.filter((g) => g.runId !== runId);
      this.runs = this.runs.filter((r) => r.runId !== runId);
      this.touchRuns();
    });
  }

  runGroups(runId: number): RunGroup[] {
    return this.groups.filter((g) => g.runId === runId).sort((a, b) => a.groupId - b.groupId);
  }

  groupItems(groupId: number): RunItem[] {
    return [...(this.items.get(groupId) ?? [])].sort((a, b) => a.position - b.position);
  }

  setGroupTarget(groupId: number, playlistId: string): void {
    this.groups = this.groups.map((g) =>
      g.groupId === groupId ? { ...g, targetPlaylistId: playlistId } : g,
    );
    this.touchRuns();
  }

  markWritten(groupId: number, videoId: string): void {
    const list = this.items.get(groupId);
    if (!list) return;
    this.items.set(
      groupId,
      list.map((i) => (i.videoId === videoId ? { ...i, written: true } : i)),
    );
    this.touch("items", groupId);
  }

  // --- summaries for the UI ------------------------------------------------------------

  listPlaylists(): PlaylistSummary[] {
    return [...this.playlists.entries()]
      .map(([playlistId, row]) => {
        let enriched = 0;
        let withSubgenre = 0;
        let withMood = 0;
        for (const videoId of row.items) {
          const track = this.tracks.get(videoId);
          // "Enriched" means every provider answered: a pending retry does not count.
          if (track && track.enrichedAt !== null && track.failedProviders.length === 0) enriched++;
          const tags = this.tags.get(videoId) ?? [];
          if (tags.some((t) => t.dimension === "subgenre")) withSubgenre++;
          if (tags.some((t) => t.dimension === "mood")) withMood++;
        }
        return {
          playlistId,
          title: row.title,
          fetchedAt: row.fetchedAt,
          total: row.items.length,
          enriched,
          withSubgenre,
          withMood,
        };
      })
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  }

  runGroupProgress(runId: number): RunGroupProgress[] {
    return this.runGroups(runId).map((g) => {
      const items = this.items.get(g.groupId) ?? [];
      return { ...g, total: items.length, written: items.filter((i) => i.written).length };
    });
  }

  // --- sync ---------------------------------------------------------------------

  /** Everything worth carrying between devices, in the shape both stores agree on. */
  snapshot(): Snapshot {
    return {
      version: SNAPSHOT_VERSION,
      updatedAt: now(),
      playlists: [...this.playlists].map(([playlistId, row]) => ({
        playlistId,
        title: row.title,
        fetchedAt: row.fetchedAt,
        videoIds: row.items,
      })),
      tracks: [...this.tracks.values()],
      tags: [...this.tags].map(([videoId, tags]) => ({ videoId, tags })),
      cache: [...this.cache].map(([id, body]) => {
        const at = id.indexOf(SEP);
        return { source: id.slice(0, at), key: id.slice(at + 1), body };
      }),
      runs: this.runs.map((run) => ({
        ...run,
        groups: this.runGroups(run.runId).map((g) => ({
          groupId: g.groupId,
          name: g.name,
          targetPlaylistId: g.targetPlaylistId,
          items: this.groupItems(g.groupId).map((i) => ({
            videoId: i.videoId,
            position: i.position,
            written: i.written,
          })),
        })),
      })),
      seq: { ...this.seq },
    };
  }

  /** Folds a remote snapshot in, replaces the model with the result, and persists all of it. */
  absorb(remote: Snapshot): MergeNotes {
    // A merge is the store writing to itself. Reporting those writes would schedule another
    // sync, which would merge again, and so on for ever — so the hook is off for the whole of
    // it, not just the last call, and restored even if something throws.
    const notify = this.onWrite;
    this.onWrite = undefined;
    try {
      return this.merge(remote);
    } finally {
      this.onWrite = notify;
    }
  }

  private merge(remote: Snapshot): MergeNotes {
    const { merged, notes } = mergeSnapshots(this.snapshot(), remote);
    this.playlists.clear();
    this.tracks.clear();
    this.tags.clear();
    this.cache.clear();
    this.items.clear();

    for (const p of merged.playlists) {
      this.playlists.set(p.playlistId, {
        title: p.title,
        fetchedAt: p.fetchedAt,
        items: p.videoIds,
      });
      this.touch("playlists", p.playlistId);
    }
    for (const t of merged.tracks) {
      this.tracks.set(t.videoId, t);
      this.touch("tracks", t.videoId);
    }
    for (const entry of merged.tags) {
      this.tags.set(entry.videoId, entry.tags);
      this.touch("tags", entry.videoId);
    }
    for (const c of merged.cache) {
      const id = c.source + SEP + c.key;
      this.cache.set(id, c.body);
      this.touch("cache", id);
    }
    this.runs = merged.runs.map(({ groups: _groups, ...run }) => run);
    this.groups = merged.runs.flatMap((run) =>
      run.groups.map((g) => ({
        groupId: g.groupId,
        runId: run.runId,
        name: g.name,
        targetPlaylistId: g.targetPlaylistId,
      })),
    );
    for (const run of merged.runs) {
      for (const g of run.groups) {
        this.items.set(
          g.groupId,
          g.items.map((i) => ({ ...i, groupId: g.groupId })),
        );
        this.touch("items", g.groupId);
      }
    }
    this.seq = merged.seq;
    this.touchRuns();
    // A merge is rare and the result must survive a close, so do not wait for the debounce.
    this.flush();
    return notes;
  }
}
