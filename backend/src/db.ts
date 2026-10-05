import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DIMENSIONS, type Dimension, type TagSource } from "./api/types.ts";
import { isCachedMiss } from "./enrich/cache.ts";
import {
  type MergeNotes,
  mergeSnapshots,
  SNAPSHOT_VERSION,
  type Snapshot,
  type Syncable,
} from "./sync/snapshot.ts";

export type { Dimension, TagSource };
// Re-exported so callers that already reach for the store keep working.
export { DIMENSIONS };

export interface Track {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
  artist: string | null;
  songTitle: string | null;
  /** Provider id → that provider's id for the track, e.g. { musicbrainz: "<MBID>" }. */
  externalIds: Record<string, string>;
  /** Providers that were unreachable when the track was last tagged; retried on the next run. */
  failedProviders: string[];
  enrichedAt: string | null;
}

export interface Tag {
  dimension: Dimension;
  value: string;
  rawTag: string;
  source: TagSource;
  weight: number;
}

export interface TrackTag extends Tag {
  videoId: string;
}

export type RunStatus = "planned" | "applying" | "paused" | "done";

export interface Run {
  runId: number;
  sourcePlaylistId: string;
  dimension: Dimension;
  minSize: number;
  createdAt: string;
  status: RunStatus;
  quotaUsed: number;
  writesDone: number;
}

export interface RunGroup {
  groupId: number;
  runId: number;
  name: string;
  targetPlaylistId: string | null;
}

export interface RunItem {
  groupId: number;
  videoId: string;
  position: number;
  written: boolean;
}

export interface PlaylistSummary {
  playlistId: string;
  title: string;
  fetchedAt: string;
  total: number;
  enriched: number;
  withSubgenre: number;
  withMood: number;
}

export interface RunGroupProgress extends RunGroup {
  total: number;
  written: number;
}

