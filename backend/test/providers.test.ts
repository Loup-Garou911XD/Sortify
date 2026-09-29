import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { ITunes, pickSong } from "../src/enrich/itunes.ts";
import { Budget, type FetchLike, type LookupDeps } from "../src/enrich/lookup.ts";
import { enrichPlaylist } from "../src/enrich/pipeline.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";
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
