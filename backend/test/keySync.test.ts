import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { forgetKeys, setKeySync, shareKeys } from "../src/server/keys.ts";
import {
  type KeySnapshot,
  keyChanges,
  liveKeys,
  mergeKeys,
  providerEnv,
  setUsesSyncedKeys,
  withSyncedKeys,
} from "../src/sync/keys.ts";
import { emptySnapshot, mergeSnapshots, normalizeSnapshot } from "../src/sync/snapshot.ts";

const key = (name: string, value: string | null, at: string): KeySnapshot => ({ name, value, at });

describe("synced keys: merging", () => {
  it("keeps the newest change per key, removals included", () => {
    const cutoff = "2026-01-01T00:00:00.000Z";
    const merged = mergeKeys(
      [
        key("DISCOGS_TOKEN", "old", "2026-02-01T00:00:00Z"),
        key("LASTFM_API_KEY", "a", "2026-03-01T00:00:00Z"),
      ],
      [
        key("DISCOGS_TOKEN", "new", "2026-02-02T00:00:00Z"),
        key("LASTFM_API_KEY", null, "2026-03-02T00:00:00Z"),
        // A removal so old every device has seen it: dropped.
        key("SPOTIFY_CLIENT_ID", null, "2025-06-01T00:00:00Z"),
      ],
      cutoff,
    );
    expect(merged).toEqual([
      key("DISCOGS_TOKEN", "new", "2026-02-02T00:00:00Z"),
      key("LASTFM_API_KEY", null, "2026-03-02T00:00:00Z"),
    ]);
    expect(liveKeys(merged)).toEqual({ DISCOGS_TOKEN: "new" });
  });

  it("never lets a Google key or a malformed entry in from a remote file", () => {
    const remote = normalizeSnapshot({
      keys: [
        key("DISCOGS_TOKEN", "d", "2026-01-01T00:00:00Z"),
        key("GOOGLE_CLIENT_SECRET", "g", "2026-01-01T00:00:00Z"),
        key("SORTIFY_CLIENT_SECRETS", "{}", "2026-01-01T00:00:00Z"),
        { name: "LASTFM_API_KEY", value: 42, at: "x" },
        "junk",
      ] as unknown as KeySnapshot[],
    });
    expect(remote.keys.map((k) => k.name)).toEqual(["DISCOGS_TOKEN"]);
    expect(keyChanges({ GOOGLE_CLIENT_ID: "g", LASTFM_API_KEY: " l " })).toMatchObject([
      { name: "LASTFM_API_KEY", value: "l" },
    ]);
  });

  it("reports keys a merge brought in, and reads a snapshot from before keys existed", () => {
    const { merged, notes } = mergeSnapshots(emptySnapshot(), {
      ...emptySnapshot(),
      keys: [key("DISCOGS_TOKEN", "d", new Date().toISOString())],
    });
    expect(notes.added.keys).toBe(1);
    expect(merged.keys.map((k) => k.name)).toEqual(["DISCOGS_TOKEN"]);
    const { keys: _keys, ...older } = emptySnapshot();
    expect(normalizeSnapshot(older).keys).toEqual([]);
  });
});

describe("synced keys: the SQLite store", () => {
  it("carries keys through a sync, but never this device's own settings", () => {
    const a = new Store(":memory:");
    a.putSyncedKeys(keyChanges({ DISCOGS_TOKEN: "d", LASTFM_API_KEY: "l" }));
    setUsesSyncedKeys(a, true);
    const b = new Store(":memory:");
    b.absorb(a.snapshot());
    expect(liveKeys(b.syncedKeys())).toEqual({ DISCOGS_TOKEN: "d", LASTFM_API_KEY: "l" });
    // The switch is per device: b has not opted in just because a did.
    expect(b.localSetting("usesSyncedKeys")).toBeUndefined();

    // A removal on b travels back and wins over a's older value.
    b.putSyncedKeys(keyChanges({ LASTFM_API_KEY: "" }));
    a.absorb(b.snapshot());
    expect(liveKeys(a.syncedKeys())).toEqual({ DISCOGS_TOKEN: "d" });
  });
});