export interface PlannedGroup {
  name: string;
  videoIds: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  video_id    TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT '',
  duration_s  INTEGER,
  topics      TEXT,
  failed_providers TEXT,
  artist      TEXT,
  song_title  TEXT,
  external_ids TEXT,
  enriched_at TEXT
);
CREATE TABLE IF NOT EXISTS playlists (
  playlist_id TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id TEXT NOT NULL,
  video_id    TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS track_tags (
  video_id  TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value     TEXT NOT NULL,
  raw_tag   TEXT NOT NULL,
  source    TEXT NOT NULL,
  weight    REAL NOT NULL,
  PRIMARY KEY (video_id, dimension, value, source)
);
CREATE TABLE IF NOT EXISTS deleted_playlists (
  playlist_id TEXT PRIMARY KEY,
  deleted_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup_cache (
  source     TEXT NOT NULL,
  key        TEXT NOT NULL,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, key)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_playlist_id TEXT NOT NULL,
  dimension          TEXT NOT NULL,
  min_size           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  status             TEXT NOT NULL,
  quota_used         INTEGER NOT NULL DEFAULT 0,
  writes_done        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run_groups (
  group_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL REFERENCES runs(run_id),
  name               TEXT NOT NULL,
  target_playlist_id TEXT,
  UNIQUE (run_id, name)
);
CREATE TABLE IF NOT EXISTS run_items (
  group_id INTEGER NOT NULL REFERENCES run_groups(group_id),
  video_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  written  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, video_id)
);
`;

const TRACK_COLUMNS = `t.video_id AS videoId, t.title, t.channel, t.duration_s AS durationS,
  t.artist, t.song_title AS songTitle, t.external_ids AS externalIds,
  t.failed_providers AS failedProviders, t.enriched_at AS enrichedAt`;

const RUN_COLUMNS = `run_id AS runId, source_playlist_id AS sourcePlaylistId, dimension,
  min_size AS minSize, created_at AS createdAt, status, quota_used AS quotaUsed,
  writes_done AS writesDone`;

const now = (): string => new Date().toISOString();
/** Stands in for "we do not know when", which is as good as very old. */
const EPOCH = new Date(0).toISOString();

/** Thin typed layer over the SQLite cache. Every stage reads and writes through it. */
/**
 * What every stage outside this file needs from the cache: `Store` minus its SQLite handle and
 * minus syncing, which belongs to `Syncable` and is no business of the pipeline. A mapped type
 * drops private members, so an alternative implementation (the browser app's IndexedDB store)
 * can satisfy this structurally and be typechecked against it.
 */
export type Cache = Omit<Store, "db" | "close" | "snapshot" | "absorb">;

interface GroupRow {
  groupId: number;
  runId: number;
  name: string;
  targetPlaylistId: string | null;
}

interface TrackRow {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
  topics: string | null;
  artist: string | null;
  songTitle: string | null;
  externalIds: string | null;
  failedProviders: string | null;
  enrichedAt: string | null;
}

export class Store implements Syncable {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTx = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // NORMAL is safe with WAL and avoids an fsync on every small cache write.
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    );
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** node:sqlite does not cache prepared statements, so reuse them per SQL string. */
  private prep(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Brings databases created by older versions up to the current schema. */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(tracks)").all() as { name: string }[]).map((c) => c.name),
    );
    const added = ["topics", "failed_providers"].filter((c) => !columns.has(c));
    if (columns.has("external_ids") && added.length === 0) return;
    this.tx(() => {
      for (const c of added) this.db.exec(`ALTER TABLE tracks ADD COLUMN ${c} TEXT`);
      if (columns.has("external_ids")) return;
      // Per-provider id columns became one JSON map, so new providers need no schema change.
      this.db.exec("ALTER TABLE tracks ADD COLUMN external_ids TEXT");
      if (!columns.has("mbid")) return;
      this.db.exec(`
        UPDATE tracks SET external_ids = (
          SELECT json_group_object(k, v) FROM (
            SELECT 'musicbrainz' AS k, mbid AS v WHERE mbid IS NOT NULL
            UNION ALL SELECT 'discogs', discogs_id WHERE discogs_id IS NOT NULL))
        WHERE mbid IS NOT NULL OR discogs_id IS NOT NULL;
        ALTER TABLE tracks DROP COLUMN mbid;
        ALTER TABLE tracks DROP COLUMN discogs_id;`);
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `fn` as one unit. Nesting joins the outer transaction rather than starting a second
   * one, which SQLite does not allow — so a method that already writes atomically can be reused
   * inside another. The browser store behaves the same way.
   */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.db.exec("BEGIN");
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  // --- playlists and tracks -------------------------------------------------

  savePlaylist(
    playlistId: string,
    title: string,
    items: { videoId: string; title: string; channel: string }[],
  ): void {
    this.tx(() => {
      this.prep(
        `INSERT INTO playlists (playlist_id, title, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT (playlist_id) DO UPDATE SET title = excluded.title, fetched_at = excluded.fetched_at`,
      ).run(playlistId, title, now());
      this.prep("DELETE FROM deleted_playlists WHERE playlist_id = ?").run(playlistId);
      this.prep("DELETE FROM playlist_items WHERE playlist_id = ?").run(playlistId);
      const upsertTrack = this.prep(
        `INSERT INTO tracks (video_id, title, channel) VALUES (?, ?, ?)
         ON CONFLICT (video_id) DO UPDATE SET title = excluded.title, channel = excluded.channel`,
      );
      const addItem = this.prep(
        "INSERT OR IGNORE INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)",
      );
      items.forEach((item, position) => {
        upsertTrack.run(item.videoId, item.title, item.channel);
        addItem.run(playlistId, item.videoId, position);
      });
    });
  }

  getPlaylist(playlistId: string): { playlistId: string; title: string } | undefined {
    return this.prep(
      "SELECT playlist_id AS playlistId, title FROM playlists WHERE playlist_id = ?",
    ).get(playlistId) as { playlistId: string; title: string } | undefined;
  }

  playlistTracks(playlistId: string): Track[] {
    const rows = this.prep(
      `SELECT ${TRACK_COLUMNS} FROM tracks t
       JOIN playlist_items p ON p.video_id = t.video_id
       WHERE p.playlist_id = ? ORDER BY p.position`,
    ).all(playlistId) as unknown as (Omit<Track, "externalIds" | "failedProviders"> & {
      externalIds: string | null;
      failedProviders: string | null;
    })[];
    return rows.map((r) => ({
      ...r,
      externalIds: r.externalIds ? JSON.parse(r.externalIds) : {},
      failedProviders: r.failedProviders ? JSON.parse(r.failedProviders) : [],
    }));
  }

  /** Videos whose duration or YouTube topics have not been fetched yet. */
  videoIdsMissingDetails(playlistId: string): string[] {
    const rows = this.prep(
      `SELECT t.video_id AS videoId FROM tracks t
         JOIN playlist_items p ON p.video_id = t.video_id
         WHERE p.playlist_id = ? AND (t.duration_s IS NULL OR t.topics IS NULL)
         ORDER BY p.position`,
    ).all(playlistId) as { videoId: string }[];
    return rows.map((r) => r.videoId);
  }

  /** YouTube's topic labels for a video, e.g. ["Hip hop music", "Music of Asia"]. */
  trackTopics(videoId: string): string[] {
    const row = this.prep("SELECT topics FROM tracks WHERE video_id = ?").get(videoId) as
      | { topics: string | null }
      | undefined;
    return row?.topics ? JSON.parse(row.topics) : [];
  }

  setVideoDetails(details: Map<string, { durationS: number | null; topics: string[] }>): void {
    this.tx(() => {
      const stmt = this.prep("UPDATE tracks SET duration_s = ?, topics = ? WHERE video_id = ?");
      for (const [videoId, d] of details) stmt.run(d.durationS, JSON.stringify(d.topics), videoId);
    });
  }

  // --- enrichment -------------------------------------------------------------

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
      this.prep(
        `UPDATE tracks SET artist = ?, song_title = ?, external_ids = ?, failed_providers = ?,
           enriched_at = ? WHERE video_id = ?`,
      ).run(
        meta.artist,
        meta.songTitle,
        JSON.stringify(meta.externalIds),
        meta.failedProviders.length > 0 ? JSON.stringify(meta.failedProviders) : null,
        now(),
        videoId,
      );
      this.prep("DELETE FROM track_tags WHERE video_id = ?").run(videoId);
      const insert = this.prep(
        `INSERT INTO track_tags (video_id, dimension, value, raw_tag, source, weight)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET weight = max(weight, excluded.weight)`,
      );
      for (const t of tags) insert.run(videoId, t.dimension, t.value, t.rawTag, t.source, t.weight);
    });
  }

  /**
   * Adds tags to a track without touching the ones it has, for a pass that infers rather than
   * looks up (see agreement.ts). The next real tagging of the track rewrites them all.
   */
  addTags(videoId: string, tags: Tag[]): void {
    this.tx(() => {
      const insert = this.prep(
        `INSERT INTO track_tags (video_id, dimension, value, raw_tag, source, weight)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET weight = max(weight, excluded.weight)`,
      );
      for (const t of tags) insert.run(videoId, t.dimension, t.value, t.rawTag, t.source, t.weight);
    });
  }

  playlistTags(playlistId: string, dimension: Dimension): TrackTag[] {
    return this.prep(
      `SELECT g.video_id AS videoId, g.dimension, g.value, g.raw_tag AS rawTag, g.source, g.weight
         FROM track_tags g JOIN playlist_items p ON p.video_id = g.video_id
         WHERE p.playlist_id = ? AND g.dimension = ?`,
    ).all(playlistId, dimension) as unknown as TrackTag[];
  }

  /**
   * The cached value, or undefined when there is none. `missTtlMs` expires cached "no match"
   * answers (see isCachedMiss): a miss older than that reads as absent, so the provider asks
   * again, while a real match is kept for good.
   */
  cacheGet(source: string, key: string, missTtlMs?: number): unknown {
    const row = this.prep(
      "SELECT body, fetched_at AS fetchedAt FROM lookup_cache WHERE source = ? AND key = ?",
    ).get(source, key) as { body: string; fetchedAt: string } | undefined;
    if (row === undefined) return undefined;
    const body: unknown = JSON.parse(row.body);
    if (missTtlMs !== undefined && isCachedMiss(body)) {
      if (Date.parse(row.fetchedAt) + missTtlMs < Date.now()) return undefined;
    }
    return body;
  }

  cachePut(source: string, key: string, body: unknown): void {
    this.prep(
      `INSERT INTO lookup_cache (source, key, body, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source, key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
    ).run(source, key, JSON.stringify(body), now());
  }

  // --- runs -------------------------------------------------------------------

  createRun(
    sourcePlaylistId: string,
    dimension: Dimension,
    minSize: number,
    groups: PlannedGroup[],
  ): number {
    return this.tx(() => {
      const { lastInsertRowid } = this.prep(
        `INSERT INTO runs (source_playlist_id, dimension, min_size, created_at, status)
           VALUES (?, ?, ?, ?, 'planned')`,
      ).run(sourcePlaylistId, dimension, minSize, now());
      const runId = Number(lastInsertRowid);
      const addGroup = this.prep("INSERT INTO run_groups (run_id, name) VALUES (?, ?)");
      const addItem = this.prep(
        "INSERT INTO run_items (group_id, video_id, position) VALUES (?, ?, ?)",
      );
      for (const group of groups) {
        const groupId = Number(addGroup.run(runId, group.name).lastInsertRowid);
        group.videoIds.forEach((videoId, position) => {
          addItem.run(groupId, videoId, position);
        });
      }
      return runId;
    });
  }

  getRun(runId: number): Run | undefined {
    return this.prep(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(runId) as
      | Run
      | undefined;
  }

  listRuns(): Run[] {
    return this.prep(
      `SELECT ${RUN_COLUMNS} FROM runs ORDER BY run_id DESC`,
    ).all() as unknown as Run[];
  }

  updateRun(
    runId: number,
    patch: { status?: RunStatus; quotaDelta?: number; writesDelta?: number },
  ): void {
    this.prep(
      `UPDATE runs SET status = coalesce(?, status), quota_used = quota_used + ?,
         writes_done = writes_done + ? WHERE run_id = ?`,
    ).run(patch.status ?? null, patch.quotaDelta ?? 0, patch.writesDelta ?? 0, runId);
  }

  runGroups(runId: number): RunGroup[] {
    return this.prep(
      `SELECT group_id AS groupId, run_id AS runId, name, target_playlist_id AS targetPlaylistId
         FROM run_groups WHERE run_id = ? ORDER BY group_id`,
    ).all(runId) as unknown as RunGroup[];
  }

  groupItems(groupId: number): RunItem[] {
    const rows = this.prep(
      `SELECT group_id AS groupId, video_id AS videoId, position, written
         FROM run_items WHERE group_id = ? ORDER BY position`,
    ).all(groupId) as { groupId: number; videoId: string; position: number; written: number }[];
    return rows.map((r) => ({ ...r, written: r.written === 1 }));
  }

  setGroupTarget(groupId: number, playlistId: string): void {
    this.prep("UPDATE run_groups SET target_playlist_id = ? WHERE group_id = ?").run(
      playlistId,
      groupId,
    );
  }

  markWritten(groupId: number, videoId: string): void {
    this.prep("UPDATE run_items SET written = 1 WHERE group_id = ? AND video_id = ?").run(
      groupId,
      videoId,
    );
  }

  // --- summaries for the web UI ------------------------------------------------

  listPlaylists(): PlaylistSummary[] {
    return this.prep(
      `SELECT p.playlist_id AS playlistId, p.title, p.fetched_at AS fetchedAt,
           COUNT(i.video_id) AS total,
           COALESCE(SUM(t.enriched_at IS NOT NULL AND t.failed_providers IS NULL), 0) AS enriched,
           COALESCE(SUM(EXISTS (SELECT 1 FROM track_tags g
             WHERE g.video_id = i.video_id AND g.dimension = 'subgenre')), 0) AS withSubgenre,
           COALESCE(SUM(EXISTS (SELECT 1 FROM track_tags g
             WHERE g.video_id = i.video_id AND g.dimension = 'mood')), 0) AS withMood
         FROM playlists p
         LEFT JOIN playlist_items i ON i.playlist_id = p.playlist_id
         LEFT JOIN tracks t ON t.video_id = i.video_id
         GROUP BY p.playlist_id
         ORDER BY p.fetched_at DESC`,
    ).all() as unknown as PlaylistSummary[];
  }

  playlistAllTags(playlistId: string): TrackTag[] {
    return this.prep(
      `SELECT g.video_id AS videoId, g.dimension, g.value, g.raw_tag AS rawTag, g.source, g.weight
         FROM track_tags g JOIN playlist_items p ON p.video_id = g.video_id
         WHERE p.playlist_id = ?
         ORDER BY g.weight DESC`,
    ).all(playlistId) as unknown as TrackTag[];
  }

  runGroupProgress(runId: number): RunGroupProgress[] {
    return this.prep(
      `SELECT g.group_id AS groupId, g.run_id AS runId, g.name,
           g.target_playlist_id AS targetPlaylistId,
           COUNT(i.video_id) AS total, COALESCE(SUM(i.written), 0) AS written
         FROM run_groups g LEFT JOIN run_items i ON i.group_id = g.group_id
         WHERE g.run_id = ?
         GROUP BY g.group_id
         ORDER BY g.group_id`,
    ).all(runId) as unknown as RunGroupProgress[];
  }

  /** Removes a run and its groups from the cache; playlists it created on YouTube are left alone. */
  /**
   * Forgets a playlist: its membership, any plans made from it, and the tracks it was the last
   * one holding, along with their tags. Tracks shared with another playlist stay, and so does
   * the provider lookup cache, which is keyed by artist and title and stays useful. Playlists
   * already created on YouTube are untouched.
   */
  deletePlaylist(playlistId: string): void {
    this.tx(() => {
      for (const run of this.listRuns()) {
        if (run.sourcePlaylistId === playlistId) this.deleteRun(run.runId);
      }
      this.prep("DELETE FROM playlist_items WHERE playlist_id = ?").run(playlistId);
      this.prep("DELETE FROM playlists WHERE playlist_id = ?").run(playlistId);
      // Remembered so syncing does not hand the playlist back from a device that still has it.
      this.prep(
        `INSERT INTO deleted_playlists (playlist_id, deleted_at) VALUES (?, ?)
           ON CONFLICT (playlist_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      ).run(playlistId, now());
      const orphans =
        "SELECT video_id FROM tracks WHERE video_id NOT IN (SELECT video_id FROM playlist_items)";
      this.prep(`DELETE FROM track_tags WHERE video_id IN (${orphans})`).run();
      this.prep(`DELETE FROM tracks WHERE video_id IN (${orphans})`).run();
    });
  }

  deleteRun(runId: number): void {
    this.tx(() => {
      this.prep(
        "DELETE FROM run_items WHERE group_id IN (SELECT group_id FROM run_groups WHERE run_id = ?)",
      ).run(runId);
      this.prep("DELETE FROM run_groups WHERE run_id = ?").run(runId);
      this.prep("DELETE FROM runs WHERE run_id = ?").run(runId);
    });
  }

  // --- sync ---------------------------------------------------------------------

  /** Everything worth carrying between devices, in the shape both stores agree on. */
  snapshot(): Snapshot {
    const rows = <T>(sql: string): T[] => this.prep(sql).all() as unknown as T[];
    const items = new Map<number, { videoId: string; position: number; written: boolean }[]>();
    for (const r of rows<{ groupId: number; videoId: string; position: number; written: number }>(
      "SELECT group_id AS groupId, video_id AS videoId, position, written FROM run_items ORDER BY position",
    )) {
      const list = items.get(r.groupId) ?? [];
      list.push({ videoId: r.videoId, position: r.position, written: r.written === 1 });
      items.set(r.groupId, list);
    }
    const groups = new Map<number, GroupRow[]>();
    for (const g of rows<GroupRow>(
      "SELECT group_id AS groupId, run_id AS runId, name, target_playlist_id AS targetPlaylistId FROM run_groups ORDER BY group_id",
    )) {
      groups.set(g.runId, [...(groups.get(g.runId) ?? []), g]);
    }
    const members = new Map<string, string[]>();
    for (const r of rows<{ playlistId: string; videoId: string }>(
      "SELECT playlist_id AS playlistId, video_id AS videoId FROM playlist_items ORDER BY position",
    )) {
      members.set(r.playlistId, [...(members.get(r.playlistId) ?? []), r.videoId]);
    }
    const tags = new Map<string, Tag[]>();
    for (const t of rows<TrackTag>(
      "SELECT video_id AS videoId, dimension, value, raw_tag AS rawTag, source, weight FROM track_tags",
    )) {
      const { videoId, ...tag } = t;
      tags.set(videoId, [...(tags.get(videoId) ?? []), tag]);
    }

    // AUTOINCREMENT remembers the highest id ever handed out, even for deleted rows, so a
    // merged-in run can never be given an id this database has already used.
    const highest = (table: string, column: string): number => {
      const seq = this.prep("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as
        | { seq: number }
        | undefined;
      const max = this.prep(`SELECT COALESCE(MAX(${column}), 0) AS n FROM ${table}`).get() as {
        n: number;
      };
      return Math.max(seq?.seq ?? 0, max.n);
    };

    return {
      version: SNAPSHOT_VERSION,
      updatedAt: now(),
      playlists: rows<{ playlistId: string; title: string; fetchedAt: string }>(
        "SELECT playlist_id AS playlistId, title, fetched_at AS fetchedAt FROM playlists",
      ).map((p) => ({ ...p, videoIds: members.get(p.playlistId) ?? [] })),
      tracks: rows<TrackRow>(
        `SELECT video_id AS videoId, title, channel, duration_s AS durationS, topics,
                artist, song_title AS songTitle, external_ids AS externalIds,
                failed_providers AS failedProviders, enriched_at AS enrichedAt FROM tracks`,
      ).map((t) => ({
        videoId: t.videoId,
        title: t.title,
        channel: t.channel,
        durationS: t.durationS,
        topics: t.topics ? (JSON.parse(t.topics) as string[]) : null,
        artist: t.artist,
        songTitle: t.songTitle,
        externalIds: t.externalIds ? (JSON.parse(t.externalIds) as Record<string, string>) : {},
        failedProviders: t.failedProviders ? (JSON.parse(t.failedProviders) as string[]) : [],
        enrichedAt: t.enrichedAt,
      })),
      tags: [...tags].map(([videoId, list]) => ({ videoId, tags: list })),
      cache: rows<{ source: string; key: string; body: string; fetchedAt: string }>(
        "SELECT source, key, body, fetched_at AS fetchedAt FROM lookup_cache",
      ).map((c) => ({
        source: c.source,
        key: c.key,
        body: JSON.parse(c.body) as unknown,
        fetchedAt: c.fetchedAt,
      })),
      deleted: rows<{ playlistId: string; at: string }>(
        "SELECT playlist_id AS playlistId, deleted_at AS at FROM deleted_playlists",
      ),
      runs: this.listRuns().map((run) => ({
        ...run,
        groups: (groups.get(run.runId) ?? []).map((g) => ({
          groupId: g.groupId,
          name: g.name,
          targetPlaylistId: g.targetPlaylistId,
          items: items.get(g.groupId) ?? [],
        })),
      })),
      seq: { run: highest("runs", "run_id"), group: highest("run_groups", "group_id") },
    };
  }

  /** Folds a remote snapshot in and writes the result back as one transaction. */
  absorb(remote: Snapshot): MergeNotes {
    const { merged, notes } = mergeSnapshots(this.snapshot(), remote);
    this.tx(() => {
      for (const table of [
        "run_items",
        "run_groups",
        "runs",
        "playlist_items",
        "track_tags",
        "tracks",
        "playlists",
        "lookup_cache",
        "deleted_playlists",
      ]) {
        this.prep(`DELETE FROM ${table}`).run();
      }
      const track = this.prep(
        `INSERT INTO tracks (video_id, title, channel, duration_s, topics, artist, song_title,
           external_ids, failed_providers, enriched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of merged.tracks) {
        track.run(
          t.videoId,
          t.title,
          t.channel,
          t.durationS,
          t.topics === null ? null : JSON.stringify(t.topics),
          t.artist,
          t.songTitle,
          JSON.stringify(t.externalIds),
          t.failedProviders.length > 0 ? JSON.stringify(t.failedProviders) : null,
          t.enrichedAt,
        );
      }
      const playlist = this.prep(
        "INSERT INTO playlists (playlist_id, title, fetched_at) VALUES (?, ?, ?)",
      );
      const member = this.prep(
        "INSERT INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)",
      );
      for (const p of merged.playlists) {
        playlist.run(p.playlistId, p.title, p.fetchedAt);
        p.videoIds.forEach((videoId, position) => {
          member.run(p.playlistId, videoId, position);
        });
      }
      const tag = this.prep(
        `INSERT INTO track_tags (video_id, dimension, value, raw_tag, source, weight)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const entry of merged.tags) {
        for (const t of entry.tags) {
          tag.run(entry.videoId, t.dimension, t.value, t.rawTag, t.source, t.weight);
        }
      }
      const cache = this.prep(
        "INSERT INTO lookup_cache (source, key, body, fetched_at) VALUES (?, ?, ?, ?)",
      );
      for (const c of merged.cache) {
        // An entry from a device that did not carry the time keeps its own age: "long ago", so a
        // cached "no match" in it is asked once more rather than standing for ever.
        cache.run(c.source, c.key, JSON.stringify(c.body), c.fetchedAt ?? EPOCH);
      }
      const grave = this.prep(
        "INSERT INTO deleted_playlists (playlist_id, deleted_at) VALUES (?, ?)",
      );
      for (const t of merged.deleted) grave.run(t.playlistId, t.at);
      const run = this.prep(
        `INSERT INTO runs (run_id, source_playlist_id, dimension, min_size, created_at, status,
           quota_used, writes_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const group = this.prep(
        "INSERT INTO run_groups (group_id, run_id, name, target_playlist_id) VALUES (?, ?, ?, ?)",
      );
      const item = this.prep(
        "INSERT INTO run_items (group_id, video_id, position, written) VALUES (?, ?, ?, ?)",
      );
      for (const r of merged.runs) {
        run.run(
          r.runId,
          r.sourcePlaylistId,
          r.dimension,
          r.minSize,
          r.createdAt,
          r.status,
          r.quotaUsed,
          r.writesDone,
        );
        for (const g of r.groups) {
          group.run(g.groupId, r.runId, g.name, g.targetPlaylistId);
          for (const i of g.items) item.run(g.groupId, i.videoId, i.position, i.written ? 1 : 0);
        }
      }
      // Keep AUTOINCREMENT past every id the merge settled on, including renumbered ones and
      // ids whose rows have since been deleted. sqlite_sequence has no unique key, so this is
      // an update-or-insert rather than an upsert.
      const hasSeq = this.prep("SELECT 1 AS present FROM sqlite_sequence WHERE name = ?");
      const raiseSeq = this.prep("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?");
      const addSeq = this.prep("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
      const bump = (table: string, value: number): void => {
        if (value <= 0) return;
        if (hasSeq.get(table)) raiseSeq.run(value, table);
        else addSeq.run(table, value);
      };
      bump("runs", merged.seq.run);
      bump("run_groups", merged.seq.group);
    });
    return notes;
  }
}
