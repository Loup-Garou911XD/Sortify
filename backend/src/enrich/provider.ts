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
  create(deps: LookupDeps, env: NodeJS.ProcessEnv): ProviderClient;
}

export interface TrackQuery {
  /** The YouTube video, for providers that use data stored per video. */
  videoId: string;
  artist: string;
  title: string;
}

export interface Resolution {
  artist: string;
  title: string;
  /** The provider's id for the matched recording or release. */
  externalId?: string;
  genres?: RawTag[];
}

export interface TrackTags {
  externalId?: string;
  /** Genre-like tags, already weighted 0–1 by the provider's own trust in them. */
  genres: RawTag[];
  moods?: RawTag[];
}

/** One provider for one tagging run. Implement whichever steps the service can do. */
export interface ProviderClient {
  readonly id: string;
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
