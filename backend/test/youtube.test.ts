import { describe, expect, it } from "vitest";
import { parseIsoDuration, QuotaExceededError, YouTubeClient } from "../src/youtube/client.ts";
import { parsePlaylistId } from "../src/youtube/playlistUrl.ts";
import { musicLink, watchLinks } from "../src/youtube/watchLinks.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const tokens = { getAccessToken: async () => ({ token: "t" }) };

describe("parsePlaylistId", () => {
  it.each([
    ["https://www.youtube.com/playlist?list=PLabc_123", "PLabc_123"],
    ["https://music.youtube.com/playlist?list=RDCLAK5uy_x", "RDCLAK5uy_x"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz", "PLxyz"],
    ["PLabc_123", "PLabc_123"],
  ])("%s", (input, id) => {
    expect(parsePlaylistId(input)).toBe(id);
  });

  it("rejects other sites and URLs without a list", () => {
    expect(() => parsePlaylistId("https://example.com/playlist?list=PL1")).toThrow();
    expect(() => parsePlaylistId("https://www.youtube.com/watch?v=abc")).toThrow();
  });
});

describe("parseIsoDuration", () => {
  it("converts ISO 8601 durations", () => {
    expect(parseIsoDuration("PT3M33S")).toBe(213);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("P1DT1S")).toBe(86_401);
    expect(parseIsoDuration("bogus")).toBeNull();
  });
});

describe("YouTubeClient", () => {
  it("pages through playlist items, skips deleted videos and counts quota", async () => {
    const pages = [
      json({
        nextPageToken: "p2",
        items: [
          {
            snippet: {
              title: "A - One",
              videoOwnerChannelTitle: "A",
              resourceId: { videoId: "v1" },
            },
          },
          { snippet: { title: "Deleted video", resourceId: { videoId: "v2" } } },
        ],
      }),
      json({
        items: [
          {
            snippet: {
              title: "B - Two",
              videoOwnerChannelTitle: "B",
              resourceId: { videoId: "v3" },
            },
          },
        ],
      }),
    ];
    const urls: string[] = [];
    const yt = new YouTubeClient(tokens, {
      fetch: async (url) => {
        urls.push(url);
        const page = pages.shift();
        if (!page) throw new Error("unexpected request");
        return page;
      },
    });
    const entries = await yt.playlistEntries("PL1");
    expect(entries.map((e) => e.videoId)).toEqual(["v1", "v3"]);
    expect(urls[1]).toContain("pageToken=p2");
    expect(yt.quotaUsed).toBe(2);
  });

  it("turns quotaExceeded into QuotaExceededError", async () => {
    const yt = new YouTubeClient(tokens, {
      fetch: async () =>
        json({ error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }, 403),
    });
    await expect(yt.addToPlaylist("PL1", "v1")).rejects.toBeInstanceOf(QuotaExceededError);
    expect(yt.quotaUsed).toBe(50);
  });

  it("retries transient 409s on insert", async () => {
    let calls = 0;
    const yt = new YouTubeClient(tokens, {
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return calls < 3
          ? json({ error: { errors: [{ reason: "SERVICE_UNAVAILABLE" }] } }, 409)
          : json({ id: "x" });
      },
    });
    await yt.addToPlaylist("PL1", "v1");
    expect(calls).toBe(3);
  });
});

describe("watchLinks", () => {
  it("splits videos into links of at most 50, in order", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const links = watchLinks(ids);
    expect(links).toHaveLength(3);
    expect(links[0]).toBe(
      `https://www.youtube.com/watch_videos?video_ids=${ids.slice(0, 50).join(",")}`,
    );
    expect(links[2]).toBe(
      `https://www.youtube.com/watch_videos?video_ids=${ids.slice(100).join(",")}`,
    );
  });

  it("returns no links for no videos", () => {
    expect(watchLinks([])).toEqual([]);
  });
});

describe("musicLink", () => {
  const WATCH = "https://www.youtube.com/watch_videos?video_ids=a,b,c";
  const redirect = (location: string | null): typeof fetch =>
    (async () =>
      new Response(null, {
        status: 303,
        ...(location === null ? {} : { headers: { location } }),
      })) as unknown as typeof fetch;

  it("turns the temporary playlist YouTube mints into a Music link", async () => {
    const link = await musicLink(
      WATCH,
      redirect("https://www.youtube.com/watch?v=a&list=TLGGxyz0MjEwMjAyNg"),
    );
    expect(link).toBe("https://music.youtube.com/watch?v=a&list=TLGGxyz0MjEwMjAyNg");
  });

  it("reads the redirect rather than following it", async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(null, {
        status: 303,
        headers: { location: "https://www.youtube.com/watch?v=a&list=TLGG1" },
      });
    }) as unknown as typeof fetch;
    await musicLink(WATCH, spy);
    expect(seen?.redirect).toBe("manual");
  });

  it("refuses a URL that is not a watch_videos link", async () => {
    await expect(musicLink("https://example.com/evil", redirect(null))).rejects.toThrow(
      /watch_videos/,
    );
  });

  it("explains itself when YouTube answers without a playlist", async () => {
    await expect(musicLink(WATCH, redirect(null))).rejects.toThrow(/did not hand back/);
    await expect(musicLink(WATCH, redirect("https://www.youtube.com/"))).rejects.toThrow(
      /did not hand back/,
    );
  });
});
