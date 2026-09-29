/**
 * JSON shapes exchanged between the local server (src/server) and the web UI (web/). Kept free of
 * runtime imports so the browser bundle can import it for types only.
 */

export type Dimension = "subgenre" | "mood" | "type";
export type TagSource = "rule" | "musicbrainz" | "discogs" | "lastfm";
export type RunStatus = "planned" | "applying" | "paused" | "done";
export type Privacy = "private" | "unlisted" | "public";

export interface StatusResponse {
  version: string;
  hasClientSecrets: boolean;
  /** Why the OAuth client could not be loaded (unset, missing file, invalid JSON). */
  clientSecretsError: string | null;
  signedIn: boolean;
  sources: { musicbrainz: boolean; discogs: boolean; lastfm: boolean };
  dailyQuota: number;
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
  enriched: boolean;
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
