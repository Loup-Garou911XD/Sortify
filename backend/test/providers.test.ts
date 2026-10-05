import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { Deezer, parseAlbum, pickTrack as pickDeezerTrack } from "../src/enrich/deezer.ts";
import { ITunes, pickSong } from "../src/enrich/itunes.ts";
import { Budget, type FetchLike, type LookupDeps } from "../src/enrich/lookup.ts";
import { MusicBrainz } from "../src/enrich/musicbrainz.ts";
import { enrichPlaylist } from "../src/enrich/pipeline.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";
import { createProviderClients, providerStatuses, SERVER_ONLY } from "../src/enrich/providers.ts";
import { Spotify } from "../src/enrich/spotify.ts";
import { YouTubeTopics } from "../src/enrich/youtubeTopics.ts";
import { TagMapper } from "../src/tagging/mapper.ts";
import { topicName } from "../src/youtube/client.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

function deps(fetch: FetchLike, store = new Store(":memory:")): LookupDeps {
  return { store, budget: new Budget(), userAgent: "test", fetch, sleep: async () => {} };
}

function playlist(store: Store, tracks: [id: string, title: string, channel: string][]) {
  store.savePlaylist(
    "PL",
    "Mix",
    tracks.map(([videoId, title, channel]) => ({ videoId, title, channel })),
  );
}

const subgenres = (store: Store, id: string) =>
  store
    .playlistTags("PL", "subgenre")
    .filter((t) => t.videoId === id)
    .map((t) => `${t.value} (${t.source})`)
    .sort();

describe("YouTube topics", () => {
  it("turns topic URLs into names", () => {
    expect(topicName("https://en.wikipedia.org/wiki/Hip_hop_music")).toBe("Hip hop music");
    expect(topicName("https://en.wikipedia.org/wiki/Music_of_Asia")).toBe("Music of Asia");
  });

  it("gives broad genres, used only when nothing better was found", async () => {
    const store = new Store(":memory:");
    playlist(store, [
      ["a", "Karan Aujla - Softly", "Karan Aujla"],
      ["b", "Kavinsky - Nightcall", "Kavinsky"],
    ]);
    store.setVideoDetails(
      new Map([
        ["a", { durationS: 200, topics: ["Hip hop music", "Music", "Music of Asia"] }],
        ["b", { durationS: 200, topics: ["Electronic music"] }],
      ]),
    );
    const synthwave: ProviderClient = {
      id: "fake",
      trackTags: async ({ videoId }) => ({
        genres: videoId === "b" ? [{ tag: "synthwave", source: "fake", weight: 1 }] : [],
      }),
    };
    await enrichPlaylist(store, "PL", {
      mapper: new TagMapper(),
      clients: [synthwave, new YouTubeTopics(store)],
    });
    expect(subgenres(store, "a")).toEqual(["Asian Music (youtube)", "Hip Hop (youtube)"]);
    expect(subgenres(store, "b")).toEqual(["Synthwave (fake)"]);
  });
});

describe("iTunes", () => {
  const results = {
    results: [
      {
        trackId: 1,
        artistName: "Karan Aujla & Ikky",
        trackName: "Softly (Tiësto Remix)",
        primaryGenreName: "Dance",
      },
      {
        trackId: 2,
        artistName: "Karan Aujla & Ikky",
        trackName: "Softly",
        primaryGenreName: "Punjabi Pop",
      },
    ],
  };

  it("picks the song whose artist and title match", () => {
    // The exact title beats the remix that is listed first.
    expect(pickSong(results, "Karan Aujla", "Softly")).toEqual({ id: "2", genre: "Punjabi Pop" });
    expect(pickSong(results, "Someone Else", "Softly")).toBeNull();
  });

  it("is asked only about tracks the others gave no subgenre", async () => {
    const store = new Store(":memory:");
    playlist(store, [
      ["a", "Karan Aujla - Softly", "Karan Aujla"],
      ["b", "Kavinsky - Nightcall", "Kavinsky"],
    ]);
    const asked: string[] = [];
    const itunes = new ITunes(
      deps(async (url) => {
        asked.push(new URL(url).searchParams.get("term") ?? "");
        return json({ results: [results.results[1]] });
      }, store),
    );
    const first: ProviderClient = {
      id: "fake",
      trackTags: async ({ videoId }) => ({
        genres: videoId === "b" ? [{ tag: "synthwave", source: "fake", weight: 1 }] : [],
      }),
    };
    await enrichPlaylist(store, "PL", { mapper: new TagMapper(), clients: [first, itunes] });
    expect(asked).toEqual(["Karan Aujla Softly"]);
    expect(subgenres(store, "a")).toEqual(["Punjabi Pop (itunes)"]);
    expect(store.playlistTracks("PL")[0]?.externalIds).toEqual({ itunes: "2" });
  });
});

