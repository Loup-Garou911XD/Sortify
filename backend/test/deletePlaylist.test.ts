import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Store } from "../src/db.ts";

function twoPlaylists(): Store {
  const store = new Store(":memory:");
  // "shared" is in both lists; "onlyA" and "onlyB" in one each.
  store.savePlaylist("A", "List A", [
    { videoId: "shared", title: "Shared", channel: "C" },
    { videoId: "onlyA", title: "Only A", channel: "C" },
  ]);
  store.savePlaylist("B", "List B", [
    { videoId: "shared", title: "Shared", channel: "C" },
    { videoId: "onlyB", title: "Only B", channel: "C" },
  ]);
  for (const videoId of ["shared", "onlyA", "onlyB"]) {
    store.saveEnrichment(
      videoId,
      { artist: "A", songTitle: "S", externalIds: {}, failedProviders: [] },
      [{ dimension: "subgenre", value: "Pop", rawTag: "pop", source: "lastfm", weight: 1 }],
    );
  }
  store.cachePut("discogs", "a-s", { styles: ["Pop"] });
  return store;
}

describe("deletePlaylist", () => {
  it("forgets the playlist and the tracks only it held", () => {
    const store = twoPlaylists();
    store.deletePlaylist("A");

    assert.equal(store.getPlaylist("A"), undefined);
    assert.deepEqual(
      store.listPlaylists().map((p) => p.playlistId),
      ["B"],
    );
    const left = store.playlistTracks("B").map((t) => t.videoId);
    assert.deepEqual(left.sort(), ["onlyB", "shared"], "the other list is intact");
  });

  it("keeps a track that another playlist still holds", () => {
    const store = twoPlaylists();
    store.deletePlaylist("A");
    const tags = store.playlistAllTags("B").map((t) => t.videoId);
    assert.ok(tags.includes("shared"), "a shared track keeps its tags");
    assert.equal(tags.includes("onlyA"), false, "the orphan's tags are gone");
  });

  it("keeps the lookup cache, which is not playlist-specific", () => {
    const store = twoPlaylists();
    store.deletePlaylist("A");
    assert.deepEqual(store.cacheGet("discogs", "a-s"), { styles: ["Pop"] }, "tagging work is kept");
  });

  it("takes the plans made from it, and leaves other plans alone", () => {
    const store = twoPlaylists();
    const fromA = store.createRun("A", "subgenre", 1, [{ name: "Pop", videoIds: ["onlyA"] }]);
    const fromB = store.createRun("B", "subgenre", 1, [{ name: "Pop", videoIds: ["onlyB"] }]);
    store.deletePlaylist("A");

    assert.equal(store.getRun(fromA), undefined, "its plan is gone");
    assert.notEqual(store.getRun(fromB), undefined, "the other playlist's plan survives");
    assert.equal(store.runGroups(fromA).length, 0, "and so are its groups");
  });

  it("is harmless when the playlist is already gone", () => {
    const store = twoPlaylists();
    store.deletePlaylist("A");
    store.deletePlaylist("A");
    assert.equal(store.listPlaylists().length, 1);
  });

  it("empties the store when the last playlist goes", () => {
    const store = twoPlaylists();
    store.deletePlaylist("A");
    store.deletePlaylist("B");
    assert.deepEqual(store.listPlaylists(), []);
    assert.deepEqual(store.snapshot().tracks, [], "no orphaned tracks are left behind");
    assert.deepEqual(store.snapshot().tags, []);
  });
});
