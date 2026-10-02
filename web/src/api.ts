/**
 * The local server, reimplemented in the page.
 *
 * `frontend/src/api.ts` sends every call to `sortify ui` over HTTP. On GitHub Pages there is no
 * server, so Vite swaps this module in for that one: same `api()` signature, same routes, same
 * JSON shapes, but the work happens here using the very same domain code the server calls
 * (`enrichPlaylist`, `planGroups`, `applyRun`, the provider registry).
 */
import type {
  ApplyRequest,
  CreateRunRequest,
  EnrichRequest,
  JobView,
  PlaylistDetail,
  PreviewRequest,
  PreviewResponse,
  StatusResponse,
  SyncView,
  TrackView,
} from "../../backend/src/api/types.ts";
import { applyRun, type Privacy } from "../../backend/src/apply.ts";
import type { Cache } from "../../backend/src/db.ts";
import { Budget, type LookupDeps } from "../../backend/src/enrich/lookup.ts";
import { type Enrichers, enrichPlaylist } from "../../backend/src/enrich/pipeline.ts";
import { createProviderClients, providerStatuses } from "../../backend/src/enrich/providers.ts";
import { planGroups } from "../../backend/src/planner.ts";
import { JobBusyError, JobRunner } from "../../backend/src/server/jobs.ts";
import {
  groupMusicLink,
  runDetail,
  runSummary,
  requireRun as sharedRequireRun,
} from "../../backend/src/server/runs.ts";
import {
  asObject,
  dimensionOf,
  optionalPositiveInt,
  RequestError,
  validateGroups,
} from "../../backend/src/server/validate.ts";
import { DriveSnapshots } from "../../backend/src/sync/drive.ts";
import { SyncEngine } from "../../backend/src/sync/engine.ts";
import { syncView } from "../../backend/src/sync/view.ts";
import { TagMapper } from "../../backend/src/tagging/mapper.ts";
import { YouTubeClient } from "../../backend/src/youtube/client.ts";
import { parsePlaylistId } from "../../backend/src/youtube/playlistUrl.ts";
import type { musicLink } from "../../backend/src/youtube/watchLinks.ts";
import type * as httpApi from "../../frontend/src/api.ts";
import { completeAuth, getAccessToken, isSignedIn, signOut, startAuth } from "./auth.ts";
import { getKeys, hasGoogleClient } from "./settings.ts";
import type { BrowserStore } from "./store.ts";

const VERSION = "0.1.0";
const DAILY_QUOTA = 10_000;

/**
 * What a rejected request looks like to the UI. It is the server's `RequestError` under the name
 * `frontend/src/api.ts` exports, because this module stands in for that one.
 */
export { RequestError as ApiError };

/**
 * `BrowserStore` is checked against `Cache` — `Store` without its SQLite handle — so the two
 * implementations of the cache cannot drift apart without the build failing.
 */
let store: Cache | undefined;
let sync: SyncEngine | undefined;
const jobs = new JobRunner();

export function boot(browserStore: BrowserStore): void {
  store = browserStore;
  // Syncing needs a signed-in account; without one the page simply works on its own.
  if (!isSignedIn()) return;
  sync = new SyncEngine(browserStore, new DriveSnapshots({ getAccessToken }));
  browserStore.onWrite = () => sync?.schedule();
  void sync.sync();
  addEventListener("pagehide", () => void sync?.flush());
}

function ready(): Cache {
  if (!store) throw new RequestError(503, "Still starting up. Try again in a moment.");
  return store;
}

function youtube(): YouTubeClient {
  if (!isSignedIn()) throw new RequestError(401, "Connect YouTube first.");
  return new YouTubeClient({ getAccessToken });
}

function enrichers(maxApiCalls?: number): { enrichers: Enrichers; budget: Budget } {
  const budget = new Budget(maxApiCalls);
  const deps: LookupDeps = {
    store: ready(),
    budget,
    // Browsers forbid setting User-Agent, so this is ignored by fetch and the browser's own
    // identity is sent instead. MusicBrainz and Discogs ask for a descriptive one; a static
    // deploy cannot provide it.
    userAgent: `Sortify/${VERSION}`,
  };
  return {
    budget,
    enrichers: { mapper: new TagMapper(), clients: createProviderClients(deps, getKeys()) },
  };
}

function requirePlaylist(id: string) {
  const playlist = ready()
    .listPlaylists()
    .find((p) => p.playlistId === id);
  if (!playlist) throw new RequestError(404, "No such playlist");
  return playlist;
}

const requireRun = (id: string) => sharedRequireRun(ready(), id);
// A page cannot read the redirect `musicLink` needs (see there), so this build has no resolver.
const musicLinks: typeof musicLink | undefined = undefined;

function startJob(...args: Parameters<JobRunner["start"]>): JobView {
  try {
    return jobs.start(...args);
  } catch (err) {
    if (err instanceof JobBusyError) throw new RequestError(409, err.message);
    throw err;
  }
}