describe("Spotify", () => {
  function fakeSpotify(tokenStatus = 200) {
    const calls: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "accounts.spotify.com") {
        calls.push(`token ${init?.method} ${new Headers(init?.headers).get("authorization")}`);
        return json({ access_token: "tok", expires_in: 3600 }, tokenStatus);
      }
      calls.push(`${url.pathname} ${new Headers(init?.headers).get("authorization")}`);
      if (url.pathname === "/v1/search") {
        return json({
          tracks: {
            items: [
              {
                id: "t1",
                name: "Softly",
                artists: [
                  { id: "ar1", name: "Karan Aujla" },
                  { id: "ar2", name: "IKKY" },
                ],
              },
            ],
          },
        });
      }
      return json({ genres: ["punjabi hip hop", "desi pop", "something unknown"] });
    };
    return { fetch, calls };
  }

  it("gets a token once, finds the track and maps the artist's genres", async () => {
    const store = new Store(":memory:");
    playlist(store, [
      ["a", "Karan Aujla - Softly", "Karan Aujla"],
      ["b", "Karan Aujla - Softly (Lyrics)", "lyric channel"],
    ]);
    const { fetch, calls } = fakeSpotify();
    const client = new Spotify(deps(fetch, store), "id", "secret");
    await enrichPlaylist(store, "PL", { mapper: new TagMapper(), clients: [client] });

    expect(subgenres(store, "a")).toEqual(["Desi Hip Hop (spotify)", "Indian Pop (spotify)"]);
    expect(store.playlistTracks("PL")[0]?.externalIds).toEqual({ spotify: "t1" });
    // One token (Basic auth), then Bearer calls; the second track is served from the cache.
    expect(calls).toEqual([
      `token POST Basic ${Buffer.from("id:secret").toString("base64")}`,
      "/v1/search Bearer tok",
      "/v1/artists/ar1 Bearer tok",
    ]);
  });

  it("reports bad app credentials", async () => {
    const { fetch } = fakeSpotify(400);
    const client = new Spotify(deps(fetch), "id", "wrong");
    await expect(
      client.trackTags({ videoId: "v", artist: "Karan Aujla", title: "Softly" }),
    ).rejects.toThrow(/SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET/);
  });
});

describe("Deezer", () => {
  const fakeDeezer = (): { fetch: FetchLike; calls: string[] } => {
    const calls: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === "/search") {
        return json({
          data: [
            { id: 1, title: "Softly", artist: { name: "Karan Aujla" }, album: { id: 9 } },
            { id: 2, title: "Softly (Live)", artist: { name: "Karan Aujla" }, album: { id: 8 } },
          ],
        });
      }
      return json({ genres: { data: [{ name: "Indian Music" }] }, release_date: "2023-04-21" });
    };
    return { fetch, calls };
  };

  it("takes album genres and the release year, one album lookup per album", async () => {
    const store = new Store(":memory:");
    playlist(store, [
      ["a", "Karan Aujla - Softly", "Karan Aujla"],
      ["b", "Karan Aujla - Softly", "other channel"],
    ]);
    const { fetch, calls } = fakeDeezer();
    await enrichPlaylist(store, "PL", {
      mapper: new TagMapper(),
      clients: [new Deezer(deps(fetch, store))],
    });

    expect(subgenres(store, "a")).toEqual(["Indian (deezer)"]);
    expect(store.playlistTags("PL", "decade").map((t) => [t.value, t.rawTag, t.source])).toEqual([
      ["2020s", "2023", "deezer"],
      ["2020s", "2023", "deezer"],
    ]);
    // Both tracks are the same lookup, so the second is served from the cache.
    expect(calls).toEqual(["/search", "/album/9"]);
  });

  it("keeps the best title match and ignores a wrong artist", () => {
    const body = {
      data: [
        { id: 1, title: "Softly (Live)", artist: { name: "Karan Aujla" }, album: { id: 9 } },
        { id: 2, title: "Softly", artist: { name: "Karan Aujla" }, album: { id: 7 } },
        { id: 3, title: "Softly", artist: { name: "Someone Else" }, album: { id: 1 } },
      ],
    };
    expect(pickDeezerTrack(body, "Karan Aujla", "Softly")).toEqual({ id: "2", albumId: "7" });
    expect(pickDeezerTrack(body, "Nobody", "Softly")).toBeNull();
    // An album with nothing on it is a miss, so the cache can expire it.
    expect(parseAlbum({ genres: { data: [] } })).toBeNull();
  });
});

