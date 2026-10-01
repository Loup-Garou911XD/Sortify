import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Store } from "../src/db.ts";
import { DriveAuthError, DriveSnapshots } from "../src/sync/drive.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import type { Snapshot } from "../src/sync/snapshot.ts";

/** A Drive that lives in memory, counting what the engine asked it to do. */
class FakeDrive {
  file: { id: string; modifiedTime: string } | undefined;
  content: Snapshot | undefined;
  calls = { find: 0, download: 0, create: 0, update: 0 };
  /** Runs before a lookup answers, to simulate another device writing first. */
  beforeFind?: () => void;
  private clock = 0;

  private stamp(): string {
    this.clock++;
    return new Date(this.clock * 1000).toISOString();
  }

  async find() {
    this.calls.find++;
    this.beforeFind?.();
    return this.file;
  }

  async download() {
    this.calls.download++;
    if (!this.content) throw new Error("nothing stored");
    return structuredClone(this.content);
  }

  async create(snapshot: Snapshot) {
    this.calls.create++;
    this.content = structuredClone(snapshot);
    this.file = { id: "f1", modifiedTime: this.stamp() };
    return this.file;
  }

  async update(_file: { id: string; modifiedTime: string }, snapshot: Snapshot) {
    this.calls.update++;
    this.content = structuredClone(snapshot);
    this.file = { id: "f1", modifiedTime: this.stamp() };
    return this.file;
  }

  /** Another device writing behind this one's back. */
  writeExternally(snapshot: Snapshot): void {
    this.content = structuredClone(snapshot);
    this.file = { id: "f1", modifiedTime: this.stamp() };
  }
}

const engineFor = (store: Store, drive: FakeDrive) =>
  new SyncEngine(store, drive as unknown as DriveSnapshots);

function seeded(playlistId: string, videoId: string): Store {
  const store = new Store(":memory:");
  store.savePlaylist(playlistId, `List ${playlistId}`, [
    { videoId, title: `Song ${videoId}`, channel: "Chan" },
  ]);
  return store;
}

describe("SyncEngine", () => {
  it("creates the file on a first sync", async () => {
    const drive = new FakeDrive();
    const store = seeded("PL1", "a");
    const result = await engineFor(store, drive).sync();
    assert.equal(result.state, "idle");
    assert.equal(drive.calls.create, 1);
    assert.equal(drive.calls.update, 0);
    assert.equal(drive.content?.playlists[0]?.playlistId, "PL1");
  });

  it("carries one device's work to another", async () => {
    const drive = new FakeDrive();
    const laptop = seeded("PL1", "a");
    const phone = seeded("PL2", "b");

    await engineFor(laptop, drive).sync();
    await engineFor(phone, drive).sync();

    assert.deepEqual(
      phone
        .listPlaylists()
        .map((p) => p.playlistId)
        .sort(),
      ["PL1", "PL2"],
      "the phone now has both",
    );
    assert.deepEqual(
      (drive.content?.playlists ?? []).map((p) => p.playlistId).sort(),
      ["PL1", "PL2"],
      "and pushed the union back",
    );
  });

  it("never sends a copy that would drop the other device's work", async () => {
    const drive = new FakeDrive();
    const laptop = seeded("PL1", "a");
    const phone = seeded("PL2", "b");
    await engineFor(laptop, drive).sync();
    await engineFor(phone, drive).sync();

    // The laptop syncs again, knowing nothing of PL2 until it pulls.
    await engineFor(laptop, drive).sync();
    assert.deepEqual(
      laptop
        .listPlaylists()
        .map((p) => p.playlistId)
        .sort(),
      ["PL1", "PL2"],
    );
    assert.equal(drive.content?.playlists.length, 2, "the remote still holds both");
  });

  it("starts the cycle again when the remote moved between merge and push", async () => {
    const drive = new FakeDrive();
    const laptop = seeded("PL1", "a");
    await engineFor(laptop, drive).sync();

    // A phone lands a playlist after the laptop pulled but before it pushes, which is the
    // window the pre-write check exists to catch.
    const phone = seeded("PL2", "b");
    // The third lookup is the check the push makes just before writing; landing the other
    // device's write exactly there is the window this guard exists for.
    drive.beforeFind = () => {
      if (drive.calls.find === 3) drive.writeExternally(phone.snapshot());
    };

    laptop.savePlaylist("PL3", "Third", [{ videoId: "c", title: "Song C", channel: "Chan" }]);
    const result = await engineFor(laptop, drive).sync();

    assert.equal(result.state, "idle");
    assert.ok(drive.calls.download >= 2, "it went back and folded in the newer copy");
    assert.deepEqual(
      (drive.content?.playlists ?? []).map((p) => p.playlistId).sort(),
      ["PL1", "PL2", "PL3"],
      "nothing was lost in the race",
    );
  });

  it("restores its own data after being overwritten by another device", async () => {
    // Drive has no atomic compare-and-swap, so a push can be clobbered. What must hold is that
    // the clobbered device puts its data back on its next sync.
    const drive = new FakeDrive();
    const laptop = seeded("PL1", "a");
    const laptopEngine = engineFor(laptop, drive);
    await laptopEngine.sync();

    const phone = seeded("PL2", "b");
    drive.writeExternally(phone.snapshot()); // the laptop's copy is gone from the remote
    assert.deepEqual(
      (drive.content?.playlists ?? []).map((p) => p.playlistId),
      ["PL2"],
    );

    await laptopEngine.sync();
    assert.deepEqual(
      (drive.content?.playlists ?? []).map((p) => p.playlistId).sort(),
      ["PL1", "PL2"],
      "the laptop merged and restored what was dropped",
    );
  });

  it("reports a missing permission as needing sign-in, not as being offline", async () => {
    const drive = new FakeDrive();
    drive.find = async () => {
      throw new DriveAuthError("Google refused access to the Sortify sync folder.");
    };
    const result = await engineFor(seeded("PL1", "a"), drive).sync();
    assert.equal(result.state, "needs-auth");
    assert.match(result.message ?? "", /refused access/);
  });

  it("reports a network failure as offline and keeps the local data", async () => {
    const drive = new FakeDrive();
    drive.find = async () => {
      throw new Error("fetch failed");
    };
    const store = seeded("PL1", "a");
    const result = await engineFor(store, drive).sync();
    assert.equal(result.state, "offline");
    assert.equal(store.listPlaylists().length, 1, "local data is untouched");
  });

  it("shares one cycle between concurrent callers", async () => {
    const drive = new FakeDrive();
    const engine = engineFor(seeded("PL1", "a"), drive);
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    assert.equal(drive.calls.create, 1, "not three files");
  });

  it("does not re-download a copy it has already folded in", async () => {
    const drive = new FakeDrive();
    const engine = engineFor(seeded("PL1", "a"), drive);
    await engine.sync();
    const after = drive.calls.download;
    await engine.sync();
    assert.equal(drive.calls.download, after, "second sync downloaded nothing new");
  });
});

