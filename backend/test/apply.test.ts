import { describe, expect, it } from "vitest";
import { applyRun, type PlaylistWriter, playlistTitle } from "../src/apply.ts";
import { Store } from "../src/db.ts";
import { QuotaExceededError, YouTubeApiError } from "../src/youtube/client.ts";

/** In-memory YouTube account that can run out of quota after N writes. */
class FakeYouTube implements PlaylistWriter {
  quotaUsed = 0;
  playlists = new Map<string, { title: string; description: string; videos: string[] }>();
  writesLeft = Number.POSITIVE_INFINITY;
  unavailable = new Set<string>();
  /** Simulates a crash after the API call succeeded but before the store recorded it. */
  crashAfterNextWrite = false;

  private write(): void {
    if (this.writesLeft <= 0) throw new QuotaExceededError();
    this.writesLeft--;
    this.quotaUsed += 50;
  }

  private maybeCrash(): void {
    if (this.crashAfterNextWrite) {
      this.crashAfterNextWrite = false;
      throw new Error("crash");
    }
  }

  async myPlaylists() {
    this.quotaUsed += 1;
    return [...this.playlists].map(([id, p]) => ({
      id,
      title: p.title,
      description: p.description,
    }));
  }

  async playlistVideoIds(playlistId: string) {
    this.quotaUsed += 1;
    return new Set(this.playlists.get(playlistId)?.videos ?? []);
  }

  async createPlaylist(title: string, description: string) {
    this.write();
    const id = `P${this.playlists.size + 1}`;
    this.playlists.set(id, { title, description, videos: [] });
    this.maybeCrash();
    return id;
  }

  async addToPlaylist(playlistId: string, videoId: string) {
    this.write();
    if (this.unavailable.has(videoId)) throw new YouTubeApiError(404, "videoNotFound", "gone");
    this.playlists.get(playlistId)?.videos.push(videoId);
    this.maybeCrash();
  }
}

function setup() {
  const store = new Store(":memory:");
  store.savePlaylist(
    "SRC",
    "Big Mix",
    ["a", "b", "c"].map((id) => ({ videoId: id, title: id, channel: "" })),
  );
  const runId = store.createRun("SRC", "subgenre", 1, [
    { name: "House", videoIds: ["a", "b", "c"] },
    { name: "Techno", videoIds: ["a"] },
  ]);
  return { store, runId, yt: new FakeYouTube() };
}

const contents = (yt: FakeYouTube) =>
  Object.fromEntries([...yt.playlists.values()].map((p) => [p.title, p.videos]));

describe("applyRun", () => {
  it("creates one playlist per group and adds every track", async () => {
    const { store, runId, yt } = setup();
    const result = await applyRun(store, yt, runId, { privacy: "private" });
    expect(result).toMatchObject({ status: "done", playlistsCreated: 2, tracksAdded: 4 });
    expect(contents(yt)).toEqual({ "Big Mix · House": ["a", "b", "c"], "Big Mix · Techno": ["a"] });
    expect(store.getRun(runId)).toMatchObject({ status: "done", writesDone: 6 });
  });

  it("pauses at the quota and resumes without duplicates", async () => {
    const { store, runId, yt } = setup();
    yt.writesLeft = 3;
    const first = await applyRun(store, yt, runId, { privacy: "private" });
    expect(first).toMatchObject({ status: "paused", reason: "quota" });
    expect(store.getRun(runId)?.status).toBe("paused");

    yt.writesLeft = Number.POSITIVE_INFINITY;
    const second = await applyRun(store, yt, runId, { privacy: "private" });
    expect(second.status).toBe("done");
    expect(contents(yt)).toEqual({ "Big Mix · House": ["a", "b", "c"], "Big Mix · Techno": ["a"] });
  });

  it("stops at --max-writes", async () => {
    const { store, runId, yt } = setup();
    const result = await applyRun(store, yt, runId, { privacy: "private", maxWrites: 2 });
    expect(result).toMatchObject({
      status: "paused",
      reason: "limit",
      playlistsCreated: 1,
      tracksAdded: 1,
    });
  });

  it("recovers from a crash between a successful call and saving progress", async () => {
    const { store, runId, yt } = setup();
    yt.crashAfterNextWrite = true; // playlist created on YouTube, id never stored
    await expect(applyRun(store, yt, runId, { privacy: "private" })).rejects.toThrow("crash");
    await applyRun(store, yt, runId, { privacy: "private" });
    expect(yt.playlists.size).toBe(2);

    const again = setup();
    await applyRun(again.store, again.yt, again.runId, { privacy: "private", maxWrites: 1 });
    again.yt.crashAfterNextWrite = true; // track added on YouTube, not marked written
    await expect(
      applyRun(again.store, again.yt, again.runId, { privacy: "private" }),
    ).rejects.toThrow("crash");
    await applyRun(again.store, again.yt, again.runId, { privacy: "private" });
    expect(contents(again.yt)["Big Mix · House"]).toEqual(["a", "b", "c"]);
  });

  it("skips videos that became unavailable", async () => {
    const { store, runId, yt } = setup();
    yt.unavailable.add("b");
    const result = await applyRun(store, yt, runId, { privacy: "private" });
    expect(result).toMatchObject({ status: "done", tracksAdded: 3, tracksSkipped: 1 });
  });
});

describe("playlistTitle", () => {
  it("keeps titles within YouTube's 150-character limit", () => {
    const title = playlistTitle("x".repeat(200), "Drum and Bass");
    expect(title.length).toBe(150);
    expect(title.endsWith("… · Drum and Bass")).toBe(true);
  });
});