describe("MusicBrainz genres", () => {
  const fakeMb = (): { fetch: FetchLike; calls: string[] } => {
    const calls: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === "/ws/2/recording") {
        return json({
          recordings: [
            {
              id: "mb-1",
              score: 100,
              title: "Softly",
              "artist-credit": [{ name: "Karan Aujla" }],
              tags: [{ name: "pop", count: 1 }],
            },
          ],
        });
      }
      return json({ genres: [{ name: "bhangra", count: 3 }], "first-release-date": "2003-05-01" });
    };
    return { fetch, calls };
  };

  it("asks for curated genres only when nothing else placed the track", async () => {
    const store = new Store(":memory:");
    playlist(store, [["a", "Karan Aujla - Softly", "Karan Aujla"]]);
    const { fetch, calls } = fakeMb();
    await enrichPlaylist(store, "PL", {
      mapper: new TagMapper(),
      clients: [new MusicBrainz(deps(fetch, store))],
    });

    // The search's loose "pop" tag only reaches a family, so the genre lookup follows.
    expect(subgenres(store, "a")).toEqual(["Bhangra (musicbrainz)"]);
    expect(store.playlistTags("PL", "decade").map((t) => t.value)).toEqual(["2000s"]);
    expect(calls).toEqual(["/ws/2/recording", "/ws/2/recording/mb-1"]);
  });

  it("makes no lookup for a track it did not resolve itself", async () => {
    const { fetch, calls } = fakeMb();
    const client = new MusicBrainz(deps(fetch));
    expect(await client.trackTags({ videoId: "v", artist: "A", title: "B" })).toEqual({
      genres: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("tracks with no artist in the title", () => {
  it("still gets the providers that read per-video data", async () => {
    const store = new Store(":memory:");
    // A label channel with no separator in the title: nothing to search a music database with.
    playlist(store, [["a", "aaj ki raat", "T-Series"]]);
    store.setVideoDetails(new Map([["a", { durationS: 200, topics: ["Indian music"] }]]));
    const asked: string[] = [];
    const searcher: ProviderClient = {
      id: "fake",
      trackTags: async ({ title }) => {
        asked.push(title);
        return { genres: [] };
      },
    };
    await enrichPlaylist(store, "PL", {
      mapper: new TagMapper(),
      clients: [searcher, new YouTubeTopics(store)],
    });

    expect(asked).toEqual([]);
    expect(subgenres(store, "a")).toEqual(["Indian (youtube)"]);
    // Tagged, so the next run does not try it again.
    expect(store.playlistTracks("PL")[0]?.enrichedAt).not.toBeNull();
  });
});

describe("the provider registry", () => {
  it("knows which providers a browser cannot reach", () => {
    expect(SERVER_ONLY).toEqual(["deezer"]);
    // The static build passes them as `skip`, so neither list offers them.
    expect(providerStatuses({}, SERVER_ONLY).map((p) => p.id)).not.toContain("deezer");
    expect(
      createProviderClients(
        deps(async () => json({})),
        {},
        SERVER_ONLY,
      ).map((c) => c.id),
    ).not.toContain("deezer");
  });
});
