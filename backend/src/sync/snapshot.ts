/**
 * The shape Sortify syncs, and the rules for merging two copies of it.
 *
 * Both shells keep the same data in different places — SQLite behind `sortify ui` and the CLI,
 * IndexedDB in the static build — so the thing that travels between them is this plain snapshot.
 * It is free of `node:` imports and of any store detail, so the browser bundle can use it.
 *
 * Merging is per record rather than per file: tagging done on one device and a plan saved on
 * another both survive, because they touch different keys. The one place that needs care is run
 * ids, which are local counters on both sides and so collide; see `mergeRuns`.
 */
import type { Dimension, RunStatus, Tag } from "../db.ts";

export const SNAPSHOT_VERSION = 1;

/**
 * A store that can be synced. Both implementations provide it: SQLite behind the CLI and
 * `sortify ui`, IndexedDB in the static build. The sync engine knows nothing else about them.
 */
export interface Syncable {
  /** Everything worth carrying between devices. */
  snapshot(): Snapshot;
  /** Folds a remote snapshot in and keeps the result, reporting what diverged. */
  absorb(remote: Snapshot): MergeNotes;
}

export interface PlaylistSnapshot {
  playlistId: string;
  title: string;
  fetchedAt: string;
  /** Video ids in playlist order. */
  videoIds: string[];
}

export interface TrackSnapshot {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
  /** YouTube's topic labels; null until `videoDetails` has been asked. */
  topics: string[] | null;
  artist: string | null;
  songTitle: string | null;
  externalIds: Record<string, string>;
  failedProviders: string[];
  enrichedAt: string | null;
}

export interface TagSnapshot {
  videoId: string;
  tags: Tag[];
}

export interface CacheSnapshot {
  source: string;
  key: string;
  body: unknown;
  /**
   * When the answer was received. Absent on a snapshot from a device that predates this field,
   * which reads as "long ago" and so lets a cached "no match" be asked once more (a match is
   * kept whatever its age; see isCachedMiss).
   */
  fetchedAt?: string;
}

export interface GroupSnapshot {
  groupId: number;
  name: string;
  targetPlaylistId: string | null;
  items: { videoId: string; position: number; written: boolean }[];
}

/** A run carries its groups, so renumbering one is a self-contained rewrite. */
export interface RunSnapshot {
  runId: number;
  sourcePlaylistId: string;
  dimension: Dimension;
  minSize: number;
  createdAt: string;
  status: RunStatus;
  quotaUsed: number;
  writesDone: number;
  groups: GroupSnapshot[];
}

/**
 * A deletion, carried so it can travel.
 *
 * Without one, merging is a union and a delete can never stick: the device that still holds the
 * playlist simply adds it back, and the next sync hands it to the device that deleted it.
 */
export interface Tombstone {
  playlistId: string;
  /** When it was deleted. A later re-fetch of the same playlist overrides it. */
  at: string;
}

/**
 * A deleted run. It names the run the way `identity` does rather than by id, because ids are
 * local counters that a merge may renumber: the same plan can be run 3 here and run 7 there.
 * Nothing resurrects a run, unlike a playlist: making a plan again gives it a new `createdAt`,
 * so the new one has an identity of its own and no tombstone to clear.
 */
export interface RunTombstone {
  createdAt: string;
  sourcePlaylistId: string;
  /** When it was deleted. */
  at: string;
}

export interface Snapshot {
  version: number;
  updatedAt: string;
  playlists: PlaylistSnapshot[];
  tracks: TrackSnapshot[];
  tags: TagSnapshot[];
  cache: CacheSnapshot[];
  runs: RunSnapshot[];
  /** Playlists deleted on some device, so a merge does not resurrect them. */
  deleted: Tombstone[];
  /** Plans deleted on some device, for the same reason. */
  deletedRuns: RunTombstone[];
  /** Highest ids handed out so far, so neither side reuses one after a merge. */
  seq: { run: number; group: number };
}

/** What a merge changed, for telling the user when two sides genuinely diverged. */
export interface MergeNotes {
  /** Runs that arrived with an id already in use and were given a new one. */
  renumbered: { from: number; to: number; name: string }[];
  /** Runs that could not be taken because both copies are mid-apply under the same id. */
  conflicted: number[];
  added: { playlists: number; tracks: number; tags: number; cache: number; runs: number };
  /** What a deletion from another device took away here. */
  removed: { playlists: number; tracks: number; runs: number };
}

