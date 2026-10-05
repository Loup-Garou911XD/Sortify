import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  JobView,
  PlaylistDetail,
  PreviewResponse,
  RunDetail,
  StatusResponse,
  SyncView,
} from "../src/api/types.ts";
import { Store } from "../src/db.ts";
import { type AppDeps, createApp, type YouTubeApi } from "../src/server/app.ts";
import type { SyncEngine } from "../src/sync/engine.ts";
import { PendingAuthStore } from "../src/youtube/auth.ts";
import { tempDir, testConfig } from "./helpers.ts";

class FakeYouTube implements YouTubeApi {
  quotaUsed = 0;
  created: { title: string; videos: string[] }[] = [];

  async getPlaylistTitle() {
    return "Fetched Mix";
  }
  async playlistEntries() {
    return [
      { videoId: "n1", title: "A - One", channel: "A" },
      { videoId: "n2", title: "B - Two", channel: "B" },
    ];
  }
  async videoDetails(ids: string[]) {
    return new Map(ids.map((id) => [id, { durationS: 200, topics: ["Pop music"] }]));
  }
  async myPlaylists() {
    return [];
  }
  async playlistVideoIds() {
    return new Set<string>();
  }
  async createPlaylist(title: string) {
    this.created.push({ title, videos: [] });
    this.quotaUsed += 50;
    return `YT${this.created.length}`;
  }
  async addToPlaylist(playlistId: string, videoId: string) {
    this.created[Number(playlistId.slice(2)) - 1]?.videos.push(videoId);
    this.quotaUsed += 50;
  }
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function setup(overrides: Partial<AppDeps> = {}) {
  const store = new Store(":memory:");
  store.savePlaylist("PL1", "Big Mix", [
    { videoId: "a", title: "a", channel: "" },
    { videoId: "b", title: "b", channel: "" },
    { videoId: "c", title: "c", channel: "" },
  ]);
  for (const [id, value] of [
    ["a", "House"],
    ["b", "House"],
    ["c", "Techno"],
  ] as const) {
    store.saveEnrichment(id, { artist: "X", songTitle: id, externalIds: {}, failedProviders: [] }, [
      { dimension: "subgenre", value, rawTag: value, source: "discogs", weight: 1 },
    ]);
  }
  const yt = new FakeYouTube();
  const calls: string[] = [];
  let signIns = 0;
  const app = createApp({
    config: testConfig({ DISCOGS_TOKEN: "t" }),
    store,
    youtube: () => yt,
    port: 4747,
    auth: {
      state: () => ({ clientSecretsError: null, signedIn: false }),
      begin: async (_config, redirectUri) => {
        calls.push(`begin ${redirectUri}`);
        signIns++;
        return {
          url: "https://accounts.google.com/x",
          state: `s${signIns}`,
          codeVerifier: "v",
          redirectUri,
        };
      },
      finish: async (_config, _pending, code) => {
        calls.push(`finish ${code}`);
      },
      signOut: () => {
        calls.push("signout");
      },
    },
    ...overrides,
  });
  const server = createServer((req, res) => void app.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: { "x-sortify": "1", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, res };
  };
  return { store, yt, app, base, api, calls };
}

function rawRequest(base: string, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request(base + path, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("security", () => {
  it("rejects unknown Host headers (DNS rebinding)", async () => {
    const { base } = await setup();
    expect(await rawRequest(base, "/api/status", { host: "evil.example" })).toBe(403);
    expect(await rawRequest(base, "/api/status", { host: "localhost:4747" })).toBe(200);
  });

  it("requires the x-sortify header on writes", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/playlists`, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("api", () => {
  it("reports status and configured sources", async () => {
    const { api } = await setup();
    const { body } = await api<StatusResponse>("/api/status");
    expect(body.sources.map((s) => [s.id, s.configured])).toEqual([
      ["musicbrainz", true],
      ["discogs", true],
      ["lastfm", false],
      ["spotify", false],
      ["itunes", true],
      ["deezer", true],
      ["youtube", true],
    ]);
    expect(body.sources[2]).toMatchObject({ label: "Last.fm", envVars: ["LASTFM_API_KEY"] });
    expect(body.signedIn).toBe(false);
  });

  it("syncs on demand, or says sync is off", async () => {
    const off = await setup();
    expect((await off.api("/api/sync", { method: "POST" })).status).toBe(409);

    let cycles = 0;
    const sync = {
      sync: async () => {
        cycles++;
        return { state: "idle", at: "2026-01-01T00:00:00.000Z" };
      },
      status: () => ({ state: "idle", at: "2026-01-01T00:00:00.000Z" }),
      schedule: () => {},
    } as unknown as SyncEngine;
    const { api } = await setup({ sync });
    const { status, body } = await api<SyncView>("/api/sync", { method: "POST" });
    expect(status).toBe(200);
    expect(cycles).toBe(1);
    expect(body).toMatchObject({ state: "idle", changed: false });
  });

  it("lists playlists with tag coverage and returns tracks with tags", async () => {
    const { api } = await setup();
    const list = await api<{ total: number; withSubgenre: number }[]>("/api/playlists");
    expect(list.body[0]).toMatchObject({ total: 3, enriched: 3, withSubgenre: 3, withMood: 0 });
    const detail = await api<PlaylistDetail>("/api/playlists/PL1");
    expect(detail.body.tracks.map((t) => t.tags[0]?.value)).toEqual(["House", "House", "Techno"]);
    expect((await api("/api/playlists/nope")).status).toBe(404);
  });

  it("previews, saves an edited plan and applies it in the background", async () => {
    const { api, yt } = await setup();
    const preview = await api<PreviewResponse>("/api/playlists/PL1/preview", {
      method: "POST",
      body: { dimension: "subgenre", minSize: 1, includeLeftovers: true },
    });
    expect(preview.body.groups.map((g) => g.name)).toEqual(["House", "Techno"]);

    const created = await api<{ runId: number }>("/api/playlists/PL1/runs", {
      method: "POST",
      body: {
        dimension: "subgenre",
        minSize: 1,
        groups: [
          { name: "Warm-up House", videoIds: ["a", "a", "b"] },
          { name: "Empty", videoIds: [] },
        ],
      },
    });
    expect(created.status).toBe(200);
    const runId = created.body.runId;
    const planned = await api<RunDetail>(`/api/runs/${runId}`);
    expect(planned.body.groups[0]?.watchLinks).toEqual([
      "https://www.youtube.com/watch_videos?video_ids=a,b",
    ]);

    const started = await api<JobView>(`/api/runs/${runId}/apply`, {
      method: "POST",
      body: { privacy: "unlisted" },
    });
    expect(started.body).toMatchObject({ kind: "apply", status: "running", runId });

    let job: JobView | null = started.body;
    for (let i = 0; i < 100 && job?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      job = (await api<JobView>("/api/job")).body;
    }
    expect(job?.status).toBe("done");
    expect(job?.progress).toEqual({ done: 2, total: 2 });
    expect(yt.created).toEqual([{ title: "Big Mix · Warm-up House", videos: ["a", "b"] }]);

    const detail = await api<RunDetail>(`/api/runs/${runId}`);
    expect(detail.body.run).toMatchObject({ status: "done", total: 2, written: 2, groupCount: 1 });
    // Deleting an applied run keeps its playlist on YouTube, and its id is never handed out again,
    // so a later run cannot adopt that playlist by its description marker.
    expect((await api(`/api/runs/${runId}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/runs/${runId}`)).status).toBe(404);
    expect(yt.created).toHaveLength(1);
    const next = await api<{ runId: number }>("/api/playlists/PL1/runs", {
      method: "POST",
      body: { dimension: "subgenre", minSize: 1, groups: [{ name: "A", videoIds: ["a"] }] },
    });
    expect(next.body.runId).toBeGreaterThan(runId);
  });

  it("refuses to group by a dimension that only labels a track", async () => {
    const { api } = await setup();
    // Song type is still tagged and shown, but a plan cannot be built on it.
    const res = await api<{ error: string }>("/api/playlists/PL1/preview", {
      method: "POST",
      body: { dimension: "type", minSize: 1, includeLeftovers: false },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dimension must be one of subgenre, mood, language, decade");
  });

  it("rejects plans with unknown videos or duplicate names", async () => {
    const { api } = await setup();
    const bad = (groups: unknown) =>
      api<{ error: string }>("/api/playlists/PL1/runs", {
        method: "POST",
        body: { dimension: "subgenre", minSize: 1, groups },
      });
    expect((await bad([{ name: "X", videoIds: ["zzz"] }])).status).toBe(400);
    const dup = await bad([
      { name: "House", videoIds: ["a"] },
      { name: "house ", videoIds: ["b"] },
    ]);
    expect(dup.body.error).toMatch(/Duplicate/);
  });

  it("deletes a run that has not been applied", async () => {
    const { api, store } = await setup();
    const { body } = await api<{ runId: number }>("/api/playlists/PL1/runs", {
      method: "POST",
      body: { dimension: "subgenre", minSize: 1, groups: [{ name: "A", videoIds: ["a"] }] },
    });
    expect((await api(`/api/runs/${body.runId}`, { method: "DELETE" })).status).toBe(200);
    expect(store.getRun(body.runId)).toBeUndefined();
  });

  it("adds a playlist from a YouTube Music URL as a background task", async () => {
    const { api, app, store } = await setup();
    const res = await api<JobView>("/api/playlists", {
      method: "POST",
      body: { url: "https://music.youtube.com/playlist?list=PLnew" },
    });
    expect(res.body.kind).toBe("fetch");
    await app.jobs.idle();
    expect(store.getPlaylist("PLnew")?.title).toBe("Fetched Mix");
    expect(store.trackTopics("n1")).toEqual(["Pop music"]);
    expect(app.jobs.current()?.message).toMatch(/Added "Fetched Mix" \(2 tracks/);
    expect(
      (await api("/api/playlists", { method: "POST", body: { url: "nope nope" } })).status,
    ).toBe(400);
  });

  it("refuses a second task while one is running", async () => {
    const { api, app } = await setup();
    app.jobs.start("enrich", "slow", {}, () => new Promise((r) => setTimeout(() => r("ok"), 50)));
    const res = await api("/api/playlists/PL1/enrich", { method: "POST", body: {} });
    expect(res.status).toBe(409);
    await app.jobs.idle();
  });
});

describe("sign-in", () => {
  it("completes the Google redirect only with the matching state", async () => {
    const { api, base, calls } = await setup();
    await api("/api/auth/start", { method: "POST" });
    expect(calls).toEqual(["begin http://127.0.0.1:4747/"]);

    const wrong = await fetch(`${base}/?code=c1&state=bad`, { redirect: "manual" });
    expect(wrong.headers.get("location")).toMatch(/^\/\?authError=/);

    const ok = await api<{ ok: boolean }>("/api/auth/complete", {
      method: "POST",
      body: { url: "http://127.0.0.1:4747/?code=c2&state=s1" },
    });
    expect(ok.status).toBe(200);
    expect(calls).toContain("finish c2");
  });

  it("accepts any recent sign-in, not just the latest, and each only once", async () => {
    const { api, calls } = await setup();
    await api("/api/auth/start", { method: "POST" }); // s1
    await api("/api/auth/start", { method: "POST" }); // s2: clicked twice
    const complete = (state: string) =>
      api<{ error?: string }>("/api/auth/complete", {
        method: "POST",
        body: { url: `http://127.0.0.1:4747/?code=c-${state}&state=${state}` },
      });
    expect((await complete("s1")).status).toBe(200);
    expect(calls).toContain("finish c-s1");
    const reused = await complete("s1");
    expect(reused.status).toBe(400);
    expect(reused.body.error).toMatch(/already used/);
  });

  it("explains access_denied (account not a test user)", async () => {
    const { api } = await setup();
    await api("/api/auth/start", { method: "POST" });
    const res = await api<{ error: string }>("/api/auth/complete", {
      method: "POST",
      body: { url: "http://127.0.0.1:4747/?error=access_denied&state=s1" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Test users/);
  });
});

describe("static files", () => {
  it("serves the built UI with a single-page fallback and no path traversal", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Sortify</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    const { base } = await setup({ staticDir: dir });

    const page = await fetch(`${base}/runs/3`);
    expect(await page.text()).toContain("<title>Sortify</title>");
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(await rawRequest(base, "/..%2F..%2Fetc%2Fpasswd", { host: "localhost" })).toBe(403);
  });
});

describe("PendingAuthStore", () => {
  const pending = (state: string) => ({ url: "u", state, codeVerifier: "v", redirectUri: "r" });

  it("survives a server restart via its file", () => {
    const file = join(tempDir(), "pending.json");
    new PendingAuthStore(file).add(pending("a"));
    const afterRestart = new PendingAuthStore(file);
    expect(afterRestart.take("a")?.state).toBe("a");
    expect(afterRestart.take("a")).toBeUndefined();
  });

  it("forgets sign-ins after 15 minutes", () => {
    const store = new PendingAuthStore(join(tempDir(), "pending.json"));
    store.add(pending("old"), 0);
    store.add(pending("new"), 10 * 60_000);
    expect(store.take("old", 16 * 60_000)).toBeUndefined();
    expect(store.take("new", 16 * 60_000)?.state).toBe("new");
  });
});
