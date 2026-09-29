import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type {
  ApplyRequest,
  CreateRunRequest,
  Dimension,
  EnrichRequest,
  GroupDraft,
  PlaylistDetail,
  PreviewRequest,
  PreviewResponse,
  Privacy,
  RunDetail,
  RunSummary,
  StatusResponse,
  TrackView,
} from "../api/types.ts";
import { applyRun, type PlaylistWriter } from "../apply.ts";
import { type Config, VERSION } from "../config.ts";
import { DIMENSIONS, type Run, type Store } from "../db.ts";
import { enrichPlaylist } from "../enrich/pipeline.ts";
import { providerStatuses } from "../enrich/providers.ts";
import { planGroups } from "../planner.ts";
import { createEnrichers, fetchPlaylist, type PlaylistReader } from "../services.ts";
import {
  authState,
  beginWebAuth,
  describeAuthError,
  finishWebAuth,
  PendingAuthStore,
  signOut,
} from "../youtube/auth.ts";
import { parsePlaylistId } from "../youtube/playlistUrl.ts";
import { JobBusyError, JobRunner } from "./jobs.ts";

export type YouTubeApi = PlaylistReader & PlaylistWriter;

export interface AppDeps {
  config: Config;
  store: Store;
  /** Built lazily per task so a sign-in done in the UI takes effect without a restart. */
  youtube: () => YouTubeApi;
  /** Directory with the built web UI (index.html + assets). */
  staticDir?: string;
  /** Port the server listens on; used for the OAuth redirect URI. */
  port: number;
  /** Extra Host header values to accept (besides localhost). */
  allowedHosts?: string[];
  auth?: {
    begin: typeof beginWebAuth;
    finish: typeof finishWebAuth;
    state: typeof authState;
    signOut: typeof signOut;
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 10 * 1024 * 1024;
const MAX_GROUPS = 500;
const MAX_NAME = 100;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  return value;
}

function dimensionOf(value: unknown): Dimension {
  if (typeof value !== "string" || !(DIMENSIONS as readonly string[]).includes(value)) {
    throw new HttpError(400, `dimension must be one of ${DIMENSIONS.join(", ")}`);
  }
  return value as Dimension;
}

/**
 * Checks edited groups against the playlist: known videos only, unique non-empty names, no
 * duplicates inside a group. Empty groups are dropped.
 */
export function validateGroups(raw: unknown, allowed: Set<string>): GroupDraft[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "groups must be an array");
  if (raw.length > MAX_GROUPS) throw new HttpError(400, `At most ${MAX_GROUPS} groups`);
  const names = new Set<string>();
  const groups: GroupDraft[] = [];
  for (const item of raw) {
    const g = asObject(item);
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!name || name.length > MAX_NAME) {
      throw new HttpError(400, `Group names must be 1–${MAX_NAME} characters`);
    }
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Duplicate group name "${name}"`);
    names.add(name.toLowerCase());
    if (!Array.isArray(g.videoIds)) throw new HttpError(400, `Group "${name}" has no videoIds`);
    const ids: string[] = [];
    for (const id of g.videoIds) {
      if (typeof id !== "string" || !allowed.has(id)) {
        throw new HttpError(400, `Group "${name}" contains a video that is not in the playlist`);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) groups.push({ name, videoIds: ids });
  }
  if (groups.length === 0) throw new HttpError(400, "The plan has no tracks");
  return groups;
}

function isLocalHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const auth = deps.auth ?? {
    begin: beginWebAuth,
    finish: finishWebAuth,
    state: authState,
    signOut,
  };
  const jobs = new JobRunner();
  const pendingAuth = new PendingAuthStore(config.pendingAuthPath);
  const redirectUri = `http://127.0.0.1:${deps.port}/`;

  const hostAllowed = (host: string | undefined): boolean => {
    if (!host) return false;
    const hostname = host.replace(/:\d+$/, "").toLowerCase();
    if (isLocalHost(hostname)) return true;
    // GitHub Codespaces forwards ports through authenticated *.app.github.dev URLs.
    if (process.env.CODESPACES === "true" && hostname.endsWith(".app.github.dev")) return true;
    return (deps.allowedHosts ?? []).includes(hostname);
  };

  const runSummary = (run: Run): RunSummary => {
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
  };

  const requirePlaylist = (id: string) => {
    const summary = store.listPlaylists().find((p) => p.playlistId === id);
    if (!summary) throw new HttpError(404, "Playlist not found. Add it first.");
    return summary;
  };

  const requireRun = (id: string): Run => {
    const run = store.getRun(Number(id));
    if (!run) throw new HttpError(404, "Run not found");
    return run;
  };

  const youtube = (): YouTubeApi => {
    try {
      return deps.youtube();
    } catch (err) {
      throw new HttpError(401, (err as Error).message);
    }
  };

