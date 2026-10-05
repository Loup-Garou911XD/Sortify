import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { Discogs, pickResult } from "../src/enrich/discogs.ts";
import { LastFm } from "../src/enrich/lastfm.ts";
import {
  Budget,
  type FetchLike,
  type LookupDeps,
  LookupFailedError,
  RateLimiter,
  ServiceClient,
} from "../src/enrich/lookup.ts";
import { MusicBrainz } from "../src/enrich/musicbrainz.ts";
import { type Enrichers, enrichPlaylist } from "../src/enrich/pipeline.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";
import { createProviderClients, providerStatuses } from "../src/enrich/providers.ts";
import { TagMapper } from "../src/tagging/mapper.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes requests by host + a key query parameter to canned responses and records calls. */
function fakeApis(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(input);
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
  const enrichers: Enrichers = {
    mapper: new TagMapper(),
    clients: [new MusicBrainz(deps), new Discogs(deps, "token"), new LastFm(deps, "key")],
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
      retryLater: 0,
      propagated: 0,
      stoppedByBudget: false,
      cancelled: false,
    });

    const [lucky] = store.playlistTracks("PL1");
    expect(lucky).toMatchObject({
      artist: "Daft Punk feat. Pharrell Williams",
      songTitle: "Get Lucky",
      externalIds: { musicbrainz: "mb-1", discogs: "release/7" },
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
    const untagged = () => store.playlistTracks("PL1").filter((t) => t.enrichedAt === null);
    expect(partial.stoppedByBudget).toBe(true);
    expect(partial.remaining).toBeGreaterThan(0);
    expect(untagged().length).toBe(partial.remaining);

    deps.budget = new Budget();
    const rest = await enrichPlaylist(store, "PL1", enrichers);
    expect(rest).toEqual({
      enriched: partial.remaining,
      remaining: 0,
      retryLater: 0,
      propagated: 0,
      stoppedByBudget: false,
      cancelled: false,
    });
    expect(untagged()).toEqual([]);
  });

  it("skips MusicBrainz for Topic tracks and searches Discogs once per track", async () => {
    const { store, enrichers, calls } = setup();
    await enrichPlaylist(store, "PL1", enrichers);
    const mb = calls.filter((c) => c.includes("musicbrainz.org"));
    expect(mb.some((c) => decodeURIComponent(c).includes("Unknown Song"))).toBe(false);
    expect(mb).toHaveLength(2);
    expect(calls.filter((c) => c.includes("api.discogs.com"))).toHaveLength(3);
  });

  it("stops between tracks when cancelled, keeping finished ones", async () => {
    const { store, enrichers } = setup();
    const controller = new AbortController();
    const summary = await enrichPlaylist(store, "PL1", enrichers, {
      concurrency: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(summary).toEqual({
      enriched: 1,
      remaining: 2,
      retryLater: 0,
      propagated: 0,
      stoppedByBudget: false,
      cancelled: true,
    });
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
    await expect(
      new Discogs(deps, "bad").trackTags({ videoId: "v", artist: "A", title: "B" }),
    ).rejects.toThrow(/Discogs rejected the request \(HTTP 401\)/);
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
    await expect(
      new MusicBrainz(deps).resolve({ videoId: "v", artist: "A", title: "B" }),
    ).rejects.toBeInstanceOf(LookupFailedError);
    expect(calls).toBe(3);
    expect(store.cacheGet("musicbrainz", "a\u0000b")).toBeUndefined();
  });
});

describe("lookup plumbing", () => {
  it("backs off every caller of a service after it says slow down", async () => {
    const clock = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(
      100,
      async (ms) => {
        slept.push(ms);
      },
      () => clock,
    );
    await limiter.wait();
    limiter.penalize(2000);
    await Promise.all([limiter.wait(), limiter.wait()]);
    expect(slept).toEqual([2000, 2100]);
  });

  it("spaces out concurrent callers of one rate limiter", async () => {
    let clock = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(
      1000,
      async (ms) => {
        slept.push(ms);
      },
      () => clock,
    );
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    expect(slept).toEqual([1000, 2000]);
    clock = 5000;
    await limiter.wait();
    expect(slept).toEqual([1000, 2000]);
  });

  it("shares one request between identical concurrent lookups", async () => {
    let requests = 0;
    const deps: LookupDeps = {
      store: new Store(":memory:"),
      budget: new Budget(),
      userAgent: "test",
      fetch: async () => {
        requests++;
        return json({ value: 42 });
      },
      sleep: async () => {},
    };
    const http = new ServiceClient(deps, { name: "Test", source: "test", intervalMs: 0 });
    const lookup = () =>
      http.get({
        key: ["k"],
        url: "https://example.test/k",
        parse: (body) => (body as { value: number }).value,
      });
    expect(await Promise.all([lookup(), lookup(), lookup()])).toEqual([42, 42, 42]);
    expect(requests).toBe(1);
    expect(deps.budget.used).toBe(1);
  });

  it("prefers a Discogs master over a release of the same artist", () => {
    const match = pickResult(
      {
        results: [
          { id: 1, type: "release", title: "Karan Aujla - Single", style: ["Bhangra"] },
          { id: 2, type: "artist", title: "Karan Aujla" },
          { id: 3, type: "master", title: "Karan Aujla - Making Memories", style: ["Hip Hop"] },
        ],
      },
      "Karan Aujla",
    );
    expect(match?.id).toBe("master/3");
  });
});

