/**
 * The run routes' answers, shared by both shells like `validate.ts`: `server/app.ts` serves them
 * over HTTP and `web/src/api.ts` answers the same routes in the page. Free of `node:` imports.
 */
import type { RunDetail, RunSummary } from "../api/types.ts";
import type { Cache, Run } from "../db.ts";
import { groupWatchLinks, type musicLink } from "../youtube/watchLinks.ts";
import { asObject, optionalPositiveInt, RequestError } from "./validate.ts";

export function requireRun(store: Cache, id: string): Run {
  const run = store.getRun(Number(id));
  if (!run) throw new RequestError(404, "No such plan");
  return run;
}

export function runSummary(store: Cache, run: Run): RunSummary {
  const groups = store.runGroupProgress(run.runId);
  return {
    runId: run.runId,
    sourcePlaylistId: run.sourcePlaylistId,
    sourceTitle: store.getPlaylist(run.sourcePlaylistId)?.title ?? run.sourcePlaylistId,
    dimension: run.dimension,
    status: run.status,
    createdAt: run.createdAt,
    quotaUsed: run.quotaUsed,
    writesDone: run.writesDone,
    groupCount: groups.length,
    total: groups.reduce((sum, g) => sum + g.total, 0),
    written: groups.reduce((sum, g) => sum + g.written, 0),
  };
}

export function runDetail(store: Cache, run: Run): RunDetail {
  return {
    run: runSummary(store, run),
    untagged: store.playlistTracks(run.sourcePlaylistId).filter((t) => t.enrichedAt === null)
      .length,
    groups: store.runGroupProgress(run.runId).map((g) => ({
      groupId: g.groupId,
      name: g.name,
      targetPlaylistId: g.targetPlaylistId,
      total: g.total,
      written: g.written,
      watchLinks: groupWatchLinks(store, g.groupId),
    })),
  };
}

/**
 * One of a group's watch links, opened in YouTube Music. The link is rebuilt from the stored
 * group rather than taken from the request, so the route cannot be pointed anywhere else.
 * `resolve` is `musicLink` where the shell can read YouTube's redirect, and undefined where it
 * cannot (a browser; see `musicLink`).
 */
export async function groupMusicLink(
  store: Cache,
  run: Run,
  groupId: string,
  body: unknown,
  resolve: typeof musicLink | undefined,
): Promise<{ url: string }> {
  const part = optionalPositiveInt(asObject(body).part, "part") ?? 1;
  if (!store.runGroups(run.runId).some((g) => g.groupId === Number(groupId))) {
    throw new RequestError(404, "No such group");
  }
  const link = groupWatchLinks(store, Number(groupId))[part - 1];
  if (!link) throw new RequestError(404, "That group has no such part");
  if (!resolve) throw new RequestError(501, "This build cannot open YouTube Music links");
  try {
    return { url: await resolve(link) };
  } catch (err) {
    throw new RequestError(502, (err as Error).message);
  }
}