// --- the routes ----------------------------------------------------------------------

type Handler = (params: string[], body: Record<string, unknown>) => unknown;

const routes: [string, RegExp, Handler][] = [
  [
    "GET",
    /^\/api\/status$/,
    (): StatusResponse => ({
      version: VERSION,
      // On a static deploy the "client secrets" are the two keys the user pasted.
      hasClientSecrets: hasGoogleClient(),
      clientSecretsError: hasGoogleClient()
        ? null
        : "Open Connections in the top bar and pick YouTube to add your Google client ID and secret.",
      signedIn: isSignedIn(),
      sources: providerStatuses(getKeys()),
      dailyQuota: DAILY_QUOTA,
      sync: sync ? syncView(sync.status()) : null,
      opensInMusic: musicLinks !== undefined,
    }),
  ],
  [
    "POST",
    /^\/api\/sync$/,
    async (): Promise<SyncView> => {
      if (!sync)
        throw new RequestError(409, "Sync is off. Connect YouTube to sync through Google Drive.");
      return syncView(await sync.sync());
    },
  ],
  ["POST", /^\/api\/auth\/start$/, async () => ({ url: await startAuth() })],
  [
    "POST",
    /^\/api\/auth\/complete$/,
    async (_p, body) => {
      if (typeof body.url !== "string") throw new RequestError(400, "url is required");
      await completeAuth(body.url);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/auth\/signout$/,
    () => {
      signOut();
      sync = undefined;
      return { ok: true };
    },
  ],

  ["GET", /^\/api\/playlists$/, () => ready().listPlaylists()],
  [
    "POST",
    /^\/api\/playlists$/,
    (_p, body) => {
      if (typeof body.url !== "string") throw new RequestError(400, "url is required");
      let playlistId: string;
      try {
        playlistId = parsePlaylistId(body.url);
      } catch (err) {
        throw new RequestError(400, (err as Error).message);
      }
      const yt = youtube();
      return startJob("fetch", "Reading playlist from YouTube", { playlistId }, async (ctx) => {
        const quotaAtStart = yt.quotaUsed;
        const title = await yt.getPlaylistTitle(playlistId);
        const entries = await yt.playlistEntries(playlistId);
        ready().savePlaylist(playlistId, title, entries);
        const missing = ready().videoIdsMissingDetails(playlistId);
        if (missing.length > 0) ready().setVideoDetails(await yt.videoDetails(missing));
        ctx.log(`${entries.length} tracks, ${missing.length} new`);
        const quota = yt.quotaUsed - quotaAtStart;
        return `Added "${title}" (${entries.length} tracks, ${quota} quota units)`;
      });
    },
  ],
  [
    "GET",
    /^\/api\/playlists\/([\w-]+)$/,
    ([id = ""]): PlaylistDetail => {
      const playlist = requirePlaylist(id);
      const tags = new Map<string, TrackView["tags"]>();
      for (const t of ready().playlistAllTags(id)) {
        const list = tags.get(t.videoId) ?? [];
        list.push({
          dimension: t.dimension,
          value: t.value,
          source: t.source,
          rawTag: t.rawTag,
          weight: t.weight,
        });
        tags.set(t.videoId, list);
      }
      const tracks = ready()
        .playlistTracks(id)
        .map(
          (t): TrackView => ({
            videoId: t.videoId,
            title: t.title,
            channel: t.channel,
            durationS: t.durationS,
            artist: t.artist,
            songTitle: t.songTitle,
            enriched: t.enrichedAt !== null && t.failedProviders.length === 0,
            retryProviders: t.failedProviders,
            tags: tags.get(t.videoId) ?? [],
          }),
        );
      return { playlist, tracks };
    },
  ],
  [
    "DELETE",
    /^\/api\/playlists\/([\w-]+)$/,
    ([id = ""]) => {
      const playlist = requirePlaylist(id);
      const current = jobs.current();
      if (current?.status === "running" && current.playlistId === id) {
        throw new RequestError(409, "This playlist is busy");
      }
      ready().deletePlaylist(playlist.playlistId);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/playlists\/([\w-]+)\/enrich$/,
    ([id = ""], body) => {
      const playlist = requirePlaylist(id);
      const req = body as EnrichRequest;
      const maxApiCalls = optionalPositiveInt(req.maxApiCalls, "maxApiCalls");
      const { enrichers: made, budget } = enrichers(maxApiCalls);
      return startJob("enrich", `Tagging "${playlist.title}"`, { playlistId: id }, async (ctx) => {
        const summary = await enrichPlaylist(ready(), id, made, {
          force: req.force === true,
          signal: ctx.signal,
          onProgress: (done, total, track) => {
            ctx.progress(done, total);
            ctx.log(track.title);
          },
        });
        let message = `Tagged ${summary.enriched} tracks with ${budget.used} API calls`;
        if (summary.retryLater > 0) {
          message += `; ${summary.retryLater} missed a source that did not answer and will be retried next time`;
        }
        if (summary.stoppedByBudget) message += "; stopped at the API call limit";
        if (summary.remaining > 0) message += `; ${summary.remaining} left`;
        return message;
      });
    },
  ],
  [
    "POST",
    /^\/api\/playlists\/([\w-]+)\/preview$/,
    ([id = ""], body): PreviewResponse => {
      requirePlaylist(id);
      const req = body as Partial<PreviewRequest>;
      const dimension = dimensionOf(req.dimension);
      return planGroups(ready().playlistTracks(id), ready().playlistTags(id, dimension), {
        dimension,
        minSize: optionalPositiveInt(req.minSize, "minSize") ?? 5,
        maxGroupsPerTrack: optionalPositiveInt(req.maxGroupsPerTrack, "maxGroupsPerTrack"),
        includeLeftovers: req.includeLeftovers !== false,
      });
    },
  ],
  [
    "POST",
    /^\/api\/playlists\/([\w-]+)\/runs$/,
    ([id = ""], body) => {
      requirePlaylist(id);
      const req = body as Partial<CreateRunRequest>;
      const dimension = dimensionOf(req.dimension);
      const minSize = optionalPositiveInt(req.minSize, "minSize") ?? 1;
      const allowed = new Set(
        ready()
          .playlistTracks(id)
          .map((t) => t.videoId),
      );
      const groups = validateGroups(req.groups, allowed);
      return { runId: ready().createRun(id, dimension, minSize, groups) };
    },
  ],

  [
    "POST",
    /^\/api\/runs\/(\d+)\/groups\/(\d+)\/music-link$/,
    ([id = "", groupId = ""], body) =>
      groupMusicLink(ready(), requireRun(id), groupId, body, musicLinks),
  ],
  [
    "GET",
    /^\/api\/runs$/,
    () =>
      ready()
        .listRuns()
        .map((r) => runSummary(ready(), r)),
  ],
  ["GET", /^\/api\/runs\/(\d+)$/, ([id = ""]) => runDetail(ready(), requireRun(id))],
  [
    "DELETE",
    /^\/api\/runs\/(\d+)$/,
    ([id = ""]) => {
      // Playlists it already created stay on YouTube.
      const run = requireRun(id);
      const current = jobs.current();
      if (current?.status === "running" && current.runId === run.runId) {
        throw new RequestError(409, "This run is being applied");
      }
      ready().deleteRun(run.runId);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/apply$/,
    ([id = ""], body) => {
      const run = requireRun(id);
      if (run.status === "done") throw new RequestError(409, "This run is already done");
      const req = body as Partial<ApplyRequest>;
      const privacy: Privacy = req.privacy ?? "private";
      if (!["private", "unlisted", "public"].includes(privacy)) {
        throw new RequestError(400, "privacy must be private, unlisted or public");
      }
      const maxWrites = optionalPositiveInt(req.maxWrites, "maxWrites");
      const yt = youtube();
      const title = ready().getPlaylist(run.sourcePlaylistId)?.title ?? run.sourcePlaylistId;
      return startJob(
        "apply",
        `Creating playlists from "${title}"`,
        { runId: run.runId, playlistId: run.sourcePlaylistId },
        async (ctx) => {
          const result = await applyRun(ready(), yt, run.runId, {
            privacy,
            maxWrites,
            signal: ctx.signal,
            log: ctx.log,
            onProgress: ctx.progress,
          });
          const parts = [
            `Created ${result.playlistsCreated} playlists`,
            `added ${result.tracksAdded} tracks`,
          ];
          if (result.tracksSkipped) parts.push(`skipped ${result.tracksSkipped} unavailable`);
          parts.push(`used ${result.quotaUsed} quota units`);
          let message = parts.join(", ");
          if (result.reason === "quota") {
            message += ". Daily quota reached; resume after midnight Pacific time";
          } else if (result.reason === "limit") {
            message += ". Stopped at the write limit; resume to continue";
          }
          return message;
        },
      );
    },
  ],

  ["GET", /^\/api\/job$/, () => jobs.current()],
  ["POST", /^\/api\/job\/cancel$/, () => ({ ok: jobs.cancel() })],
];

/**
 * Drop-in replacement for the HTTP `api()`. Same signature, same errors: callers cannot tell
 * whether a server answered or this module did.
 */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const body = init.body === undefined ? {} : asObject(init.body);
  for (const [routeMethod, pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (routeMethod !== method) continue;
    try {
      return (await handler(match.slice(1), body)) as T;
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError(500, err instanceof Error ? err.message : String(err));
    }
  }
  throw new RequestError(404, `No route for ${method} ${path}`);
}

/**
 * The Vite plugin substitutes this module for `frontend/src/api.ts` at build time, which tsc
 * cannot see. These two assignments are what make the compiler check that the stand-in still
 * matches what the app imports.
 */
const _api: typeof httpApi.api = api;
const _error: typeof httpApi.ApiError = RequestError;
void [_api, _error];