export const emptySnapshot = (): Snapshot => ({
  version: SNAPSHOT_VERSION,
  updatedAt: new Date(0).toISOString(),
  playlists: [],
  tracks: [],
  tags: [],
  cache: [],
  runs: [],
  deleted: [],
  deletedRuns: [],
  seq: { run: 0, group: 0 },
});

const cacheKey = (c: CacheSnapshot): string => `${c.source}\u0000${c.key}`;
const newer = (a: string | null, b: string | null): boolean => (a ?? "") > (b ?? "");

/**
 * A run whose ids are written into YouTube playlist descriptions and not yet recorded locally.
 *
 * `apply` finds such a playlist again by the `[sortify run N group M]` marker in its description,
 * but only while the group has no stored target. Renumbering a run in that state would orphan a
 * playlist on YouTube and make the next apply create a duplicate, so those ids are frozen.
 */
export function idsAreFrozen(run: RunSnapshot): boolean {
  return run.status !== "planned" && run.groups.some((g) => g.targetPlaylistId === null);
}

/**
 * What makes a run itself, independent of the id it happens to hold.
 *
 * A renumbered run keeps this, which is how a second merge of the same remote recognises the
 * copy it already made instead of renumbering it again and again.
 */
const identity = (run: RunSnapshot): string => `${run.createdAt}\u0000${run.sourcePlaylistId}`;
const graveKey = (t: RunTombstone): string => `${t.createdAt}\u0000${t.sourcePlaylistId}`;

/**
 * Combines one run's progress from both sides. Applying only ever moves forward — a target gets
 * recorded, an item gets written — so taking the further-along value of each is right, and makes
 * the merge independent of which copy is "newer".
 */
function mergeRun(local: RunSnapshot, remote: RunSnapshot): RunSnapshot {
  const remoteGroups = new Map(remote.groups.map((g) => [g.groupId, g]));
  return {
    ...local,
    status: local.writesDone >= remote.writesDone ? local.status : remote.status,
    quotaUsed: Math.max(local.quotaUsed, remote.quotaUsed),
    writesDone: Math.max(local.writesDone, remote.writesDone),
    groups: local.groups.map((group) => {
      const other = remoteGroups.get(group.groupId);
      if (!other) return group;
      const written = new Set(
        [...group.items, ...other.items].filter((i) => i.written).map((i) => i.videoId),
      );
      return {
        ...group,
        targetPlaylistId: group.targetPlaylistId ?? other.targetPlaylistId,
        items: group.items.map((i) => ({ ...i, written: i.written || written.has(i.videoId) })),
      };
    }),
  };
}

function renumber(run: RunSnapshot, runId: number, nextGroupId: () => number): RunSnapshot {
  return {
    ...run,
    runId,
    groups: run.groups.map((g) => ({ ...g, groupId: nextGroupId() })),
  };
}

/**
 * Merges remote runs into local ones.
 *
 * Same run on both sides: progress is combined. Different runs that happen to share an id: the
 * local one keeps the id and the remote one is renumbered — unless its ids are frozen, in which
 * case it is reported as a conflict and left out rather than being quietly broken.
 */
function mergeRuns(
  local: RunSnapshot[],
  remote: RunSnapshot[],
  seq: { run: number; group: number },
  notes: MergeNotes,
): RunSnapshot[] {
  const byId = new Map(local.map((r) => [r.runId, r]));
  const byIdentity = new Map(local.map((r) => [identity(r), r.runId]));
  for (const run of [...local, ...remote]) {
    seq.run = Math.max(seq.run, run.runId);
    for (const group of run.groups) seq.group = Math.max(seq.group, group.groupId);
  }
  const nextGroupId = () => ++seq.group;

  for (const incoming of remote) {
    // Already here, under this id or one a previous merge moved it to.
    const existingId = byIdentity.get(identity(incoming));
    if (existingId !== undefined) {
      const mine = byId.get(existingId);
      if (mine) byId.set(existingId, mergeRun(mine, incoming));
      continue;
    }
    if (!byId.has(incoming.runId)) {
      byId.set(incoming.runId, incoming);
      byIdentity.set(identity(incoming), incoming.runId);
      notes.added.runs++;
      continue;
    }
    if (idsAreFrozen(incoming)) {
      // Both copies are mid-apply under this id; moving either would orphan a playlist.
      notes.conflicted.push(incoming.runId);
      continue;
    }
    const runId = ++seq.run;
    byId.set(runId, renumber(incoming, runId, nextGroupId));
    byIdentity.set(identity(incoming), runId);
    notes.renumbered.push({
      from: incoming.runId,
      to: runId,
      name: incoming.groups[0]?.name ?? "",
    });
    notes.added.runs++;
  }

  return [...byId.values()].sort((a, b) => a.runId - b.runId);
}

