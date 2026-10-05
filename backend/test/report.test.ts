import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { MISS_TTL_MS } from "../src/enrich/cache.ts";
import { Budget, type FetchLike, type LookupDeps, ServiceClient } from "../src/enrich/lookup.ts";
import { enrichPlaylist } from "../src/enrich/pipeline.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";
import { tagReport } from "../src/enrich/report.ts";
import { emptySnapshot } from "../src/sync/snapshot.ts";
import { TagMapper } from "../src/tagging/mapper.ts";

const json = (body: unknown): Response => new Response(JSON.stringify(body));

/** A client whose answers come from one fake service, so the cache is the real thing. */
function tagger(deps: LookupDeps): ProviderClient {
  const http = new ServiceClient(deps, { name: "Fake", source: "discogs", intervalMs: 0 });
  return {
    id: "discogs",
    trackTags: async ({ artist, title }) => {
      const tags = await http.get({
        key: [artist, title],
        url: `https://example.test/?q=${encodeURIComponent(title)}`,
        parse: (body) => (body as { tags?: string[] } | null)?.tags ?? [],
      });
      return { genres: tags.map((tag) => ({ tag, source: "discogs", weight: 1 })) };
    },
  };
}

function seeded(fetch: FetchLike): { store: Store; deps: LookupDeps; calls: () => number } {
  const store = new Store(":memory:");
  store.savePlaylist("PL", "Mix", [
    { videoId: "a", title: "Kavinsky - Nightcall", channel: "Kavinsky" },
    { videoId: "b", title: "Boards of Canada - Olson", channel: "bocrecords" },
  ]);
  let used = 0;
  const counted: FetchLike = (input, init) => {
    used++;
    return fetch(input, init);
  };
  return {
    store,
    deps: { store, budget: new Budget(), userAgent: "t", fetch: counted, sleep: async () => {} },
    calls: () => used,
  };
}

describe("the lookup cache", () => {
  const fetch: FetchLike = async (input) =>
    json(new URL(input).searchParams.get("q") === "Nightcall" ? { tags: ["synthwave"] } : {});

  it("keeps a match for good but asks again about an expired miss", async () => {
    const { store, deps, calls } = seeded(fetch);
    const enrichers = { mapper: new TagMapper(), clients: [tagger(deps)] };
    await enrichPlaylist(store, "PL", enrichers);
    expect(calls()).toBe(2);

    // Both answers are cached, so nothing is asked again.
    await enrichPlaylist(store, "PL", enrichers, { force: true });
    expect(calls()).toBe(2);

    // Age every entry past the miss TTL: the match stands, the miss is asked again.
    const old = store.snapshot();
    const stale = new Date(Date.now() - MISS_TTL_MS - 1000).toISOString();
    const aged = new Store(":memory:");
    aged.absorb({
      ...emptySnapshot(),
      ...old,
      cache: old.cache.map((c) => ({ ...c, fetchedAt: stale })),
    });
    const second = {
      mapper: new TagMapper(),
      clients: [tagger({ ...deps, store: aged })],
    };
    await enrichPlaylist(aged, "PL", second, { force: true });
    expect(calls()).toBe(3);
    expect(aged.playlistTags("PL", "subgenre").map((t) => t.value)).toEqual(["Synthwave"]);
  });

  it("answers from the cache alone when offline, without a single request", async () => {
    const { store, deps, calls } = seeded(fetch);
    await enrichPlaylist(store, "PL", { mapper: new TagMapper(), clients: [tagger(deps)] });
    const before = calls();

    const offline = { mapper: new TagMapper(), clients: [tagger({ ...deps, offline: true })] };
    const report = await tagReport(store, "PL", offline);
    expect(calls()).toBe(before);
    expect(report.dimensions.find((d) => d.dimension === "subgenre")).toEqual({
      dimension: "subgenre",
      tracks: 1,
      values: 1,
    });

    // An empty cache offline means no answers at all, and no requests to find out.
    const cold = new Store(":memory:");
    cold.savePlaylist("PL", "Mix", [{ videoId: "a", title: "A - B", channel: "c" }]);
    const coldReport = await tagReport(cold, "PL", {
      mapper: new TagMapper(),
      clients: [tagger({ ...deps, store: cold, offline: true })],
    });
    expect(calls()).toBe(before);
    expect(coldReport.unanswered).toBe(1);
  });
});

describe("tagReport", () => {
  it("counts coverage per dimension and source, and ranks the tags with no label", async () => {
    const store = new Store(":memory:");
    store.savePlaylist("PL", "Mix", [
      { videoId: "a", title: "Kavinsky - Nightcall", channel: "Kavinsky" },
      { videoId: "b", title: "Kavinsky - Testarossa (Remix)", channel: "Kavinsky" },
      { videoId: "c", title: "aaj ki raat", channel: "T-Series" },
    ]);
    const client: ProviderClient = {
      id: "lastfm",
      trackTags: async ({ title }) => ({
        genres: [
          { tag: "synthwave", source: "lastfm", weight: 1 },
          { tag: "French Electro", source: "lastfm", weight: 0.8 },
          { tag: "french electro", source: "lastfm", weight: 0.4 },
          ...(title === "Nightcall" ? [{ tag: "seen live", source: "lastfm", weight: 0.5 }] : []),
        ],
        moods: [{ tag: "chillout", source: "lastfm", weight: 0.9 }],
      }),
    };
    const report = await tagReport(store, "PL", { mapper: new TagMapper(), clients: [client] });

    expect(report.total).toBe(3);
    expect(report.unparsed).toBe(1);
    expect(report.dimensions).toEqual([
      { dimension: "subgenre", tracks: 2, values: 1 },
      { dimension: "mood", tracks: 2, values: 1 },
      { dimension: "type", tracks: 1, values: 1 },
      { dimension: "language", tracks: 0, values: 0 },
      { dimension: "decade", tracks: 0, values: 0 },
    ]);
    expect(report.sources).toEqual([
      { source: "lastfm", tracks: 2, tags: 4 },
      { source: "rule", tracks: 1, tags: 1 },
    ]);
    // Spellings of one tag count together, under the commonest one, and the map's tags are gone.
    expect(report.unmapped).toEqual([
      { tag: "French Electro", sources: ["lastfm"], tracks: 2 },
      { tag: "seen live", sources: ["lastfm"], tracks: 1 },
    ]);
  });

  it("writes nothing", async () => {
    const store = new Store(":memory:");
    store.savePlaylist("PL", "Mix", [{ videoId: "a", title: "A - B", channel: "c" }]);
    const client: ProviderClient = {
      id: "lastfm",
      trackTags: async () => ({ genres: [{ tag: "techno", source: "lastfm", weight: 1 }] }),
    };
    await tagReport(store, "PL", { mapper: new TagMapper(), clients: [client] });
    expect(store.playlistAllTags("PL")).toEqual([]);
    expect(store.playlistTracks("PL")[0]?.enrichedAt).toBeNull();
  });
});
