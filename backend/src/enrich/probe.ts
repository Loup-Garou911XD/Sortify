import type { SourceTestResult } from "../api/types.ts";
import type { Cache } from "../db.ts";
import { Budget, type LookupDeps } from "./lookup.ts";
import type { ProviderClient, TrackQuery } from "./provider.ts";
import { createProviderClients } from "./providers.ts";

/** A song every catalogue knows, so "no match" points at the service rather than the query. */
const PROBE: TrackQuery = { videoId: "sortify-probe", artist: "Coldplay", title: "Yellow" };
/** One probe makes at most a few requests (Spotify's two, plus retries); this caps a runaway. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * The store with its lookup cache switched off: every lookup goes over the network, so a test
 * shows what the service says now, and nothing a test sees is written back. Everything else
 * passes through to the real store. A Proxy, not a subclass, because it wraps either shell's store.
 */
export function uncached(store: Cache): Cache {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "cacheGet") return () => undefined;
      if (prop === "cachePut") return () => {};
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * `POST /api/sources/test` for both shells: one live lookup per configured provider, minus the
 * `skip`ped ones (the static build passes SERVER_ONLY). The cache is neither read nor written.
 */
export function testSources(
  store: Cache,
  env: NodeJS.ProcessEnv,
  userAgent: string,
  skip: readonly string[] = [],
): Promise<SourceTestResult[]> {
  const deps: LookupDeps = { store: uncached(store), budget: new Budget(), userAgent };
  return probeProviders(createProviderClients(deps, env, skip));
}

/**
 * Asks each provider one live question about a well-known song and reports what came back. Build
 * the clients on an `uncached` store, or the answer may come from the cache.
 *
 * - `works`: it found the song and gave something the pipeline uses (genres, moods or a year).
 * - `limited`: it answered, but found nothing or gave nothing for a song every catalogue has.
 *   That is how a service that quietly stopped sending a field shows up (Spotify's genres did),
 *   and how a region block looks (Deezer lists results it will not return).
 * - `failed`: the lookup raised: a rejected key, an unreachable service, a timeout.
 *
 * A provider that makes no requests of its own (it reads data collected while fetching) works
 * without a request.
 */
export async function probeProviders(clients: ProviderClient[]): Promise<SourceTestResult[]> {
  return Promise.all(clients.map(probeOne));
}

const SONG = `"${PROBE.title}" by ${PROBE.artist}`;

async function probeOne(client: ProviderClient): Promise<SourceTestResult> {
  const id = client.id;
  if (client.videoOnly) {
    return {
      id,
      status: "works",
      message: "Makes no requests: reads labels saved when a playlist is fetched.",
      ms: 0,
    };
  }
  const started = Date.now();
  const result = (status: SourceTestResult["status"], message: string): SourceTestResult => ({
    id,
    status,
    message,
    ms: Date.now() - started,
  });
  let answer: Answer;
  try {
    answer = await withTimeout(ask(client), PROBE_TIMEOUT_MS);
  } catch (err) {
    return result("failed", (err as Error).message);
  }
  if (!answer.found) return result("limited", `Answered, but had no match for ${SONG}.`);
  const gave = [
    count(answer.genres, "genre"),
    count(answer.moods, "mood"),
    answer.year === undefined ? "" : `year ${answer.year}`,
  ].filter(Boolean);
  if (gave.length === 0) {
    return result("limited", `Found ${SONG}, but gave no genres, moods or year.`);
  }
  return result("works", `Found ${SONG}: ${gave.join(", ")}.`);
}

const count = (n: number, noun: string): string =>
  n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;

interface Answer {
  found: boolean;
  genres: number;
  moods: number;
  year: number | undefined;
}

/**
 * Walks the steps the client implements, the way the pipeline does: `resolve`, then `trackTags`
 * with the id the resolver found (MusicBrainz's genres hang off that id), then `artistTags` only
 * if neither found the song.
 */
async function ask(client: ProviderClient): Promise<Answer> {
  const answer: Answer = { found: false, genres: 0, moods: 0, year: undefined };
  let query = PROBE;
  if (client.resolve) {
    const match = await client.resolve(PROBE);
    if (!match) return answer;
    answer.found = true;
    answer.genres += match.genres?.length ?? 0;
    answer.year ??= match.year;
    if (match.externalId) query = { ...PROBE, externalIds: { [client.id]: match.externalId } };
  }
  if (client.trackTags) {
    const tags = await client.trackTags(query);
    answer.genres += tags.genres.length;
    answer.moods += tags.moods?.length ?? 0;
    answer.year ??= tags.year;
    answer.found ||=
      tags.externalId !== undefined || tags.genres.length > 0 || tags.year !== undefined;
  }
  if (!answer.found && client.artistTags) {
    answer.genres += (await client.artistTags(PROBE.artist)).length;
    answer.found = answer.genres > 0;
  }
  return answer;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
