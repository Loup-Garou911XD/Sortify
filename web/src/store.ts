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

const DB_NAME = "sortify";
const DB_VERSION = 1;
const RECORDS = "records";
const FLUSH_MS = 600;
const SEP = "\x00";

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

interface RunRecord {
  runs: Run[];
  groups: RunGroup[];
  items: [number, RunItem[]][];
  seq: { run: number; group: number };
}

interface Snapshot {
  playlists: Map<string, PlaylistRow>;
  tracks: Map<string, TrackRow>;
  tags: Map<string, Tag[]>;
  cache: Map<string, unknown>;
  runs: Run[];
  groups: RunGroup[];
  items: Map<number, RunItem[]>;
  seq: { run: number; group: number };
}

type Collection = "playlists" | "tracks" | "tags" | "cache" | "runs";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(RECORDS)) req.result.createObjectStore(RECORDS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

function read<T>(db: IDBDatabase, key: Collection): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(RECORDS, "readonly").objectStore(RECORDS).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export class BrowserStore {
  private readonly playlists = new Map<string, PlaylistRow>();
  private readonly tracks = new Map<string, TrackRow>();
  private readonly tags = new Map<string, Tag[]>();
  private readonly cache = new Map<string, unknown>();
  private runs: Run[] = [];
  private groups: RunGroup[] = [];
  private readonly items = new Map<number, RunItem[]>();
  private seq = { run: 0, group: 0 };

  private readonly dirty = new Set<Collection>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private depth = 0;

  private constructor(private readonly db: IDBDatabase | null) {}

  /** Opens the database and loads the model. Falls back to memory-only if storage is blocked. */
  static async open(): Promise<BrowserStore> {
    let db: IDBDatabase | null = null;
    try {
      db = await idb();
    } catch {
      // Private browsing or blocked storage: the app still runs, it just forgets on reload.
    }
    const store = new BrowserStore(db);
    if (db) await store.load(db);
    // A tab closing mid-debounce would otherwise lose the last few hundred milliseconds.
    addEventListener("pagehide", () => store.flush());
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") store.flush();
    });
    return store;
  }

  private async load(db: IDBDatabase): Promise<void> {
    for (const [k, v] of (await read<[string, PlaylistRow][]>(db, "playlists")) ?? [])
      this.playlists.set(k, v);
    for (const [k, v] of (await read<[string, TrackRow][]>(db, "tracks")) ?? [])
      this.tracks.set(k, v);
    for (const [k, v] of (await read<[string, Tag[]][]>(db, "tags")) ?? []) this.tags.set(k, v);
    for (const [k, v] of (await read<[string, unknown][]>(db, "cache")) ?? []) this.cache.set(k, v);
    const runs = await read<RunRecord>(db, "runs");
    if (runs) {
      this.runs = runs.runs;
      this.groups = runs.groups;
      for (const [k, v] of runs.items) this.items.set(k, v);
      this.seq = runs.seq;
    }
  }

  private touch(...what: Collection[]): void {
    for (const c of what) this.dirty.add(c);
    if (this.depth > 0 || this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Writes every collection changed since the last flush. Safe to call at any time. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.db || this.dirty.size === 0) return;
    const os = this.db.transaction(RECORDS, "readwrite").objectStore(RECORDS);
    for (const c of this.dirty) {
      if (c === "playlists") os.put([...this.playlists], c);
      else if (c === "tracks") os.put([...this.tracks], c);
      else if (c === "tags") os.put([...this.tags], c);
      else if (c === "cache") os.put([...this.cache], c);
      else {
        const record: RunRecord = {
          runs: this.runs,
          groups: this.groups,
          items: [...this.items],
          seq: this.seq,
        };
        os.put(record, c);
      }
    }
    this.dirty.clear();
  }

  /**
   * Runs `fn` as one unit. Collections are snapshotted first and restored if it throws, so a
   * failed stage cannot leave the model half-written — the guarantee SQLite gives with BEGIN.
   * Every write below replaces objects rather than mutating them, which is what makes a
   * shallow snapshot enough.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    const snapshot: Snapshot = {
      playlists: new Map(this.playlists),
      tracks: new Map(this.tracks),
      tags: new Map(this.tags),
      cache: new Map(this.cache),
      runs: [...this.runs],
      groups: [...this.groups],
      items: new Map(this.items),
      seq: { ...this.seq },
    };
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.touch();
      return result;
    } catch (err) {
      this.depth--;
      this.restore(snapshot);
      throw err;
    }
  }

  private restore(s: Snapshot): void {
    const reset = <K, V>(target: Map<K, V>, from: Map<K, V>): void => {
      target.clear();
      for (const [k, v] of from) target.set(k, v);
    };
    reset(this.playlists, s.playlists);
    reset(this.tracks, s.tracks);
    reset(this.tags, s.tags);
    reset(this.cache, s.cache);
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
      }
      this.touch("playlists", "tracks");
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
        if (row) this.tracks.set(videoId, { ...row, durationS: d.durationS, topics: d.topics });
      }
      this.touch("tracks");
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
      this.touch("tracks", "tags");
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
    this.cache.set(source + SEP + key, body);
    this.touch("cache");
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
      }
      this.touch("runs");
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
    this.touch("runs");
  }

  deleteRun(runId: number): void {
    this.tx(() => {
      for (const g of this.groups) if (g.runId === runId) this.items.delete(g.groupId);
      this.groups = this.groups.filter((g) => g.runId !== runId);
      this.runs = this.runs.filter((r) => r.runId !== runId);
      this.touch("runs");
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
    this.touch("runs");
  }

  markWritten(groupId: number, videoId: string): void {
    const list = this.items.get(groupId);
    if (!list) return;
    this.items.set(
      groupId,
      list.map((i) => (i.videoId === videoId ? { ...i, written: true } : i)),
    );
    this.touch("runs");
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
}
