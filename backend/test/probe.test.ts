import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { Budget, ServiceClient } from "../src/enrich/lookup.ts";
import { probeProviders, uncached } from "../src/enrich/probe.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("source tests", () => {
  it("tells a working source from a limited and a failed one", async () => {
    const clients: ProviderClient[] = [
      {
        id: "resolver",
        // The id it resolves is what its trackTags step needs, as with MusicBrainz.
        resolve: async ({ artist, title }) => ({ artist, title, externalId: "mb1" }),
        trackTags: async ({ externalIds }) => ({
          genres: externalIds?.resolver === "mb1" ? [{ tag: "rock", source: "r", weight: 1 }] : [],
          year: 2000,
        }),
      },
      { id: "years", trackTags: async () => ({ externalId: "sp1", genres: [], year: 2000 }) },
      { id: "nomatch", trackTags: async () => ({ genres: [] }) },
      { id: "nothing", trackTags: async () => ({ externalId: "x1", genres: [] }) },
      {
        id: "broken",
        trackTags: async () => {
          throw new Error("Test rejected the request (HTTP 401); check its API key or token");
        },
      },
      { id: "topics", videoOnly: true, trackTags: async () => ({ genres: [] }) },
    ];
    const results = await probeProviders(clients);
    expect(results.map((r) => [r.id, r.status, r.message])).toEqual([
      ["resolver", "works", 'Found "Yellow" by Coldplay: 1 genre, year 2000.'],
      ["years", "works", 'Found "Yellow" by Coldplay: year 2000.'],
      ["nomatch", "limited", 'Answered, but had no match for "Yellow" by Coldplay.'],
      ["nothing", "limited", 'Found "Yellow" by Coldplay, but gave no genres, moods or year.'],
      ["broken", "failed", "Test rejected the request (HTTP 401); check its API key or token"],
      ["topics", "works", "Makes no requests: reads labels saved when a playlist is fetched."],
    ]);
  });

  it("asks over the network even when the answer is cached, and caches nothing", async () => {
    const store = new Store(":memory:");
    store.cachePut("test", "k", 1);
    let requests = 0;
    const http = new ServiceClient(
      {
        store: uncached(store),
        budget: new Budget(),
        userAgent: "test",
        fetch: async () => {
          requests++;
          return json({ value: 2 });
        },
        sleep: async () => {},
      },
      { name: "Test", source: "test", intervalMs: 0 },
    );
    const value = await http.get({
      key: ["k", "new"],
      url: "https://example.test/k",
      parse: (body) => (body as { value: number }).value,
    });
    expect(value).toBe(2);
    expect(requests).toBe(1);
    expect(store.cacheGet("test", "k\u0000new")).toBeUndefined();
    // The rest of the store still answers through the wrapper.
    expect(uncached(store).listPlaylists()).toEqual([]);
  });
});
