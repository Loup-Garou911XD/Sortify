import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Dimension, TagSource } from "./api/types.ts";

export type { Dimension, TagSource };
export const DIMENSIONS: readonly Dimension[] = ["subgenre", "mood", "type"];

export interface Track {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
  artist: string | null;
  songTitle: string | null;
  /** Provider id → that provider's id for the track, e.g. { musicbrainz: "<MBID>" }. */
  externalIds: Record<string, string>;
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
  t.artist, t.song_title AS songTitle, t.external_ids AS externalIds, t.enriched_at AS enrichedAt`;

const RUN_COLUMNS = `run_id AS runId, source_playlist_id AS sourcePlaylistId, dimension,
  min_size AS minSize, created_at AS createdAt, status, quota_used AS quotaUsed,
  writes_done AS writesDone`;

const now = (): string => new Date().toISOString();

/** Thin typed layer over the SQLite cache. Every stage reads and writes through it. */
export class Store {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

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
    if (columns.has("external_ids")) return;
    // Per-provider id columns became one JSON map, so new providers need no schema change.
    this.tx(() => {
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

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
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
    ).all(playlistId) as unknown as (Omit<Track, "externalIds"> & { externalIds: string | null })[];
    return rows.map((r) => ({ ...r, externalIds: r.externalIds ? JSON.parse(r.externalIds) : {} }));
  }

  videoIdsMissingDuration(playlistId: string): string[] {
    const rows = this.prep(
      `SELECT t.video_id AS videoId FROM tracks t
         JOIN playlist_items p ON p.video_id = t.video_id
         WHERE p.playlist_id = ? AND t.duration_s IS NULL ORDER BY p.position`,
    ).all(playlistId) as { videoId: string }[];
    return rows.map((r) => r.videoId);
  }

  setDurations(durations: Map<string, number>): void {
    this.tx(() => {
      const stmt = this.prep("UPDATE tracks SET duration_s = ? WHERE video_id = ?");
      for (const [videoId, seconds] of durations) stmt.run(seconds, videoId);
    });
  }

  // --- enrichment -------------------------------------------------------------

  saveEnrichment(
    videoId: string,
    meta: {
      artist: string | null;
      songTitle: string | null;
      externalIds: Record<string, string>;
    },
    tags: Tag[],
  ): void {
    this.tx(() => {
      this.prep(
        `UPDATE tracks SET artist = ?, song_title = ?, external_ids = ?, enriched_at = ?
           WHERE video_id = ?`,
      ).run(meta.artist, meta.songTitle, JSON.stringify(meta.externalIds), now(), videoId);
      this.prep("DELETE FROM track_tags WHERE video_id = ?").run(videoId);
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

  cacheGet(source: string, key: string): unknown {
    const row = this.prep("SELECT body FROM lookup_cache WHERE source = ? AND key = ?").get(
      source,
      key,
    ) as { body: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.body);
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
           COALESCE(SUM(t.enriched_at IS NOT NULL), 0) AS enriched,
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

  /** Removes a run and its groups. Callers must only do this for runs never applied. */
  deleteRun(runId: number): void {
    this.tx(() => {
      this.prep(
        "DELETE FROM run_items WHERE group_id IN (SELECT group_id FROM run_groups WHERE run_id = ?)",
      ).run(runId);
      this.prep("DELETE FROM run_groups WHERE run_id = ?").run(runId);
      this.prep("DELETE FROM runs WHERE run_id = ?").run(runId);
    });
  }
}
