import { describe, expect, it } from "vitest";
import { Store, type Tag, type Track, type TrackTag } from "../src/db.ts";
import { AGREEMENT_SOURCE, artistAgreementTags } from "../src/enrich/agreement.ts";
import { enrichPlaylist } from "../src/enrich/pipeline.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";
import { TagMapper } from "../src/tagging/mapper.ts";

const track = (videoId: string, artist: string | null): Track => ({
  videoId,
  title: `${artist ?? "?"} - ${videoId}`,
  channel: "c",
  durationS: null,
  artist,
  songTitle: videoId,
  externalIds: {},
  failedProviders: [],
  enrichedAt: "2026-01-01T00:00:00.000Z",
});

const tag = (videoId: string, value: string, source = "discogs"): TrackTag => ({
  videoId,
  dimension: "subgenre",
  value,
  rawTag: value.toLowerCase(),
  source,
  weight: 1,
});

const values = (tags: Tag[] | undefined) => (tags ?? []).map((t) => t.value);

describe("artistAgreementTags", () => {
  it("carries a subgenre most of the artist's tagged tracks share", () => {
    const tracks = ["a", "b", "c", "d"].map((id) => track(id, "Karan Aujla"));
    const added = artistAgreementTags(tracks, [
      tag("a", "Punjabi Pop"),
      tag("b", "Punjabi Pop"),
      tag("c", "Desi Hip Hop"),
    ]);
    // Punjabi Pop holds for 2 of 3, Desi Hip Hop for 1: only the first clears the half share.
    expect(values(added.get("d"))).toEqual(["Punjabi Pop"]);
    expect(added.get("d")?.[0]).toMatchObject({
      source: AGREEMENT_SOURCE,
      rawTag: "Karan Aujla",
      weight: 0.267,
    });
    // Tracks that already have a subgenre are left alone.
    expect(added.has("a")).toBe(false);
  });

  it("needs two tagged tracks, and never crosses artists", () => {
    const tracks = [track("a", "Solo"), track("b", "Solo"), track("c", "Other")];
    expect(artistAgreementTags(tracks, [tag("a", "Techno")]).size).toBe(0);
    const added = artistAgreementTags(
      [...tracks, track("d", "Solo")],
      [tag("a", "Techno"), tag("b", "Techno"), tag("c", "Bhangra")],
    );
    expect([...added.keys()]).toEqual(["d"]);
  });

  it("ignores its own earlier tags as evidence, and skips untagged tracks", () => {
    const tracks = [track("a", "X"), track("b", "X"), track("c", "X"), track("d", null)];
    const previous = [
      tag("a", "House"),
      tag("b", "House"),
      tag("c", "House", AGREEMENT_SOURCE),
      tag("d", "House"),
    ];
    // c is only held up by a previous round, so it is still a candidate rather than evidence.
    const added = artistAgreementTags(tracks, previous);
    expect(values(added.get("c"))).toEqual(["House"]);
    expect(added.get("c")?.[0]?.weight).toBe(0.4);
  });

  it("leaves a track that has not been tagged yet alone", () => {
    const pending = { ...track("c", "X"), enrichedAt: null };
    const added = artistAgreementTags(
      [track("a", "X"), track("b", "X"), pending],
      [tag("a", "House"), tag("b", "House")],
    );
    expect(added.size).toBe(0);
  });
});

describe("enrichPlaylist", () => {
  it("fills a track's subgenre in from the same artist's other tracks", async () => {
    const store = new Store(":memory:");
    store.savePlaylist("PL", "Mix", [
      { videoId: "a", title: "Karan Aujla - Softly", channel: "Karan Aujla" },
      { videoId: "b", title: "Karan Aujla - Winning Speech", channel: "Karan Aujla" },
      { videoId: "c", title: "Karan Aujla - Chitta", channel: "Karan Aujla" },
    ]);
    const known: ProviderClient = {
      id: "discogs",
      trackTags: async ({ title }) => ({
        genres: title === "Chitta" ? [] : [{ tag: "punjabi pop", source: "discogs", weight: 1 }],
      }),
    };
    const summary = await enrichPlaylist(store, "PL", {
      mapper: new TagMapper(),
      clients: [known],
    });

    expect(summary.propagated).toBe(1);
    const tags = store.playlistTags("PL", "subgenre").filter((t) => t.videoId === "c");
    expect(tags.map((t) => [t.value, t.source, t.weight])).toEqual([
      ["Punjabi Pop", AGREEMENT_SOURCE, 0.4],
    ]);

    // Running again neither duplicates the tag nor spreads it further.
    const again = await enrichPlaylist(store, "PL", { mapper: new TagMapper(), clients: [known] });
    expect(again.propagated).toBe(1);
    expect(store.playlistTags("PL", "subgenre").filter((t) => t.videoId === "c")).toHaveLength(1);
  });
});
