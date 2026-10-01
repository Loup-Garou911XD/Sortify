import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Tag } from "../src/db.ts";
import {
  emptySnapshot,
  idsAreFrozen,
  isQuiet,
  mergeSnapshots,
  type RunSnapshot,
  type Snapshot,
  type TrackSnapshot,
} from "../src/sync/snapshot.ts";

const track = (videoId: string, over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  videoId,
  title: `Song ${videoId}`,
  channel: "Chan",
  durationS: null,
  topics: null,
  artist: null,
  songTitle: null,
  externalIds: {},
  failedProviders: [],
  enrichedAt: null,
  ...over,
});

const tag = (value: string): Tag => ({
  dimension: "subgenre",
  value,
  rawTag: value.toLowerCase(),
  source: "lastfm",
  weight: 1,
});

const run = (runId: number, over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  runId,
  sourcePlaylistId: "PL1",
  dimension: "subgenre",
  minSize: 5,
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "planned",
  quotaUsed: 0,
  writesDone: 0,
  groups: [
    {
      groupId: runId * 10,
      name: "Pop",
      targetPlaylistId: null,
      items: [{ videoId: "a", position: 0, written: false }],
    },
  ],
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ ...emptySnapshot(), ...over });

describe("mergeSnapshots", () => {
  it("keeps work done on either side", () => {
    const local = snap({ tracks: [track("a", { enrichedAt: "2026-01-02T00:00:00.000Z" })] });
    const remote = snap({ tracks: [track("b", { enrichedAt: "2026-01-03T00:00:00.000Z" })] });
    const { merged, notes } = mergeSnapshots(local, remote);
    assert.deepEqual(merged.tracks.map((t) => t.videoId).sort(), ["a", "b"], "both tracks survive");
    assert.equal(notes.added.tracks, 1);
  });

  it("prefers the more recently tagged copy of a track", () => {
    const stale = track("a", { enrichedAt: "2026-01-01T00:00:00.000Z", artist: "Old" });
    const fresh = track("a", { enrichedAt: "2026-01-05T00:00:00.000Z", artist: "New" });
    assert.equal(
      mergeSnapshots(snap({ tracks: [stale] }), snap({ tracks: [fresh] })).merged.tracks[0]?.artist,
      "New",
    );
    assert.equal(
      mergeSnapshots(snap({ tracks: [fresh] }), snap({ tracks: [stale] })).merged.tracks[0]?.artist,
      "New",
    );
  });

  it("keeps details that cost quota even when the other copy wins", () => {
    const local = track("a", { enrichedAt: "2026-01-05T00:00:00.000Z" });
    const remote = track("a", {
      enrichedAt: "2026-01-01T00:00:00.000Z",
      durationS: 210,
      topics: ["Pop music"],
    });
    const merged = mergeSnapshots(snap({ tracks: [local] }), snap({ tracks: [remote] })).merged;
    assert.equal(merged.tracks[0]?.enrichedAt, "2026-01-05T00:00:00.000Z", "newer tagging wins");
    assert.equal(merged.tracks[0]?.durationS, 210, "but the fetched duration is kept");
    assert.deepEqual(merged.tracks[0]?.topics, ["Pop music"]);
  });

  it("follows the winning track when choosing tags", () => {
    const local = snap({
      tracks: [track("a", { enrichedAt: "2026-01-01T00:00:00.000Z" })],
      tags: [{ videoId: "a", tags: [tag("Pop")] }],
    });
    const remote = snap({
      tracks: [track("a", { enrichedAt: "2026-01-09T00:00:00.000Z" })],
      tags: [{ videoId: "a", tags: [tag("Rock")] }],
    });
    assert.equal(mergeSnapshots(local, remote).merged.tags[0]?.tags[0]?.value, "Rock");
  });

  it("unions the lookup cache", () => {
    const local = snap({ cache: [{ source: "discogs", key: "x", body: 1 }] });
    const remote = snap({
      cache: [
        { source: "discogs", key: "x", body: 2 },
        { source: "lastfm", key: "y", body: 3 },
      ],
    });
    const { merged, notes } = mergeSnapshots(local, remote);
    assert.equal(merged.cache.length, 2);
    assert.equal(merged.cache.find((c) => c.source === "discogs")?.body, 1, "local entry kept");
    assert.equal(notes.added.cache, 1);
  });

  it("takes the newer fetch of a playlist whole", () => {
    const local = snap({
      playlists: [{ playlistId: "PL1", title: "Old", fetchedAt: "2026-01-01", videoIds: ["a"] }],
    });
    const remote = snap({
      playlists: [
        { playlistId: "PL1", title: "New", fetchedAt: "2026-02-01", videoIds: ["a", "b"] },
      ],
    });
    const merged = mergeSnapshots(local, remote).merged;
    assert.equal(merged.playlists[0]?.title, "New");
    assert.deepEqual(merged.playlists[0]?.videoIds, ["a", "b"]);
  });
});

