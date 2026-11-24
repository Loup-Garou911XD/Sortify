/**
 * JSON shapes exchanged between the local server (src/server) and the web UI (web/). It imports
 * nothing, so every shell can use it — including the browser build, which cannot load `node:`
 * modules at all.
 */

export type Dimension = "subgenre" | "mood" | "type" | "language" | "decade";
/** Every dimension a tag can have. */
export const DIMENSIONS: readonly Dimension[] = ["subgenre", "mood", "type", "language", "decade"];
/**
 * The dimensions a plan can group by, which is not every dimension: a song type ("Live",
 * "Remix") describes one upload of a song rather than sorting a library, so it stays a tag you
 * can see and search, not a shelf. Plans made when it was one still read back fine.
 */
export const GROUP_BY: readonly Dimension[] = ["subgenre", "mood", "language", "decade"];
/** Where a tag came from: "rule" (title rules) or a provider id (see ProviderStatus). */
export type TagSource = string;
export type RunStatus = "planned" | "applying" | "paused" | "done";
export type Privacy = "private" | "unlisted" | "public";

/** How the last attempt to sync with Google Drive went. Absent when a shell does not sync. */
export interface SyncView {
  state: "idle" | "syncing" | "offline" | "needs-auth";
  /** Why it is not working, when it is not. */
  message: string | null;
  /** When the state was last settled. */
  at: string;
  /** The last merge brought in work from another device, so open pages are stale. */
  changed: boolean;
  /** Set when the last merge moved a run's id or could not take one. */
  renamedRuns: { from: number; to: number; name: string }[];
  conflictedRuns: number[];
  /** What the last merge brought in from other devices; all zero when it changed nothing. */
  brought: {
    playlists: number;
    tracks: number;
    tags: number;
    /** Lookup-cache answers. */
    cache: number;
    runs: number;
    keys: number;
  };
  /** What deletions made on other devices took away here in the last merge. */
  removed: { playlists: number; tracks: number; runs: number };
  /** How much is in the Drive folder; null until this device has synced once. */
  usage: DriveUsage | null;
}

export type DrivePart = "playlists" | "tracks" | "tags" | "cache" | "plans" | "keys" | "other";

/** The sync file in Google Drive: its size, and what makes it up. */
export interface DriveUsage {
  /** Its size in bytes, as Drive reports it (measured here if Drive did not say). */
  bytes: number;
  /**
   * What takes the space, largest first, measured from the copy this device last uploaded.
   * `other` is the file's own bookkeeping: deletions, id counters, the format version.
   */
  parts: { part: DrivePart; count: number; bytes: number }[];
}

export interface StatusResponse {
  version: string;
  hasClientSecrets: boolean;
  /** Why the OAuth client could not be loaded (unset, missing file, invalid JSON). */
  clientSecretsError: string | null;
  signedIn: boolean;
  /** Tagging providers in the order they are asked, from the backend's provider registry. */
  sources: ProviderStatus[];
  dailyQuota: number;
  /** Null when this build does not sync, or when the user is not signed in. */
  sync: SyncView | null;
  /** Null whenever `sync` is: keys travel in the same file. */
  keySync: KeySyncView | null;
  /**
   * Whether this shell can open a group's watch_videos links in YouTube Music (see `musicLink`
   * for why the static build cannot). The UI hides the Music links when it is false.
   */
  opensInMusic: boolean;
}

export interface ProviderStatus {
  id: string;
  label: string;
  /** What it contributes, e.g. "The only mood source". */
  help: string;
  /** Environment variables it needs (API keys); empty when it needs none. */
  envVars: string[];
  configured: boolean;
  /** Its key came from the keys synced through Google Drive rather than this device. */
  fromDrive?: boolean;
}

/** Tag-source keys in the sync file, and whether this device uses them (see sync/keys.ts). */
export interface KeySyncView {
  /** This device's own switch, off by default. */
  enabled: boolean;
  /** Names of the keys currently in the sync file. */
  inDrive: string[];
  /**
   * Turning sync on moves this device's own keys into the sync file (the browser, which can
   * rewrite its keys); otherwise they stay put and are shared explicitly (a server's `.env`).
   */
  keysMovable: boolean;
}

/** One provider's answer to `POST /api/sources/test`: a live lookup that skips the cache. */
export interface SourceTestResult {
  id: string;
  /**
   * `works`: found the test song and gave genres, moods or a year. `limited`: answered, but with
   * nothing usable. `failed`: a rejected key, an outage, a timeout. See `probeProviders`.
   */
  status: "works" | "limited" | "failed";
  message: string;
  ms: number;
}

export interface SourceTestResponse {
  results: SourceTestResult[];
}

/** One of the signed-in user's own YouTube playlists, offered in the sidebar's picker. */
export interface LibraryPlaylist {
  playlistId: string;
  title: string;
  /** Videos in it as YouTube counts them; null when YouTube does not say (Liked videos). */
  count: number | null;
}

/** `GET /api/youtube/playlists`: Liked videos first, then the user's own, in YouTube's order. */
export interface LibraryResponse {
  playlists: LibraryPlaylist[];
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

export interface TrackTagView {
  dimension: Dimension;
  value: string;
  source: TagSource;
  rawTag: string;
  weight: number;
}

export interface TrackView {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
  artist: string | null;
  songTitle: string | null;
  /** Tagged, with every provider answering. */
  enriched: boolean;
  /** Providers that were unreachable last time; the next "Tag" run asks them again. */
  retryProviders: string[];
  tags: TrackTagView[];
}

export interface PlaylistDetail {
  playlist: PlaylistSummary;
  tracks: TrackView[];
}

export interface GroupDraft {
  name: string;
  videoIds: string[];
}

export interface PreviewRequest {
  dimension: Dimension;
  minSize: number;
  maxGroupsPerTrack?: number;
  includeLeftovers: boolean;
}

export interface PreviewResponse {
  groups: GroupDraft[];
  dropped: { name: string; size: number }[];
  tagged: number;
  total: number;
}

export interface CreateRunRequest {
  dimension: Dimension;
  minSize: number;
  groups: GroupDraft[];
}

export interface RunSummary {
  runId: number;
  sourcePlaylistId: string;
  sourceTitle: string;
  dimension: Dimension;
  status: RunStatus;
  createdAt: string;
  quotaUsed: number;
  writesDone: number;
  groupCount: number;
  total: number;
  written: number;
}

export interface RunGroupView {
  groupId: number;
  name: string;
  targetPlaylistId: string | null;
  total: number;
  written: number;
  /** Temporary youtube.com playlists of the group's tracks (no quota; 50 videos per link). */
  watchLinks: string[];
}

export interface RunDetail {
  run: RunSummary;
  groups: RunGroupView[];
  /**
   * Tracks in the source playlist with no tags at all, counted now rather than when the plan was
   * made. The plan page warns about them before anything is written: they are in Unsorted if the
   * plan has that group, and in none of its playlists otherwise.
   */
  untagged: number;
}

export interface EnrichRequest {
  force?: boolean;
  maxApiCalls?: number;
}

export interface ApplyRequest {
  privacy: Privacy;
  maxWrites?: number;
}

export type JobKind = "fetch" | "enrich" | "apply";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobView {
  id: number;
  kind: JobKind;
  label: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number } | null;
  log: string[];
  message: string | null;
  playlistId: string | null;
  runId: number | null;
}

export interface ApiError {
  error: string;
}