/**
 * Combines two snapshots into one that holds everything either side knew.
 *
 * `local` wins ties, so a device never loses work it has not yet pushed.
 */
export function mergeSnapshots(
  localRaw: Snapshot,
  remoteRaw: Snapshot,
): {
  merged: Snapshot;
  notes: MergeNotes;
} {
  // Either side may predate a field: a remote written by an older device, or a local store
  // loaded from a database written before an upgrade.
  const local = normalizeSnapshot(localRaw);
  const remote = normalizeSnapshot(remoteRaw);
  const notes: MergeNotes = {
    renumbered: [],
    conflicted: [],
    added: { playlists: 0, tracks: 0, tags: 0, cache: 0, runs: 0 },
    removed: { playlists: 0, tracks: 0, runs: 0 },
  };

  // Deletions first: the newest one per playlist wins, and they decide what survives below.
  const tombstones = new Map<string, Tombstone>();
  for (const t of [...local.deleted, ...remote.deleted]) {
    const seen = tombstones.get(t.playlistId);
    if (!seen || t.at > seen.at) tombstones.set(t.playlistId, t);
  }

  // Playlists: the member list travels with the fetch that produced it.
  const playlists = new Map(local.playlists.map((p) => [p.playlistId, p]));
  for (const p of remote.playlists) {
    const mine = playlists.get(p.playlistId);
    if (!mine) notes.added.playlists++;
    if (!mine || p.fetchedAt > mine.fetchedAt) playlists.set(p.playlistId, p);
  }

  // Tracks: the tagged copy wins, and details fetched on either side are kept either way,
  // because duration and topics cost YouTube quota to fetch again.
  const tracks = new Map(local.tracks.map((t) => [t.videoId, t]));
  for (const incoming of remote.tracks) {
    const mine = tracks.get(incoming.videoId);
    if (!mine) {
      tracks.set(incoming.videoId, incoming);
      notes.added.tracks++;
      continue;
    }
    const winner = newer(incoming.enrichedAt, mine.enrichedAt) ? incoming : mine;
    const other = winner === mine ? incoming : mine;
    tracks.set(incoming.videoId, {
      ...winner,
      durationS: winner.durationS ?? other.durationS,
      topics: winner.topics ?? other.topics,
    });
  }

  // Tags are rewritten wholesale whenever a track is tagged, so they follow the winning track.
  const tags = new Map(local.tags.map((t) => [t.videoId, t]));
  for (const incoming of remote.tags) {
    const localTrack = local.tracks.find((t) => t.videoId === incoming.videoId);
    const remoteTrack = remote.tracks.find((t) => t.videoId === incoming.videoId);
    if (!tags.has(incoming.videoId)) notes.added.tags++;
    if (
      !tags.has(incoming.videoId) ||
      newer(remoteTrack?.enrichedAt ?? null, localTrack?.enrichedAt ?? null)
    ) {
      tags.set(incoming.videoId, incoming);
    }
  }

  // The lookup cache is append-mostly; take the union, and for an entry both sides hold, the
  // later answer — one side may have re-asked a stale "no match" and got a match.
  const cache = new Map(local.cache.map((c) => [cacheKey(c), c]));
  for (const c of remote.cache) {
    const mine = cache.get(cacheKey(c));
    if (!mine) notes.added.cache++;
    else if (!newer(c.fetchedAt ?? null, mine.fetchedAt ?? null)) continue;
    cache.set(cacheKey(c), c);
  }

  const seq = {
    run: Math.max(local.seq.run, remote.seq.run),
    group: Math.max(local.seq.group, remote.seq.group),
  };

  // Deleted plans, by identity rather than id. Filtered out before the merge rather than after,
  // so a buried run is never renumbered, never counted as brought in, and never pushed back to
  // the device that still holds it.
  const runGraves = new Map<string, RunTombstone>();
  for (const t of [...local.deletedRuns, ...remote.deletedRuns]) {
    const seen = runGraves.get(graveKey(t));
    if (!seen || t.at > seen.at) runGraves.set(graveKey(t), t);
  }
  const alive = (run: RunSnapshot): boolean => !runGraves.has(identity(run));
  notes.removed.runs = local.runs.filter((r) => !alive(r)).length;
  const runs = mergeRuns(local.runs.filter(alive), remote.runs.filter(alive), seq, notes);

  // Apply the deletions. A playlist fetched again after it was deleted outlives its tombstone:
  // the user deliberately re-added it, which is a later intent than the delete.
  const surviving = new Map<string, PlaylistSnapshot>();
  const orphaned = new Set<string>();
  const buried = new Set<string>();
  for (const [id, playlist] of playlists) {
    const grave = tombstones.get(id);
    if (!grave) {
      surviving.set(id, playlist);
    } else if (playlist.fetchedAt > grave.at) {
      tombstones.delete(id);
      surviving.set(id, playlist);
    } else {
      buried.add(id);
      // Only what this playlist held is a candidate for removal; nothing else is touched.
      for (const videoId of playlist.videoIds) orphaned.add(videoId);
      if (local.playlists.some((p) => p.playlistId === id)) notes.removed.playlists++;
    }
  }

  // A track goes only if the deleted playlist was the last one holding it.
  for (const p of surviving.values()) for (const videoId of p.videoIds) orphaned.delete(videoId);
  const keptTracks = [...tracks.values()].filter((t) => !orphaned.has(t.videoId));
  notes.removed.tracks = local.tracks.filter((t) => orphaned.has(t.videoId)).length;

  const keptRuns = runs.filter((r) => !buried.has(r.sourcePlaylistId));
  notes.removed.runs += local.runs.filter((r) => alive(r) && buried.has(r.sourcePlaylistId)).length;

  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString();

  return {
    merged: {
      version: SNAPSHOT_VERSION,
      updatedAt: new Date().toISOString(),
      playlists: [...surviving.values()],
      tracks: keptTracks,
      tags: [...tags.values()].filter((t) => !orphaned.has(t.videoId)),
      cache: [...cache.values()],
      runs: keptRuns,
      deleted: [...tombstones.values()].filter((t) => t.at > cutoff),
      // A plan whose playlist is gone needs no tombstone of its own: the playlist's buries it.
      deletedRuns: [...runGraves.values()].filter(
        (t) => t.at > cutoff && !buried.has(t.sourcePlaylistId),
      ),
      seq,
    },
    notes,
  };
}

