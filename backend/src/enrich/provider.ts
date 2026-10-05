import type { RawTag } from "../tagging/mapper.ts";
import type { LookupDeps } from "./lookup.ts";
import type { ParsedTitle } from "./titleParser.ts";

/**
 * A metadata source for tagging (MusicBrainz, Discogs, Last.fm, and later e.g. Spotify). Adding a
 * provider means writing one module that exports a TagProvider and listing it in PROVIDERS
 * (providers.ts); the pipeline, CLI, API status and web UI pick it up from there.
 */
export interface TagProvider {
  /** Stable id: cache namespace, tag `source` in the database, key in a track's external ids. */
  id: string;
  label: string;
  /** One line on what it contributes; shown in the UI and CLI. */
  help: string;
  /** Environment variables it needs (API keys). If any is missing, the provider is off. */
  envVars: string[];
  /**
   * The service answers without an `access-control-allow-origin` header, so a browser cannot
   * read it: the static build leaves this provider out (see web/src/api.ts). Shells with a
   * server of their own are unaffected.
   */
  serverOnly?: boolean;
  create(deps: LookupDeps, env: NodeJS.ProcessEnv): ProviderClient;
}

export interface TrackQuery {
  /** The YouTube video, for providers that use data stored per video. */
  videoId: string;
  artist: string;
  title: string;
  /**
   * Ids earlier steps established, keyed by provider id. A provider can look up its own id (the
   * one its `resolve` returned) to ask a second, cheaper question about the same track.
   */
  externalIds?: Record<string, string>;
}

export interface Resolution {
  artist: string;
  title: string;
  /** The provider's id for the matched recording or release. */
  externalId?: string;
  genres?: RawTag[];
  /** Year of the earliest release the provider knows, for the `decade` tag. */
  year?: number;
}

export interface TrackTags {
  externalId?: string;
  /** Genre-like tags, already weighted 0–1 by the provider's own trust in them. */
  genres: RawTag[];
  moods?: RawTag[];
  /** Year of the earliest release the provider knows, for the `decade` tag. */
  year?: number;
}

/** One provider for one tagging run. Implement whichever steps the service can do. */
export interface ProviderClient {
  readonly id: string;
  /**
   * Works from the video alone (per-video data already in the cache), so it is asked even about
   * tracks whose title gave no artist or song name — the uploads no music database would match.
   */
  readonly videoOnly?: boolean;
  /**
   * Ask only about tracks the other providers gave no subgenre, e.g. for a slow or strictly
   * rate-limited service. Fallback providers run after the parallel step, before artist tags.
   */
  readonly fallback?: boolean;
  /**
   * Finds the track in the provider's catalogue and returns its canonical spelling. Resolvers run
   * first, in PROVIDERS order; the first match wins and the later steps use its spelling.
   */
  resolve?(query: TrackQuery): Promise<Resolution | undefined>;
  /** Tags for the track. All providers' tag lookups run in parallel. */
  trackTags?(query: TrackQuery): Promise<TrackTags>;
  /**
   * Artist-level genre tags, as a fallback when no provider tagged the track. Only used when the
   * artist is known (stated in the title or confirmed by a resolver), never for a guessed one.
   */
  artistTags?(artist: string): Promise<RawTag[]>;
  /** Tracks this provider should not be asked about, e.g. ones whose metadata is already clean. */
  skip?(parsed: ParsedTitle): boolean;
}
