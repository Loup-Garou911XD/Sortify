const API = "https://www.googleapis.com/youtube/v3";

/** Quota units per call, from the YouTube Data API quota table. */
export const QUOTA_COST = { list: 1, insert: 50 } as const;

export class QuotaExceededError extends Error {
  constructor() {
    super("YouTube Data API daily quota exceeded");
    this.name = "QuotaExceededError";
  }
}

export class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(`YouTube API ${status}${reason ? ` (${reason})` : ""}: ${message}`);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = reason;
  }
}

export interface TokenProvider {
  getAccessToken(): Promise<{ token?: string | null }>;
}

export interface PlaylistEntry {
  videoId: string;
  title: string;
  channel: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiErrorBody {
  error?: { message?: string; errors?: { reason?: string }[] };
}

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const MAX_ATTEMPTS = 4;

/** Converts an ISO 8601 duration such as PT1H2M3S to seconds. */
export function parseIsoDuration(value: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const [, d, h, min, s] = m.map((part) => Number(part ?? 0));
  return (d ?? 0) * 86_400 + (h ?? 0) * 3_600 + (min ?? 0) * 60 + (s ?? 0);
}

/**
 * Minimal YouTube Data API v3 client over fetch. Counts quota units spent so callers can report
 * usage and stop before the daily limit.
 */
export class YouTubeClient {
  quotaUsed = 0;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    tokens: TokenProvider,
    options: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.tokens = tokens;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(
    method: "GET" | "POST",
    resource: string,
    params: Record<string, string>,
    cost: number,
    body?: unknown,
  ): Promise<T> {
    const url = `${API}/${resource}?${new URLSearchParams(params)}`;
    for (let attempt = 1; ; attempt++) {
      const { token } = await this.tokens.getAccessToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      this.quotaUsed += cost;
      if (res.ok) return (await res.json()) as T;

      const err = ((await res.json().catch(() => ({}))) as ApiErrorBody).error;
      const reason = err?.errors?.[0]?.reason;
      if (res.status === 403 && reason && QUOTA_REASONS.has(reason)) {
        throw new QuotaExceededError();
      }
      // playlistItems.insert intermittently answers 409 SERVICE_UNAVAILABLE; 5xx and rate
      // limits are also transient.
      const transient =
        res.status >= 500 ||
        res.status === 409 ||
        res.status === 429 ||
        reason === "rateLimitExceeded";
      if (!transient || attempt >= MAX_ATTEMPTS) {
        throw new YouTubeApiError(res.status, reason, err?.message ?? res.statusText);
      }
      await this.sleep(500 * 2 ** (attempt - 1));
    }
  }

  async getPlaylistTitle(playlistId: string): Promise<string> {
    const data = await this.request<{ items?: { snippet: { title: string } }[] }>(
      "GET",
      "playlists",
      { part: "snippet", id: playlistId },
      QUOTA_COST.list,
    );
    const item = data.items?.[0];
    if (!item) throw new Error(`Playlist ${playlistId} not found or not visible to this account`);
    return item.snippet.title;
  }

  /** All playable entries in a playlist, in order. Deleted and private videos are skipped. */
  async playlistEntries(playlistId: string): Promise<PlaylistEntry[]> {
    const entries: PlaylistEntry[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{
        nextPageToken?: string;
        items: {
          snippet: {
            title: string;
            videoOwnerChannelTitle?: string;
            resourceId: { videoId?: string };
          };
        }[];
      }>(
        "GET",
        "playlistItems",
        {
          part: "snippet",
          playlistId,
          maxResults: "50",
          ...(pageToken ? { pageToken } : {}),
        },
        QUOTA_COST.list,
      );
      for (const { snippet } of data.items) {
        const videoId = snippet.resourceId.videoId;
        // Deleted/private videos have no owner channel.
        if (!videoId || snippet.videoOwnerChannelTitle === undefined) continue;
        entries.push({ videoId, title: snippet.title, channel: snippet.videoOwnerChannelTitle });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return entries;
  }

  async videoDurations(videoIds: string[]): Promise<Map<string, number>> {
    const durations = new Map<string, number>();
    for (let i = 0; i < videoIds.length; i += 50) {
      const data = await this.request<{
        items: { id: string; contentDetails: { duration: string } }[];
      }>(
        "GET",
        "videos",
        { part: "contentDetails", id: videoIds.slice(i, i + 50).join(","), maxResults: "50" },
        QUOTA_COST.list,
      );
      for (const item of data.items) {
        const seconds = parseIsoDuration(item.contentDetails.duration);
        if (seconds !== null) durations.set(item.id, seconds);
      }
    }
    return durations;
  }

  /** The signed-in user's playlists, with descriptions (used to find Sortify's own). */
  async myPlaylists(): Promise<{ id: string; title: string; description: string }[]> {
    const out: { id: string; title: string; description: string }[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{
        nextPageToken?: string;
        items: { id: string; snippet: { title: string; description: string } }[];
      }>(
        "GET",
        "playlists",
        { part: "snippet", mine: "true", maxResults: "50", ...(pageToken ? { pageToken } : {}) },
        QUOTA_COST.list,
      );
      for (const item of data.items) {
        out.push({ id: item.id, title: item.snippet.title, description: item.snippet.description });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async playlistVideoIds(playlistId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const data = await this.request<{
        nextPageToken?: string;
        items: { contentDetails: { videoId: string } }[];
      }>(
        "GET",
        "playlistItems",
        {
          part: "contentDetails",
          playlistId,
          maxResults: "50",
          ...(pageToken ? { pageToken } : {}),
        },
        QUOTA_COST.list,
      );
      for (const item of data.items) ids.add(item.contentDetails.videoId);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return ids;
  }

  async createPlaylist(
    title: string,
    description: string,
    privacyStatus: "private" | "unlisted" | "public",
  ): Promise<string> {
    const data = await this.request<{ id: string }>(
      "POST",
      "playlists",
      { part: "snippet,status" },
      QUOTA_COST.insert,
      { snippet: { title, description }, status: { privacyStatus } },
    );
    return data.id;
  }

  async addToPlaylist(playlistId: string, videoId: string): Promise<void> {
    await this.request("POST", "playlistItems", { part: "snippet" }, QUOTA_COST.insert, {
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    });
  }
}