describe("DriveSnapshots", () => {
  const token = async () => ({ token: "t" });

  it("asks only for its own hidden folder", async () => {
    let seen = "";
    const drive = new DriveSnapshots({
      getAccessToken: token,
      fetch: async (url) => {
        seen = url;
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      },
    });
    await drive.find();
    // URLSearchParams writes spaces as "+", which decodeURIComponent leaves alone.
    const query = decodeURIComponent(seen).replaceAll("+", " ");
    assert.match(query, /spaces=appDataFolder/);
    assert.match(query, /trashed = false/);
    assert.doesNotMatch(query, /spaces=drive/, "never the user's own files");
  });

  it("sends the token and reads back the new modifiedTime", async () => {
    let auth: string | undefined;
    const drive = new DriveSnapshots({
      getAccessToken: token,
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? undefined;
        return new Response(
          JSON.stringify({ id: "f1", modifiedTime: "2026-01-01T00:00:00.000Z" }),
          {
            status: 200,
          },
        );
      },
    });
    const file = await drive.create({} as Snapshot);
    assert.equal(auth, "Bearer t");
    assert.equal(file.modifiedTime, "2026-01-01T00:00:00.000Z");
  });

  it("turns a refused request into a sign-in problem", async () => {
    const drive = new DriveSnapshots({
      getAccessToken: token,
      fetch: async () => new Response("{}", { status: 403 }),
    });
    await assert.rejects(() => drive.find(), DriveAuthError);
  });

  it("tells a missing scope apart from a disabled API", async () => {
    // Both arrive as 403 and the fix for one is no use for the other.
    const refuse = (body: string) =>
      new DriveSnapshots({
        getAccessToken: token,
        fetch: async () => new Response(body, { status: 403 }),
      });

    const scope = refuse(
      JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }),
    );
    await assert.rejects(
      () => scope.find(),
      (err: Error) => /connect YouTube again/i.test(err.message),
    );

    const disabled = refuse(
      JSON.stringify({
        error: {
          message: "Google Drive API has not been used in project 1 before or it is disabled.",
          errors: [{ reason: "accessNotConfigured" }],
        },
      }),
    );
    await assert.rejects(
      () => disabled.find(),
      (err: Error) => /Drive API, which is not enabled/i.test(err.message),
    );
  });
});