/** Whether a merge changed anything a person would want to hear about. */
export const isQuiet = (notes: MergeNotes): boolean =>
  notes.renumbered.length === 0 &&
  notes.conflicted.length === 0 &&
  Object.values(notes.added).every((n) => n === 0) &&
  Object.values(notes.removed).every((n) => n === 0);

/**
 * Fills in anything an older snapshot has not got.
 *
 * A file written before a field existed arrives without it, and a merge that assumed the field
 * was there would throw rather than sync. Every collection is defaulted here, at the one point
 * where outside data enters, so adding a field later cannot break a device that has not caught
 * up yet.
 */
export function normalizeSnapshot(raw: Partial<Snapshot> | null | undefined): Snapshot {
  const base = emptySnapshot();
  if (!raw || typeof raw !== "object") return base;
  return {
    version: typeof raw.version === "number" ? raw.version : base.version,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
    tracks: Array.isArray(raw.tracks) ? raw.tracks : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    cache: Array.isArray(raw.cache) ? raw.cache : [],
    runs: Array.isArray(raw.runs) ? raw.runs.map((r) => ({ ...r, groups: r.groups ?? [] })) : [],
    deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    deletedRuns: Array.isArray(raw.deletedRuns) ? raw.deletedRuns : [],
    seq: {
      run: Number(raw.seq?.run) || 0,
      group: Number(raw.seq?.group) || 0,
    },
  };
}

/** Tombstones expire once every device has surely seen them, so the list cannot grow for ever. */
const TOMBSTONE_DAYS = 90;