describe("providers", () => {
  it("plugs in any ProviderClient without touching the pipeline", async () => {
    const store = new Store(":memory:");
    store.savePlaylist("PL", "Mix", [
      { videoId: "a", title: "Nightcall - Kavinsky", channel: "Kavinsky" },
      { videoId: "b", title: "Get Lucky", channel: "Daft Punk - Topic" },
    ]);
    const asked: string[] = [];
    // A stand-in for e.g. a future Spotify provider: resolves spelling, returns its own tags.
    const spotifyLike: ProviderClient = {
      id: "spotify",
      skip: (parsed) => parsed.official,
      resolve: async ({ artist, title }) => {
        asked.push(`resolve ${title}`);
        return { artist: artist.toUpperCase(), title, externalId: `sp:${title}` };
      },
      trackTags: async ({ artist }) => ({
        genres: [{ tag: "retrowave", source: "spotify", weight: 0.9 }],
        moods: [{ tag: "dark", source: "spotify", weight: 0.9 }],
        externalId: `sp-artist:${artist}`,
      }),
    };
    await enrichPlaylist(store, "PL", { mapper: new TagMapper(), clients: [spotifyLike] });

    const [a, b] = store.playlistTracks("PL");
    expect(a).toMatchObject({ artist: "KAVINSKY", externalIds: { spotify: "sp-artist:KAVINSKY" } });
    expect(b?.externalIds).toEqual({});
    expect(asked).toEqual(["resolve Nightcall"]);
    const tags = store.playlistTags("PL", "subgenre").map((t) => [t.videoId, t.value, t.source]);
    expect(tags).toEqual([["a", "Synthwave", "spotify"]]);
    expect(store.playlistTags("PL", "mood").map((t) => t.value)).toEqual(["Dark"]);
  });

  it("turns providers on from their environment variables and honours --skip", () => {
    const deps: LookupDeps = { store: new Store(":memory:"), budget: new Budget(), userAgent: "t" };
    const env = { DISCOGS_TOKEN: "x", LASTFM_API_KEY: " " };
    expect(providerStatuses(env).map((p) => [p.id, p.configured])).toEqual([
      ["musicbrainz", true],
      ["discogs", true],
      ["lastfm", false],
      ["spotify", false],
      ["itunes", true],
      ["deezer", true],
      ["youtube", true],
    ]);
    expect(createProviderClients(deps, env).map((c) => c.id)).toEqual([
      "musicbrainz",
      "discogs",
      "itunes",
      "deezer",
      "youtube",
    ]);
    expect(createProviderClients(deps, env, ["musicbrainz", "itunes"]).map((c) => c.id)).toEqual([
      "discogs",
      "deezer",
      "youtube",
    ]);
  });
});

describe("unreachable providers", () => {
  const client = (status: () => number, authenticated: boolean) => {
    let requests = 0;
    const http = new ServiceClient(
      {
        store: new Store(":memory:"),
        budget: new Budget(),
        userAgent: "t",
        sleep: async () => {},
        fetch: async () => {
          requests++;
          return json({ ok: true }, status());
        },
      },
      { name: "Svc", source: "svc", intervalMs: 0, authenticated },
    );
    return {
      get: () => http.get({ key: ["k"], url: "https://x.test", parse: () => "ok" }),
      requests: () => requests,
    };
  };

  it("retries a 403 from a keyless service instead of blaming a key", async () => {
    let n = 0;
    const svc = client(() => (++n < 3 ? 403 : 200), false);
    expect(await svc.get()).toBe("ok");
    expect(svc.requests()).toBe(3);
  });

  it("still stops at once on a 403 from a service with a key", async () => {
    const svc = client(() => 403, true);
    await expect(svc.get()).rejects.toThrow(/Svc rejected the request \(HTTP 403\)/);
    expect(svc.requests()).toBe(1);
  });

  it("keeps other tags, then retries the track on the next normal run", async () => {
    const store = new Store(":memory:");
    store.savePlaylist("PL", "Mix", [
      { videoId: "a", title: "Kavinsky - Nightcall", channel: "x" },
    ]);
    let flakyUp = false;
    const flaky: ProviderClient = {
      id: "flaky",
      trackTags: async () => {
        if (!flakyUp) throw new LookupFailedError("Flaky");
        return { genres: [], moods: [{ tag: "dark", source: "flaky", weight: 1 }] };
      },
    };
    const steady: ProviderClient = {
      id: "steady",
      trackTags: async () => ({ genres: [{ tag: "synthwave", source: "steady", weight: 1 }] }),
    };
    const enrichers = { mapper: new TagMapper(), clients: [steady, flaky] };

    const first = await enrichPlaylist(store, "PL", enrichers);
    expect(first.retryLater).toBe(1);
    expect(store.playlistTracks("PL")[0]?.failedProviders).toEqual(["flaky"]);
    expect(store.playlistTags("PL", "subgenre").map((t) => t.value)).toEqual(["Synthwave"]);
    expect(store.listPlaylists()[0]?.enriched).toBe(0);

    flakyUp = true;
    const second = await enrichPlaylist(store, "PL", enrichers);
    expect(second).toMatchObject({ enriched: 1, retryLater: 0 });
    expect(store.playlistTracks("PL")[0]?.failedProviders).toEqual([]);
    expect(store.playlistTags("PL", "mood").map((t) => t.value)).toEqual(["Dark"]);
    expect(store.listPlaylists()[0]?.enriched).toBe(1);
    // Nothing left to do: the next run asks no one.
    expect((await enrichPlaylist(store, "PL", enrichers)).enriched).toBe(0);
  });
});