describe("mergeSnapshots: runs", () => {
  it("combines progress when both sides hold the same run", () => {
    const base = run(1, { status: "paused" });
    const group = base.groups[0] ?? { groupId: 10, name: "Pop", targetPlaylistId: null, items: [] };
    const local: RunSnapshot = {
      ...base,
      writesDone: 2,
      quotaUsed: 100,
      groups: [
        {
          ...group,
          targetPlaylistId: "PLnew",
          items: [{ videoId: "a", position: 0, written: false }],
        },
      ],
    };
    const remote: RunSnapshot = {
      ...base,
      writesDone: 5,
      quotaUsed: 250,
      groups: [
        {
          ...group,
          targetPlaylistId: null,
          items: [{ videoId: "a", position: 0, written: true }],
        },
      ],
    };
    const merged = mergeSnapshots(snap({ runs: [local] }), snap({ runs: [remote] })).merged;
    assert.equal(merged.runs.length, 1, "not duplicated");
    assert.equal(merged.runs[0]?.writesDone, 5, "progress moves forward only");
    assert.equal(merged.runs[0]?.quotaUsed, 250);
    assert.equal(merged.runs[0]?.groups[0]?.targetPlaylistId, "PLnew", "a recorded target is kept");
    assert.equal(
      merged.runs[0]?.groups[0]?.items[0]?.written,
      true,
      "a written track stays written",
    );
  });

  it("renumbers a different run that collided on an id", () => {
    const local = run(1, { createdAt: "2026-01-01T00:00:00.000Z" });
    const remote = run(1, { createdAt: "2026-02-02T00:00:00.000Z" });
    const { merged, notes } = mergeSnapshots(
      snap({ runs: [local], seq: { run: 1, group: 10 } }),
      snap({ runs: [remote], seq: { run: 1, group: 10 } }),
    );
    assert.equal(merged.runs.length, 2, "both runs survive");
    assert.equal(merged.runs[0]?.runId, 1);
    assert.equal(notes.renumbered.length, 1);
    assert.equal(notes.renumbered[0]?.from, 1);
    const moved = merged.runs.find((r) => r.runId !== 1);
    assert.equal(moved?.createdAt, "2026-02-02T00:00:00.000Z");
    assert.notEqual(moved?.groups[0]?.groupId, 10, "its groups are renumbered too");
    assert.ok(merged.seq.run >= 2 && merged.seq.group > 10, "the counters move past both");
  });

  it("never renumbers a run whose marker may be live on YouTube", () => {
    // Mid-apply with an unrecorded target: a playlist carrying [sortify run 1 group 10] may
    // exist on YouTube, and moving the id would orphan it.
    const frozen = run(1, {
      createdAt: "2026-02-02T00:00:00.000Z",
      status: "paused",
      groups: [
        {
          groupId: 10,
          name: "Pop",
          targetPlaylistId: null,
          items: [{ videoId: "a", position: 0, written: false }],
        },
      ],
    });
    assert.equal(idsAreFrozen(frozen), true);
    const { merged, notes } = mergeSnapshots(
      snap({ runs: [run(1, { createdAt: "2026-01-01T00:00:00.000Z" })] }),
      snap({ runs: [frozen] }),
    );
    assert.equal(merged.runs.length, 1, "the conflicting run is not taken");
    assert.deepEqual(notes.conflicted, [1], "and it is reported rather than broken");
  });

  it("renumbers an applied run once every target is recorded", () => {
    const applied = run(1, {
      createdAt: "2026-02-02T00:00:00.000Z",
      status: "done",
      groups: [
        {
          groupId: 10,
          name: "Pop",
          targetPlaylistId: "PLdone",
          items: [{ videoId: "a", position: 0, written: true }],
        },
      ],
    });
    assert.equal(idsAreFrozen(applied), false, "the marker is never consulted again");
    const { merged } = mergeSnapshots(
      snap({ runs: [run(1, { createdAt: "2026-01-01T00:00:00.000Z" })] }),
      snap({ runs: [applied] }),
    );
    assert.equal(merged.runs.length, 2);
    assert.equal(merged.runs.find((r) => r.runId !== 1)?.groups[0]?.targetPlaylistId, "PLdone");
  });

  it("does not duplicate a renumbered run on a later merge", () => {
    // The remote run collides with a local one, so it is moved. Syncing the same remote again
    // must recognise the copy already made rather than moving another one in beside it.
    const local = snap({ runs: [run(1, { createdAt: "2026-01-01T00:00:00.000Z" })] });
    const remote = snap({ runs: [run(1, { createdAt: "2026-02-02T00:00:00.000Z" })] });
    const once = mergeSnapshots(local, remote);
    assert.equal(once.merged.runs.length, 2);
    const twice = mergeSnapshots(once.merged, remote);
    assert.equal(twice.merged.runs.length, 2, "still two runs, not three");
    assert.equal(twice.notes.renumbered.length, 0, "nothing moved the second time");
    const thrice = mergeSnapshots(twice.merged, remote);
    assert.equal(thrice.merged.runs.length, 2, "and it stays settled");
  });

  it("is stable when a device merges the same remote twice", () => {
    const local = snap({ runs: [run(1)], tracks: [track("a")] });
    const remote = snap({ runs: [run(2, { createdAt: "2026-03-03T00:00:00.000Z" })] });
    const once = mergeSnapshots(local, remote).merged;
    const twice = mergeSnapshots(once, remote);
    assert.equal(twice.merged.runs.length, 2, "no run is duplicated on a second merge");
    assert.equal(twice.notes.renumbered.length, 0);
    assert.ok(isQuiet(twice.notes), "and the second merge has nothing to report");
  });
});
