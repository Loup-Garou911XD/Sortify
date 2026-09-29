import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { Discogs } from "../src/enrich/discogs.ts";
import { LastFm } from "../src/enrich/lastfm.ts";
import { Budget, type FetchLike, type LookupDeps } from "../src/enrich/lookup.ts";
import { MusicBrainz } from "../src/enrich/musicbrainz.ts";
import { enrichPlaylist } from "../src/enrich/pipeline.ts";
import { TagMapper } from "../src/tagging/mapper.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes requests by host + a key query parameter to canned responses and records calls. */
function fakeApis(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === "musicbrainz.org") {
      const query = url.searchParams.get("query") ?? "";
      if (!query.toLowerCase().includes("get lucky")) return json({ recordings: [] });
      return json({
        recordings: [
          {
            id: "mb-1",
            score: 100,
            title: "Get Lucky",
            "artist-credit": [
              { name: "Daft Punk", joinphrase: " feat. " },
              { name: "Pharrell Williams" },
            ],
            tags: [{ name: "disco", count: 3 }],
          },
        ],
      });
    }
    if (url.hostname === "api.discogs.com") {
      if (url.searchParams.get("type") === "master") return json({ results: [] });
      return json({
        results: [
          {
            id: 9,
            type: "release",
            title: "Various - Hits 2013",
            style: ["Europop"],
            format: ["CD", "Compilation"],
          },
          {
            id: 7,
            type: "release",
            title: "Daft Punk - Random Access Memories",
            genre: ["Electronic"],
            style: ["Nu-Disco", "Disco"],
          },
        ],
      });
    }
    if (url.hostname === "ws.audioscrobbler.com") {
      if (url.searchParams.get("method") === "artist.gettoptags") {
        return json({ toptags: { tag: [{ name: "indie rock", count: 100 }] } });
      }
      if (url.searchParams.get("artist")?.startsWith("Daft Punk")) {
        return json({ error: 6, message: "Track not found" });
      }
      if (url.searchParams.get("track") === "Obscure") return json({ toptags: { tag: [] } });
      return json({
        toptags: {
          tag: [
            { name: "funk", count: 100 },
            { name: "feel good", count: 60 },
            { name: "party", count: 5 },
          ],
        },
      });
    }
    return json({}, 404);
  };
  return { fetch, calls };
}

function setup(budgetLimit?: number) {
  const store = new Store(":memory:");
  const { fetch, calls } = fakeApis();
  const deps: LookupDeps = {
    store,
    budget: new Budget(budgetLimit),
    userAgent: "test",
    fetch,
    sleep: async () => {},
  };
  const enrichers = {
    mapper: new TagMapper(),
    musicbrainz: new MusicBrainz(deps),
    discogs: new Discogs(deps, "token"),
    lastfm: new LastFm(deps, "key"),
  };
  store.savePlaylist("PL1", "Mix", [
    { videoId: "v1", title: "Daft Punk - Get Lucky (Official Video)", channel: "DaftPunkVEVO" },
    { videoId: "v2", title: "Unknown Song", channel: "Some Band - Topic" },
    { videoId: "v3", title: "Other Band - Obscure", channel: "uploader" },
  ]);
  return { store, enrichers, deps, calls };
}

describe("enrichPlaylist", () => {
  it("combines MusicBrainz, Discogs and Last.fm into subgenre, mood and type tags", async () => {
    const { store, enrichers } = setup();
    const summary = await enrichPlaylist(store, "PL1", enrichers);
    expect(summary).toEqual({
      enriched: 3,
      remaining: 0,
      stoppedByBudget: false,
      cancelled: false,
    });

    const [lucky] = store.playlistTracks("PL1");
    expect(lucky).toMatchObject({
      artist: "Daft Punk feat. Pharrell Williams",
      songTitle: "Get Lucky",
      mbid: "mb-1",
      discogsId: "release/7",
    });
    const subgenres = store.playlistTags("PL1", "subgenre").filter((t) => t.videoId === "v1");
    expect(new Set(subgenres.map((t) => t.value))).toEqual(new Set(["Nu-Disco", "Disco"]));

    // Only Last.fm has mood tags; "party" is below the minimum count.
    const moods = store.playlistTags("PL1", "mood");
    expect(moods.filter((t) => t.videoId === "v2").map((t) => t.value)).toEqual(["Happy"]);
  });

  it("takes subgenres from Last.fm track tags, then artist tags at half weight", async () => {
    const { store, enrichers } = setup();
    await enrichPlaylist(store, "PL1", enrichers);
    const subgenres = store.playlistTags("PL1", "subgenre");
    const of = (id: string) =>
      subgenres.filter((t) => t.videoId === id).map((t) => [t.value, t.weight]);
    expect(of("v2")).toEqual([["Funk", 1]]);
    expect(of("v3")).toEqual([["Indie Rock", 0.5]]);
  });

  it("serves repeated lookups from the cache", async () => {
    const { store, enrichers, calls } = setup();
    await enrichPlaylist(store, "PL1", enrichers);
    const first = calls.length;
    await enrichPlaylist(store, "PL1", enrichers, { force: true });
    expect(calls.length).toBe(first);
  });

  it("stops cleanly at the API budget and resumes later", async () => {
    const { store, enrichers, deps } = setup(3);
    const partial = await enrichPlaylist(store, "PL1", enrichers);
    expect(partial.stoppedByBudget).toBe(true);
    expect(partial.remaining).toBe(3);
    expect(store.playlistTracks("PL1").filter((t) => t.enrichedAt === null).length).toBe(3);

    deps.budget = new Budget();
    const rest = await enrichPlaylist(store, "PL1", enrichers);
    expect(rest).toEqual({ enriched: 3, remaining: 0, stoppedByBudget: false, cancelled: false });
  });
});

describe("lookup errors", () => {
  it("fails loudly on a rejected API key instead of caching 'no match'", async () => {
    const store = new Store(":memory:");
    const deps: LookupDeps = {
      store,
      budget: new Budget(),
      userAgent: "test",
      fetch: async () => json({ message: "Invalid consumer token" }, 401),
      sleep: async () => {},
    };
    await expect(new Discogs(deps, "bad").findStyles("A", "B")).rejects.toThrow(/401/);
  });

  it("retries 503s and gives up without caching", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const deps: LookupDeps = {
      store,
      budget: new Budget(),
      userAgent: "test",
      fetch: async () => {
        calls++;
        return json({}, 503);
      },
      sleep: async () => {},
    };
    expect(await new MusicBrainz(deps).findRecording("A", "B")).toBeNull();
    expect(calls).toBe(3);
    expect(store.cacheGet("musicbrainz", "a\u0000b")).toBeUndefined();
  });
});
