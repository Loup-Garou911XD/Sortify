import type { ProviderStatus } from "../api/types.ts";
import { discogs } from "./discogs.ts";
import { itunes } from "./itunes.ts";
import { lastfm } from "./lastfm.ts";
import type { LookupDeps } from "./lookup.ts";
import { musicbrainz } from "./musicbrainz.ts";
import type { ProviderClient, TagProvider } from "./provider.ts";
import { spotify } from "./spotify.ts";
import { youtubeTopics } from "./youtubeTopics.ts";

/**
 * Every tagging provider, in the order they are asked. Resolvers (spelling correction) run in
 * this order, so put the most trusted first. To add one, write a module exporting a TagProvider
 * (see provider.ts) and list it here.
 */
export const PROVIDERS: readonly TagProvider[] = [
  musicbrainz,
  discogs,
  lastfm,
  spotify,
  itunes,
  youtubeTopics,
];

export const isConfigured = (provider: TagProvider, env: NodeJS.ProcessEnv): boolean =>
  provider.envVars.every((name) => Boolean(env[name]?.trim()));

export function providerStatuses(env: NodeJS.ProcessEnv): ProviderStatus[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    help: p.help,
    envVars: p.envVars,
    configured: isConfigured(p, env),
  }));
}

/** Clients for the providers that are configured and not skipped (`--skip`). */
export function createProviderClients(
  deps: LookupDeps,
  env: NodeJS.ProcessEnv,
  skip: readonly string[] = [],
): ProviderClient[] {
  return PROVIDERS.filter((p) => isConfigured(p, env) && !skip.includes(p.id)).map((p) =>
    p.create(deps, env),
  );
}
