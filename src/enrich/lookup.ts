import type { Store } from "../db.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BudgetExhaustedError extends Error {
  constructor(limit: number) {
    super(`Reached the limit of ${limit} API calls for this run`);
    this.name = "BudgetExhaustedError";
  }
}

/** Caps external API calls per command invocation (`--max-api-calls`). Cache hits are free. */
export class Budget {
  used = 0;
  readonly limit: number | undefined;

  constructor(limit?: number) {
    this.limit = limit;
  }

  take(): void {
    if (this.limit !== undefined && this.used >= this.limit) {
      throw new BudgetExhaustedError(this.limit);
    }
    this.used++;
  }
}

/** Enforces a minimum gap between requests to one service. */
export class RateLimiter {
  private next = 0;
  private readonly intervalMs: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;

  constructor(intervalMs: number, sleep: Sleep = realSleep, now: () => number = Date.now) {
    this.intervalMs = intervalMs;
    this.sleep = sleep;
    this.now = now;
  }

  async wait(): Promise<void> {
    const delay = this.next - this.now();
    if (delay > 0) await this.sleep(delay);
    this.next = Math.max(this.now(), this.next) + this.intervalMs;
  }
}

export interface LookupDeps {
  store: Store;
  budget: Budget;
  userAgent: string;
  fetch?: FetchLike;
  sleep?: Sleep;
}

const MAX_ATTEMPTS = 3;

const SERVICE_NAMES: Record<string, string> = {
  musicbrainz: "MusicBrainz",
  discogs: "Discogs",
  lastfm: "Last.fm",
};

/**
 * GETs JSON through the SQLite lookup cache. `parse` turns the response body into the value that
 * is cached, so a "no match" result is cached too and never re-requested. Returns undefined
 * (uncached) when the service keeps failing, so one flaky service does not stop enrichment.
 */
export async function cachedGet<T>(
  deps: LookupDeps,
  limiter: RateLimiter,
  request: {
    source: string;
    cacheKey: string;
    url: string;
    headers?: Record<string, string>;
    parse: (body: unknown, status: number) => T;
  },
): Promise<T | undefined> {
  const cached = deps.store.cacheGet(request.source, request.cacheKey);
  if (cached !== undefined) return cached as T;

  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    deps.budget.take();
    await limiter.wait();
    let res: Response;
    try {
      res = await fetchImpl(request.url, {
        headers: { "user-agent": deps.userAgent, accept: "application/json", ...request.headers },
      });
    } catch {
      await sleep(1000 * attempt);
      continue;
    }
    // 503 (MusicBrainz) and 429 (Discogs, Last.fm) mean "slow down".
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * attempt);
      continue;
    }
    // A bad token or API key would otherwise be cached as "no match" for every track.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${SERVICE_NAMES[request.source.split("-")[0] ?? ""] ?? request.source} rejected the request (HTTP ${res.status}); check its API key or token`,
      );
    }
    const body: unknown = await res.json().catch(() => null);
    const value = request.parse(body, res.status);
    deps.store.cachePut(request.source, request.cacheKey, value);
    return value;
  }
  return undefined;
}
