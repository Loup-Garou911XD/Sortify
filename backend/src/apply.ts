import type { Cache, RunGroup } from "./db.ts";
import { QuotaExceededError, YouTubeApiError, type YouTubeClient } from "./youtube/client.ts";

export type Privacy = "private" | "unlisted" | "public";

export type PlaylistWriter = Pick<
  YouTubeClient,
  "quotaUsed" | "myPlaylists" | "playlistVideoIds" | "createPlaylist" | "addToPlaylist"
>;

export interface ApplyOptions {
  privacy: Privacy;
  /** Stop after this many write calls (playlist creations + track additions). */
  maxWrites?: number;
  log?: (line: string) => void;
  /** Called after each track is settled with (tracks written so far, tracks in the run). */
  onProgress?: (done: number, total: number) => void;
  /** Stops before the next write call; the run is left paused and can be resumed. */
  signal?: AbortSignal;
}

export interface ApplyResult {
  status: "done" | "paused";
  reason?: "quota" | "limit" | "cancelled";
  playlistsCreated: number;
  tracksAdded: number;
  tracksSkipped: number;
  quotaUsed: number;
}

class WriteLimitReached extends Error {}
class Cancelled extends Error {}

const MAX_TITLE = 150;

export function playlistTitle(sourceTitle: string, groupName: string): string {
  const suffix = ` · ${groupName}`;
  const room = MAX_TITLE - suffix.length;
  const base = sourceTitle.length > room ? `${sourceTitle.slice(0, room - 1)}…` : sourceTitle;
  return `${base}${suffix}`;
}

/** Tag in the playlist description that lets a resumed run find a playlist it already made. */
export const groupMarker = (group: RunGroup): string =>
  `[sortify run ${group.runId} group ${group.groupId}]`;

/**
 * Creates one playlist per group and adds its tracks. Progress is saved after every call, so the
 * run can stop at the daily quota or `maxWrites` and resume later without duplicates:
 * - a group whose playlist was created but not recorded is found again by its description marker;
 * - a group with unconfirmed additions is checked against the playlist's current contents.
 */
export async function applyRun(
  store: Cache,
  yt: PlaylistWriter,
  runId: number,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const log = options.log ?? (() => {});
  const run = store.getRun(runId);
  if (!run) throw new Error(`No run with id ${runId}`);
  const source = store.getPlaylist(run.sourcePlaylistId);
  const sourceTitle = source?.title ?? run.sourcePlaylistId;

  const result: ApplyResult = {
    status: "done",
    playlistsCreated: 0,
    tracksAdded: 0,
    tracksSkipped: 0,
    quotaUsed: 0,
  };
  if (run.status === "done") return result;

  const quotaAtStart = yt.quotaUsed;
  let writes = 0;
  const spendWrite = (): void => {
    if (options.signal?.aborted) throw new Cancelled();
    if (options.maxWrites !== undefined && writes >= options.maxWrites)
      throw new WriteLimitReached();
    writes++;
  };

  const groups = store.runGroups(runId);
  const itemsOf = new Map(groups.map((g) => [g.groupId, store.groupItems(g.groupId)]));
  const total = [...itemsOf.values()].reduce((sum, items) => sum + items.length, 0);
  let done = [...itemsOf.values()].reduce(
    (sum, items) => sum + items.filter((i) => i.written).length,
    0,
  );
  const settle = (groupId: number, videoId: string): void => {
    store.markWritten(groupId, videoId);
    done++;
    options.onProgress?.(done, total);
  };
  options.onProgress?.(done, total);

  store.updateRun(runId, { status: "applying" });
  let mine: Awaited<ReturnType<PlaylistWriter["myPlaylists"]>> | undefined;

  try {
    for (const group of groups) {
      let target = group.targetPlaylistId;
      let verify = target !== null;

      if (target === null) {
        mine ??= await yt.myPlaylists();
        const marker = groupMarker(group);
        const existing = mine.find((p) => p.description.includes(marker));
        if (existing) {
          target = existing.id;
          verify = true;
        } else {
          spendWrite();
          target = await yt.createPlaylist(
            playlistTitle(sourceTitle, group.name),
            `Sorted by ${run.dimension} from "${sourceTitle}" with Sortify. ${marker}`,
            options.privacy,
          );
          result.playlistsCreated++;
          log(`Created playlist "${playlistTitle(sourceTitle, group.name)}"`);
        }
        store.setGroupTarget(group.groupId, target);
      }

      let pending = (itemsOf.get(group.groupId) ?? []).filter((i) => !i.written);
      if (pending.length === 0) continue;
      if (verify) {
        const present = await yt.playlistVideoIds(target);
        for (const item of pending) {
          if (present.has(item.videoId)) settle(group.groupId, item.videoId);
        }
        pending = pending.filter((i) => !present.has(i.videoId));
      }

      for (const item of pending) {
        spendWrite();
        try {
          await yt.addToPlaylist(target, item.videoId);
          result.tracksAdded++;
        } catch (err) {
          // A video that became private or was deleted since fetching; skip it for good.
          if (err instanceof YouTubeApiError && (err.status === 404 || err.status === 403)) {
            log(`Skipped ${item.videoId}: ${err.message}`);
            result.tracksSkipped++;
          } else {
            throw err;
          }
        }
        settle(group.groupId, item.videoId);
      }
      log(`"${group.name}": ${itemsOf.get(group.groupId)?.length ?? 0} tracks`);
    }
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      result.status = "paused";
      result.reason = "quota";
    } else if (err instanceof WriteLimitReached) {
      result.status = "paused";
      result.reason = "limit";
    } else if (err instanceof Cancelled) {
      result.status = "paused";
      result.reason = "cancelled";
    } else {
      store.updateRun(runId, { status: "paused", quotaDelta: yt.quotaUsed - quotaAtStart });
      throw err;
    }
  }

  result.quotaUsed = yt.quotaUsed - quotaAtStart;
  store.updateRun(runId, {
    status: result.status,
    quotaDelta: result.quotaUsed,
    writesDelta: result.playlistsCreated + result.tracksAdded,
  });
  return result;
}
