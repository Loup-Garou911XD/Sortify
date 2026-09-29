import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView, PlaylistDetail, PreviewResponse, RunDetail } from "../src/api/types.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { type AppDeps, createApp, type YouTubeApi } from "../src/server/app.ts";

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
  async videoDurations(ids: string[]) {
    return new Map(ids.map((id) => [id, 200]));
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
    store.saveEnrichment(id, { artist: "X", songTitle: id, mbid: null, discogsId: null }, [
      { dimension: "subgenre", value, rawTag: value, source: "discogs", weight: 1 },
    ]);
  }
  const yt = new FakeYouTube();
  const calls: string[] = [];
  const app = createApp({
    config: { ...loadConfig({}), discogsToken: "t", lastfmApiKey: undefined },
    store,
    youtube: () => yt,
    port: 4747,
    auth: {
      state: () => ({ hasClientSecrets: true, signedIn: false }),
      begin: async (_config, redirectUri) => {
        calls.push(`begin ${redirectUri}`);
        return {
          url: "https://accounts.google.com/x",
          state: "s1",
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
    const { body } = await api<{ sources: Record<string, boolean>; signedIn: boolean }>(
      "/api/status",
    );
    expect(body.sources).toEqual({ musicbrainz: true, discogs: true, lastfm: false });
    expect(body.signedIn).toBe(false);
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
    const del = await api(`/api/runs/${runId}`, { method: "DELETE" });
    expect(del.status).toBe(409);
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
});

describe("static files", () => {
  it("serves the built UI with a single-page fallback and no path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sortify-web-"));
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
