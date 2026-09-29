import { describe, expect, it } from "vitest";
import { parseIsoDuration, QuotaExceededError, YouTubeClient } from "../src/youtube/client.ts";
import { parsePlaylistId } from "../src/youtube/playlistUrl.ts";

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
