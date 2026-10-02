/**
 * JSON shapes exchanged between the local server (src/server) and the web UI (web/). It imports
 * nothing, so every shell can use it — including the browser build, which cannot load `node:`
 * modules at all.
 */

export type Dimension = "subgenre" | "mood" | "type";
/** Every dimension, for validating input and listing choices. */
export const DIMENSIONS: readonly Dimension[] = ["subgenre", "mood", "type"];
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
  /**
   * Whether this shell can turn a watch_videos link into a YouTube Music one. Reading YouTube's
   * redirect needs something that is not a browser, so the static build cannot, and hides the
   * YouTube Music links rather than offering one that could never work.
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
