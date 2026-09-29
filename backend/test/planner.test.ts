import { describe, expect, it } from "vitest";
import type { Track, TrackTag } from "../src/db.ts";
import { estimateQuota, planGroups } from "../src/planner.ts";

const track = (videoId: string): Track => ({
  videoId,
  title: videoId,
  channel: "",
  durationS: null,
  artist: null,
  songTitle: null,
  externalIds: {},
  enrichedAt: "2026-01-01",
});

const tag = (videoId: string, value: string, weight = 1): TrackTag => ({
  videoId,
  dimension: "subgenre",
  value,
  rawTag: value,
  source: "discogs",
  weight,
});

describe("planGroups", () => {
  const tracks = ["a", "b", "c", "d", "e"].map(track);
  const tags = [
    tag("a", "House"),
    tag("a", "Techno", 0.5),
    tag("b", "House"),
    tag("c", "Techno"),
    tag("c", "House", 0.2),
    tag("d", "Dub"),
  ];

  it("puts tracks in every matching group, in playlist order", () => {
    const plan = planGroups(tracks, tags, {
      dimension: "subgenre",
      minSize: 1,
      includeLeftovers: true,
    });
    expect(plan.groups).toEqual([
      { name: "House", videoIds: ["a", "b", "c"] },
      { name: "Techno", videoIds: ["a", "c"] },
      { name: "Dub", videoIds: ["d"] },
      { name: "Unsorted", videoIds: ["e"] },
    ]);
    expect(plan.tagged).toBe(4);
  });

  it("drops small groups and sends orphaned tracks to Other", () => {
    const plan = planGroups(tracks, tags, {
      dimension: "subgenre",
      minSize: 2,
      includeLeftovers: true,
    });
    expect(plan.groups.map((g) => g.name)).toEqual(["House", "Techno", "Other", "Unsorted"]);
    expect(plan.groups.find((g) => g.name === "Other")?.videoIds).toEqual(["d"]);
    expect(plan.dropped).toEqual([{ name: "Dub", size: 1 }]);
  });

  it("caps groups per track by weight", () => {
    const plan = planGroups(tracks, tags, {
      dimension: "subgenre",
      minSize: 1,
      maxGroupsPerTrack: 1,
      includeLeftovers: false,
    });
    expect(plan.groups).toEqual([
      { name: "House", videoIds: ["a", "b"] },
      { name: "Dub", videoIds: ["d"] },
      { name: "Techno", videoIds: ["c"] },
    ]);
  });

  it("adds up weights from sources that agree", () => {
    const plan = planGroups(
      [track("a")],
      [
        tag("a", "House", 0.6),
        { ...tag("a", "House", 0.6), source: "lastfm" },
        tag("a", "Techno", 1),
      ],
      { dimension: "subgenre", minSize: 1, maxGroupsPerTrack: 1, includeLeftovers: false },
    );
    expect(plan.groups.map((g) => g.name)).toEqual(["House"]);
  });
});

describe("estimateQuota", () => {
  it("charges 50 units per playlist and per addition", () => {
    const est = estimateQuota(
      [
        { name: "A", videoIds: ["1", "2", "3"] },
        { name: "B", videoIds: ["1"] },
      ],
      100,
    );
    expect(est).toEqual({ playlists: 2, additions: 4, units: 300, days: 3 });
  });
});

describe("Store migration", () => {
  it("moves per-provider id columns into external_ids", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { Store } = await import("../src/db.ts");
    const { tempDir } = await import("./helpers.ts");
    const path = `${tempDir()}/old.db`;
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE tracks (video_id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '',
        duration_s INTEGER, artist TEXT, song_title TEXT, mbid TEXT, discogs_id TEXT, enriched_at TEXT);
      CREATE TABLE playlist_items (playlist_id TEXT NOT NULL, video_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, video_id));
      INSERT INTO tracks (video_id, title, mbid, discogs_id) VALUES ('a', 'A', 'mb-1', 'master/2'), ('b', 'B', NULL, NULL);
      INSERT INTO playlist_items VALUES ('PL', 'a', 0), ('PL', 'b', 1);`);
    old.close();

    const store = new Store(path);
    expect(store.playlistTracks("PL").map((t) => t.externalIds)).toEqual([
      { musicbrainz: "mb-1", discogs: "master/2" },
      {},
    ]);
    store.close();
    // Opening again is a no-op.
    expect(new Store(path).playlistTracks("PL")).toHaveLength(2);
  });
});
