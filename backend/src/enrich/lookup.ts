import type { Cache } from "../db.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BudgetExhaustedError extends Error {
  constructor(limit: number) {
    super(`Reached the limit of ${limit} API calls for this run`);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * A lookup that kept failing (network errors, "slow down" answers) after its retries. Nothing is
 * cached, and the pipeline marks the track so the next run asks that provider again.
 */
export class LookupFailedError extends Error {
  constructor(service: string) {
    super(`${service} did not answer after several tries`);
    this.name = "LookupFailedError";
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

/**
 * Enforces a minimum gap between requests to one service. Slots are reserved synchronously, so
 * concurrent callers are spaced out instead of all waking at the same moment.
 */
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
    const now = this.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  /** Pushes every caller's next slot back, e.g. after the service answered "slow down". */
  penalize(ms: number): void {
    this.next = Math.max(this.next, this.now() + ms);
  }
}

export interface LookupDeps {
  store: Cache;
  budget: Budget;
  userAgent: string;
  fetch?: FetchLike;
  sleep?: Sleep;
}

const MAX_ATTEMPTS = 3;

/** Cache key from lookup inputs; case-insensitive so "ADELE" and "Adele" share an entry. */
export const lookupKey = (...parts: string[]): string => parts.join("\u0000").toLowerCase();

export interface ServiceOptions {
  /** Display name used in error messages, e.g. "Last.fm". */
  name: string;
  /** Cache namespace; the provider id. */
  source: string;
  /** Minimum gap between requests, from the service's rate limit. */
  intervalMs: number;
  /** Sent with every request, e.g. an Authorization header; a function for short-lived tokens. */
  headers?: Record<string, string> | (() => Promise<Record<string, string>>);
  /**
   * The requests carry an API key or token. Then 401/403 means a bad key and stops the run; for
   * keyless services it usually means throttling or a temporary block, so it is retried.
   */
  authenticated?: boolean;
}

export interface LookupRequest<T> {
  /** Separate cache namespace within the service, e.g. "track" or "artist". */
  kind?: string;
  /** Lookup inputs; joined with lookupKey for the cache. */
  key: string[];
  url: string;
  parse: (body: unknown, status: number) => T;
}

/**
 * Everything a metadata provider needs to call its HTTP API politely: its own rate limit, the
 * shared SQLite lookup cache, the run's API budget, retries with service-wide backoff, and one
 * shared request for identical concurrent lookups. Providers only build URLs and parse bodies.
 */
export class ServiceClient {
  readonly name: string;
  private readonly deps: LookupDeps;
  private readonly options: ServiceOptions;
  private readonly limiter: RateLimiter;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(deps: LookupDeps, options: ServiceOptions) {
    this.deps = deps;
    this.options = options;
    this.name = options.name;
    this.limiter = new RateLimiter(options.intervalMs, deps.sleep);
  }

  /**
   * GETs JSON through the cache. `parse` turns the body into the value that is cached, so a "no
   * match" is cached too and never re-requested. Rejects with LookupFailedError (nothing cached)
   * when the service keeps failing, so the caller can carry on and retry it later.
   */
  get<T>(request: LookupRequest<T>): Promise<T> {
    const source = request.kind ? `${this.options.source}-${request.kind}` : this.options.source;
    const key = lookupKey(...request.key);
    const cached = this.deps.store.cacheGet(source, key);
    if (cached !== undefined) return Promise.resolve(cached as T);

    const flightKey = `${source}\u0000${key}`;
    const pending = this.inflight.get(flightKey);
    if (pending) return pending as Promise<T>;
    const lookup = this.fetchAndCache(source, key, request).finally(() =>
      this.inflight.delete(flightKey),
    );
    this.inflight.set(flightKey, lookup);
    return lookup;
  }

  private async fetchAndCache<T>(
    source: string,
    key: string,
    request: LookupRequest<T>,
  ): Promise<T> {
    // `fetch` is a method of the global object: capturing it unbound and calling it through a
    // variable throws "Illegal invocation" in browsers, though it works in Node.
    const fetchImpl = this.deps.fetch ?? fetch.bind(globalThis);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.deps.budget.take();
      await this.limiter.wait();
      // Outside the try: a failing token request is a configuration error, not a network blip.
      const extra =
        typeof this.options.headers === "function"
          ? await this.options.headers()
          : this.options.headers;
      let res: Response;
      try {
        res = await fetchImpl(request.url, {
          headers: { "user-agent": this.deps.userAgent, accept: "application/json", ...extra },
        });
      } catch {
        this.limiter.penalize(1000 * attempt);
        continue;
      }
      const denied = res.status === 401 || res.status === 403;
      // 503 (MusicBrainz) and 429 (Discogs, Last.fm) mean "slow down", and so does a 403 from a
      // keyless service: back off for every caller of this service, not just this one.
      if (res.status === 429 || res.status >= 500 || (denied && !this.options.authenticated)) {
        this.limiter.penalize(2000 * attempt);
        continue;
      }
      // A bad token or API key would otherwise be cached as "no match" for every track.
      if (denied) {
        throw new Error(
          `${this.name} rejected the request (HTTP ${res.status}); check its API key or token`,
        );
      }
      const body: unknown = await res.json().catch(() => null);
      const value = request.parse(body, res.status);
      this.deps.store.cachePut(source, key, value);
      return value;
    }
    throw new LookupFailedError(this.name);
  }
}