  const startJob: JobRunner["start"] = (...args) => {
    try {
      return jobs.start(...args);
    } catch (err) {
      if (err instanceof JobBusyError) throw new HttpError(409, err.message);
      throw err;
    }
  };

  type Handler = (params: string[], body: () => Promise<unknown>) => unknown | Promise<unknown>;
  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/api\/status$/,
      (): StatusResponse => {
        const state = auth.state(config);
        return {
          version: VERSION,
          hasClientSecrets: state.clientSecretsError === null,
          ...state,
          sources: providerStatuses(config.env),
          dailyQuota: config.dailyQuota,
        };
      },
    ],
    [
      "POST",
      /^\/api\/auth\/start$/,
      async () => {
        const pending = await auth.begin(config, redirectUri);
        pendingAuth.add(pending);
        return { url: pending.url };
      },
    ],
    [
      "POST",
      /^\/api\/auth\/complete$/,
      async (_, body) => {
        const { url } = asObject(await body());
        if (typeof url !== "string") throw new HttpError(400, "url is required");
        let parsed: URL;
        try {
          parsed = new URL(url, redirectUri);
        } catch {
          throw new HttpError(400, "That is not a URL");
        }
        await completeAuth(parsed.searchParams);
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/auth\/signout$/,
      () => {
        auth.signOut(config);
        return { ok: true };
      },
    ],
    ["GET", /^\/api\/playlists$/, () => store.listPlaylists()],
    [
      "POST",
      /^\/api\/playlists$/,
      async (_, body) => {
        const { url } = asObject(await body());
        if (typeof url !== "string") throw new HttpError(400, "url is required");
        let playlistId: string;
        try {
          playlistId = parsePlaylistId(url);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        const yt = youtube();
        return startJob("fetch", "Reading playlist from YouTube", { playlistId }, async (ctx) => {
          const r = await fetchPlaylist(store, yt, playlistId);
          ctx.log(`${r.tracks} tracks, ${r.newTracks} new`);
          return `Added "${r.title}" (${r.tracks} tracks, ${r.quotaUsed} quota units)`;
        });
      },
    ],
    [
      "GET",
      /^\/api\/playlists\/([\w-]+)$/,
      ([id = ""]): PlaylistDetail => {
        const playlist = requirePlaylist(id);
        const tags = new Map<string, TrackView["tags"]>();
        for (const t of store.playlistAllTags(id)) {
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
        const tracks = store.playlistTracks(id).map(
          (t): TrackView => ({
            videoId: t.videoId,
            title: t.title,
            channel: t.channel,
            durationS: t.durationS,
            artist: t.artist,
            songTitle: t.songTitle,
            enriched: t.enrichedAt !== null,
            tags: tags.get(t.videoId) ?? [],
          }),
        );
        return { playlist, tracks };
      },
    ],
    [
      "POST",
      /^\/api\/playlists\/([\w-]+)\/enrich$/,
      async ([id = ""], body) => {
        const playlist = requirePlaylist(id);
        const req = asObject(await body()) as EnrichRequest;
        const maxApiCalls = optionalPositiveInt(req.maxApiCalls, "maxApiCalls");
        const { enrichers, budget } = createEnrichers(config, store, { maxApiCalls });
        return startJob(
          "enrich",
          `Tagging "${playlist.title}"`,
          { playlistId: id },
          async (ctx) => {
            const summary = await enrichPlaylist(store, id, enrichers, {
              force: req.force === true,
              signal: ctx.signal,
              onProgress: (done, total, track) => {
                ctx.progress(done, total);
                ctx.log(track.title);
              },
            });
            let message = `Tagged ${summary.enriched} tracks with ${budget.used} API calls`;
            if (summary.stoppedByBudget) message += `; stopped at the API call limit`;
            if (summary.remaining > 0) message += `; ${summary.remaining} left`;
            return message;
          },
        );
      },
    ],
    [
      "POST",
      /^\/api\/playlists\/([\w-]+)\/preview$/,
      async ([id = ""], body): Promise<PreviewResponse> => {
        requirePlaylist(id);
        const req = asObject(await body()) as Partial<PreviewRequest>;
        const dimension = dimensionOf(req.dimension);
        const plan = planGroups(store.playlistTracks(id), store.playlistTags(id, dimension), {
          dimension,
          minSize: optionalPositiveInt(req.minSize, "minSize") ?? 5,
          maxGroupsPerTrack: optionalPositiveInt(req.maxGroupsPerTrack, "maxGroupsPerTrack"),
          includeLeftovers: req.includeLeftovers !== false,
        });
        return plan;
      },
    ],
    [
      "POST",
      /^\/api\/playlists\/([\w-]+)\/runs$/,
      async ([id = ""], body) => {
        requirePlaylist(id);
        const req = asObject(await body()) as Partial<CreateRunRequest>;
        const dimension = dimensionOf(req.dimension);
        const minSize = optionalPositiveInt(req.minSize, "minSize") ?? 1;
        const allowed = new Set(store.playlistTracks(id).map((t) => t.videoId));
        const groups = validateGroups(req.groups, allowed);
        return { runId: store.createRun(id, dimension, minSize, groups) };
      },
    ],
    ["GET", /^\/api\/runs$/, () => store.listRuns().map(runSummary)],
    [
      "GET",
      /^\/api\/runs\/(\d+)$/,
      ([id = ""]): RunDetail => {
        const run = requireRun(id);
        return {
          run: runSummary(run),
          groups: store.runGroupProgress(run.runId).map((g) => ({
            groupId: g.groupId,
            name: g.name,
            targetPlaylistId: g.targetPlaylistId,
            total: g.total,
            written: g.written,
          })),
        };
      },
    ],
    [
      "DELETE",
      /^\/api\/runs\/(\d+)$/,
      ([id = ""]) => {
        const run = requireRun(id);
        if (store.runGroups(run.runId).some((g) => g.targetPlaylistId !== null)) {
          throw new HttpError(409, "This run already created playlists on YouTube");
        }
        if (jobs.current()?.status === "running" && jobs.current()?.runId === run.runId) {
          throw new HttpError(409, "This run is being applied");
        }
        store.deleteRun(run.runId);
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/runs\/(\d+)\/apply$/,
      async ([id = ""], body) => {
        const run = requireRun(id);
        if (run.status === "done") throw new HttpError(409, "This run is already done");
        const req = asObject(await body()) as Partial<ApplyRequest>;
        const privacy: Privacy = req.privacy ?? "private";
        if (!["private", "unlisted", "public"].includes(privacy)) {
          throw new HttpError(400, "privacy must be private, unlisted or public");
        }
        const maxWrites = optionalPositiveInt(req.maxWrites, "maxWrites");
        const yt = youtube();
        const title = store.getPlaylist(run.sourcePlaylistId)?.title ?? run.sourcePlaylistId;
        return startJob(
          "apply",
          `Creating playlists from "${title}"`,
          { runId: run.runId, playlistId: run.sourcePlaylistId },
          async (ctx) => {
            const result = await applyRun(store, yt, run.runId, {
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
    ["POST", /^\/api\/job\/cancel$/, () => ({ cancelled: jobs.cancel() })],
  ];

  async function completeAuth(params: URLSearchParams): Promise<void> {
    const error = params.get("error");
    if (error) throw new HttpError(400, describeAuthError(error));
    const code = params.get("code");
    if (!code) throw new HttpError(400, "That URL has no sign-in code");
    const pending = pendingAuth.take(params.get("state") ?? "");
    if (!pending) {
      throw new HttpError(
        400,
        "This sign-in is older than 15 minutes, was already used, or was not started here. " +
          "Click “Open Google sign-in” again.",
      );
    }
    await auth.finish(config, pending, code);
  }

  function serveStatic(url: URL, res: ServerResponse): void {
    const root = deps.staticDir ? resolve(deps.staticDir) : undefined;
    if (!root || !existsSync(join(root, "index.html"))) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "The web UI is not built. Run `npm run build` at the repo root, then restart `sortify ui`.",
      );
      return;
    }
    let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    // Unknown paths fall back to the single-page app.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    const isAsset = url.pathname.startsWith("/assets/");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(readFileSync(file));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Refusing unknown Host headers blocks DNS-rebinding pages from reaching this API.
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Host not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    try {
      if (url.pathname.startsWith("/api/")) {
        // A custom header forces a CORS preflight, which this server never approves, so other
        // websites open in the browser cannot trigger writes.
        if (method !== "GET" && req.headers["x-sortify"] !== "1") {
          throw new HttpError(403, "Missing x-sortify header");
        }
        for (const [m, pattern, handler] of routes) {
          const match = pattern.exec(url.pathname);
          if (!match) continue;
          if (m !== method) continue;
          const result = await handler(match.slice(1), () => readJson(req));
          sendJson(res, 200, result);
          return;
        }
        throw new HttpError(404, "Not found");
      }

      // Google redirects the browser back to "/?code=...&state=..." after consent.
      if (method === "GET" && url.pathname === "/" && url.searchParams.has("state")) {
        try {
          await completeAuth(url.searchParams);
          res.writeHead(302, { location: "/?signedIn=1" }).end();
        } catch (err) {
          res.writeHead(302, {
            location: `/?authError=${encodeURIComponent((err as Error).message)}`,
          });
          res.end();
        }
        return;
      }

      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      serveStatic(url, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  }

  return { handle, jobs };
}
