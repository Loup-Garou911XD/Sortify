/**
 * Tag-source API keys, carried between devices in the sync file.
 *
 * Only the keys the tag providers read travel: never the Google client or the Google sign-in.
 * Those cannot help anyway, since reading the sync file already takes a Google sign-in, and
 * keeping them out is enforced here, at the point where remote data enters (`syncableEntries`),
 * not only by what devices choose to send.
 *
 * Whether a device uses the synced keys is its own switch, on unless turned off there, and never
 * synced (see
 * `usesSyncedKeys`). Keys a device has locally (`.env`, the environment, this browser's storage)
 * always win; synced keys only fill the gaps. Free of `node:` imports, like the rest of `sync/`.
 */
import type { ProviderStatus } from "../api/types.ts";
import { PROVIDERS } from "../enrich/providers.ts";
import { newestBy } from "./newest.ts";

/** One key in the sync file. `value: null` is a removal, kept so a merge cannot undo it. */
export interface KeySnapshot {
  name: string;
  value: string | null;
  /** When it was set or removed; the newest change per key wins a merge. */
  at: string;
}

/** The keys that may travel: every provider's `envVars` and optional `settings`. */
export const SYNCABLE_KEYS: readonly string[] = [
  ...new Set(PROVIDERS.flatMap((p) => [...p.envVars, ...(p.settings ?? [])])),
];

const isSyncable = (name: string): boolean => SYNCABLE_KEYS.includes(name);

/** Drops anything that is not a well-formed entry for a syncable key. */
export function syncableEntries(raw: unknown): KeySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (k): k is KeySnapshot =>
      typeof k === "object" &&
      k !== null &&
      typeof k.name === "string" &&
      isSyncable(k.name) &&
      (typeof k.value === "string" || k.value === null) &&
      typeof k.at === "string",
  );
}

/**
 * The newest change per key wins, removals included. A removal older than `cutoff` has done its
 * job (every device has seen it) and is dropped, the way playlist tombstones are.
 */
export function mergeKeys(
  local: KeySnapshot[],
  remote: KeySnapshot[],
  cutoff: string,
): KeySnapshot[] {
  return [...newestBy([...local, ...remote], (k) => k.name).values()]
    .filter((k) => k.value !== null || k.at > cutoff)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The keys currently set, without removals. */
export function liveKeys(entries: KeySnapshot[]): Record<string, string> {
  return Object.fromEntries(
    entries.filter((k) => k.value !== null).map((k) => [k.name, k.value as string]),
  );
}

/**
 * Entries recording `values` as of now: a blank value is a removal. Only syncable names are
 * kept, so passing a whole environment is safe.
 */
export function keyChanges(values: Record<string, string | null | undefined>): KeySnapshot[] {
  const at = new Date().toISOString();
  return Object.entries(values)
    .filter(([name]) => isSyncable(name))
    .map(([name, value]) => ({ name, value: value?.trim() ? value.trim() : null, at }));
}

/** The syncable keys this device has set locally, e.g. to share them. */
export function localSyncableKeys(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    SYNCABLE_KEYS.flatMap((name) => {
      const value = env[name]?.trim();
      return value ? [[name, value]] : [];
    }),
  );
}

/**
 * The environment the providers should see: the local one, with gaps filled from the synced
 * keys. Also says which names came from the sync file, so the UI can show it.
 */
export function withSyncedKeys(
  env: Record<string, string | undefined>,
  synced: Record<string, string>,
): { env: Record<string, string | undefined>; fromSync: string[] } {
  const merged = { ...env };
  const fromSync: string[] = [];
  for (const [name, value] of Object.entries(synced)) {
    if (env[name]?.trim()) continue;
    merged[name] = value;
    fromSync.push(name);
  }
  return { env: merged, fromSync };
}

/** What a store must offer for synced keys; both stores do. */
export interface KeyStore {
  syncedKeys(): KeySnapshot[];
  putSyncedKeys(changes: KeySnapshot[]): void;
  localSetting(name: string): string | undefined;
  setLocalSetting(name: string, value: string | null): void;
}

const USE_SYNCED_KEYS = "usesSyncedKeys";

/**
 * Whether this device uses the synced keys: on unless turned off here. Off is stored, not on, so
 * a device that never touched the switch follows the default. Never synced.
 */
export const usesSyncedKeys = (store: KeyStore): boolean =>
  store.localSetting(USE_SYNCED_KEYS) !== "0";

export const setUsesSyncedKeys = (store: KeyStore, on: boolean): void =>
  store.setLocalSetting(USE_SYNCED_KEYS, on ? null : "0");

/** The environment providers should get on this device: `withSyncedKeys` unless it opted out. */
export function providerEnv(
  env: Record<string, string | undefined>,
  store: KeyStore,
): { env: Record<string, string | undefined>; fromSync: string[] } {
  return usesSyncedKeys(store)
    ? withSyncedKeys(env, liveKeys(store.syncedKeys()))
    : { env, fromSync: [] };
}

/** Removes every synced key, as removals that travel, so other devices drop them too. */
export function forgetSyncedKeys(store: KeyStore): void {
  const names = Object.keys(liveKeys(store.syncedKeys()));
  store.putSyncedKeys(keyChanges(Object.fromEntries(names.map((n) => [n, null]))));
}

/** Marks each configured source whose key came from the sync file. */
export function withKeySources(statuses: ProviderStatus[], fromSync: string[]): ProviderStatus[] {
  return statuses.map((s) =>
    s.configured && s.envVars.some((v) => fromSync.includes(v)) ? { ...s, fromDrive: true } : s,
  );
}