describe("synced keys: what providers see", () => {
  it("fills only the gaps, and only on a device that opted in", () => {
    const store = new Store(":memory:");
    store.putSyncedKeys(keyChanges({ DISCOGS_TOKEN: "synced", LASTFM_API_KEY: "synced" }));
    const local = { DISCOGS_TOKEN: "mine", LASTFM_API_KEY: "  " };

    expect(providerEnv(local, store)).toEqual({ env: local, fromSync: [] });
    setUsesSyncedKeys(store, true);
    expect(providerEnv(local, store)).toEqual({
      env: { DISCOGS_TOKEN: "mine", LASTFM_API_KEY: "synced" },
      fromSync: ["LASTFM_API_KEY"],
    });
    expect(withSyncedKeys({}, {}).fromSync).toEqual([]);
  });
});

describe("synced keys: the routes", () => {
  /** A browser's own keys: readable and writable, like localStorage. */
  function browser(initial: Record<string, string>) {
    let keys = { ...initial };
    return {
      device: {
        read: () => keys,
        write: (values: Record<string, string>) => {
          const next = { ...keys };
          for (const [k, v] of Object.entries(values)) {
            if (v.trim()) next[k] = v;
            else delete next[k];
          }
          keys = next;
        },
      },
      keys: () => keys,
    };
  }

  it("moves a browser's keys into the sync file and back, keeping the Google client local", () => {
    const store = new Store(":memory:");
    const b = browser({ DISCOGS_TOKEN: "d", GOOGLE_CLIENT_ID: "g" });

    expect(setKeySync(store, b.device, { enabled: true })).toEqual({
      enabled: true,
      inDrive: ["DISCOGS_TOKEN"],
      keysMovable: true,
    });
    expect(b.keys()).toEqual({ GOOGLE_CLIENT_ID: "g" });
    expect(providerEnv(b.keys(), store).env.DISCOGS_TOKEN).toBe("d");

    // Turning it off copies the synced keys back, so nothing stops working here.
    setKeySync(store, b.device, { enabled: false });
    expect(b.keys()).toEqual({ GOOGLE_CLIENT_ID: "g", DISCOGS_TOKEN: "d" });
  });

  it("shares .env keys without touching them, and forgets them everywhere", () => {
    const store = new Store(":memory:");
    const env = { read: () => ({ DISCOGS_TOKEN: "d", SORTIFY_CLIENT_SECRETS: "{}" }) };

    expect(() => shareKeys(store, env)).toThrow(/Turn on key sync/);
    setKeySync(store, env, { enabled: true });
    // Nothing moves on enabling: a server cannot rewrite its .env.
    expect(liveKeys(store.syncedKeys())).toEqual({});
    expect(shareKeys(store, env).inDrive).toEqual(["DISCOGS_TOKEN"]);

    expect(forgetKeys(store, env)).toEqual({ enabled: false, inDrive: [], keysMovable: false });
    // Forgetting leaves a removal behind, so a merge cannot bring the key back.
    expect(store.syncedKeys()).toMatchObject([{ name: "DISCOGS_TOKEN", value: null }]);
    expect(() => setKeySync(store, env, { enabled: "yes" })).toThrow(/true or false/);
  });

  it("does not resurrect a forgotten key from a device that still holds it", () => {
    const mine = new Store(":memory:");
    const theirs = new Store(":memory:");
    mine.putSyncedKeys([key("DISCOGS_TOKEN", "d", "2026-01-01T00:00:00.000Z")]);
    theirs.absorb(mine.snapshot());
    forgetKeys(mine, { read: () => ({}) });
    mine.absorb(theirs.snapshot());
    expect(liveKeys(mine.syncedKeys())).toEqual({});
  });
});
